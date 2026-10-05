import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
async function freePort(preferred: number) {
  return new Promise<number>((done, reject) => {
    const s = createServer();
    s.once("error", () => {
      const alternate = createServer();
      alternate.listen(0, "127.0.0.1", () => {
        const port = (alternate.address() as any).port;
        alternate.close(() => done(port));
      });
      alternate.on("error", reject);
    });
    s.listen(preferred, "127.0.0.1", () => s.close(() => done(preferred)));
  });
}
const port = await freePort(5173),
  apiPort = await freePort(3001),
  dbPort = await freePort(55432);
let postgres: EmbeddedPostgres | undefined;
if (!process.env.DATABASE_URL) {
  const directory = resolve(".local/postgres");
  postgres = new EmbeddedPostgres({
    databaseDir: directory,
    user: "job",
    password: "localdev",
    port: dbPort,
    persistent: true,
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  });
  if (!existsSync(resolve(directory, "PG_VERSION")))
    await postgres.initialise();
  await postgres.start();
  const c = postgres.getPgClient();
  await c.connect();
  const { rows } = await c.query(
    "SELECT 1 FROM pg_database WHERE datname='jobs'",
  );
  await c.end();
  if (!rows.length) await postgres.createDatabase("jobs");
  process.env.DATABASE_URL = `postgres://job:localdev@127.0.0.1:${dbPort}/jobs`;
}
process.env.PORT = String(apiPort);
process.env.APP_ORIGIN = `http://127.0.0.1:${port}`;
const { migrate } = await import("../src/migrate.js");
await migrate();
const { pool } = await import("../src/db.js");
await pool.end();
const children = [
  spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(process.execPath, ["--import", "tsx", "src/runner-main.ts"], {
    stdio: "inherit",
    env: process.env,
  }),
  spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    },
  ),
];
console.log(
  `\nPoste: http://127.0.0.1:${port}\nLocal login: APP_PASSWORD from .env, or local-development-only\n`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill("SIGTERM"));
  await new Promise((r) => setTimeout(r, 1500));
  await postgres?.stop();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
for (const child of children)
  child.on("exit", (code) => {
    if (!stopping && code !== 0) void stop();
  });
