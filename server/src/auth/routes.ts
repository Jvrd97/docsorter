import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as OTPAuth from "otpauth";
import { query, one } from "../db.js";
import { env } from "../env.js";
import {
  verifyPassword, unwrapDek, unlock, lock, getDek, rewrapDek,
} from "../crypto/vault.js";
import {
  createSession, destroySession, requireAuth, clientIp, audit,
} from "./session.js";

const credentials = z.object({
  login: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
  totp: z.string().trim().max(10).optional(),
});

interface UserRow {
  id: string;
  login: string;
  password_hash: string;
  kdf_salt: Buffer;
  wrapped_dek: Buffer;
  totp_secret: string | null;
  failed_count: number;
  locked_until: Date | null;
}

function checkTotp(secret: string, token: string | undefined): boolean {
  if (!token) return false;
  const totp = new OTPAuth.TOTP({
    issuer: "DocSorter",
    label: "DocSorter",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
  return totp.validate({ token: token.replace(/\s/g, ""), window: 1 }) !== null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const parsed = credentials.safeParse(request.body);
      const ip = clientIp(request);
      if (!parsed.success) return reply.code(400).send({ error: "неверный запрос" });

      const user = await one<UserRow>("SELECT * FROM users WHERE login=$1", [parsed.data.login]);
      // Одинаковый ответ и на несуществующий логин, и на неверный пароль:
      // иначе форма превращается в проверялку «есть ли такой пользователь».
      if (!user) {
        await audit(null, ip, "login_fail", { login: parsed.data.login, reason: "нет пользователя" });
        return reply.code(401).send({ error: "неверный логин или пароль" });
      }

      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        const minutes = Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000);
        return reply.code(429).send({ error: `вход заблокирован ещё на ${minutes} мин` });
      }

      const passwordOk = await verifyPassword(user.password_hash, parsed.data.password);
      const totpOk = user.totp_secret ? checkTotp(user.totp_secret, parsed.data.totp) : true;

      if (!passwordOk || !totpOk) {
        const failed = user.failed_count + 1;
        const lockNow = failed >= env.MAX_LOGIN_ATTEMPTS;
        await query(
          `UPDATE users SET failed_count=$2,
                            locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
            WHERE id=$1`,
          [user.id, lockNow ? 0 : failed, lockNow, String(env.LOCKOUT_MINUTES)],
        );
        await audit(user.id, ip, "login_fail", { reason: passwordOk ? "totp" : "пароль", failed });
        if (user.totp_secret && passwordOk && !parsed.data.totp) {
          return reply.code(401).send({ error: "нужен код из приложения", needTotp: true });
        }
        return reply.code(401).send({ error: "неверный логин или пароль" });
      }

      if (env.REQUIRE_TOTP && !user.totp_secret) {
        return reply.code(403).send({ error: "второй фактор обязателен, но не настроен" });
      }

      let dek: Buffer;
      try {
        dek = await unwrapDek(parsed.data.password, user.kdf_salt, user.wrapped_dek);
      } catch {
        await audit(user.id, ip, "login_fail", { reason: "не открылся ключ" });
        return reply.code(401).send({ error: "неверный логин или пароль" });
      }

      unlock(user.id, dek);
      await query("UPDATE users SET failed_count=0, locked_until=NULL WHERE id=$1", [user.id]);
      await createSession(user.id, request, reply);
      await audit(user.id, ip, "login_ok");
      return { login: user.login, vaultUnlocked: true, totpEnabled: !!user.totp_secret };
    },
  );

  // После перезапуска сервера сессия ещё жива, а ключ из памяти пропал.
  // Этот маршрут открывает хранилище заново, не заставляя логиниться с нуля.
  app.post(
    "/api/auth/unlock",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = z.object({ password: z.string().min(1) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "неверный запрос" });

      const user = await one<UserRow>("SELECT * FROM users WHERE id=$1", [request.userId]);
      if (!user) return reply.code(401).send({ error: "не авторизован" });

      if (!(await verifyPassword(user.password_hash, body.data.password))) {
        await audit(user.id, clientIp(request), "unlock_fail");
        return reply.code(401).send({ error: "неверный пароль" });
      }
      unlock(user.id, await unwrapDek(body.data.password, user.kdf_salt, user.wrapped_dek));
      await audit(user.id, clientIp(request), "unlock");
      return { vaultUnlocked: true };
    },
  );

  app.post("/api/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    lock(request.userId!);
    await destroySession(request, reply);
    await audit(request.userId!, clientIp(request), "logout");
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireAuth }, async (request) => {
    const user = await one<{ totp_secret: string | null }>(
      "SELECT totp_secret FROM users WHERE id=$1",
      [request.userId],
    );
    return {
      login: request.login,
      vaultUnlocked: !!getDek(request.userId!),
      totpEnabled: !!user?.totp_secret,
    };
  });

  app.post("/api/auth/password", { preHandler: requireAuth }, async (request, reply) => {
    const body = z
      .object({ oldPassword: z.string().min(1), newPassword: z.string().min(16) })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "новый пароль короче 16 символов" });
    }
    const user = await one<UserRow>("SELECT * FROM users WHERE id=$1", [request.userId]);
    if (!user || !(await verifyPassword(user.password_hash, body.data.oldPassword))) {
      return reply.code(401).send({ error: "старый пароль не подошёл" });
    }
    // Файлы не перешифровываем: меняется только обёртка вокруг того же DEK.
    const dek = await unwrapDek(body.data.oldPassword, user.kdf_salt, user.wrapped_dek);
    const next = await rewrapDek(dek, body.data.newPassword);
    await query(
      "UPDATE users SET password_hash=$2, kdf_salt=$3, wrapped_dek=$4 WHERE id=$1",
      [user.id, next.passwordHash, next.kdfSalt, next.wrappedDek],
    );
    await query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
    await audit(user.id, clientIp(request), "password_change");
    return { ok: true, reloginRequired: true };
  });

  app.get("/api/auth/sessions", { preHandler: requireAuth }, async (request) => {
    const { rows } = await query(
      `SELECT id, user_agent, ip, created_at, last_seen, expires_at
         FROM sessions WHERE user_id=$1 ORDER BY last_seen DESC`,
      [request.userId],
    );
    return { sessions: rows };
  });

  app.delete("/api/auth/sessions", { preHandler: requireAuth }, async (request) => {
    await query("DELETE FROM sessions WHERE user_id=$1", [request.userId]);
    lock(request.userId!);
    return { ok: true };
  });
}
