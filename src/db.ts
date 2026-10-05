import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "./config.js";
import * as schema from "./schema.js";
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});
export const db = drizzle(pool, { schema });
export type Tx = pg.PoolClient;
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  values: unknown[] = [],
  tx?: Tx,
): Promise<T[]> {
  return (await (tx || pool).query<T>(text, values)).rows;
}
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export const event = async (
  type: string,
  id: string | null,
  data: unknown = {},
  tx?: Tx,
) => {
  await query(
    "INSERT INTO events(type,entity_id,data) VALUES ($1,$2,$3)",
    [type, id, JSON.stringify(data)],
    tx,
  );
};
export async function enqueue(
  task: string,
  payload: unknown,
  key: string,
  tx?: Tx,
) {
  await query(
    "SELECT graphile_worker.add_job($1,$2::json,job_key := $3,max_attempts := 4)",
    [task, JSON.stringify(payload), key],
    tx,
  );
}
