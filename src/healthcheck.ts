import { query, pool } from "./db.js";
try {
  const rows = await query(
    "SELECT service FROM heartbeats WHERE service=$1 AND last_seen_at>now()-interval '2 minutes'",
    [process.argv[2]],
  );
  process.exitCode = rows.length ? 0 : 1;
} catch {
  process.exitCode = 1;
}
await pool.end();
