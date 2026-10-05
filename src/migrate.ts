import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeWorkerUtils } from "graphile-worker";
import { config } from "./config.js";
import { pool, query, transaction } from "./db.js";
export async function migrate() {
  const utils = await makeWorkerUtils({ connectionString: config.databaseUrl });
  await utils.migrate();
  await utils.release();
  await transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(7421901)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(resolve("migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      if (
        (await query("SELECT name FROM migrations WHERE name=$1", [name], tx))
          .length
      )
        continue;
      await tx.query(await readFile(resolve("migrations", name), "utf8"));
      await tx.query("INSERT INTO migrations(name) VALUES ($1)", [name]);
    }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === resolve("src/migrate.ts")) {
  await migrate();
  await pool.end();
}
