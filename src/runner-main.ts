import { run } from "graphile-worker";
import { config } from "./config.js";
import { query } from "./db.js";
import { runApplication } from "./runner.js";
import { z } from "zod";
const beat = setInterval(
  () =>
    void query(
      "INSERT INTO heartbeats(service) VALUES('runner') ON CONFLICT(service) DO UPDATE SET last_seen_at=now()",
    ),
  30000,
);
const runner = await run({
  connectionString: config.databaseUrl,
  concurrency: 1,
  taskList: {
    run_application: async (payload) => {
      const { id, mode } = z
        .object({ id: z.uuid(), mode: z.enum(["prepare", "submit"]) })
        .parse(payload);
      await runApplication(id, mode);
    },
  },
  pollInterval: 1000,
});
process.on("SIGTERM", () => void runner.stop());
process.on("SIGINT", () => void runner.stop());
await runner.promise;
clearInterval(beat);
