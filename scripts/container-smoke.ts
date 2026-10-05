import assert from "node:assert/strict";
import { query, pool } from "../src/db.js";
import { config } from "../src/config.js";
const root = "http://127.0.0.1:3001/api";
const login = await fetch(`${root}/login`, {
  method: "POST",
  headers: { Origin: config.origin, "Content-Type": "application/json" },
  body: JSON.stringify({ password: config.password }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
async function api(path: string, body?: unknown) {
  const r = await fetch(`${root}${path}`, {
    headers: {
      Cookie: cookie,
      Origin: config.origin,
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r;
}
if (!process.argv.includes("--persisted")) {
  await api("/profile", {
    name: "CI Candidate",
    email: "ci@example.com",
    roles: ["Developer"],
    skills: ["TypeScript"],
    locations: ["Paris"],
    seniority: "mid",
    facts: [{ id: "ci", text: "TypeScript project" }],
    validated: true,
  });
  await api("/import", {
    format: "json",
    items: [
      {
        title: "CI Developer",
        company: "CI",
        url: "https://example.com/ci-poste",
        source: "manual",
        description: "TypeScript project",
        skills: ["TypeScript"],
      },
    ],
  });
  await api("/documents", { kind: "cv", jobId: null });
}
let docs: any[] = [];
for (let i = 0; i < 60; i++) {
  docs = await (await api("/documents")).json();
  if (docs.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert(docs.length);
const pdf = await api(`/documents/${docs[0].id}/download`);
assert(
  Buffer.from(await pdf.arrayBuffer())
    .subarray(0, 5)
    .toString() === "%PDF-",
);
assert(
  (
    await query(
      "SELECT id FROM jobs WHERE canonical_url='https://example.com/ci-poste'",
    )
  ).length,
);
assert.equal(
  (
    await query(
      "SELECT * FROM heartbeats WHERE last_seen_at>now()-interval '2 minutes' AND service IN ('worker','runner')",
    )
  ).length,
  2,
);
console.log(
  "Container smoke passed: auth, migration, worker PDF, runner heartbeat and persistent offer",
);
await pool.end();
