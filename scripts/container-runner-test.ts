import assert from "node:assert/strict";
import { createServer } from "node:http";
import { query, pool } from "../src/db.js";
import { ingest } from "../src/store.js";
import { runApplication } from "../src/runner.js";
import { createBatch, submissionEligibility } from "../src/operations.js";
import { jobSchema } from "../src/domain.js";
let submits = 0;
let uploads = 0;
const fixture = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.method === "POST") {
    submits++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (Buffer.concat(chunks).includes(Buffer.from("%PDF-"))) uploads++;
      res.end("<h1>CI application confirmed</h1>");
    });
  } else
    res.end(
      '<form method="post" enctype="multipart/form-data"><label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label><label>CV<input name="cv" type="file" required></label><button>Submit</button></form>',
    );
});
await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
try {
  const url = `http://127.0.0.1:${(fixture.address() as any).port}/form`;
  const job = await ingest(
    jobSchema.parse({
      title: "Developer",
      company: "CI",
      location: "Paris",
      contract: "CDI",
      remote: "hybrid",
      seniority: "mid",
      skills: ["TypeScript"],
      description: "TypeScript project",
      salary: { min: 55000, period: "year", basis: "gross", currency: "EUR" },
      source: "manual",
      url,
    }),
  );
  await query(
    "INSERT INTO connectors(id,name,kind,enabled,authorized,config) VALUES('ci-form','CI form','form',true,true,$1)",
    [
      JSON.stringify({
        url,
        allowedHosts: ["127.0.0.1"],
        authorizationEvidence: "Owned CI fixture",
        fields: [
          { label: "Name", profileKey: "name" },
          { label: "Email", profileKey: "email" },
        ],
        cvLabel: "CV",
        submitLabel: "Submit",
        confirmationText: "CI application confirmed",
      }),
    ],
  );
  const [a] = await query(
    "INSERT INTO applications(job_id,connector_id) VALUES($1,'ci-form') RETURNING id",
    [job.id],
  );
  await query("UPDATE documents SET approved_at=now() WHERE job_id IS NULL");
  await runApplication(a.id, "prepare", { testLocal: true });
  assert.equal(submits, 0);
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [a.id])
    )[0].runner_state,
    "ready",
  );
  await query("UPDATE connectors SET auto_submit=true WHERE id='ci-form'");
  const op = await createBatch(
    {
      action: "submit",
      applicationIds: [a.id],
      reviewTokens: {
        [a.id]: (await submissionEligibility(a.id)).reviewToken!,
      },
    },
    "ci-submission-key",
  );
  assert.equal(
    (
      await query("SELECT state FROM operation_items WHERE operation_id=$1", [
        op.id,
      ])
    )[0].state,
    "queued",
  );
  // Prevent the normal worker from racing this test-only local runner.
  await query("SELECT graphile_worker.remove_job($1)", [`run:${a.id}`]);
  await runApplication(a.id, "submit", { testLocal: true });
  assert.equal(submits, 1);
  assert.equal(uploads, 1);
  assert.equal(
    (
      await query("SELECT runner_state FROM applications WHERE id=$1", [a.id])
    )[0].runner_state,
    "confirmed",
  );
  console.log(
    "Controlled container runner passed: upload, prepare, approval, identifiable confirmation",
  );
} finally {
  await new Promise<void>((r) => fixture.close(() => r()));
  await pool.end();
}
