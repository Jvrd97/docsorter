import { z } from "zod";
import { zbool } from "./zbool.js";

const schema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string(),

  /** Куда класть зашифрованные файлы (том, примонтированный в контейнер). */
  STORAGE_DIR: z.string().default("/data/blobs"),

  /** Секрет для подписи cookie сессии. 64+ случайных символа. */
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),

  /** Требовать второй фактор, если он настроен. */
  REQUIRE_TOTP: zbool().default(false),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().default(8),
  LOCKOUT_MINUTES: z.coerce.number().default(15),

  /** Кто разбирает документы: claude CLI по OAuth-токену или Anthropic API по ключу. */
  AI_PROVIDER: z.enum(["cli", "api", "off"]).default("cli"),
  AI_MODEL: z.string().default("claude-haiku-4-5"),
  CLAUDE_BIN: z.string().default("claude"),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().default(240_000),

  /** Эмбеддинги: none (по умолчанию) или voyage. Claude своих эмбеддингов не даёт. */
  EMBEDDINGS_PROVIDER: z.enum(["none", "voyage"]).default("none"),
  VOYAGE_API_KEY: z.string().optional(),
  VOYAGE_MODEL: z.string().default("voyage-3"),

  /** Сколько документов разбирать одновременно. Слабый сервер — оставь 1. */
  WORKER_CONCURRENCY: z.coerce.number().default(1),
  WORKER_POLL_MS: z.coerce.number().default(3000),

  /** Резервный офлайн-OCR, если ИИ недоступен. */
  OCR_LANGUAGES: z.string().default("deu+eng+rus"),
  TESSDATA_DIR: z.string().default("/data/tessdata"),

  /** Отдавать статику фронтенда из этой папки. */
  WEB_DIR: z.string().default("/app/web"),

  /** Ограничение размера одного файла, МБ. */
  MAX_UPLOAD_MB: z.coerce.number().default(40),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
