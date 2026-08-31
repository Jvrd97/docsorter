import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db.js";
import { ask, extractJson, aiEnabled } from "../ai/index.js";
import { embed, embeddingsEnabled, toVectorLiteral } from "../pipeline/embeddings.js";
import { requireVault, clientIp, audit } from "../auth/session.js";
import { CATEGORIES } from "../pipeline/taxonomy.js";
import { searchFts, searchFilters, searchVector, mergeHits, type Hit, type SearchFilters } from "./fts.js";

const body = z.object({
  q: z.string().min(1).max(500),
  mode: z.enum(["fast", "smart"]).default("smart"),
  limit: z.coerce.number().min(1).max(50).default(20),
  includeArchived: z.boolean().default(false),
});

interface Plan extends SearchFilters {
  keywords: string[];
  intent: "find" | "answer";
  restated: string;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/search",
    { preHandler: requireVault, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = body.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "пустой запрос" });
      const { q, mode, limit, includeArchived } = parsed.data;
      const userId = request.userId!;

      // Быстрый режим: только полнотекстовый поиск, без единого вызова модели.
      if (mode === "fast" || !aiEnabled) {
        const hits = await searchFts(userId, q, { includeArchived }, limit);
        await audit(userId, clientIp(request), "search", { q, mode: "fast", found: hits.length });
        return { mode: "fast", answer: null, plan: null, documents: hits.slice(0, limit) };
      }

      // Умный режим: модель превращает фразу в план, база достаёт кандидатов,
      // модель переранжирует их и отвечает словами со ссылками на документы.
      const plan = await makePlan(q);
      const filters: SearchFilters = { ...plan, includeArchived };

      const lists: Hit[][] = [];
      const text = plan.keywords.join(" ") || q;
      lists.push(await searchFts(userId, text, filters, 40));
      if (lists[0]!.length < 5) lists.push(await searchFilters(userId, filters, 30));
      if (embeddingsEnabled) {
        const vector = await embed(q).catch(() => null);
        if (vector) lists.push(await searchVector(userId, toVectorLiteral(vector), filters, 30));
      }

      const candidates = mergeHits(...lists).slice(0, 24);
      if (candidates.length === 0) {
        await audit(userId, clientIp(request), "search", { q, mode: "smart", found: 0 });
        return { mode: "smart", answer: "Ничего не нашлось.", plan, documents: [] };
      }

      const verdict = await rerank(q, candidates).catch(() => null);
      const ordered = verdict?.order?.length
        ? (verdict.order
            .map((id) => candidates.find((c) => c.id === id))
            .filter((c): c is Hit => !!c))
        : candidates;

      await audit(userId, clientIp(request), "search", { q, mode: "smart", found: ordered.length });
      return {
        mode: "smart",
        answer: verdict?.answer ?? null,
        plan,
        documents: ordered.slice(0, limit),
      };
    },
  );

  app.get("/api/search/suggest", { preHandler: requireVault }, async (request) => {
    const q = String((request.query as { q?: string }).q ?? "").trim();
    if (q.length < 2) return { suggestions: [] };
    const { rows } = await query<{ value: string; kind: string }>(
      `SELECT DISTINCT value, kind FROM (
         SELECT title AS value, 'документ' AS kind FROM documents
          WHERE user_id=$1 AND title ILIKE $2
         UNION ALL
         SELECT sender, 'отправитель' FROM documents
          WHERE user_id=$1 AND sender ILIKE $2
         UNION ALL
         SELECT tag, 'тег' FROM documents, unnest(tags) tag
          WHERE user_id=$1 AND tag ILIKE $2
       ) s WHERE value IS NOT NULL LIMIT 12`,
      [request.userId, `%${q}%`],
    );
    return { suggestions: rows };
  });
}

const PLAN_SYSTEM =
  "Ты превращаешь человеческую фразу в план поиска по личному архиву документов. " +
  "Отвечай только JSON.";

async function makePlan(q: string): Promise<Plan> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = [
    `Сегодня ${today}. Запрос пользователя: «${q}»`,
    "",
    "Верни JSON:",
    "{",
    '  "keywords": ["слова для полнотекстового поиска: имена, номера, суммы, ключевые термины. Добавь немецкие синонимы, если запрос по-русски: счёт→Rechnung, договор→Vertrag, страховка→Versicherung, налог→Steuer, справка→Bescheinigung"],',
    `  "category": "одна из: ${CATEGORIES.join(" | ")} — или null",`,
    '  "sender": "организация или null",',
    '  "tags": ["теги или пустой массив"],',
    '  "dateFrom": "YYYY-MM-DD или null",',
    '  "dateTo": "YYYY-MM-DD или null",',
    '  "amountMin": null, "amountMax": null,',
    '  "intent": "find если человек ищет документ, answer если он задал вопрос по содержанию",',
    '  "restated": "как ты понял запрос, одна фраза по-русски"',
    "}",
    "",
    'Относительные даты разворачивай в конкретные: «за прошлый год» → 1 января и 31 декабря прошлого года.',
    "Не выдумывай фильтры, которых в запросе нет: сомневаешься — ставь null.",
  ].join("\n");

  const parsed = await extractJson<Partial<Plan>>(await ask({ system: PLAN_SYSTEM, prompt, maxTokens: 1200 }));
  return {
    keywords: Array.isArray(parsed?.keywords)
      ? parsed.keywords.filter((k): k is string => typeof k === "string").slice(0, 12)
      : [q],
    category: pickCategory(parsed?.category),
    sender: typeof parsed?.sender === "string" ? parsed.sender : null,
    tags: Array.isArray(parsed?.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [],
    dateFrom: isDate(parsed?.dateFrom) ? parsed!.dateFrom! : null,
    dateTo: isDate(parsed?.dateTo) ? parsed!.dateTo! : null,
    amountMin: typeof parsed?.amountMin === "number" ? parsed.amountMin : null,
    amountMax: typeof parsed?.amountMax === "number" ? parsed.amountMax : null,
    intent: parsed?.intent === "answer" ? "answer" : "find",
    restated: typeof parsed?.restated === "string" ? parsed.restated : q,
  };
}

async function rerank(q: string, hits: Hit[]): Promise<{ order: string[]; answer: string | null }> {
  const cards = hits.map((h) => ({
    id: h.id,
    title: h.title,
    sender: h.sender,
    category: h.category,
    date: h.doc_date,
    amount: h.amount,
    summary: h.summary?.slice(0, 300) ?? null,
    snippet: h.snippet?.slice(0, 500) ?? null,
  }));

  const prompt = [
    `Запрос: «${q}»`,
    "",
    "Кандидаты из архива:",
    JSON.stringify(cards, null, 1),
    "",
    "Верни JSON:",
    '{"order": ["id по убыванию полезности — только реально подходящие, остальные выкинь"],',
    ' "answer": "короткий ответ по-русски на основе найденного, со ссылкой на документы по названию; null, если человек просто искал документ, а не задавал вопрос"}',
    "",
    "Ничего не выдумывай: отвечай только тем, что есть в карточках.",
  ].join("\n");

  const parsed = await extractJson<{ order?: string[]; answer?: string | null }>(
    await ask({ prompt, maxTokens: 2000 }),
  );
  return {
    order: Array.isArray(parsed?.order) ? parsed.order.filter((id): id is string => typeof id === "string") : [],
    answer: typeof parsed?.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : null,
  };
}

function pickCategory(value: unknown): string | null {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value) ? value : null;
}

function isDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}
