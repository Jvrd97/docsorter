import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ask, extractJson, AiUnavailable } from "../ai/index.js";
import { env } from "../env.js";
import { CATEGORIES, FALLBACK_CATEGORY, KNOWN_SENDERS, ENTITY_KINDS } from "./taxonomy.js";
import { makeTempDir, safeUnlink, extFor } from "./media.js";
import { ocrFallback } from "./ocr.js";

export interface RawEntity {
  kind: string;
  value: string;
}

export interface Analysis {
  title: string;
  category: string;
  sender: string | null;
  summary: string;
  docDate: string | null;
  dueDate: string | null;
  amount: number | null;
  currency: string | null;
  language: string | null;
  actionNeeded: string | null;
  tags: string[];
  entities: RawEntity[];
  fullText: string;
}

const SYSTEM =
  "Ты разбираешь личный архив документов человека, живущего в Германии. " +
  "Документы бывают на немецком, английском и русском. " +
  "Отвечай только валидным JSON, без пояснений и без markdown-заборов.";

function buildPrompt(): string {
  return [
    "Разбери документ и верни JSON строго такой формы:",
    "{",
    '  "title": "короткое название, 2-6 слов, по-русски, без даты и без символов / \\\\ : * ? \\" < > |",',
    `  "category": "ровно одна из: ${CATEGORIES.join(" | ")}",`,
    '  "sender": "организация-отправитель или null",',
    '  "summary": "1-2 предложения по-русски: что это и о чём",',
    '  "docDate": "YYYY-MM-DD — дата САМОГО документа (письма, чека, счёта), не сегодняшняя; иначе null",',
    '  "dueDate": "YYYY-MM-DD — срок оплаты или ответа, если он назван; иначе null",',
    '  "amount": 123.45,',
    '  "currency": "EUR",',
    '  "language": "de | en | ru",',
    '  "actionNeeded": "что человеку нужно сделать, коротко по-русски; null если ничего",',
    '  "tags": ["3-8 тегов по-русски строчными буквами: тема, тип документа, участники"],',
    `  "entities": [{"kind": "один из: ${ENTITY_KINDS.join("|")}", "value": "как в документе"}],`,
    '  "fullText": "ВЕСЬ текст документа как есть, сохраняя переносы строк"',
    "}",
    "",
    "Правила:",
    `- если отправитель — одна из известных организаций, пиши РОВНО так: ${KNOWN_SENDERS.join(", ")};`,
    "- в entities обязательно вынеси номера: договора, клиента, счёта, дела (Aktenzeichen), IBAN, налоговый номер;",
    "- amount — итоговая сумма документа; если сумм нет, null;",
    '- fullText — дословная расшифровка, не пересказ. Не сокращай и не переводи.',
  ].join("\n");
}

/**
 * Один вызов модели на документ: и метаданные, и полная расшифровка текста.
 * fullText нужен полнотекстовому поиску — без него ищется только по карточке.
 */
export async function analyzeDocument(
  fileBuffer: Buffer,
  mime: string,
): Promise<{ analysis: Analysis; source: "ai" | "ocr" }> {
  const dir = await makeTempDir();
  const filePath = path.join(dir, "document" + extFor(mime));
  try {
    await writeFile(filePath, fileBuffer);
    const raw = await ask({
      system: SYSTEM,
      prompt: buildPrompt(),
      filePath,
      fileBuffer,
      mime,
      maxTokens: 16000,
    });
    const parsed = extractJson<Partial<Analysis>>(raw);
    if (!parsed?.category) throw new Error("модель не вернула разбор");
    return { analysis: sanitize(parsed), source: "ai" };
  } catch (err) {
    if (env.AI_PROVIDER === "off" || err instanceof AiUnavailable || isAiFailure(err)) {
      const text = await ocrFallback(fileBuffer, mime);
      return { analysis: fromOcrOnly(text), source: "ocr" };
    }
    throw err;
  } finally {
    await safeUnlink(filePath);
  }
}

function isAiFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ENOENT|not found|timed out|ETIMEDOUT|429|5\d\d|cli:/i.test(message);
}

export function sanitize(input: Partial<Analysis>): Analysis {
  const category =
    input.category && (CATEGORIES as readonly string[]).includes(input.category)
      ? input.category
      : FALLBACK_CATEGORY;

  return {
    title: cleanTitle(input.title) ?? "Документ без названия",
    category,
    sender: cleanString(input.sender, 120),
    summary: cleanString(input.summary, 2000) ?? "",
    docDate: validDate(input.docDate),
    dueDate: validDate(input.dueDate),
    amount: typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : null,
    currency: cleanString(input.currency, 8),
    language: cleanString(input.language, 8),
    actionNeeded: cleanString(input.actionNeeded, 500),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.filter((t): t is string => typeof t === "string")
          .map((t) => t.toLowerCase().trim())
          .filter((t) => t.length > 1 && t.length <= 40))].slice(0, 12)
      : [],
    entities: Array.isArray(input.entities)
      ? input.entities
          .filter((e): e is RawEntity => !!e && typeof e.value === "string" && e.value.trim().length > 1)
          .map((e) => ({
            kind: (ENTITY_KINDS as readonly string[]).includes(e.kind) ? e.kind : "other",
            value: e.value.trim().slice(0, 200),
          }))
          .slice(0, 40)
      : [],
    fullText: typeof input.fullText === "string" ? input.fullText.slice(0, 400_000) : "",
  };
}

function fromOcrOnly(text: string): Analysis {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 3);
  return sanitize({
    title: firstLine?.slice(0, 60) ?? "Документ без названия",
    category: FALLBACK_CATEGORY,
    summary: "Разобрано офлайн-OCR: модель была недоступна. Нажми «Переразобрать», когда связь вернётся.",
    fullText: text,
    tags: ["нужен-переразбор"],
  });
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed.slice(0, max);
}

export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
    .trim();
  return cleaned.length >= 3 ? cleaned : null;
}

export function validDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return null;
  const year = Number(raw.slice(0, 4));
  return year >= 1900 && year <= 2100 ? raw : null;
}
