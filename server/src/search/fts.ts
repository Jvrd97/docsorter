import { query } from "../db.js";

export interface SearchFilters {
  category?: string | null;
  sender?: string | null;
  tags?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  includeArchived?: boolean;
}

export interface Hit {
  id: string;
  title: string | null;
  category: string | null;
  sender: string | null;
  summary: string | null;
  doc_date: string | null;
  due_date: string | null;
  amount: string | null;
  currency: string | null;
  tags: string[];
  action_needed: string | null;
  mime: string;
  has_thumb: boolean;
  snippet: string | null;
  score: number;
}

const SELECT = `
  d.id, d.title, d.category, d.sender, d.summary, d.doc_date, d.due_date,
  d.amount, d.currency, d.tags, d.action_needed, d.mime,
  (d.thumb_key IS NOT NULL) AS has_thumb`;

/**
 * Полнотекстовый поиск на трёх языках сразу.
 * 'simple' ловит номера и написание как есть, языковые конфиги — словоформы.
 * websearch_to_tsquery терпит любой ввод пользователя и не падает на кавычках.
 */
export async function searchFts(
  userId: string,
  text: string,
  filters: SearchFilters,
  limit = 40,
): Promise<Hit[]> {
  const { clause, params } = buildFilters(userId, filters);
  params.push(text);
  const q = `$${params.length}`;
  params.push(limit);

  const { rows } = await query<Hit>(
    `WITH qs AS (
       SELECT websearch_to_tsquery('simple',  ${q}) AS simple_q,
              websearch_to_tsquery('german',  ${q}) AS de_q,
              websearch_to_tsquery('russian', ${q}) AS ru_q,
              websearch_to_tsquery('english', ${q}) AS en_q
     )
     SELECT ${SELECT},
            ts_headline('simple', coalesce(d.full_text, d.summary, ''), qs.simple_q,
              'MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "') AS snippet,
            greatest(
              ts_rank_cd(d.tsv, qs.simple_q),
              ts_rank_cd(d.tsv, qs.de_q),
              ts_rank_cd(d.tsv, qs.ru_q),
              ts_rank_cd(d.tsv, qs.en_q)
            ) + similarity(coalesce(d.title, ''), ${q}) AS score
       FROM documents d, qs
      WHERE ${clause}
        AND (
              d.tsv @@ qs.simple_q OR d.tsv @@ qs.de_q
           OR d.tsv @@ qs.ru_q     OR d.tsv @@ qs.en_q
           OR coalesce(d.title, '') % ${q}
        )
      ORDER BY score DESC, d.doc_date DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Поиск только по фильтрам, без текста: «все счета от o2 за 2025». */
export async function searchFilters(
  userId: string,
  filters: SearchFilters,
  limit = 40,
): Promise<Hit[]> {
  const { clause, params } = buildFilters(userId, filters);
  params.push(limit);
  const { rows } = await query<Hit>(
    `SELECT ${SELECT}, NULL::text AS snippet, 0::float AS score
       FROM documents d
      WHERE ${clause}
      ORDER BY d.doc_date DESC NULLS LAST, d.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Векторный поиск. Работает, только если включены эмбеддинги. */
export async function searchVector(
  userId: string,
  vector: string,
  filters: SearchFilters,
  limit = 40,
): Promise<Hit[]> {
  const { clause, params } = buildFilters(userId, filters);
  params.push(vector, limit);
  const { rows } = await query<Hit>(
    `SELECT ${SELECT}, NULL::text AS snippet,
            (1 - (d.embedding <=> $${params.length - 1}::vector)) AS score
       FROM documents d
      WHERE ${clause} AND d.embedding IS NOT NULL
      ORDER BY d.embedding <=> $${params.length - 1}::vector
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

function buildFilters(userId: string, f: SearchFilters) {
  const parts = ["d.user_id = $1", "d.status = 'ready'"];
  const params: unknown[] = [userId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    parts.push(sql.replace("?", `$${params.length}`));
  };

  if (f.category) add("d.category = ?", f.category);
  if (f.sender) add("d.sender ILIKE ?", `%${f.sender}%`);
  if (f.tags?.length) add("d.tags && ?::text[]", f.tags);
  if (f.dateFrom) add("d.doc_date >= ?::date", f.dateFrom);
  if (f.dateTo) add("d.doc_date <= ?::date", f.dateTo);
  if (typeof f.amountMin === "number") add("d.amount >= ?", f.amountMin);
  if (typeof f.amountMax === "number") add("d.amount <= ?", f.amountMax);
  if (!f.includeArchived) parts.push("d.archived = false");

  return { clause: parts.join(" AND "), params };
}

/** Склеивает результаты нескольких способов поиска, не теряя лучший счёт. */
export function mergeHits(...lists: Hit[][]): Hit[] {
  const byId = new Map<string, Hit>();
  for (const list of lists) {
    for (const hit of list) {
      const existing = byId.get(hit.id);
      if (!existing) byId.set(hit.id, hit);
      else {
        existing.score = Math.max(existing.score, hit.score);
        existing.snippet ??= hit.snippet;
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
