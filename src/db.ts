import pg from "pg";
import "dotenv/config";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Hosted Postgres (Supabase, RDS, Neon...) requires TLS.
  // DB_SSL=true enables it; DB_SSL_NO_VERIFY=true skips CA verification
  // (needed for Supabase's pooler unless you install their CA cert).
  ssl: process.env.DB_SSL === "true"
    ? { rejectUnauthorized: process.env.DB_SSL_NO_VERIFY !== "true" }
    : undefined,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** Run a function inside a transaction. Rolls back on any throw. */
export async function withTransaction<T>(
  fn: (q: typeof query) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  const txQuery = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string, params: unknown[] = []
  ): Promise<R[]> => (await client.query<R>(text, params)).rows;
  try {
    await client.query("BEGIN");
    const result = await fn(txQuery as typeof query);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
