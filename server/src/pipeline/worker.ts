import { query, one } from "../db.js";
import { env } from "../env.js";
import { getDek } from "../crypto/vault.js";
import * as storage from "../storage/index.js";
import { analyzeDocument } from "./analyze.js";
import { buildLinks, saveEntities } from "./link.js";
import { embed, embeddingsEnabled, toVectorLiteral } from "./embeddings.js";
import { thumbnail, pdfPageCount } from "./media.js";
import type { FastifyBaseLogger } from "fastify";

interface Job {
  id: string;
  kind: string;
  payload: { documentId: string; userId: string };
  attempts: number;
}

const MAX_ATTEMPTS = 3;
let running = false;

export function startWorker(log: FastifyBaseLogger): () => void {
  running = true;
  const loops = Array.from({ length: Math.max(1, env.WORKER_CONCURRENCY) }, () => loop(log));
  return () => {
    running = false;
    void Promise.allSettled(loops);
  };
}

async function loop(log: FastifyBaseLogger): Promise<void> {
  while (running) {
    let picked = false;
    try {
      picked = await tick(log);
    } catch (err) {
      log.error({ err }, "сбой цикла обработчика");
    }
    if (!picked) await sleep(env.WORKER_POLL_MS);
  }
}

async function tick(log: FastifyBaseLogger): Promise<boolean> {
  const job = await claim();
  if (!job) return false;

  const dek = getDek(job.payload.userId);
  if (!dek) {
    // Хранилище заперто: ключа в памяти нет, файл не расшифровать.
    // Не тратим попытку — просто ждём, пока владелец войдёт.
    await query(
      "UPDATE jobs SET status='queued', run_after=now() + interval '30 seconds', attempts=attempts-1, updated_at=now() WHERE id=$1",
      [job.id],
    );
    return false;
  }

  try {
    if (job.kind === "analyze") await runAnalyze(job, dek, log);
    else if (job.kind === "link") await buildLinks(job.payload.documentId, job.payload.userId);
    else if (job.kind === "embed") await runEmbed(job);
    await query("UPDATE jobs SET status='done', updated_at=now() WHERE id=$1", [job.id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, job: job.id, kind: job.kind }, "задание упало");
    const dead = job.attempts >= MAX_ATTEMPTS;
    await query(
      `UPDATE jobs
          SET status = $2,
              last_error = $3,
              run_after = now() + ($4 || ' seconds')::interval,
              updated_at = now()
        WHERE id = $1`,
      [job.id, dead ? "failed" : "queued", message.slice(0, 2000), String(60 * job.attempts)],
    );
    if (dead && job.kind === "analyze") {
      await query("UPDATE documents SET status='failed', error=$2, updated_at=now() WHERE id=$1", [
        job.payload.documentId,
        message.slice(0, 2000),
      ]);
    }
  }
  return true;
}

async function claim(): Promise<Job | null> {
  const res = await query<Job>(
    `UPDATE jobs SET status='running', attempts=attempts+1, updated_at=now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE status='queued' AND run_after <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id::text, kind, payload, attempts`,
  );
  return res.rows[0] ?? null;
}

async function runAnalyze(job: Job, dek: Buffer, log: FastifyBaseLogger): Promise<void> {
  const doc = await one<{
    blob_key: string; mime: string; thumb_key: string | null;
    title: string | null; category: string | null; sender: string | null; doc_date: string | null;
  }>(
    "SELECT blob_key, mime, thumb_key, title, category, sender, doc_date FROM documents WHERE id=$1",
    [job.payload.documentId],
  );
  if (!doc) throw new Error("документ исчез из базы");

  await query("UPDATE documents SET status='processing', updated_at=now() WHERE id=$1", [
    job.payload.documentId,
  ]);

  const buffer = await storage.get(doc.blob_key, dek);

  if (!doc.thumb_key) {
    const thumb = await thumbnail(buffer, doc.mime);
    if (thumb) {
      const key = storage.newKey(".jpg");
      await storage.put(key, thumb, dek);
      await query("UPDATE documents SET thumb_key=$2 WHERE id=$1", [job.payload.documentId, key]);
    }
  }

  const pages = doc.mime === "application/pdf" ? await pdfPageCount(buffer) : 1;
  const { analysis, source } = await analyzeDocument(buffer, doc.mime);
  log.info({ doc: job.payload.documentId, source }, "документ разобран");

  // Офлайн-OCR даёт слабый разбор. Если карточка уже была заполнена (подсказкой
  // при импорте или руками), её значения важнее — не затираем их мусором.
  const keep = source === "ocr";
  const title    = keep ? doc.title    ?? analysis.title    : analysis.title;
  const category = keep ? doc.category ?? analysis.category : analysis.category;
  const sender   = keep ? doc.sender   ?? analysis.sender   : analysis.sender;
  const docDate  = keep ? doc.doc_date ?? analysis.docDate  : analysis.docDate;

  await query(
    `UPDATE documents SET
        status='ready', title=$2, category=$3, sender=$4, summary=$5,
        doc_date=$6, due_date=$7, amount=$8, currency=$9, language=$10,
        action_needed=$11, tags=$12, full_text=$13, ai_raw=$14,
        page_count=$15, error=NULL, processed_at=now(), updated_at=now()
      WHERE id=$1`,
    [
      job.payload.documentId,
      title,
      category,
      sender,
      analysis.summary,
      docDate,
      analysis.dueDate,
      analysis.amount,
      analysis.currency,
      analysis.language,
      analysis.actionNeeded,
      analysis.tags,
      analysis.fullText,
      JSON.stringify({ source, ...analysis, fullText: undefined }),
      pages,
    ],
  );

  await saveEntities(job.payload.documentId, analysis.entities);
  await enqueue("link", job.payload);
  if (embeddingsEnabled) await enqueue("embed", job.payload);
}

async function runEmbed(job: Job): Promise<void> {
  const doc = await one<{ title: string; summary: string; full_text: string; tags: string[] }>(
    "SELECT coalesce(title,'') title, coalesce(summary,'') summary, coalesce(full_text,'') full_text, tags FROM documents WHERE id=$1",
    [job.payload.documentId],
  );
  if (!doc) return;
  const vector = await embed(
    [doc.title, doc.tags.join(" "), doc.summary, doc.full_text].join("\n").slice(0, 30_000),
  );
  if (!vector) return;
  await query("UPDATE documents SET embedding=$2::vector WHERE id=$1", [
    job.payload.documentId,
    toVectorLiteral(vector),
  ]);
}

export async function enqueue(
  kind: "analyze" | "link" | "embed",
  payload: { documentId: string; userId: string },
): Promise<void> {
  await query("INSERT INTO jobs (kind, payload) VALUES ($1, $2)", [kind, JSON.stringify(payload)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
