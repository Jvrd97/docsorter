import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { userInfo } from "node:os";
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

/**
 * Проверяем право на запись при старте, а не при первой загрузке документа.
 * Классический случай: том смонтирован от root, контейнер работает под
 * непривилегированным пользователем — тогда EACCES вылезал бы только на
 * загрузке, уже после ответа «сервер готов».
 */
export async function ensureStorage(): Promise<void> {
  const probe = path.join(env.STORAGE_DIR, ".write-test");
  try {
    await mkdir(env.STORAGE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(probe, "ok");
    await unlink(probe);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `нет прав на запись в ${env.STORAGE_DIR} (процесс работает под uid ${process.getuid?.() ?? "?"}, ` +
          `${userInfo().username}). Скорее всего том смонтирован от root: ` +
          "используй именованный том или выставь владельца каталогу на хосте.",
      );
    }
    throw err;
  }
}
