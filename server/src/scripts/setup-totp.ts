import * as OTPAuth from "otpauth";
import { pool, query, one } from "../db.js";
import { askLine } from "./prompt.js";

async function main(): Promise<void> {
  const login = process.argv[2] ?? (await askLine("Логин: "));
  const user = await one<{ id: string; totp_secret: string | null }>(
    "SELECT id, totp_secret FROM users WHERE login=$1",
    [login],
  );
  if (!user) throw new Error("нет такого пользователя");
  if (user.totp_secret) {
    const answer = await askLine("Второй фактор уже настроен. Перевыпустить? (да/нет): ");
    if (answer.toLowerCase() !== "да") return;
  }

  const totp = new OTPAuth.TOTP({
    issuer: "DocSorter",
    label: login,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });

  console.log("\nДобавь в приложение-аутентификатор одним из двух способов.\n");
  console.log("Ссылка (открой на телефоне):\n");
  console.log("  " + totp.toString() + "\n");
  console.log("Или введи ключ вручную:\n");
  console.log("  " + totp.secret.base32 + "\n");

  const code = await askLine("Введи код из приложения для проверки: ");
  if (totp.validate({ token: code.replace(/\s/g, ""), window: 1 }) === null) {
    throw new Error("код не подошёл — ничего не сохранил");
  }

  await query("UPDATE users SET totp_secret=$2 WHERE id=$1", [user.id, totp.secret.base32]);
  console.log("\nГотово: второй фактор включён.");
}

main()
  .catch((err) => {
    console.error("Ошибка:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
