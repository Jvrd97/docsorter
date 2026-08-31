import { createWorker, PSM, type Worker } from "tesseract.js";
import { env } from "../env.js";
import { makeTempDir, safeUnlink, extFor } from "./media.js";
import { writeFile, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // Языковые модели скачиваются один раз и лежат на томе, а не в образе.
    workerPromise = createWorker(env.OCR_LANGUAGES.split("+"), 1, {
      cachePath: env.TESSDATA_DIR,
    }).then(async (worker) => {
      // Фото документа часто снято боком. Режим с определением ориентации
      // спасает такие страницы; если модель osd не подтянулась — работаем без него.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO_OSD }).catch(() => undefined);
      return worker;
    });
  }
  return workerPromise;
}

/**
 * Резерв на случай, когда модель недоступна: текстовый слой PDF,
 * иначе локальный Tesseract. Хуже по качеству, но документ не теряется.
 */
export async function ocrFallback(buf: Buffer, mime: string): Promise<string> {
  if (mime !== "application/pdf") return recognize(buf);

  const embedded = await pdfText(buf);
  if (embedded.trim().length > 50) return embedded;

  // Текстового слоя нет — значит это скан. Рендерим страницы в 200 dpi:
  // распознавать превью в 500 px бесполезно, из него выходит каша.
  const pages = await renderPdf(buf, 3);
  const texts: string[] = [];
  for (const page of pages) texts.push(await recognize(page));
  return texts.join("\n\n").trim() || embedded;
}

async function renderPdf(buf: Buffer, maxPages: number): Promise<Buffer[]> {
  const dir = await makeTempDir();
  const src = path.join(dir, "doc.pdf");
  const base = path.join(dir, "page");
  try {
    await writeFile(src, buf);
    await exec("pdftoppm", ["-jpeg", "-r", "200", "-f", "1", "-l", String(maxPages), src, base], {
      timeout: 180_000,
    });
    const names = (await readdir(dir)).filter((n) => n.startsWith("page-")).sort();
    const pages: Buffer[] = [];
    for (const name of names) {
      pages.push(await readFile(path.join(dir, name)));
      await safeUnlink(path.join(dir, name));
    }
    return pages;
  } catch {
    return [];
  } finally {
    await safeUnlink(src);
  }
}

async function recognize(image: Buffer): Promise<string> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return data.text ?? "";
  } catch {
    return "";
  }
}

async function pdfText(buf: Buffer): Promise<string> {
  const dir = await makeTempDir();
  const src = path.join(dir, "doc" + extFor("application/pdf"));
  const dst = path.join(dir, "doc.txt");
  try {
    await writeFile(src, buf);
    await exec("pdftotext", ["-layout", src, dst], { timeout: 60_000 });
    return await readFile(dst, "utf8");
  } catch {
    return "";
  } finally {
    await safeUnlink(src);
    await safeUnlink(dst);
  }
}

export async function shutdownOcr(): Promise<void> {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}
