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
      const { id, mode, operationItem } = z
        .object({
          id: z.uuid(),
          mode: z.enum(["prepare", "submit"]),
          operationItem: z.uuid().optional(),
        })
        .parse(payload);
      if (operationItem) {
        const rows = await query(
          "UPDATE operation_items SET state='running',updated_at=now() WHERE id=$1 AND state='queued' RETURNING id",
          [operationItem],
        );
        if (!rows.length) return;
      }
      try {
        await runApplication(id, mode);
      } catch (e) {
        if (operationItem)
          await query(
            "UPDATE operation_items SET state='queued',updated_at=now() WHERE id=$1 AND state='running'",
            [operationItem],
          );
        throw e;
      }
      if (operationItem) {
        const [a] = await query(
          "SELECT runner_state,last_error FROM applications WHERE id=$1",
          [id],
        );
        await query(
          "UPDATE operation_items SET state=$2,message=$3,updated_at=now() WHERE id=$1",
          [
            operationItem,
            ["ready", "confirmed"].includes(a.runner_state)
              ? "completed"
              : a.runner_state,
            a.last_error,
          ],
        );
      }
    },
  },
  pollInterval: 1000,
});
process.on("SIGTERM", () => void runner.stop());
process.on("SIGINT", () => void runner.stop());
await runner.promise;
clearInterval(beat);
