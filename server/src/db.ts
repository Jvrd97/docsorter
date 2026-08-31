import pg from "pg";
import { env } from "./env.js";

// Даты (DATE, oid 1082) отдаём строкой 'YYYY-MM-DD', а не Date —
// иначе часовой пояс контейнера сдвигает дату документа на сутки.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const res = await query<T>(text, params);
  return res.rows[0] ?? null;
}

export async function waitForDb(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
