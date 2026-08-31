import { randomBytes } from "node:crypto";
import { pool, query, one } from "../db.js";
import { createVaultMaterial } from "../crypto/vault.js";
import { askLine } from "./prompt.js";

const MIN_LENGTH = 24;

async function main(): Promise<void> {
  const login = process.argv[2] ?? (await askLine("Логин: "));
  if (!login) throw new Error("логин пустой");

  const existing = await one("SELECT id FROM users WHERE login=$1", [login]);
  if (existing) throw new Error(`пользователь ${login} уже есть`);

  let password = process.env.DOCSORTER_PASSWORD ?? "";
  if (!password) {
    console.log(
      `\nПароль от ${MIN_LENGTH} символов. Он же — ключ шифрования файлов:\n` +
        "восстановить его нельзя, забудешь — архив не откроется.\n" +
        "Пустой ввод сгенерирует случайный пароль на 64 символа.\n",
    );
    password = await askLine("Пароль: ", true);
    if (!password) {
      password = randomBytes(48).toString("base64url").slice(0, 64);
      console.log(`\nСгенерирован пароль (сохрани в менеджер паролей прямо сейчас):\n\n  ${password}\n`);
    } else {
      const repeat = await askLine("Пароль ещё раз: ", true);
      if (repeat !== password) throw new Error("пароли не совпали");
    }
  }
  if (password.length < MIN_LENGTH) throw new Error(`пароль короче ${MIN_LENGTH} символов`);

  const material = await createVaultMaterial(password);
  await query(
    "INSERT INTO users (login, password_hash, kdf_salt, wrapped_dek) VALUES ($1,$2,$3,$4)",
    [login, material.passwordHash, material.kdfSalt, material.wrappedDek],
  );
  console.log(`\nГотово: пользователь ${login} создан.`);
  console.log("Дальше: npm run user:totp — включить второй фактор.");
}

main()
  .catch((err) => {
    console.error("Ошибка:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
