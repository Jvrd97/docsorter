import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { query, one } from "../db.js";
import { env } from "../env.js";
import { getDek } from "../crypto/vault.js";

export const COOKIE = "ds_session";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    login?: string;
  }
}

export async function createSession(
  userId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const id = randomBytes(32).toString("hex");
  await query(
    `INSERT INTO sessions (id, user_id, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' hours')::interval)`,
    [id, userId, request.headers["user-agent"] ?? null, clientIp(request), String(env.SESSION_TTL_HOURS)],
  );
  reply.setCookie(COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    signed: true,
    maxAge: env.SESSION_TTL_HOURS * 3600,
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = readCookie(request);
  if (id) await query("DELETE FROM sessions WHERE id=$1", [id]);
  reply.clearCookie(COOKIE, { path: "/" });
}

function readCookie(request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip;
}

/** Пускает дальше только с живой сессией. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const id = readCookie(request);
  if (!id) return void reply.code(401).send({ error: "не авторизован" });

  const session = await one<{ user_id: string; login: string }>(
    `SELECT s.user_id, u.login FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  if (!session) {
    reply.clearCookie(COOKIE, { path: "/" });
    return void reply.code(401).send({ error: "сессия истекла" });
  }

  request.userId = session.user_id;
  request.login = session.login;
  void query("UPDATE sessions SET last_seen=now() WHERE id=$1", [id]);
}

/** Дополнительно требует, чтобы хранилище было открыто (DEK в памяти). */
export async function requireVault(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;
  if (!getDek(request.userId!)) {
    reply.code(423).send({ error: "хранилище заперто", needUnlock: true });
  }
}

export async function audit(
  userId: string | null,
  ip: string,
  action: string,
  detail?: unknown,
): Promise<void> {
  await query("INSERT INTO audit_log (user_id, ip, action, detail) VALUES ($1,$2,$3,$4)", [
    userId,
    ip,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}
