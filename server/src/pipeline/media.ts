import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const KEEP_AS_IS = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

async function imagemagick(args: string[]): Promise<void> {
  try {
    await exec("magick", args, { timeout: 120_000 });
  } catch {
    await exec("convert", args, { timeout: 120_000 });
  }
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "docsorter-"));
}

export async function safeUnlink(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* уже нет — и хорошо */
  }
}

/**
 * Приводит вход к тому, что умеют и браузер, и модель: PDF/JPEG/PNG/WebP.
 * HEIC с айфона, TIFF со сканера и прочее конвертируется в JPEG.
 */
export async function normalize(
  buf: Buffer,
  mime: string,
  originalName: string,
): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  if (KEEP_AS_IS.has(mime)) {
    return { buffer: buf, mime, ext: extFor(mime) };
  }
  const dir = await makeTempDir();
  const src = path.join(dir, "src" + (path.extname(originalName) || ".bin"));
  const dst = path.join(dir, "out.jpg");
  try {
    await writeFile(src, buf);
    await imagemagick([src + "[0]", "-auto-orient", "-quality", "88", dst]);
    return { buffer: await readFile(dst), mime: "image/jpeg", ext: ".jpg" };
  } finally {
    await safeUnlink(src);
    await safeUnlink(dst);
  }
}

export function extFor(mime: string): string {
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  return ".jpg";
}

/** Превью 500 px по длинной стороне. Возвращает null, если сделать не вышло. */
export async function thumbnail(buf: Buffer, mime: string): Promise<Buffer | null> {
  const dir = await makeTempDir();
  const src = path.join(dir, "src" + extFor(mime));
  const dst = path.join(dir, "thumb.jpg");
  try {
    await writeFile(src, buf);
    if (mime === "application/pdf") {
      const base = path.join(dir, "page");
      await exec("pdftoppm", ["-jpeg", "-r", "60", "-f", "1", "-l", "1", src, base], {
        timeout: 60_000,
      });
      await imagemagick([base + "-1.jpg", "-resize", "500x500>", "-quality", "75", dst]);
      await safeUnlink(base + "-1.jpg");
    } else {
      await imagemagick([src, "-auto-orient", "-resize", "500x500>", "-quality", "75", dst]);
    }
    return await readFile(dst);
  } catch {
    return null;
  } finally {
    await safeUnlink(src);
    await safeUnlink(dst);
  }
}

export async function pdfPageCount(buf: Buffer): Promise<number | null> {
  const dir = await makeTempDir();
  const src = path.join(dir, "doc.pdf");
  try {
    await writeFile(src, buf);
    const { stdout } = await exec("pdfinfo", [src], { timeout: 30_000 });
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  } finally {
    await safeUnlink(src);
  }
}
