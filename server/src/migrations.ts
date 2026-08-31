import { query } from "./db.js";

/**
 * Идемпотентные миграции поверх db/init.sql. init.sql выполняется только при
 * создании базы, поэтому всё, что добавилось позже, доезжает сюда.
 */
const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS app_settings (
     user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     key        text NOT NULL,
     value_enc  bytea NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, key)
   )`,
];

export async function migrate(): Promise<void> {
  for (const statement of STATEMENTS) await query(statement);
}
