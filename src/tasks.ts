import { query, enqueue, transaction, event } from "./db.js";
import { settings, evaluate } from "./store.js";
import { callAI, aiMatchSchema } from "./ai.js";
import { queueNotification, deliverNotification } from "./notifications.js";
import { collectConnector } from "./connectors.js";
import { generateDocument } from "./documents.js";
import { z } from "zod";
import type { TaskList } from "graphile-worker";
import { automationGate, ReviewError } from "./runner.js";
import { canonicalUrl } from "./urls.js";
import { pruneEvidence } from "./evidence.js";
import { operationDocument, enrichJob } from "./operations.js";
import { runDiagnostic } from "./diagnostics.js";
export const tasks = {
  async process_job({ id }: { id: string }) {
    const prefs = await settings();
    if (prefs.paused) return;
    const { job, profile, evaluation } = await evaluate(id);
    if (job.state === "ignored" || evaluation.rejected) return;
    if (prefs.aiEnabled && evaluation.ai_status === "disabled") {
      const claimed = await query(
        "UPDATE evaluations SET ai_status='running' WHERE id=$1 AND ai_status='disabled' RETURNING id",
        [evaluation.id],
      );
      if (claimed.length) {
        try {
          const analysis = aiMatchSchema.parse(
            await callAI(
              evaluation.cache_key,
              "Evalue adequation et reserves. Chaque evidence doit etre un extrait exact de offre.description ou offre.title. JSON {adequacy:0..100,reservations:string[],evidence:string[]}.",
              {
                offer: job.data,
                profile: {
                  skills: profile.data.skills,
                  roles: profile.data.roles,
                  locations: profile.data.locations,
                  seniority: profile.data.seniority,
                  summary: profile.data.summary,
                  facts: profile.data.facts,
                },
              },
            ),
          );
          if (
            analysis.evidence.some(
              (s) => !`${job.data.title}\n${job.data.description}`.includes(s),
            )
          )
            throw new Error("Extrait non justifie");
          await query(
            "UPDATE evaluations SET ai=$2,ai_status='completed' WHERE id=$1",
            [evaluation.id, JSON.stringify(analysis)],
          );
        } catch {
          await query("UPDATE evaluations SET ai_status='failed' WHERE id=$1", [
            evaluation.id,
          ]);
        }
      }
    }
    if (evaluation.score >= prefs.notificationMinScore)
      await queueNotification(
        `job:${id}`,
        `${job.data.title}\n${job.data.company || "Entreprise inconnue"} · ${job.data.location || "Lieu inconnu"}\nScore ${evaluation.score}/100\n${evaluation.data.unknowns.join(", ")}`,
        id,
      );
    if (
      evaluation.score >= prefs.autoThreshold &&
      !evaluation.data.unknowns.length
    ) {
      const candidates = await query(
        "SELECT * FROM connectors WHERE enabled AND authorized AND auto_submit AND submission_mode='automatic' AND kind='form'",
      );
      const connector = candidates.find(
        (c) => canonicalUrl(c.config.url) === job.canonical_url,
      );
      if (connector)
        try {
          await transaction(async (tx) => {
            await query(
              "INSERT INTO applications(job_id,connector_id) VALUES($1,$2) ON CONFLICT(job_id) DO NOTHING",
              [id, connector.id],
              tx,
            );
            const [a] = await query(
              "SELECT * FROM applications WHERE job_id=$1 FOR UPDATE",
              [id],
              tx,
            );
            if (
              a.status !== "to_apply" ||
              !["needs_review", "ready"].includes(a.runner_state)
            )
              return;
            if (a.last_error && a.runner_state === "needs_review") return;
            await query(
              "UPDATE applications SET connector_id=$2 WHERE id=$1",
              [a.id, connector.id],
              tx,
            );
            await automationGate(a.id, tx);
            await query(
              "UPDATE applications SET runner_state='queued',updated_at=now() WHERE id=$1",
              [a.id],
              tx,
            );
            await enqueue(
              "run_application",
              { id: a.id, mode: "submit" },
              `run:${a.id}`,
              tx,
            );
          });
        } catch (e) {
          if (!(e instanceof ReviewError)) throw e;
        }
    }
  },
  notify: async ({ id }: { id: string }) => deliverNotification(id),
  collect: async ({ id }: { id: string }) => collectConnector(id),
  document: async ({
    jobId,
    kind,
  }: {
    jobId: string | null;
    kind: "cv" | "letter";
  }) => {
    if ((await settings()).paused)
      throw new Error("Generation suspendue : reprise requise");
    try {
      await generateDocument(jobId, kind);
    } catch {
      await event("document.failed", jobId, {
        kind,
        message:
          "Generation interrompue. Verifier le profil et la configuration IA.",
      });
      throw new Error("Generation documentaire interrompue");
    }
  },
  async tick() {
    await pruneEvidence();
    await query(
      "INSERT INTO heartbeats(service) VALUES('worker') ON CONFLICT(service) DO UPDATE SET last_seen_at=now()",
    );
    if ((await settings()).paused) return;
    const rows = await query(
      "SELECT * FROM connectors WHERE enabled AND authorized AND kind IN ('email','rss','html')",
    );
    for (const c of rows)
      if (
        !c.last_run_at ||
        Date.now() - new Date(c.last_run_at).getTime() >
          (c.kind === "email" ? 300000 : 21600000)
      )
        await enqueue("collect", { id: c.id }, `collect:${c.id}`);
    for (const reminder of await query(
      "SELECT r.*,a.job_id,a.status,j.data FROM reminders r JOIN applications a ON a.id=r.application_id JOIN jobs j ON j.id=a.job_id WHERE due_at<=now() AND dismissed_at IS NULL AND notified_at IS NULL",
    )) {
      if (["applied", "interview"].includes(reminder.status))
        await queueNotification(
          `reminder:${reminder.id}`,
          `Relance a preparer : ${reminder.data.title}`,
          reminder.job_id,
        );
      await query("UPDATE reminders SET notified_at=now() WHERE id=$1", [
        reminder.id,
      ]);
    }
    await query(
      "UPDATE notifications SET state='unknown',last_error='Worker interrompu pendant la livraison' WHERE state='sending' AND updated_at<now()-interval '10 minutes'",
    );
    await query(
      "UPDATE evaluations SET ai_status='failed' WHERE ai_status='running' AND created_at<now()-interval '10 minutes'",
    );
    await query(
      "UPDATE applications SET runner_state=CASE WHEN runner_state='submitting' THEN 'unknown' ELSE 'needs_review' END,last_error='Runner interrompu : verification requise' WHERE runner_state IN ('submitting','preparing') AND updated_at<now()-interval '10 minutes'",
    );
    await query(
      "UPDATE application_attempts t SET state=a.runner_state,finished_at=now() FROM applications a WHERE t.application_id=a.id AND t.state IN ('preparing','submitting') AND a.runner_state IN ('unknown','needs_review') AND t.created_at<now()-interval '10 minutes'",
    );
    await query(
      "UPDATE operation_items SET state='failed',message='Traitement interrompu ; verification requise',updated_at=now() WHERE state='running' AND updated_at<now()-interval '10 minutes'",
    );
    await query(
      "UPDATE diagnostics SET state='failed',message='Diagnostic interrompu' WHERE state='queued' AND checked_at<now()-interval '10 minutes'",
    );
  },
};
const idPayload = z.object({ id: z.string().min(1) });
export const taskList: TaskList = {
  operation_document: operationDocument,
  enrich_job: async (p) => enrichJob(p),
  diagnostic: async (p) =>
    runDiagnostic(
      z
        .object({ integration: z.enum(["imap", "notifications", "ai"]) })
        .parse(p).integration,
    ),
  process_job: async (p) => tasks.process_job(idPayload.parse(p)),
  notify: async (p) => tasks.notify(idPayload.parse(p)),
  collect: async (p) => tasks.collect(idPayload.parse(p)),
  document: async (p) =>
    tasks.document(
      z
        .object({ jobId: z.uuid().nullable(), kind: z.enum(["cv", "letter"]) })
        .parse(p),
    ),
  tick: async () => tasks.tick(),
};
