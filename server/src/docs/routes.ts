import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { query, one } from "../db.js";
import { env } from "../env.js";
import { getDek } from "../crypto/vault.js";
import * as storage from "../storage/index.js";
import { requireVault, clientIp, audit } from "../auth/session.js";
import { normalize, extFor } from "../pipeline/media.js";
import { enqueue } from "../pipeline/worker.js";
import { insertLink } from "../pipeline/link.js";
import { CATEGORIES } from "../pipeline/taxonomy.js";
import { zbool } from "../zbool.js";

const listQuery = z.object({
  category: z.string().optional(),
  sender: z.string().optional(),
  tag: z.union([z.string(), z.array(z.string())]).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["pending", "processing", "ready", "failed"]).optional(),
  favorite: zbool().optional(),
  archived: zbool().optional(),
  sort: z.enum(["date_desc", "date_asc", "added_desc", "added_asc", "amount_desc"]).default("date_desc"),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

const CARD_COLUMNS = `
  id, status, title, category, sender, summary, doc_date, due_date, amount, currency,
  tags, action_needed, original_name, mime, size_bytes, page_count, thumb_key IS NOT NULL AS has_thumb,
  favorite, archived, error, created_at, processed_at`;

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  // ───────────────────────────── загрузка ────────────────────────────────────
  app.post("/api/documents", { preHandler: requireVault }, async (request, reply) => {
    const userId = request.userId!;
    const dek = getDek(userId)!;
    const analyze = (request.query as { analyze?: string }).analyze !== "0";
    const created: unknown[] = [];
    const skipped: unknown[] = [];
    // Поле hint перед файлом даёт готовые метаданные (используется при импорте
    // старого архива). Телефон шлёт просто файлы — тогда hint пустой.
    let hint: Partial<Hint> | null = null;

    for await (const part of request.parts()) {
      if (part.type === "field") {
        if (part.fieldname === "hint") hint = parseHint(String(part.value));
        continue;
      }

      const raw = await part.toBuffer();
      const sha = createHash("sha256").update(raw).digest("hex");

      const duplicate = await one<{ id: string; title: string | null }>(
        "SELECT id, title FROM documents WHERE user_id=$1 AND sha256=$2",
        [userId, sha],
      );
      if (duplicate) {
        skipped.push({ name: part.filename, reason: "уже загружен", id: duplicate.id, title: duplicate.title });
        hint = null;
        continue;
      }

      const normalized = await normalize(raw, part.mimetype, part.filename);
      const key = storage.newKey(extFor(normalized.mime));
      await storage.put(key, normalized.buffer, dek);

      const row = await one<{ id: string }>(
        `INSERT INTO documents
           (user_id, sha256, original_name, mime, size_bytes, blob_key, status,
            title, category, sender, doc_date, summary, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          userId, sha, part.filename, normalized.mime, normalized.buffer.length, key,
          analyze ? "pending" : "ready",
          hint?.title ?? null, hint?.category ?? null, hint?.sender ?? null,
          hint?.docDate ?? null, hint?.summary ?? null, hint?.tags ?? [],
        ],
      );
      if (analyze) await enqueue("analyze", { documentId: row!.id, userId });
      created.push({ id: row!.id, name: part.filename });
      hint = null;
    }

    await audit(userId, clientIp(request), "upload", { created: created.length, skipped: skipped.length });
    return reply.code(created.length ? 201 : 200).send({ created, skipped });
  });

  // ───────────────────────────── список ──────────────────────────────────────
  app.get("/api/documents", { preHandler: requireVault }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "неверные фильтры" });
    const f = parsed.data;

    const where: string[] = ["user_id = $1"];
    const params: unknown[] = [request.userId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };

    if (f.category) add("category = ?", f.category);
    if (f.sender) add("sender = ?", f.sender);
    if (f.tag) add("tags && ?::text[]", Array.isArray(f.tag) ? f.tag : [f.tag]);
    if (f.dateFrom) add("doc_date >= ?::date", f.dateFrom);
    if (f.dateTo) add("doc_date <= ?::date", f.dateTo);
    if (f.status) add("status = ?", f.status);
    if (f.favorite !== undefined) add("favorite = ?", f.favorite);
    where.push(f.archived ? "archived = true" : "archived = false");

    const order = {
      date_desc: "doc_date DESC NULLS LAST, created_at DESC",
      date_asc: "doc_date ASC NULLS LAST, created_at ASC",
      added_desc: "created_at DESC",
      added_asc: "created_at ASC",
      amount_desc: "amount DESC NULLS LAST",
    }[f.sort];

    params.push(f.limit, f.offset);
    const { rows } = await query(
      `SELECT ${CARD_COLUMNS} FROM documents
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = await one<{ count: string }>(
      `SELECT count(*)::text FROM documents WHERE ${where.join(" AND ")}`,
      params.slice(0, -2),
    );
    return { documents: rows, total: Number(total?.count ?? 0) };
  });

  // ───────────────────────────── карточка ────────────────────────────────────
  app.get("/api/documents/:id", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await one(
      `SELECT ${CARD_COLUMNS}, full_text, ai_raw FROM documents WHERE id=$1 AND user_id=$2`,
      [id, request.userId],
    );
    if (!doc) return reply.code(404).send({ error: "не найдено" });

    const entities = await query(
      "SELECT id, kind, value FROM entities WHERE document_id=$1 ORDER BY kind, value",
      [id],
    );
    const links = await query(
      `SELECT l.id, l.kind, l.reason, l.confidence, l.source,
              d.id AS other_id, d.title AS other_title, d.sender AS other_sender,
              d.category AS other_category, d.doc_date AS other_date,
              (d.thumb_key IS NOT NULL) AS other_has_thumb
         FROM document_links l
         JOIN documents d
           ON d.id = CASE WHEN l.from_id = $1 THEN l.to_id ELSE l.from_id END
        WHERE (l.from_id = $1 OR l.to_id = $1) AND d.user_id = $2
        ORDER BY l.confidence DESC, d.doc_date DESC NULLS LAST`,
      [id, request.userId],
    );
    return { document: doc, entities: entities.rows, links: links.rows };
  });

  // ───────────────────────────── файл и превью ───────────────────────────────
  app.get("/api/documents/:id/file", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const download = (request.query as { download?: string }).download === "1";
    const doc = await one<{ blob_key: string; mime: string; title: string | null; original_name: string }>(
      "SELECT blob_key, mime, title, original_name FROM documents WHERE id=$1 AND user_id=$2",
      [id, request.userId],
    );
    if (!doc) return reply.code(404).send({ error: "не найдено" });

    const buffer = await storage.get(doc.blob_key, getDek(request.userId!)!);
    const name = `${doc.title ?? doc.original_name}${extFor(doc.mime)}`.replace(/[/\\]/g, "-");
    await audit(request.userId!, clientIp(request), "download", { id });
    return reply
      .header("content-type", doc.mime)
      .header("cache-control", "private, no-store")
      .header(
        "content-disposition",
        `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .send(buffer);
  });

  app.get("/api/documents/:id/thumb", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await one<{ thumb_key: string | null }>(
      "SELECT thumb_key FROM documents WHERE id=$1 AND user_id=$2",
      [id, request.userId],
    );
    if (!doc?.thumb_key) return reply.code(404).send({ error: "нет превью" });
    const buffer = await storage.get(doc.thumb_key, getDek(request.userId!)!);
    return reply
      .header("content-type", "image/jpeg")
      .header("cache-control", "private, max-age=3600")
      .send(buffer);
  });

  // ───────────────────────────── правка ──────────────────────────────────────
  const patchBody = z.object({
    title: z.string().min(1).max(200).optional(),
    category: z.enum(CATEGORIES).optional(),
    sender: z.string().max(200).nullable().optional(),
    summary: z.string().max(4000).optional(),
    docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    amount: z.number().nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    favorite: z.boolean().optional(),
    archived: z.boolean().optional(),
  });

  app.patch("/api/documents/:id", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "неверные поля" });

    const columns: Record<string, string> = {
      title: "title", category: "category", sender: "sender", summary: "summary",
      docDate: "doc_date", dueDate: "due_date", amount: "amount",
      tags: "tags", favorite: "favorite", archived: "archived",
    };
    const sets: string[] = [];
    const params: unknown[] = [id, request.userId];
    for (const [key, value] of Object.entries(parsed.data)) {
      const column = columns[key];
      if (!column) continue;
      params.push(key === "tags" ? (value as string[]).map((t) => t.toLowerCase().trim()) : value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: "нечего менять" });

    const updated = await one(
      `UPDATE documents SET ${sets.join(", ")}, updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING ${CARD_COLUMNS}`,
      params,
    );
    if (!updated) return reply.code(404).send({ error: "не найдено" });
    return { document: updated };
  });

  app.post("/api/documents/:id/reanalyze", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await one<{ id: string }>("SELECT id FROM documents WHERE id=$1 AND user_id=$2", [
      id,
      request.userId,
    ]);
    if (!doc) return reply.code(404).send({ error: "не найдено" });
    await query("UPDATE documents SET status='pending', error=NULL WHERE id=$1", [id]);
    await enqueue("analyze", { documentId: id, userId: request.userId! });
    return { ok: true };
  });

  app.delete("/api/documents/:id", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const doc = await one<{ blob_key: string; thumb_key: string | null }>(
      "DELETE FROM documents WHERE id=$1 AND user_id=$2 RETURNING blob_key, thumb_key",
      [id, request.userId],
    );
    if (!doc) return reply.code(404).send({ error: "не найдено" });
    await storage.remove(doc.blob_key);
    if (doc.thumb_key) await storage.remove(doc.thumb_key);
    await audit(request.userId!, clientIp(request), "delete", { id });
    return { ok: true };
  });

  // ───────────────────────────── связи вручную ───────────────────────────────
  app.post("/api/documents/:id/links", { preHandler: requireVault }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({ toId: z.string().uuid(), kind: z.string().max(40).default("manual"), reason: z.string().max(300).optional() })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "неверный запрос" });

    const pair = await query("SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND user_id=$2", [
      [id, body.data.toId],
      request.userId,
    ]);
    if (pair.rowCount !== 2) return reply.code(404).send({ error: "документ не найден" });

    await insertLink(id, body.data.toId, body.data.kind, body.data.reason ?? null, 1, "manual");
    return { ok: true };
  });

  app.delete("/api/links/:linkId", { preHandler: requireVault }, async (request, reply) => {
    const { linkId } = request.params as { linkId: string };
    const res = await query(
      `DELETE FROM document_links l USING documents d
        WHERE l.id=$1 AND d.id = l.from_id AND d.user_id=$2`,
      [linkId, request.userId],
    );
    return res.rowCount ? { ok: true } : reply.code(404).send({ error: "не найдено" });
  });

  // ───────────────────────────── фасеты и статистика ─────────────────────────
  app.get("/api/facets", { preHandler: requireVault }, async (request) => {
    const [categories, senders, tags, years] = await Promise.all([
      query(`SELECT category AS value, count(*)::int AS count FROM documents
              WHERE user_id=$1 AND archived=false AND category IS NOT NULL
              GROUP BY 1 ORDER BY 2 DESC`, [request.userId]),
      query(`SELECT sender AS value, count(*)::int AS count FROM documents
              WHERE user_id=$1 AND archived=false AND sender IS NOT NULL
              GROUP BY 1 ORDER BY 2 DESC LIMIT 60`, [request.userId]),
      query(`SELECT tag AS value, count(*)::int AS count
               FROM documents, unnest(tags) AS tag
              WHERE user_id=$1 AND archived=false
              GROUP BY 1 ORDER BY 2 DESC LIMIT 80`, [request.userId]),
      query(`SELECT extract(year FROM doc_date)::int AS value, count(*)::int AS count
               FROM documents WHERE user_id=$1 AND doc_date IS NOT NULL
              GROUP BY 1 ORDER BY 1 DESC`, [request.userId]),
    ]);
    return {
      categories: categories.rows, senders: senders.rows, tags: tags.rows, years: years.rows,
      allCategories: CATEGORIES,
    };
  });

  app.get("/api/stats", { preHandler: requireVault }, async (request) => {
    const stats = await one(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status='ready')::int      AS ready,
              count(*) FILTER (WHERE status IN ('pending','processing'))::int AS in_progress,
              count(*) FILTER (WHERE status='failed')::int     AS failed,
              count(*) FILTER (WHERE action_needed IS NOT NULL AND archived=false)::int AS todo,
              coalesce(sum(size_bytes),0)::bigint AS bytes
         FROM documents WHERE user_id=$1`,
      [request.userId],
    );
    const due = await query(
      `SELECT ${CARD_COLUMNS} FROM documents
        WHERE user_id=$1 AND archived=false AND due_date IS NOT NULL AND due_date >= CURRENT_DATE - 30
        ORDER BY due_date ASC LIMIT 20`,
      [request.userId],
    );
    return { stats, due: due.rows };
  });
}

interface Hint {
  title: string | null;
  category: string | null;
  sender: string | null;
  docDate: string | null;
  summary: string | null;
  tags: string[];
}

const hintSchema = z.object({
  title: z.string().max(200).nullish(),
  category: z.enum(CATEGORIES).nullish(),
  sender: z.string().max(200).nullish(),
  docDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  summary: z.string().max(4000).nullish(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});

function parseHint(value: string): Partial<Hint> | null {
  try {
    const parsed = hintSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    return {
      title: parsed.data.title ?? null,
      category: parsed.data.category ?? null,
      sender: parsed.data.sender ?? null,
      docDate: parsed.data.docDate ?? null,
      summary: parsed.data.summary ?? null,
      tags: parsed.data.tags ?? [],
    };
  } catch {
    return null;
  }
}
