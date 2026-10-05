import { z } from "zod";
import { query, transaction, enqueue, event } from "./db.js";
import { hash, canonicalUrl, sourceFromUrl } from "./domain.js";
import { settings, ingest } from "./store.js";
import { automationGate, ReviewError } from "./runner.js";
import { generateDocument } from "./documents.js";
import { fetchPublic, NetworkError } from "./network.js";
import { parseJobPosting } from "./normalize.js";
import { recordConnectorFailure } from "./connectors.js";

export const batchSchema = z.object({
  action: z.enum(["cv", "letter", "prepare", "submit"]),
  applicationIds: z.array(z.uuid()).min(1).max(50),
  reviewTokens: z.record(z.uuid(), z.string()).default({}),
});
export const reviewToken = (snapshot: any) =>
  hash([
    snapshot.profileId,
    snapshot.jobHash,
    snapshot.connectorHash,
    snapshot.documentIds,
  ]);
export async function submissionEligibility(id: string) {
  try {
    const gate = await automationGate(id, undefined, false);
    if (gate.app.runner_state !== "ready")
      throw new ReviewError("Preparation supervisee requise");
    return {
      id,
      eligible: true,
      reason: null,
      reviewToken: reviewToken(gate.snapshot),
    };
  } catch (e) {
    return {
      id,
      eligible: false,
      reason: e instanceof ReviewError ? e.message : "Configuration a verifier",
    };
  }
}
export async function createBatch(
  input: z.input<typeof batchSchema>,
  key: string,
) {
  const body = batchSchema.parse(input);
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `operation:${key}`,
    ]);
    const digest = hash(body);
    const [old] = await query(
      "SELECT * FROM operations WHERE idempotency_key=$1",
      [key],
      tx,
    );
    if (old) {
      if (old.request_hash !== digest)
        throw new ReviewError("Cle d'idempotence deja utilisee");
      return old;
    }
    if ((await settings(tx)).paused)
      throw new ReviewError("Arret global actif");
    const [op] = await query(
      "INSERT INTO operations(kind,idempotency_key,request_hash) VALUES($1,$2,$3) RETURNING *",
      [body.action, key, digest],
      tx,
    );
    for (const id of [...new Set(body.applicationIds)].sort()) {
      const [a] = await query(
        "SELECT * FROM applications WHERE id=$1 FOR UPDATE",
        [id],
        tx,
      );
      if (!a) throw new ReviewError("Candidature introuvable");
      const [item] = await query(
        "INSERT INTO operation_items(operation_id,application_id,job_id) VALUES($1,$2,$3) RETURNING id",
        [op.id, id, a.job_id],
        tx,
      );
      try {
        if (body.action === "prepare" || body.action === "submit") {
          if (
            a.status !== "to_apply" ||
            [
              "queued",
              "preparing",
              "submitting",
              "unknown",
              "confirmed",
            ].includes(a.runner_state)
          )
            throw new ReviewError("Candidature active, envoyee ou incertaine");
          const [connector] = await query(
            "SELECT * FROM connectors WHERE id=$1",
            [a.connector_id],
            tx,
          );
          if (
            !connector?.enabled ||
            !connector.authorized ||
            connector.kind !== "form"
          )
            throw new ReviewError("Connecteur autorise requis");
          if (body.action === "submit") {
            if (a.runner_state !== "ready")
              throw new ReviewError("Preparation supervisee requise");
            const gate = await automationGate(id, tx, false);
            if (body.reviewTokens[id] !== reviewToken(gate.snapshot))
              throw new ReviewError(
                "Configuration modifiee depuis la revue ; nouvelle confirmation requise",
              );
            await query(
              "INSERT INTO submission_approvals(application_id,snapshot,expires_at) VALUES($1,$2,now()+interval '24 hours') ON CONFLICT(application_id) DO UPDATE SET snapshot=excluded.snapshot,expires_at=excluded.expires_at,consumed_at=NULL",
              [id, JSON.stringify(gate.snapshot)],
              tx,
            );
          }
          await query(
            "UPDATE applications SET runner_state='queued',updated_at=now(),last_error=NULL WHERE id=$1",
            [id],
            tx,
          );
          await enqueue(
            "run_application",
            { id, mode: body.action, operationItem: item.id },
            `run:${id}`,
            tx,
          );
        } else {
          await enqueue(
            "operation_document",
            { itemId: item.id, jobId: a.job_id, kind: body.action },
            `operation:${item.id}`,
            tx,
          );
        }
      } catch (e) {
        if (!(e instanceof ReviewError)) throw e;
        await query(
          "UPDATE operation_items SET state='excluded',message=$2 WHERE id=$1",
          [item.id, e.message],
          tx,
        );
      }
    }
    await event(
      "operation.created",
      op.id,
      { action: body.action, count: body.applicationIds.length },
      tx,
    );
    return op;
  });
}
export async function operationDocument(payload: unknown) {
  const { itemId, jobId, kind } = z
    .object({
      itemId: z.uuid(),
      jobId: z.uuid(),
      kind: z.enum(["cv", "letter"]),
    })
    .parse(payload);
  const [item] = await query(
    "UPDATE operation_items SET state='running',updated_at=now() WHERE id=$1 AND state='queued' RETURNING id",
    [itemId],
  );
  if (!item) return;
  try {
    if ((await settings()).paused)
      throw new ReviewError("Generation suspendue");
    await generateDocument(jobId, kind);
    await query(
      "UPDATE operation_items SET state='completed',updated_at=now() WHERE id=$1",
      [itemId],
    );
  } catch {
    await query(
      "UPDATE operation_items SET state='failed',message='Generation interrompue : verifier le profil et IA',updated_at=now() WHERE id=$1",
      [itemId],
    );
  }
}
export async function enrichJob(
  payload: unknown,
  request: typeof fetchPublic = fetchPublic,
) {
  const { itemId, jobId, connectorId } = z
    .object({ itemId: z.uuid(), jobId: z.uuid(), connectorId: z.string() })
    .parse(payload);
  const [item] = await query(
    "UPDATE operation_items SET state='running',updated_at=now() WHERE id=$1 AND state='queued' RETURNING id",
    [itemId],
  );
  if (!item) return;
  const { pool } = await import("./db.js");
  const lock = await pool.connect();
  let domain: string | undefined;
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [
      `collect:${connectorId}`,
    ]);
    if ((await settings()).paused)
      throw new ReviewError("Enrichissement suspendu");
    const [c] = await query("SELECT * FROM connectors WHERE id=$1", [
      connectorId,
    ]);
    const [job] = await query("SELECT * FROM jobs WHERE id=$1", [jobId]);
    if (
      !c?.enabled ||
      !c.authorized ||
      c.kind !== "html" ||
      !c.config.authorizationEvidence ||
      !job ||
      ["indeed", "linkedin"].includes(sourceFromUrl(job.canonical_url))
    )
      throw new ReviewError("Source non autorisee");
    if (
      c.cursor.nextAllowed &&
      new Date(c.cursor.nextAllowed).getTime() > Date.now()
    )
      throw new ReviewError("Source temporairement limitee");
    domain = `domain:${new URL(job.canonical_url).hostname}`;
    await lock.query("SELECT pg_advisory_lock(hashtext($1))", [domain]);
    if (!c.config.allowedHosts?.includes(new URL(job.canonical_url).hostname))
      throw new ReviewError("Domaine hors liste");
    const response = await request(
      job.canonical_url,
      {},
      c.config.allowedHosts,
    );
    if (/captcha|verify you are human|unusual traffic/i.test(response.text)) {
      throw new NetworkError("Challenge detecte", 0, true);
    }
    const matches = parseJobPosting(response.text, response.url).filter(
      (j) => canonicalUrl(j.url) === job.canonical_url,
    );
    if (matches.length !== 1)
      throw new NetworkError("Annonce absente ou ambigue", 0, true);
    await ingest(
      {
        ...matches[0],
        source: job.data.source,
        externalId: job.data.externalId,
      },
      { connector: connectorId, html: response.text, url: response.url },
    );
    await event("job.enriched", jobId, { connectorId });
    await query(
      "UPDATE connectors SET failures=0,last_error=NULL,last_success_at=now(),cursor=cursor || '{\"structuralFailures\":0}'::jsonb WHERE id=$1",
      [connectorId],
    );
    await query(
      "UPDATE operation_items SET state='completed',updated_at=now() WHERE id=$1",
      [itemId],
    );
  } catch (e) {
    if (!(e instanceof ReviewError))
      await recordConnectorFailure(connectorId, e);
    await query(
      "UPDATE operation_items SET state='failed',message=$2,updated_at=now() WHERE id=$1",
      [
        itemId,
        e instanceof ReviewError ? e.message : "Enrichissement interrompu",
      ],
    );
  } finally {
    if (domain)
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [domain]);
    await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `collect:${connectorId}`,
    ]);
    lock.release();
  }
}
