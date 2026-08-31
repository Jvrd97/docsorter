import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";
import { seal, open } from "./blob.js";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// 2^16 * 8 * 128 ≈ 64 МБ на одну проверку пароля. Дорого для перебора,
// незаметно для одного входа в сутки даже на слабом сервере.
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };

const ARGON = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65536, // КиБ = 64 МБ
  timeCost: 3,
  parallelism: 1,
};

/** Хеш пароля для проверки входа. Не даёт ключ шифрования. */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(stored, password, ARGON);
  } catch {
    return false;
  }
}

/** KEK — ключ, которым завёрнут DEK. Выводится из пароля отдельно от хеша. */
export function deriveKek(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password, salt, 32, SCRYPT);
}

/** Новый пользователь: случайный DEK + его обёртка. */
export async function createVaultMaterial(password: string) {
  const kdfSalt = randomBytes(32);
  const dek = randomBytes(32);
  const kek = await deriveKek(password, kdfSalt);
  return { kdfSalt, wrappedDek: seal(dek, kek), passwordHash: await hashPassword(password) };
}

export async function unwrapDek(
  password: string,
  kdfSalt: Buffer,
  wrappedDek: Buffer,
): Promise<Buffer> {
  const kek = await deriveKek(password, kdfSalt);
  return open(wrappedDek, kek); // бросит, если пароль не тот — GCM-тег не сойдётся
}

/** Смена пароля без перешифровки файлов: перезаворачиваем тот же DEK. */
export async function rewrapDek(dek: Buffer, newPassword: string) {
  const kdfSalt = randomBytes(32);
  const kek = await deriveKek(newPassword, kdfSalt);
  return {
    kdfSalt,
    wrappedDek: seal(dek, kek),
    passwordHash: await hashPassword(newPassword),
  };
}

// ───────────────────────── состояние «хранилище открыто» ─────────────────────
// DEK живёт только в памяти процесса. Перезапуск сервера = хранилище заперто,
// пока кто-то не войдёт паролем. Это осознанный размен: иначе ключ пришлось бы
// держать на том же диске, что и данные, и шифрование потеряло бы смысл.

const unlocked = new Map<string, Buffer>();

export function unlock(userId: string, dek: Buffer): void {
  unlocked.set(userId, dek);
}

export function getDek(userId: string): Buffer | null {
  return unlocked.get(userId) ?? null;
}

export function lock(userId: string): void {
  const dek = unlocked.get(userId);
  if (dek) dek.fill(0);
  unlocked.delete(userId);
}

export function anyUnlockedUser(): string | null {
  const first = unlocked.keys().next();
  return first.done ? null : first.value;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
