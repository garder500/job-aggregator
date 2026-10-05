import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { scryptSync, timingSafeEqual, randomBytes } from "node:crypto";
import { existsSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { config } from "./config.js";
import { pool, db, query, transaction, event, enqueue } from "./db.js";
import { documents as documentTable } from "./schema.js";
import {
  profileSchema,
  settingsSchema,
  jobSchema,
  canonicalUrl,
  sourceFromUrl,
} from "./domain.js";
import {
  currentProfile,
  settings,
  ingest,
  evaluate,
  mergeJobs,
} from "./store.js";
import { parseEmail } from "./normalize.js";
import { migrate } from "./migrate.js";
import { formSchema, automationGate, ReviewError } from "./runner.js";
import { validatePublicUrl } from "./network.js";
import { evidencePath } from "./evidence.js";
import { setupStatus } from "./diagnostics.js";
import {
  batchSchema,
  createBatch,
  submissionEligibility,
} from "./operations.js";
import { hash } from "./domain.js";
class InputError extends Error {}
const uuid = z.uuid();
const passwordSalt = randomBytes(16);
const passwordHash = scryptSync(config.password, passwordSalt, 32);
export async function createServer() {
  const app = Fastify({
    bodyLimit: 1500000,
    logger: {
      level: "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "password",
        "token",
        "email",
        "phone",
      ],
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url || req.url.split("?")[0];
    if (!route.startsWith("/api/")) return;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return reply.code(403).send({ error: "Origine de requete invalide" });
    if (["/api/login", "/api/health"].includes(route)) return;
    const signed = req.cookies.session && req.unsignCookie(req.cookies.session);
    let valid = false;
    if (signed && signed.valid && signed.value) {
      const [expires] = signed.value.split(":");
      valid = Number(expires) > Date.now();
    }
    if (!valid) return reply.code(401).send({ error: "Connexion requise" });
  });
  app.addHook("onSend", async (req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "SAMEORIGIN");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    if (error instanceof InputError || error instanceof ReviewError)
      return reply.code(409).send({ error: error.message });
    if ((error as any).statusCode && (error as any).statusCode < 500)
      return reply
        .code((error as any).statusCode)
        .send({ error: "Requete invalide" });
    app.log.error(
      { route: req.routeOptions.url, code: (error as any).code },
      "Requete interrompue",
    );
    reply.code(500).send({
      error: "Operation interrompue. Consultez la sante des services.",
    });
  });
  app.get("/api/health", async () => {
    await query("SELECT 1");
    return { ok: true };
  });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z.object({ password: z.string().max(500) }).parse(req.body);
      const candidate = scryptSync(body.password, passwordSalt, 32);
      if (!timingSafeEqual(candidate, passwordHash))
        return reply.code(401).send({ error: "Mot de passe incorrect" });
      reply.setCookie(
        "session",
        `${Date.now() + 12 * 3600000}:${randomBytes(16).toString("hex")}`,
        {
          signed: true,
          httpOnly: true,
          sameSite: "strict",
          secure: new URL(config.origin).protocol === "https:",
          path: "/",
          maxAge: 43200,
        },
      );
      return { ok: true };
    },
  );
  app.post("/api/logout", async (_, reply) => {
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async () => ({ ok: true }));
  app.get("/api/overview", async () => {
    const [counts] = await query(
      "SELECT count(*)::int total,count(*) FILTER(WHERE state='new')::int new,count(*) FILTER(WHERE state='shortlisted')::int shortlisted FROM jobs",
    );
    const [apps] = await query(
      "SELECT count(*) FILTER(WHERE status='applied')::int applied,count(*) FILTER(WHERE status='interview')::int interviews,count(*) FILTER(WHERE runner_state='unknown')::int uncertain FROM applications",
    );
    const [usage] = await query(
      "SELECT coalesce(sum(reserved_eur),0) reserved FROM ai_usage WHERE created_at>=date_trunc('month',now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris'",
    );
    return {
      ...counts,
      ...apps,
      aiReserved: Number(usage.reserved),
      settings: await settings(),
      heartbeats: await query("SELECT * FROM heartbeats"),
      events: await query("SELECT * FROM events ORDER BY id DESC LIMIT 15"),
      reminders: await query(
        "SELECT r.*,j.data FROM reminders r JOIN applications a ON a.id=r.application_id JOIN jobs j ON j.id=a.job_id WHERE dismissed_at IS NULL ORDER BY due_at LIMIT 30",
      ),
    };
  });
  app.get("/api/jobs", async (req) => {
    const args = z
      .object({
        q: z.string().max(200).default(""),
        state: z
          .enum(["all", "new", "seen", "ignored", "shortlisted"])
          .default("all"),
        minScore: z.coerce.number().min(0).max(100).default(0),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query);
    return query(
      `SELECT j.*,e.score,e.rejected,e.data evaluation,e.ai,e.ai_status,a.id application_id,a.status application_status,a.runner_state FROM jobs j
      LEFT JOIN LATERAL (SELECT * FROM evaluations WHERE job_id=j.id AND profile_id=(SELECT id FROM profiles ORDER BY version DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1) e ON true
      LEFT JOIN applications a ON a.job_id=j.id WHERE ($1='all' OR j.state=$1) AND ($2='' OR j.data->>'title' ILIKE '%'||$2||'%' OR j.data->>'company' ILIKE '%'||$2||'%') AND coalesce(e.score,0)>=$3 ORDER BY e.score DESC NULLS LAST,j.created_at DESC LIMIT 100 OFFSET $4`,
      [args.state, args.q, args.minScore, args.offset],
    );
  });
  app.get("/api/jobs/:id", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const [job] = await query("SELECT * FROM jobs WHERE id=$1", [id]);
    if (!job) throw new InputError("Offre introuvable");
    return {
      ...job,
      sources: await query(
        "SELECT source,url FROM job_sources WHERE job_id=$1",
        [id],
      ),
      evaluations: await query(
        "SELECT * FROM evaluations WHERE job_id=$1 ORDER BY created_at DESC LIMIT 5",
        [id],
      ),
      application: (
        await query("SELECT * FROM applications WHERE job_id=$1", [id])
      )[0],
    };
  });
  app.post("/api/import", async (req) => {
    const body = z
      .discriminatedUnion("format", [
        z.object({
          format: z.literal("json"),
          items: z.array(jobSchema).min(1).max(50),
        }),
        z.object({
          format: z.literal("eml"),
          content: z.string().min(1).max(1000000),
        }),
      ])
      .parse(req.body);
    const items =
      body.format === "eml" ? await parseEmail(body.content) : body.items;
    if (!items.length)
      throw new InputError(
        "Aucune offre identifiee. Utilisez un import JSON pour les liens non reconnus.",
      );
    const result = [];
    for (const item of items)
      result.push(
        await ingest(
          item,
          body.format === "eml" ? { email: body.content, job: item } : item,
        ),
      );
    return {
      received: items.length,
      created: result.filter((r) => r.created).length,
      items: result,
    };
  });
  app.post("/api/jobs/:id/state", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const { state } = z
      .object({ state: z.enum(["new", "seen", "ignored", "shortlisted"]) })
      .parse(req.body);
    const rows = await query(
      "UPDATE jobs SET state=$2 WHERE id=$1 RETURNING id",
      [id, state],
    );
    if (!rows.length) throw new InputError("Offre introuvable");
    await event("job.state", id, { state });
    return { ok: true };
  });
  app.post("/api/jobs/:id/evaluate", async (req) => {
    const id = uuid.parse((req.params as any).id);
    await evaluate(id);
    await enqueue("process_job", { id }, `process:${id}`);
    return { ok: true };
  });
  app.get("/api/duplicates", async () =>
    query(
      "SELECT d.*,l.data left_data,r.data right_data FROM duplicate_candidates d JOIN jobs l ON l.id=d.left_id JOIN jobs r ON r.id=d.right_id WHERE NOT resolved",
    ),
  );
  app.post("/api/duplicates", async (req) => {
    const { left, right, action } = z
      .object({ left: uuid, right: uuid, action: z.enum(["merge", "dismiss"]) })
      .parse(req.body);
    if (action === "merge") await mergeJobs(left, right);
    else
      await query(
        "UPDATE duplicate_candidates SET resolved=true WHERE left_id=$1 AND right_id=$2",
        [left, right],
      );
    return { ok: true };
  });
  app.get("/api/profile", async () => currentProfile());
  app.post("/api/profile", async (req) => {
    const data = profileSchema.parse(req.body);
    return transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(7421906)");
      const old = await currentProfile(tx);
      const [profile] = await query(
        "INSERT INTO profiles(version,data) VALUES($1,$2) RETURNING *",
        [old.version + 1, JSON.stringify(data)],
        tx,
      );
      for (const j of await query("SELECT id FROM jobs", [], tx)) {
        await evaluate(j.id, tx);
        await enqueue("process_job", { id: j.id }, `process:${j.id}`, tx);
      }
      await event(
        "profile.updated",
        profile.id,
        { version: profile.version },
        tx,
      );
      return profile;
    });
  });
  app.get("/api/settings", async () => ({
    data: await settings(),
    configured: {
      discord: !!config.discord,
      telegram: !!(config.telegram && config.telegramChat),
      slack: !!config.slack,
      ai: !!(config.aiKey && config.aiModel),
      imap: !!(config.imap.host && config.imap.user && config.imap.password),
    },
  }));
  app.post("/api/settings", async (req) => {
    const data = settingsSchema.parse(req.body);
    const previous = await settings();
    await query("UPDATE settings SET data=$1", [JSON.stringify(data)]);
    if (
      (previous.paused && !data.paused) ||
      (!previous.aiEnabled && data.aiEnabled)
    ) {
      for (const j of await query("SELECT id FROM jobs WHERE state<>'ignored'"))
        await enqueue("process_job", { id: j.id }, `process:${j.id}`);
      for (const n of await query(
        "SELECT id FROM notifications WHERE state='pending'",
      ))
        await enqueue("notify", { id: n.id }, `notify:${n.id}`);
    }
    await event("settings.updated", null, { paused: data.paused });
    return { ok: true };
  });
  app.get("/api/connectors", async () =>
    query("SELECT * FROM connectors ORDER BY name"),
  );
  app.post("/api/connectors", async (req) => {
    const body = z
      .object({
        id: z.string().regex(/^[a-z0-9-]{1,60}$/),
        name: z.string().min(1).max(200),
        kind: z.enum(["rss", "html", "form"]),
        enabled: z.boolean(),
        authorized: z.boolean(),
        auto_submit: z.boolean().default(false),
        submission_mode: z
          .enum(["review_required", "automatic"])
          .default("review_required"),
        config: z.record(z.string(), z.unknown()),
      })
      .parse(req.body);
    if (body.kind === "form") {
      const form = formSchema.parse(body.config);
      validatePublicUrl(form.url);
      if (["indeed", "linkedin"].includes(sourceFromUrl(form.url)))
        throw new InputError(
          "Soumission externe desactivee pour cette plateforme",
        );
    } else {
      const http = z
        .object({
          url: z.url(),
          allowedHosts: z.array(z.string()).min(1),
          authorizationEvidence: z.string().min(10),
        })
        .parse(body.config);
      validatePublicUrl(http.url);
      if (!http.allowedHosts.includes(new URL(http.url).hostname))
        throw new InputError("Domaine hors liste");
      if (["indeed", "linkedin"].includes(sourceFromUrl(http.url)))
        throw new InputError(
          "Utilisez les alertes et imports pour cette plateforme",
        );
    }
    const [old] = await query("SELECT * FROM connectors WHERE id=$1", [
      body.id,
    ]);
    if (old && ["import", "email"].includes(old.kind))
      throw new InputError("Identifiant reserve");
    const changed =
      old && JSON.stringify(old.config) !== JSON.stringify(body.config);
    if (
      body.auto_submit &&
      (body.kind !== "form" ||
        !body.authorized ||
        !old ||
        changed ||
        Number(old.cursor.supervisedRuns || 0) < 1)
    )
      throw new InputError("Preparation supervisee requise avant activation");
    await query(
      "INSERT INTO connectors(id,name,kind,enabled,authorized,auto_submit,config) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,enabled=excluded.enabled,authorized=excluded.authorized,auto_submit=excluded.auto_submit,config=excluded.config,cursor=CASE WHEN connectors.config<>excluded.config THEN '{}'::jsonb ELSE connectors.cursor END",
      [
        body.id,
        body.name,
        body.kind,
        body.enabled,
        body.authorized,
        body.auto_submit,
        JSON.stringify(body.config),
      ],
    );
    await event("connector.updated", body.id);
    await query("UPDATE connectors SET submission_mode=$2 WHERE id=$1", [
      body.id,
      body.submission_mode,
    ]);
    if (body.auto_submit)
      for (const job of await query(
        "SELECT id FROM jobs WHERE canonical_url=$1",
        [canonicalUrl(String(body.config.url))],
      ))
        await enqueue("process_job", { id: job.id }, `process:${job.id}`);
    return { ok: true };
  });
  app.post("/api/connectors/:id/toggle", async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const id = z
      .string()
      .max(60)
      .parse((req.params as any).id);
    await query(
      "UPDATE connectors SET enabled=$2,failures=0,last_error=NULL WHERE id=$1",
      [id, enabled],
    );
    return { ok: true };
  });
  app.post("/api/connectors/:id/collect", async (req) => {
    const id = z
      .string()
      .max(60)
      .parse((req.params as any).id);
    await enqueue("collect", { id }, `collect:${id}`);
    return { ok: true };
  });
  app.get("/api/applications", async () =>
    query(
      "SELECT a.*,j.data,e.score FROM applications a JOIN jobs j ON j.id=a.job_id LEFT JOIN LATERAL (SELECT score FROM evaluations WHERE job_id=j.id AND profile_id=(SELECT id FROM profiles ORDER BY version DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1)e ON true ORDER BY a.updated_at DESC",
    ),
  );
  app.get("/api/setup", setupStatus);
  app.post("/api/diagnostics/:integration", async (req) => {
    const integration = z
      .enum(["imap", "notifications", "ai"])
      .parse((req.params as any).integration);
    const key = z
      .string()
      .min(8)
      .max(120)
      .parse(req.headers["idempotency-key"]);
    return transaction(async (tx) => {
      const [op] = await query(
        "INSERT INTO operations(kind,idempotency_key,request_hash) VALUES('diagnostic',$1,$2) ON CONFLICT DO NOTHING RETURNING id",
        [key, hash(integration)],
        tx,
      );
      if (!op) {
        const [old] = await query(
          "SELECT * FROM operations WHERE idempotency_key=$1",
          [key],
          tx,
        );
        if (old.request_hash !== hash(integration))
          throw new ReviewError("Cle deja utilisee");
        return { id: old.id };
      }
      const [existing] = await query(
        "SELECT * FROM diagnostics WHERE integration=$1 FOR UPDATE",
        [integration],
        tx,
      );
      if (existing?.state === "queued")
        throw new ReviewError("Diagnostic deja en cours");
      await query(
        "INSERT INTO diagnostics(integration,state,message) VALUES($1,'queued','Test demande') ON CONFLICT(integration) DO UPDATE SET state='queued',message='Test demande',checked_at=now()",
        [integration],
        tx,
      );
      await enqueue(
        "diagnostic",
        { integration },
        `diagnostic:${integration}`,
        tx,
      );
      await event("diagnostic.requested", op.id, { integration }, tx);
      return op;
    });
  });
  app.get("/api/review", async () => {
    const apps = await query(
      "SELECT a.*,j.data FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.status='to_apply' ORDER BY a.updated_at DESC LIMIT 100",
    );
    return Promise.all(
      apps.map(async (a) => {
        const { evaluation } = await evaluate(a.job_id);
        const documents = await query(
          "SELECT id,kind,approved_at,viewed_at FROM documents WHERE (job_id=$1 OR (job_id IS NULL AND kind='cv')) AND profile_id=(SELECT id FROM profiles ORDER BY version DESC LIMIT 1) ORDER BY created_at DESC",
          [a.job_id],
        );
        return {
          ...a,
          evaluation,
          documents,
          eligibility: await submissionEligibility(a.id),
        };
      }),
    );
  });
  app.post("/api/batches", async (req) =>
    createBatch(
      batchSchema.parse(req.body),
      z.string().min(8).max(120).parse(req.headers["idempotency-key"]),
    ),
  );
  app.get("/api/operations", async () =>
    query(
      "SELECT o.*,coalesce(jsonb_agg(i.*) FILTER(WHERE i.id IS NOT NULL),'[]') items FROM operations o LEFT JOIN operation_items i ON i.operation_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 20",
    ),
  );
  app.get("/api/operations/:id", async (req) => {
    const id = uuid.parse((req.params as any).id);
    return {
      ...(await query("SELECT * FROM operations WHERE id=$1", [id]))[0],
      items: await query(
        "SELECT * FROM operation_items WHERE operation_id=$1",
        [id],
      ),
    };
  });
  app.post("/api/jobs/:id/enrich", async (req) => {
    const jobId = uuid.parse((req.params as any).id);
    const { connectorId } = z
      .object({ connectorId: z.string().min(1).max(60) })
      .parse(req.body);
    const key = z
      .string()
      .min(8)
      .max(120)
      .parse(req.headers["idempotency-key"]);
    return transaction(async (tx) => {
      const digest = hash([jobId, connectorId]);
      const [op] = await query(
        "INSERT INTO operations(kind,idempotency_key,request_hash) VALUES('enrich',$1,$2) ON CONFLICT DO NOTHING RETURNING *",
        [key, digest],
        tx,
      );
      if (!op) {
        const [old] = await query(
          "SELECT * FROM operations WHERE idempotency_key=$1",
          [key],
          tx,
        );
        if (old.request_hash !== digest)
          throw new ReviewError("Cle deja utilisee");
        return old;
      }
      const [item] = await query(
        "INSERT INTO operation_items(operation_id,job_id) VALUES($1,$2) RETURNING id",
        [op.id, jobId],
        tx,
      );
      await enqueue(
        "enrich_job",
        { itemId: item.id, jobId, connectorId },
        `enrich:${item.id}`,
        tx,
      );
      return op;
    });
  });
  app.post("/api/applications", async (req) => {
    const { jobId } = z.object({ jobId: uuid }).parse(req.body);
    return transaction(async (tx) => {
      const [job] = await query("SELECT id FROM jobs WHERE id=$1", [jobId], tx);
      if (!job) throw new InputError("Offre introuvable");
      const [row] = await query(
        "INSERT INTO applications(job_id) VALUES($1) ON CONFLICT(job_id) DO UPDATE SET job_id=excluded.job_id RETURNING *",
        [jobId],
        tx,
      );
      await event("application.tracked", row.id, {}, tx);
      return row;
    });
  });
  app.post("/api/applications/:id/status", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const { status } = z
      .object({
        status: z.enum([
          "to_apply",
          "applied",
          "interview",
          "rejected",
          "withdrawn",
        ]),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      const [a] = await query(
        "SELECT * FROM applications WHERE id=$1 FOR UPDATE",
        [id],
        tx,
      );
      if (!a) throw new InputError("Candidature introuvable");
      if (
        ["queued", "preparing", "submitting", "unknown"].includes(
          a.runner_state,
        )
      )
        throw new InputError(
          "Resoudre ou terminer la tentative avant de changer le statut",
        );
      if (status === "to_apply" && a.submitted_at)
        throw new InputError(
          "Une candidature envoyee ne peut revenir dans la file",
        );
      await query(
        "UPDATE applications SET status=$2,submitted_at=CASE WHEN $2 IN ('applied','interview') THEN coalesce(submitted_at,now()) ELSE submitted_at END,runner_state=CASE WHEN $2 IN ('applied','interview') THEN 'confirmed' ELSE runner_state END,updated_at=now() WHERE id=$1",
        [id, status],
        tx,
      );
      if (["applied", "interview"].includes(status))
        await query(
          "INSERT INTO reminders(application_id,due_at) VALUES($1,now()+($2||' days')::interval) ON CONFLICT DO NOTHING",
          [id, String((await settings(tx)).reminderDays)],
          tx,
        );
      await event("application.status", id, { status, manual: true }, tx);
    });
    return { ok: true };
  });
  app.post("/api/applications/:id/run", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const { mode, connectorId } = z
      .object({
        mode: z.enum(["prepare", "submit"]),
        connectorId: z.string().max(60),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      const [a] = await query(
        "SELECT a.*,j.canonical_url FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=$1 FOR UPDATE OF a",
        [id],
        tx,
      );
      if (
        !a ||
        a.status !== "to_apply" ||
        ["queued", "preparing", "submitting", "confirmed", "unknown"].includes(
          a.runner_state,
        )
      )
        throw new InputError("Tentative deja active ou candidature envoyee");
      if ((await settings(tx)).paused)
        throw new InputError("Arret global actif");
      const [c] = await query(
        "SELECT * FROM connectors WHERE id=$1",
        [connectorId],
        tx,
      );
      if (!c?.enabled || !c.authorized || c.kind !== "form")
        throw new InputError("Connecteur de formulaire autorise requis");
      const form = formSchema.parse(c.config);
      if (canonicalUrl(form.url) !== a.canonical_url)
        throw new InputError("Le formulaire doit correspondre a cette offre");
      await query(
        "UPDATE applications SET connector_id=$2 WHERE id=$1",
        [id, connectorId],
        tx,
      );
      if (mode === "submit") {
        if (a.runner_state !== "ready")
          throw new ReviewError("Preparation supervisee requise");
        const gate = await automationGate(id, tx, false);
        await query(
          "INSERT INTO submission_approvals(application_id,snapshot,expires_at) VALUES($1,$2,now()+interval '24 hours') ON CONFLICT(application_id) DO UPDATE SET snapshot=excluded.snapshot,expires_at=excluded.expires_at,consumed_at=NULL",
          [id, JSON.stringify(gate.snapshot)],
          tx,
        );
      }
      await query(
        "UPDATE applications SET runner_state='queued',updated_at=now() WHERE id=$1",
        [id],
        tx,
      );
      await enqueue("run_application", { id, mode }, `run:${id}`, tx);
      await event("application.queued", id, { mode }, tx);
    });
    return { ok: true };
  });
  app.post("/api/applications/:id/resolve", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z
      .object({
        submitted: z.boolean(),
        evidence: z.string().min(10).max(2000),
      })
      .parse(req.body);
    await transaction(async (tx) => {
      const [a] = await query(
        "SELECT * FROM applications WHERE id=$1 FOR UPDATE",
        [id],
        tx,
      );
      if (a?.runner_state !== "unknown")
        throw new InputError("Seul un resultat incertain peut etre resolu");
      await query(
        "UPDATE applications SET runner_state=$2,status=$3,submitted_at=CASE WHEN $4 THEN now() ELSE submitted_at END,last_error=NULL,updated_at=now() WHERE id=$1",
        [
          id,
          body.submitted ? "confirmed" : "needs_review",
          body.submitted ? "applied" : "to_apply",
          body.submitted,
        ],
        tx,
      );
      if (body.submitted)
        await query(
          "INSERT INTO reminders(application_id,due_at) VALUES($1,now()+($2||' days')::interval) ON CONFLICT DO NOTHING",
          [id, String((await settings(tx)).reminderDays)],
          tx,
        );
      await event("application.resolved", id, body, tx);
    });
    return { ok: true };
  });
  app.get("/api/applications/:id/attempts", async (req) =>
    query(
      "SELECT * FROM application_attempts WHERE application_id=$1 ORDER BY created_at DESC",
      [uuid.parse((req.params as any).id)],
    ),
  );
  app.get("/api/attempts/:id/evidence", async (req, reply) => {
    const id = uuid.parse((req.params as any).id);
    if (!existsSync(evidencePath(id)))
      throw new InputError("Preuve visuelle indisponible ou expiree");
    return reply.type("image/png").send(createReadStream(evidencePath(id)));
  });
  app.get("/api/documents", async () =>
    db
      .select({
        id: documentTable.id,
        jobId: documentTable.jobId,
        profileId: documentTable.profileId,
        kind: documentTable.kind,
        content: documentTable.content,
        approvedAt: documentTable.approvedAt,
        createdAt: documentTable.createdAt,
      })
      .from(documentTable)
      .orderBy(desc(documentTable.createdAt)),
  );
  app.post("/api/documents", async (req) => {
    if ((await settings()).paused) throw new InputError("Arret global actif");
    const body = z
      .object({
        jobId: uuid.nullable().default(null),
        kind: z.enum(["cv", "letter"]),
      })
      .parse(req.body);
    await enqueue(
      "document",
      body,
      `document:${body.jobId || "master"}:${body.kind}`,
    );
    return { ok: true };
  });
  app.get("/api/documents/:id/download", async (req, reply) => {
    const [d] = await query("SELECT * FROM documents WHERE id=$1", [
      uuid.parse((req.params as any).id),
    ]);
    if (!d || !existsSync(d.path))
      throw new InputError("Document indisponible");
    await query("UPDATE documents SET viewed_at=now() WHERE id=$1", [d.id]);
    reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="${d.kind}-${d.id}.pdf"`,
      );
    return reply.send(createReadStream(d.path));
  });
  app.post("/api/documents/:id/approve", async (req) => {
    const id = uuid.parse((req.params as any).id);
    const { approved } = z.object({ approved: z.boolean() }).parse(req.body);
    const [d] = await query("SELECT * FROM documents WHERE id=$1", [id]);
    if (!d || !existsSync(d.path)) throw new InputError("Document introuvable");
    if (d.profile_id !== (await currentProfile()).id)
      throw new InputError("Document issu dun ancien profil");
    if (approved && !d.viewed_at)
      throw new InputError("Consultez le PDF avant de l'approuver");
    if (approved && d.job_id) {
      const [job] = await query("SELECT data FROM jobs WHERE id=$1", [
        d.job_id,
      ]);
      if (d.content.jobHash !== hash(job.data))
        throw new InputError("Document issu d'une ancienne offre");
    }
    await query(
      "UPDATE documents SET approved_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1",
      [id, approved],
    );
    await event("document.approved", id, { approved });
    if (approved)
      for (const job of await query(
        d.job_id
          ? "SELECT id FROM jobs WHERE id=$1"
          : "SELECT id FROM jobs WHERE state<>'ignored'",
        d.job_id ? [d.job_id] : [],
      ))
        await enqueue("process_job", { id: job.id }, `process:${job.id}`);
    return { ok: true };
  });
  app.post("/api/reminders/:id/dismiss", async (req) => {
    await query("UPDATE reminders SET dismissed_at=now() WHERE id=$1", [
      uuid.parse((req.params as any).id),
    ]);
    return { ok: true };
  });
  app.get("/api/notifications", async () =>
    query("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50"),
  );
  if (existsSync(resolve("dist/web"))) {
    await app.register(staticPlugin, { root: resolve("dist/web") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Route inconnue" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
if (process.argv[1] && resolve(process.argv[1]) === resolve("src/server.ts")) {
  await migrate();
  const app = await createServer();
  await app.listen({ host: config.host, port: config.port });
  const stop = async () => {
    await app.close();
    await pool.end();
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
