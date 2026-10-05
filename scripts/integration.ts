import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createServer as netServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
await mkdir(resolve(".local"), { recursive: true });
const root = await mkdtemp(resolve(".local/integration-"));
const port = await new Promise<number>((done) => {
  const s = netServer();
  s.listen(0, "127.0.0.1", () => {
    const p = (s.address() as any).port;
    s.close(() => done(p));
  });
});
const postgres = new EmbeddedPostgres({
  databaseDir: join(root, "postgres"),
  user: "test",
  password: "test-password",
  port,
  persistent: true,
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `postgres://test:test-password@127.0.0.1:${port}/jobs`;
process.env.APP_ORIGIN = "http://127.0.0.1:5173";
process.env.APP_PASSWORD = "local-development-only";
process.env.DATA_DIR = join(root, "documents");
process.env.SESSIONS_DIR = join(root, "sessions");
for (const name of [
  "AI_API_KEY",
  "DISCORD_WEBHOOK_URL",
  "SLACK_WEBHOOK_URL",
  "TELEGRAM_BOT_TOKEN",
  "IMAP_PASSWORD",
]) {
  process.env[name] = "";
  process.env[`${name}_FILE`] = "";
}
process.env.DATABASE_URL_FILE = "";
process.env.APP_PASSWORD_FILE = "";
await postgres.initialise();
await postgres.start();
await postgres.createDatabase("jobs");
const { migrate } = await import("../src/migrate.js");
const { pool, query } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { ingest, evaluate } = await import("../src/store.js");
const { jobSchema, profileSchema } = await import("../src/domain.js");
const { queueNotification, deliverNotification } =
  await import("../src/notifications.js");
const { generateDocument } = await import("../src/documents.js");
const { automationGate, runApplication } = await import("../src/runner.js");
let app: Awaited<ReturnType<typeof createServer>> | undefined;
let fixture: ReturnType<typeof httpServer> | undefined;
try {
  await migrate();
  await migrate();
  app = await createServer();
  await app.ready();
  const base = jobSchema.parse({
    title: "Developpeur TypeScript",
    company: "Atelier Test",
    location: "Paris",
    url: "https://example.com/jobs/integration",
    description:
      "TypeScript React PostgreSQL Docker. Une annonce complete suffisamment longue pour etablir une concordance forte entre deux sources, sans effacer les republications.",
    contract: "CDI",
    remote: "hybrid",
    seniority: "senior",
    salary: { min: 55000, max: 65000, period: "year", basis: "gross" },
  });
  const profile = profileSchema.parse({
    name: "Camille Test",
    email: "camille@example.test",
    skills: ["TypeScript", "React"],
    roles: ["Developpeur"],
    locations: ["Paris"],
    seniority: "senior",
    validated: true,
    facts: [
      {
        id: "experience-1",
        category: "experience",
        text: "Creation d un outil TypeScript personnel.",
      },
    ],
  });
  await query("UPDATE profiles SET data=$1", [JSON.stringify(profile)]);
  const imports = await Promise.all(
    Array.from({ length: 5 }, () => ingest(base)),
  );
  assert.equal(imports.filter((i) => i.created).length, 1);
  const id = imports[0].id;
  assert.equal((await query("SELECT count(*) n FROM jobs"))[0].n, "1");
  assert.equal((await query("SELECT count(*) n FROM source_items"))[0].n, "1");
  const other = await ingest({
    ...base,
    url: "https://example.org/jobs/integration",
    source: "career",
  });
  assert.equal(other.created, false);
  assert.equal(other.id, id);
  await ingest({
    ...base,
    description: base.description + " Revision de la description.",
  });
  assert.equal((await query("SELECT count(*) n FROM jobs"))[0].n, "1");
  assert.equal((await query("SELECT count(*) n FROM source_items"))[0].n, "3");
  assert.equal((await evaluate(id)).evaluation.score, 100);
  await Promise.all([
    queueNotification(`test:${id}`, "Test", id),
    queueNotification(`test:${id}`, "Test", id),
  ]);
  assert.equal((await query("SELECT count(*) n FROM notifications"))[0].n, "1");
  const [notification] = await query("SELECT id FROM notifications");
  await deliverNotification(notification.id);
  assert.equal(
    (await query("SELECT state FROM notifications"))[0].state,
    "disabled",
  );
  const cv = await generateDocument(id, "cv");
  const [doc] = await query("SELECT * FROM documents WHERE id=$1", [cv]);
  assert((await readFile(doc.path)).subarray(0, 4).toString() === "%PDF");
  assert.deepEqual(doc.content.facts, profile.facts);
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({
    data: new Uint8Array(await readFile(doc.path)),
    useSystemFonts: true,
  });
  const pdf = await loading.promise;
  const pdfPage = await pdf.getPage(1);
  const extracted = (await pdfPage.getTextContent()).items
    .map((item: any) => item.str)
    .join(" ");
  assert(extracted.includes(profile.name));
  assert(extracted.includes(profile.facts[0].text));
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = pdfPage.getViewport({ scale: 1.4 });
  const canvas = createCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  await pdfPage.render({
    canvas: canvas as any,
    canvasContext: canvas.getContext("2d") as any,
    viewport,
  }).promise;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "cv-preview.png"), canvas.toBuffer("image/png"));
  await loading.destroy();
  console.log(`PDF visual proof: ${join(root, "cv-preview.png")}`);
  const unauth = await app.inject({ method: "GET", url: "/api/jobs" });
  assert.equal(unauth.statusCode, 401);
  const badOrigin = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: "https://evil.example" },
    payload: { password: "local-development-only" },
  });
  assert.equal(badOrigin.statusCode, 403);
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    headers: { origin: process.env.APP_ORIGIN },
    payload: { password: "local-development-only" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies[0];
  const headers = {
    origin: process.env.APP_ORIGIN,
    cookie: `${cookie.name}=${cookie.value}`,
  };
  const setup = await app.inject({ method: "GET", url: "/api/setup", headers });
  assert.equal(setup.statusCode, 200);
  assert.equal(setup.json().configured.imap, false);
  assert(!setup.body.includes("test-password"));
  const unviewedApproval = await app.inject({
    method: "POST",
    url: `/api/documents/${cv}/approve`,
    headers,
    payload: { approved: true },
  });
  assert.equal(unviewedApproval.statusCode, 409);
  const viewedPdf = await app.inject({
    method: "GET",
    url: `/api/documents/${cv}/download`,
    headers,
  });
  assert.equal(viewedPdf.statusCode, 200);
  const viewedApproval = await app.inject({
    method: "POST",
    url: `/api/documents/${cv}/approve`,
    headers,
    payload: { approved: true },
  });
  assert.equal(viewedApproval.statusCode, 200);
  const diagnostic = await app.inject({
    method: "POST",
    url: "/api/diagnostics/imap",
    headers: { ...headers, "idempotency-key": "integration-diagnostic" },
    payload: {},
  });
  assert.equal(diagnostic.statusCode, 200);
  const repeatedDiagnostic = await app.inject({
    method: "POST",
    url: "/api/diagnostics/imap",
    headers: { ...headers, "idempotency-key": "integration-diagnostic" },
    payload: {},
  });
  assert.equal(repeatedDiagnostic.json().id, diagnostic.json().id);
  const { runDiagnostic } = await import("../src/diagnostics.js");
  await runDiagnostic("imap");
  assert.equal(
    (await query("SELECT state FROM diagnostics WHERE integration='imap'"))[0]
      .state,
    "failed",
  );
  const list = await app.inject({ method: "GET", url: "/api/jobs", headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  const tracked = await app.inject({
    method: "POST",
    url: "/api/applications",
    headers,
    payload: { jobId: id },
  });
  assert.equal(tracked.statusCode, 200);
  const aid = tracked.json().id;
  await query("UPDATE applications SET runner_state='unknown' WHERE id=$1", [
    aid,
  ]);
  const rerun = await app.inject({
    method: "POST",
    url: `/api/applications/${aid}/run`,
    headers,
    payload: { mode: "submit", connectorId: "manual" },
  });
  assert.equal(rerun.statusCode, 409);
  const bypass = await app.inject({
    method: "POST",
    url: `/api/applications/${aid}/status`,
    headers,
    payload: { status: "applied" },
  });
  assert.equal(bypass.statusCode, 409);
  const resolveResponse = await app.inject({
    method: "POST",
    url: `/api/applications/${aid}/resolve`,
    headers,
    payload: {
      submitted: true,
      evidence: "Confirmation verifiee sur le compte test",
    },
  });
  assert.equal(resolveResponse.statusCode, 200);
  assert.equal((await query("SELECT count(*) n FROM reminders"))[0].n, "1");
  const reset = await app.inject({
    method: "POST",
    url: `/api/applications/${aid}/status`,
    headers,
    payload: { status: "to_apply" },
  });
  assert.equal(reset.statusCode, 409);
  await assert.rejects(() => automationGate(aid), /deja envoyee/);
  const forbidden = await app.inject({
    method: "POST",
    url: "/api/connectors",
    headers,
    payload: {
      id: "linkedin-scraper",
      name: "Forbidden",
      kind: "html",
      enabled: true,
      authorized: true,
      config: {
        url: "https://www.linkedin.com/jobs/view/1",
        allowedHosts: ["www.linkedin.com"],
        authorizationEvidence: "test evidence",
      },
    },
  });
  assert.equal(forbidden.statusCode, 409);
  const stale = await app.inject({
    method: "POST",
    url: "/api/profile",
    headers,
    payload: profile,
  });
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json().version, 2);
  const approve = await app.inject({
    method: "POST",
    url: `/api/documents/${cv}/approve`,
    headers,
    payload: { approved: true },
  });
  assert.equal(approve.statusCode, 409);
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  assert.equal((await c.query("SELECT count(*) n FROM jobs")).rows[0].n, "1");
  await c.end();
  let submits = 0;
  fixture = httpServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.method === "POST") {
      submits++;
      res.end(
        req.url?.includes("unknown")
          ? "<h1>Merci</h1>"
          : "<h1>Candidature confirmee</h1>",
      );
      return;
    }
    res.end(
      `<form method="post" enctype="multipart/form-data" action="/submit${req.url}"><label>Nom complet<input name="name" required></label><label>Email<input type="email" name="email" required></label><label>CV<input type="file" name="cv" required></label><button>Postuler</button></form>`,
    );
  });
  await new Promise<void>((done) => fixture!.listen(0, "127.0.0.1", done));
  const fixturePort = (fixture.address() as any).port;
  const master = await generateDocument(null, "cv");
  await query("UPDATE documents SET approved_at=now(),viewed_at=now() WHERE id=$1", [master]);
  async function localApplication(flow: string) {
    const url = `http://127.0.0.1:${fixturePort}/job/${flow}`;
    const imported = await ingest({
      ...base,
      url,
      description: base.description + ` Flow ${flow}.`,
    });
    const connectorId = `local-${flow}`;
    const form = {
      url,
      allowedHosts: ["127.0.0.1"],
      authorizationEvidence: "Owned local integration form",
      fields: [
        { label: "Nom complet", profileKey: "name" },
        { label: "Email", profileKey: "email" },
      ],
      cvLabel: "CV",
      submitLabel: "Postuler",
      confirmationText: "Candidature confirmee",
    };
    await query(
      "INSERT INTO connectors(id,name,kind,enabled,authorized,config) VALUES($1,$1,'form',true,true,$2)",
      [connectorId, JSON.stringify(form)],
    );
    const [a] = await query(
      "INSERT INTO applications(job_id,connector_id) VALUES($1,$2) RETURNING *",
      [imported.id, connectorId],
    );
    return a;
  }
  const confirmed = await localApplication("confirmed");
  await runApplication(confirmed.id, "prepare", { testLocal: true });
  assert.equal(submits, 0);
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [
        confirmed.id,
      ])
    )[0].runner_state,
    "ready",
  );
  await query(
    "UPDATE connectors SET auto_submit=true,submission_mode='automatic' WHERE id=$1",
    [confirmed.connector_id],
  );
  const { tasks } = await import("../src/tasks.js");
  await tasks.process_job({ id: confirmed.job_id });
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [
        confirmed.id,
      ])
    )[0].runner_state,
    "queued",
  );
  await tasks.process_job({ id: confirmed.job_id });
  assert.equal(
    (
      await query("SELECT count(*) n FROM applications WHERE job_id=$1", [
        confirmed.job_id,
      ])
    )[0].n,
    "1",
  );
  await runApplication(confirmed.id, "submit", { testLocal: true });
  assert.equal(submits, 1);
  assert.equal(
    (
      await query("SELECT status FROM applications WHERE id=$1", [confirmed.id])
    )[0].status,
    "applied",
  );
  const uncertain = await localApplication("unknown");
  await runApplication(uncertain.id, "prepare", { testLocal: true });
  await query("UPDATE connectors SET auto_submit=true WHERE id=$1", [
    uncertain.connector_id,
  ]);
  await query("UPDATE settings SET data=jsonb_set(data,'{dailyLimit}','1')");
  await assert.rejects(() => automationGate(uncertain.id), /Plafond/);
  await query("UPDATE settings SET data=jsonb_set(data,'{dailyLimit}','5')");
  const { createBatch, submissionEligibility } =
    await import("../src/operations.js");
  const reviewTokens = {
    [uncertain.id]: (await submissionEligibility(uncertain.id)).reviewToken!,
  };
  await assert.rejects(() => automationGate(uncertain.id), /Approbation/);
  const batch = await createBatch(
    {
      action: "submit",
      applicationIds: [uncertain.id, confirmed.id],
      reviewTokens,
    },
    "integration-batch-submit",
  );
  assert.equal(
    (
      await createBatch(
        {
          action: "submit",
          applicationIds: [uncertain.id, confirmed.id],
          reviewTokens,
        },
        "integration-batch-submit",
      )
    ).id,
    batch.id,
  );
  assert.equal(
    (
      await query(
        "SELECT count(*) n FROM operation_items WHERE operation_id=$1",
        [batch.id],
      )
    )[0].n,
    "2",
  );
  assert.equal(
    (
      await query(
        "SELECT count(*) n FROM operation_items WHERE operation_id=$1 AND state='excluded'",
        [batch.id],
      )
    )[0].n,
    "1",
  );
  await assert.rejects(
    () =>
      createBatch(
        { action: "cv", applicationIds: [uncertain.id] },
        "integration-batch-submit",
      ),
    /idempotence/,
  );
  await query(
    "UPDATE submission_approvals SET expires_at=now()-interval '1 second' WHERE application_id=$1",
    [uncertain.id],
  );
  await assert.rejects(() => automationGate(uncertain.id), /Approbation/);
  await query(
    "UPDATE submission_approvals SET expires_at=now()+interval '24 hours' WHERE application_id=$1",
    [uncertain.id],
  );
  await automationGate(uncertain.id);
  await runApplication(uncertain.id, "submit", { testLocal: true });
  assert.equal(submits, 2);
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [
        uncertain.id,
      ])
    )[0].runner_state,
    "unknown",
  );
  await runApplication(uncertain.id, "submit", { testLocal: true });
  assert.equal(submits, 2);
  const crashed = await localApplication("crashed");
  const changed = await localApplication("changed");
  await runApplication(changed.id, "prepare", { testLocal: true });
  await query("UPDATE connectors SET auto_submit=true WHERE id=$1", [
    changed.connector_id,
  ]);
  const changedReviewToken = (await submissionEligibility(changed.id))
    .reviewToken!;
  await createBatch(
    {
      action: "submit",
      applicationIds: [changed.id],
      reviewTokens: {
        [changed.id]: changedReviewToken,
      },
    },
    "integration-changed-approval",
  );
  await query(
    "UPDATE jobs SET data=jsonb_set(data,'{description}',to_jsonb((data->>'description') || ' Updated')) WHERE id=$1",
    [changed.job_id],
  );
  assert.equal(
    (
      await query(
        "SELECT count(*) n FROM submission_approvals WHERE application_id=$1",
        [changed.id],
      )
    )[0].n,
    "0",
  );
  await assert.rejects(() => automationGate(changed.id), /Approbation/);
  await query("UPDATE applications SET runner_state='ready' WHERE id=$1", [
    changed.id,
  ]);
  const staleReviewBatch = await createBatch(
    {
      action: "submit",
      applicationIds: [changed.id],
      reviewTokens: { [changed.id]: changedReviewToken },
    },
    "integration-stale-review",
  );
  assert.equal(
    (
      await query("SELECT state FROM operation_items WHERE operation_id=$1", [
        staleReviewBatch.id,
      ])
    )[0].state,
    "excluded",
  );
  await query(
    "UPDATE applications SET runner_state='needs_review' WHERE id=$1",
    [changed.id],
  );
  const { enrichJob } = await import("../src/operations.js");
  const targeted = await generateDocument(id, "cv");
  await query(
    "UPDATE documents SET approved_at=now(),viewed_at=now() WHERE id=$1",
    [targeted],
  );
  await query(
    "INSERT INTO connectors(id,name,kind,enabled,authorized,config) VALUES('enrichment-fixture','Owned enrichment','html',true,true,$1)",
    [
      JSON.stringify({
        url: base.url,
        allowedHosts: ["example.com"],
        authorizationEvidence: "Owned enrichment fixture",
      }),
    ],
  );
  const [enrichOp] = await query(
    "INSERT INTO operations(kind,idempotency_key,request_hash) VALUES('enrich','integration-enrich','fixture') RETURNING id",
  );
  const [enrichItem] = await query(
    "INSERT INTO operation_items(operation_id,job_id) VALUES($1,$2) RETURNING id",
    [enrichOp.id, id],
  );
  const enrichmentHtml = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: base.title, url: base.url, hiringOrganization: { name: base.company }, description: `${base.description} Enriched description with additional verified responsibilities and complete context.` })}</script>`;
  await enrichJob(
    { itemId: enrichItem.id, jobId: id, connectorId: "enrichment-fixture" },
    async () => ({
      text: enrichmentHtml,
      url: base.url,
      headers: new Headers(),
    }),
  );
  assert.equal(
    (
      await query("SELECT state FROM operation_items WHERE id=$1", [
        enrichItem.id,
      ])
    )[0].state,
    "completed",
  );
  assert.equal(
    (
      await query("SELECT approved_at FROM documents WHERE id=$1", [targeted])
    )[0].approved_at,
    null,
  );
  assert.equal(
    (
      await query("SELECT count(*) n FROM jobs WHERE canonical_url=$1", [
        base.url,
      ])
    )[0].n,
    "1",
  );
  for (let n = 0; n < 3; n++) {
    await query(
      "UPDATE connectors SET cursor=cursor - 'nextAllowed' WHERE id='enrichment-fixture'",
    );
    const [failureItem] = await query(
      "INSERT INTO operation_items(operation_id,job_id) VALUES($1,$2) RETURNING id",
      [enrichOp.id, id],
    );
    await enrichJob(
      { itemId: failureItem.id, jobId: id, connectorId: "enrichment-fixture" },
      async () => ({
        text: "<html>Changed DOM</html>",
        url: base.url,
        headers: new Headers(),
      }),
    );
    assert.equal(
      (
        await query("SELECT state FROM operation_items WHERE id=$1", [
          failureItem.id,
        ])
      )[0].state,
      "failed",
    );
  }
  assert.equal(
    (
      await query(
        "SELECT enabled FROM connectors WHERE id='enrichment-fixture'",
      )
    )[0].enabled,
    false,
  );
  assert.equal(
    (await query("SELECT enabled FROM connectors WHERE id='manual'"))[0]
      .enabled,
    true,
  );
  await query(
    "UPDATE applications SET runner_state='submitting',updated_at=now()-interval '11 minutes' WHERE id=$1",
    [crashed.id],
  );
  await tasks.tick();
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [
        crashed.id,
      ])
    )[0].runner_state,
    "unknown",
  );
  const expectedJobs = (await query("SELECT count(*) n FROM jobs"))[0].n,
    initialDocs = (await query("SELECT count(*) n FROM documents"))[0].n;
  const { config } = await import("../src/config.js");
  const { callAI } = await import("../src/ai.js");
  config.aiKey = "fixture";
  config.aiModel = "fixture-model";
  await query(
    'UPDATE settings SET data=data || \'{"aiEnabled":true,"aiBudget":0.05}\'::jsonb',
  );
  let aiCalls = 0;
  const stub = async () => {
    aiCalls++;
    return {
      text: JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                factIds: ["experience-1"],
                opening: "Invented degree must never be used",
              }),
            },
          },
        ],
      }),
      headers: new Headers(),
      url: "https://example.com",
    };
  };
  const concurrent = await Promise.allSettled([
    callAI("budget-test", "Test", {}, stub),
    callAI("budget-test", "Test", {}, stub),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(aiCalls, 1);
  await assert.rejects(() => callAI("over-budget", "Test", {}, stub), /Budget/);
  await query("UPDATE settings SET data=jsonb_set(data,'{aiBudget}','1')");
  const letter = await generateDocument(id, "letter", stub);
  const [letterDoc] = await query("SELECT * FROM documents WHERE id=$1", [
    letter,
  ]);
  assert.deepEqual(letterDoc.content.facts, profile.facts);
  assert(!letterDoc.content.opening.includes("Invented degree"));
  assert.equal(await generateDocument(id, "letter", stub), letter);
  assert.equal(aiCalls, 2);
  const expectedDocs = String(Number(initialDocs) + 1);
  await query("UPDATE settings SET data=jsonb_set(data,'{aiEnabled}','false')");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const run = promisify(execFile);
  const dump = join(root, "database.dump");
  const binary = (name: string) =>
    process.env.PG_BIN
      ? join(process.env.PG_BIN, `${name}${suffix}`)
      : `${name}${suffix}`;
  await run(
    binary("pg_dump"),
    [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "test",
      "-d",
      "jobs",
      "-Fc",
      "-f",
      dump,
    ],
    { env: { ...process.env, PGPASSWORD: "test-password" } },
  );
  await postgres.createDatabase("restored");
  await run(
    binary("pg_restore"),
    [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "test",
      "-d",
      "restored",
      dump,
    ],
    { env: { ...process.env, PGPASSWORD: "test-password" } },
  );
  const restored = new pg.Client({
    connectionString: process.env.DATABASE_URL!.replace("/jobs", "/restored"),
  });
  await restored.connect();
  assert.equal(
    (await restored.query("SELECT count(*) n FROM jobs")).rows[0].n,
    expectedJobs,
  );
  assert.equal(
    (await restored.query("SELECT count(*) n FROM documents")).rows[0].n,
    expectedDocs,
  );
  await restored.end();
  console.log(
    "Integration passed: concurrent replay, cross-source dedup, revisions, notifications, PDF/text, authentication/CSRF, uncertain-send lock, profile versions, reminders, automatic queue, supervised runner, daily cap, post-submit timeout without retry, crash recovery, AI budget/cache, factual letters, PostgreSQL dump/restore.",
  );
} finally {
  if (fixture) await new Promise<void>((done) => fixture!.close(() => done()));
  await app?.close();
  await pool.end();
  await postgres.stop();
}
