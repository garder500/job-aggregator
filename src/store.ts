import { query, transaction, event, enqueue, type Tx } from "./db.js";
import {
  profileSchema,
  settingsSchema,
  folded,
  hash,
  canonicalUrl,
  type JobInput,
  type Profile,
} from "./domain.js";
import { normalizeJob } from "./normalize.js";
import { scoreJob } from "./scoring.js";
import { config } from "./config.js";
export async function currentProfile(
  tx?: Tx,
): Promise<{ id: string; version: number; data: Profile }> {
  const [row] = await query(
    "SELECT * FROM profiles ORDER BY version DESC LIMIT 1",
    [],
    tx,
  );
  return { ...row, data: profileSchema.parse(row.data) };
}
export async function settings(tx?: Tx) {
  return settingsSchema.parse(
    (await query("SELECT data FROM settings", [], tx))[0].data,
  );
}
export async function ingest(input: JobInput, raw: unknown = input) {
  const job = normalizeJob(input);
  const url = canonicalUrl(job.url);
  const externalId = job.externalId || url;
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(7421902)");
    const [item] = await query(
      "INSERT INTO source_items(source,external_id,digest,raw) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
      [job.source, externalId, hash(raw), JSON.stringify(raw)],
      tx,
    );
    if (!item) {
      const [old] = await query(
        "SELECT job_id id FROM job_sources WHERE source=$1 AND external_id=$2 LIMIT 1",
        [job.source, externalId],
        tx,
      );
      if (old)
        await query(
          "UPDATE jobs SET last_seen_at=now() WHERE id=$1",
          [old.id],
          tx,
        );
      return { id: old?.id, created: false };
    }
    const fingerprint = hash([
      folded(job.company),
      folded(job.title),
      folded(job.location),
      folded(job.description),
    ]);
    const [match] = await query(
      `SELECT j.* FROM jobs j WHERE canonical_url=$1 OR id IN (SELECT job_id FROM job_sources WHERE source=$2 AND external_id=$3)
      OR ($4::boolean AND fingerprint=$5) OR ($6::boolean AND data->>'employerReference'=$7 AND lower(data->>'company')=lower($8)) ORDER BY created_at LIMIT 1`,
      [
        url,
        job.source,
        externalId,
        Boolean(job.company && job.location && job.description.length >= 100),
        fingerprint,
        Boolean(job.company && job.employerReference),
        job.employerReference || "",
        job.company,
      ],
      tx,
    );
    let id: string;
    const created = !match;
    if (match) {
      id = match.id;
      // Keep complete fields when a short email preview follows an enriched record.
      const next = {
        ...job,
        company: job.company || match.data.company,
        location: job.location || match.data.location,
        description:
          job.description.length >= match.data.description.length
            ? job.description
            : match.data.description,
        skills: [...new Set([...match.data.skills, ...job.skills])],
        salary: job.salary || match.data.salary,
        seniority: job.seniority || match.data.seniority,
        contract:
          job.contract === "unknown" ? match.data.contract : job.contract,
        remote: job.remote === "unknown" ? match.data.remote : job.remote,
      };
      await query(
        "UPDATE jobs SET data=$2,last_seen_at=now(),fingerprint=$3 WHERE id=$1",
        [
          id,
          JSON.stringify(next),
          hash([
            folded(next.company),
            folded(next.title),
            folded(next.location),
            folded(next.description),
          ]),
        ],
        tx,
      );
    } else {
      [{ id }] = await query(
        "INSERT INTO jobs(canonical_url,data,fingerprint) VALUES($1,$2,$3) RETURNING id",
        [url, JSON.stringify(job), fingerprint],
        tx,
      );
    }
    await query(
      "INSERT INTO job_sources(job_id,source_item_id,source,external_id,url) VALUES($1,$2,$3,$4,$5)",
      [id, item.id, job.source, externalId, url],
      tx,
    );
    if (created && job.company) {
      const similar = await query(
        "SELECT id FROM jobs WHERE id<>$1 AND lower(data->>'company')=lower($2) AND lower(data->>'title')=lower($3)",
        [id, job.company, job.title],
        tx,
      );
      for (const other of similar)
        await query(
          "INSERT INTO duplicate_candidates(left_id,right_id,reason) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            id,
            other.id,
            "Entreprise et titre identiques ; reference ou localisation a verifier",
          ],
          tx,
        );
    }
    await evaluate(id, tx);
    await event(
      created ? "job.imported" : "job.refreshed",
      id,
      { source: job.source },
      tx,
    );
    await enqueue("process_job", { id }, `process:${id}`, tx);
    return { id, created };
  });
}
export async function evaluate(id: string, tx?: Tx) {
  const [job] = await query("SELECT * FROM jobs WHERE id=$1", [id], tx);
  if (!job) throw new Error("Offre introuvable");
  const profile = await currentProfile(tx);
  const result = scoreJob(job.data, profile.data);
  const key = hash([
    job.data,
    profile.id,
    "score-v1",
    config.aiModel,
    "match-v1",
  ]);
  const [evaluation] = await query(
    "INSERT INTO evaluations(job_id,profile_id,cache_key,score,rejected,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(cache_key) DO UPDATE SET cache_key=excluded.cache_key RETURNING *",
    [
      id,
      profile.id,
      key,
      result.score,
      result.rejected,
      JSON.stringify(result),
    ],
    tx,
  );
  return { job, profile, evaluation };
}
export async function mergeJobs(left: string, right: string) {
  if (left === right) throw new Error("Deux offres distinctes sont requises");
  return transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(7421902)");
    if (
      (
        await query(
          "SELECT id FROM jobs WHERE id=ANY($1::uuid[])",
          [[left, right]],
          tx,
        )
      ).length !== 2
    )
      throw new Error("Offre introuvable");
    const apps = await query(
      "SELECT * FROM applications WHERE job_id=ANY($1::uuid[]) FOR UPDATE",
      [[left, right]],
      tx,
    );
    if (
      apps.length > 1 ||
      apps.some((a) =>
        ["queued", "preparing", "ready", "submitting", "unknown"].includes(
          a.runner_state,
        ),
      )
    )
      throw new Error(
        "Fusion interdite : candidature active ou historique conflictuel",
      );
    await query(
      "UPDATE job_sources SET job_id=$1 WHERE job_id=$2",
      [left, right],
      tx,
    );
    await query(
      "UPDATE applications SET job_id=$1 WHERE job_id=$2",
      [left, right],
      tx,
    );
    await query(
      "UPDATE documents SET job_id=$1 WHERE job_id=$2",
      [left, right],
      tx,
    );
    await query(
      "DELETE FROM duplicate_candidates WHERE left_id=$1 OR right_id=$1",
      [right],
      tx,
    );
    await query("DELETE FROM evaluations WHERE job_id=$1", [right], tx);
    await query("DELETE FROM jobs WHERE id=$1", [right], tx);
    await event("job.merged", left, { merged: right }, tx);
  });
}
