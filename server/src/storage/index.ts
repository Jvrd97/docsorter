import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { seal, open } from "../crypto/blob.js";

/**
 * Блочное хранилище: файлы лежат на диске уже зашифрованными.
 * Ключ (DEK) в памяти процесса — на диске рядом с данными его нет.
 * Раскладка по двум уровням каталогов, чтобы не собрать 100 000 файлов в одной папке.
 */

function pathFor(key: string): string {
  const a = key.slice(0, 2);
  const b = key.slice(2, 4);
  return path.join(env.STORAGE_DIR, a, b, key);
}

export function newKey(ext = ""): string {
  return randomUUID().replace(/-/g, "") + ext;
}

export async function put(key: string, plain: Buffer, dek: Buffer): Promise<void> {
  const file = pathFor(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, seal(plain, dek), { mode: 0o600 });
}

export async function get(key: string, dek: Buffer): Promise<Buffer> {
  return open(await readFile(pathFor(key)), dek);
}

export async function remove(key: string): Promise<void> {
  try {
    await unlink(pathFor(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function exists(key: string): Promise<boolean> {
  try {
    await stat(pathFor(key));
    return true;
  } catch {
    return false;
  }
}

export async function ensureStorage(): Promise<void> {
  await mkdir(env.STORAGE_DIR, { recursive: true, mode: 0o700 });
}
