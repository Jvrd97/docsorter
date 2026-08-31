import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { existsSync } from "node:fs";
import { env } from "./env.js";
import { waitForDb, pool, query } from "./db.js";
import { ensureStorage } from "./storage/index.js";
import { authRoutes } from "./auth/routes.js";
import { documentRoutes } from "./docs/routes.js";
import { searchRoutes } from "./search/routes.js";
import { startWorker } from "./pipeline/worker.js";
import { shutdownOcr } from "./pipeline/ocr.js";

const app = Fastify({
  logger: { level: env.NODE_ENV === "production" ? "info" : "debug" },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'self'", "blob:"],
      frameSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "data:"],
      formAction: ["'self'"],
      // 'self', а не 'none': карточка документа показывает PDF в своём iframe,
      // и запрет встраивания целиком сломал бы просмотр. Чужие сайты всё равно
      // встроить не смогут.
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      // Апгрейд до HTTPS навязывает HSTS на реальном домене; здесь он только
      // мешает проверить приложение по http внутри своей сети.
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
  // Приложение открывается только по HTTPS, поэтому HSTS включён жёстко.
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
});

await app.register(cookie, { secret: env.SESSION_SECRET, hook: "onRequest" });
await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
await app.register(multipart, {
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 60 },
});

app.get("/api/health", async () => ({ ok: true, ai: env.AI_PROVIDER, model: env.AI_MODEL }));

await app.register(authRoutes);
await app.register(documentRoutes);
await app.register(searchRoutes);

// Фронтенд отдаётся тем же процессом: один контейнер, один порт, один сертификат.
if (existsSync(env.WEB_DIR)) {
  await app.register(fastifyStatic, { root: path.resolve(env.WEB_DIR), index: false });
  // index: false отключает выдачу каталога, поэтому корень отдаём явно —
  // иначе @fastify/static отвечает на "/" кодом 403.
  app.get("/", (_request, reply) => reply.sendFile("index.html"));
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "не найдено" });
    return reply.sendFile("index.html");
  });
}

await waitForDb();
await ensureStorage();

// Мусор от прошлого запуска: задания, застрявшие в running, вернуть в очередь.
await query("UPDATE jobs SET status='queued' WHERE status='running'");
await query("DELETE FROM sessions WHERE expires_at < now()");

const stopWorker = startWorker(app.log);

await app.listen({ port: env.PORT, host: env.HOST });
app.log.info(
  { ai: env.AI_PROVIDER, model: env.AI_MODEL, embeddings: env.EMBEDDINGS_PROVIDER },
  "DocSorter запущен",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    app.log.info("останавливаюсь");
    stopWorker();
    await app.close();
    await shutdownOcr();
    await pool.end();
    process.exit(0);
  });
}
