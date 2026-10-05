import { run } from "graphile-worker";
import { config } from "./config.js";
import { taskList } from "./tasks.js";
const runner = await run({
  connectionString: config.databaseUrl,
  concurrency: 2,
  taskList,
  crontab: "* * * * * tick",
  pollInterval: 1000,
});
process.on("SIGTERM", () => void runner.stop());
process.on("SIGINT", () => void runner.stop());
await runner.promise;
