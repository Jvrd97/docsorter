import { query } from "../db.js";
import { ask, extractJson, aiEnabled } from "../ai/index.js";
import { normalizeEntity } from "./taxonomy.js";

const STRONG_KINDS = new Set([
  "iban", "contract_no", "customer_no", "case_no", "invoice_no", "tax_id",
]);

const LINK_KINDS = new Set([
  "same_entity", "same_case", "reply_to", "invoice_for", "renewal_of", "same_sender", "manual",
]);

interface Candidate {
  id: string;
  title: string | null;
  sender: string | null;
  category: string | null;
  doc_date: string | null;
  summary: string | null;
}

/**
 * Связи строятся в два прохода.
 * Точный: совпал номер договора или IBAN — связь есть, ИИ не нужен.
 * Мягкий: тот же отправитель или пересекающиеся теги — кандидатов показываем
 * модели, и она говорит, какие пары действительно связаны и чем.
 */
export async function buildLinks(documentId: string, userId: string): Promise<number> {
  let created = await linkByEntities(documentId, userId);
  if (aiEnabled()) created += await linkByModel(documentId, userId);
  return created;
}

async function linkByEntities(documentId: string, userId: string): Promise<number> {
  const { rows } = await query<{ other_id: string; kind: string; value: string }>(
    `SELECT DISTINCT e2.document_id AS other_id, e1.kind, e1.value
       FROM entities e1
       JOIN entities e2
         ON e2.value_norm = e1.value_norm
        AND e2.kind       = e1.kind
        AND e2.document_id <> e1.document_id
       JOIN documents d ON d.id = e2.document_id AND d.user_id = $2
      WHERE e1.document_id = $1
        AND e1.kind = ANY($3::text[])
        AND length(e1.value_norm) >= 5`,
    [documentId, userId, [...STRONG_KINDS]],
  );

  let created = 0;
  for (const row of rows) {
    const ok = await insertLink(
      documentId,
      row.other_id,
      "same_entity",
      `общий ${row.kind}: ${row.value}`,
      1,
      "auto",
    );
    if (ok) created++;
  }
  return created;
}

async function linkByModel(documentId: string, userId: string): Promise<number> {
  const doc = await query<Candidate & { tags: string[] }>(
    `SELECT id, title, sender, category, doc_date, summary, tags
       FROM documents WHERE id = $1 AND user_id = $2`,
    [documentId, userId],
  );
  const self = doc.rows[0];
  if (!self) return 0;

  const { rows: candidates } = await query<Candidate>(
    `SELECT d.id, d.title, d.sender, d.category, d.doc_date, d.summary
       FROM documents d
      WHERE d.user_id = $1
        AND d.id <> $2
        AND d.status = 'ready'
        AND (
              (d.sender IS NOT NULL AND d.sender = $3)
           OR (d.tags && $4::text[])
        )
        AND NOT EXISTS (
              SELECT 1 FROM document_links l
               WHERE (l.from_id = $2 AND l.to_id = d.id)
                  OR (l.from_id = d.id AND l.to_id = $2)
        )
      ORDER BY abs(coalesce(d.doc_date, CURRENT_DATE) - coalesce($5::date, CURRENT_DATE))
      LIMIT 12`,
    [userId, documentId, self.sender, self.tags, self.doc_date],
  );
  if (candidates.length === 0) return 0;

  const prompt = [
    "Вот новый документ:",
    JSON.stringify(describe(self), null, 1),
    "",
    "И вот другие документы из того же архива:",
    JSON.stringify(candidates.map(describe), null, 1),
    "",
    "Какие из них по-настоящему связаны с новым документом? Связь — это когда",
    "документы про одно и то же дело, договор, счёт или переписку, а не просто",
    "«тот же отправитель». Если связей нет, верни пустой массив.",
    "",
    'Ответь JSON: {"links": [{"id": "<id кандидата>", "kind": "same_case|reply_to|invoice_for|renewal_of|same_sender", "reason": "одна фраза по-русски", "confidence": 0.0-1.0}]}',
  ].join("\n");

  const parsed = extractJson<{ links?: Array<{ id: string; kind: string; reason?: string; confidence?: number }> }>(
    await ask({ prompt, maxTokens: 2000 }),
  );
  if (!parsed?.links?.length) return 0;

  const allowed = new Set(candidates.map((c) => c.id));
  let created = 0;
  for (const link of parsed.links) {
    if (!allowed.has(link.id)) continue;
    const kind = LINK_KINDS.has(link.kind) ? link.kind : "same_case";
    const confidence = typeof link.confidence === "number" ? Math.min(1, Math.max(0, link.confidence)) : 0.6;
    if (confidence < 0.5) continue;
    const ok = await insertLink(documentId, link.id, kind, link.reason?.slice(0, 300) ?? null, confidence, "auto");
    if (ok) created++;
  }
  return created;
}

function describe(doc: Candidate) {
  return {
    id: doc.id,
    title: doc.title,
    sender: doc.sender,
    category: doc.category,
    date: doc.doc_date,
    summary: doc.summary?.slice(0, 300) ?? null,
  };
}

export async function insertLink(
  fromId: string,
  toId: string,
  kind: string,
  reason: string | null,
  confidence: number,
  source: "auto" | "manual",
): Promise<boolean> {
  if (fromId === toId) return false;
  const existing = await query(
    `SELECT 1 FROM document_links
      WHERE kind = $3 AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`,
    [fromId, toId, kind],
  );
  if (existing.rowCount) return false;
  await query(
    `INSERT INTO document_links (from_id, to_id, kind, reason, confidence, source)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [fromId, toId, kind, reason, confidence, source],
  );
  return true;
}

export async function saveEntities(
  documentId: string,
  entities: Array<{ kind: string; value: string }>,
): Promise<void> {
  await query("DELETE FROM entities WHERE document_id = $1", [documentId]);
  for (const entity of entities) {
    const norm = normalizeEntity(entity.value);
    if (norm.length < 3) continue;
    await query(
      `INSERT INTO entities (document_id, kind, value, value_norm) VALUES ($1, $2, $3, $4)`,
      [documentId, entity.kind, entity.value, norm],
    );
  }
}
