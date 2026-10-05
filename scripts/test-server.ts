import EmbeddedPostgres from "embedded-postgres";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer as netServer } from "node:net";
await mkdir(resolve(".local"), { recursive: true });
const root = await mkdtemp(resolve(".local/e2e-"));
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
process.env.APP_ORIGIN = "http://127.0.0.1:8787";
process.env.APP_PASSWORD = "local-development-only";
process.env.DATA_DIR = join(root, "documents");
process.env.SESSIONS_DIR = join(root, "sessions");
// Tests never inherit external service credentials.
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
await migrate();
const { createServer } = await import("../src/server.js");
const { pool } = await import("../src/db.js");
const { taskList } = await import("../src/tasks.js");
const { run } = await import("graphile-worker");
const app = await createServer();
await app.listen({ host: "127.0.0.1", port: 8787 });
const worker = await run({
  connectionString: process.env.DATABASE_URL,
  taskList,
  concurrency: 2,
  pollInterval: 100,
});
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await worker.stop();
  await app.close();
  await pool.end();
  await postgres.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
