import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDek } from "../crypto/vault.js";
import { requireVault, clientIp, audit } from "../auth/session.js";
import {
  SETTING_KEYS, SETTING_KEY_LIST, maskSecret, refreshRuntime, runtime, writeSetting,
  type SettingKey,
} from "./store.js";
import { ask } from "../ai/index.js";
import { env } from "../env.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — самая быстрая и дешёвая" },
  { id: "claude-sonnet-5", label: "Sonnet 5 — точнее, дороже" },
  { id: "claude-opus-5", label: "Opus 5 — самая сильная, для трудных бумаг" },
];

const body = z.object({ values: z.record(z.string(), z.string().nullable()) });

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // Секреты наружу не отдаём никогда — только «задан / не задан» и хвост.
  app.get("/api/settings", { preHandler: requireVault }, async () => {
    const config = runtime();
    return {
      values: {
        AI_PROVIDER: config.aiProvider,
        AI_MODEL: config.aiModel,
        EMBEDDINGS_PROVIDER: config.embeddingsProvider,
        VOYAGE_MODEL: config.voyageModel,
      },
      secrets: {
        CLAUDE_CODE_OAUTH_TOKEN: maskSecret(config.claudeToken),
        ANTHROPIC_API_KEY: maskSecret(config.anthropicKey),
        VOYAGE_API_KEY: maskSecret(config.voyageKey),
      },
      models: MODELS,
      // Что приедет из .env, если стереть значение в интерфейсе.
      envDefaults: {
        AI_PROVIDER: env.AI_PROVIDER,
        AI_MODEL: env.AI_MODEL,
        EMBEDDINGS_PROVIDER: env.EMBEDDINGS_PROVIDER,
        hasEnvClaudeToken: !!env.CLAUDE_CODE_OAUTH_TOKEN,
        hasEnvAnthropicKey: !!env.ANTHROPIC_API_KEY,
      },
    };
  });

  app.put("/api/settings", { preHandler: requireVault }, async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "неверный запрос" });

    const userId = request.userId!;
    const dek = getDek(userId)!;
    const changed: string[] = [];

    for (const [rawKey, value] of Object.entries(parsed.data.values)) {
      if (!SETTING_KEY_LIST.includes(rawKey as SettingKey)) continue;
      const key = rawKey as SettingKey;
      const spec = SETTING_KEYS[key];

      if (value !== null && "options" in spec) {
        const options = spec.options as readonly string[];
        if (!options.includes(value)) {
          return reply.code(400).send({ error: `${key}: допустимо только ${options.join(", ")}` });
        }
      }
      const clean = value === null ? null : value.trim();
      await writeSetting(userId, dek, key, clean === "" ? null : clean);
      changed.push(key);
    }

    // Новые значения действуют сразу, без перезапуска контейнера.
    await refreshRuntime(userId, dek);
    await audit(userId, clientIp(request), "settings_change", { keys: changed });
    return { ok: true, changed };
  });

  // Кнопка «Проверить»: настоящий короткий запрос к модели текущими ключами.
  app.post(
    "/api/settings/test",
    { preHandler: requireVault, config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async () => {
      const config = runtime();
      if (config.aiProvider === "off") return { ok: false, error: "разбор моделью выключен" };

      const started = Date.now();
      try {
        const answer = await ask({ prompt: "Ответь ровно одним словом: работает", maxTokens: 32 });
        return {
          ok: true,
          provider: config.aiProvider,
          model: config.aiModel,
          ms: Date.now() - started,
          answer: answer.trim().slice(0, 120),
        };
      } catch (err) {
        return {
          ok: false,
          provider: config.aiProvider,
          ms: Date.now() - started,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        };
      }
    },
  );
}
