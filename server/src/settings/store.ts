import { query } from "../db.js";
import { env } from "../env.js";
import { seal, open } from "../crypto/blob.js";

/**
 * Настройки, которые правятся в интерфейсе. Значения лежат в базе
 * зашифрованными тем же ключом, что и файлы, — прочитать их можно только при
 * открытом хранилище. Что не задано в интерфейсе, берётся из .env.
 */

export const SETTING_KEYS = {
  AI_PROVIDER: { secret: false, options: ["cli", "api", "off"] as const },
  AI_MODEL: { secret: false },
  CLAUDE_CODE_OAUTH_TOKEN: { secret: true },
  ANTHROPIC_API_KEY: { secret: true },
  EMBEDDINGS_PROVIDER: { secret: false, options: ["none", "voyage"] as const },
  VOYAGE_API_KEY: { secret: true },
  VOYAGE_MODEL: { secret: false },
} as const;

export type SettingKey = keyof typeof SETTING_KEYS;
export const SETTING_KEY_LIST = Object.keys(SETTING_KEYS) as SettingKey[];

export interface Runtime {
  aiProvider: "cli" | "api" | "off";
  aiModel: string;
  claudeToken: string | undefined;
  anthropicKey: string | undefined;
  embeddingsProvider: "none" | "voyage";
  voyageKey: string | undefined;
  voyageModel: string;
}

function fromEnv(): Runtime {
  return {
    aiProvider: env.AI_PROVIDER,
    aiModel: env.AI_MODEL,
    claudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    anthropicKey: env.ANTHROPIC_API_KEY || undefined,
    embeddingsProvider: env.EMBEDDINGS_PROVIDER,
    voyageKey: env.VOYAGE_API_KEY || undefined,
    voyageModel: env.VOYAGE_MODEL,
  };
}

// Кэш в памяти: воркер дёргает настройки на каждый документ, ходить за ними
// в базу и расшифровывать каждый раз незачем.
let cached: Runtime = fromEnv();
let cachedFor: string | null = null;

export function runtime(): Runtime {
  return cached;
}

export function resetRuntime(): void {
  cached = fromEnv();
  cachedFor = null;
}

export async function refreshRuntime(userId: string, dek: Buffer): Promise<Runtime> {
  const stored = await readAll(userId, dek);
  const base = fromEnv();
  const pick = (key: SettingKey, fallback: string | undefined) => stored[key] ?? fallback;

  const provider = pick("AI_PROVIDER", base.aiProvider);
  const embeddings = pick("EMBEDDINGS_PROVIDER", base.embeddingsProvider);

  cached = {
    aiProvider: isOneOf(provider, SETTING_KEYS.AI_PROVIDER.options) ? provider : base.aiProvider,
    aiModel: pick("AI_MODEL", base.aiModel) || base.aiModel,
    claudeToken: pick("CLAUDE_CODE_OAUTH_TOKEN", base.claudeToken) || undefined,
    anthropicKey: pick("ANTHROPIC_API_KEY", base.anthropicKey) || undefined,
    embeddingsProvider: isOneOf(embeddings, SETTING_KEYS.EMBEDDINGS_PROVIDER.options)
      ? embeddings
      : base.embeddingsProvider,
    voyageKey: pick("VOYAGE_API_KEY", base.voyageKey) || undefined,
    voyageModel: pick("VOYAGE_MODEL", base.voyageModel) || base.voyageModel,
  };
  cachedFor = userId;
  return cached;
}

export function runtimeOwner(): string | null {
  return cachedFor;
}

async function readAll(userId: string, dek: Buffer): Promise<Partial<Record<SettingKey, string>>> {
  const { rows } = await query<{ key: string; value_enc: Buffer }>(
    "SELECT key, value_enc FROM app_settings WHERE user_id=$1",
    [userId],
  );
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of rows) {
    if (!SETTING_KEY_LIST.includes(row.key as SettingKey)) continue;
    try {
      out[row.key as SettingKey] = open(row.value_enc, dek).toString("utf8");
    } catch {
      // Значение зашифровано другим ключом (пароль менялся до перезаворачивания)
      // — молча падаем на .env, а не роняем приложение.
    }
  }
  return out;
}

export async function writeSetting(
  userId: string,
  dek: Buffer,
  key: SettingKey,
  value: string | null,
): Promise<void> {
  if (value === null || value === "") {
    await query("DELETE FROM app_settings WHERE user_id=$1 AND key=$2", [userId, key]);
    return;
  }
  await query(
    `INSERT INTO app_settings (user_id, key, value_enc, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id, key) DO UPDATE SET value_enc=EXCLUDED.value_enc, updated_at=now()`,
    [userId, key, seal(Buffer.from(value, "utf8"), dek)],
  );
}

/** Показываем только хвост секрета: «задан» видно, значение — нет. */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 8 ? "•".repeat(value.length) : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isOneOf<T extends readonly string[]>(
  value: string | undefined,
  options: T,
): value is T[number] {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}
