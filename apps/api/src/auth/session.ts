import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, Ctx } from '../context.js';
import { clients, sessions, staffProfiles, users } from '../db/schema.js';
import { randomToken, sha256 } from '../lib/crypto.js';

export const COOKIE = 'caixa_sid';
const FULL_TTL = 7 * 24 * 3600_000, MFA_TTL = 5 * 60_000;

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string, maxAgeMs: number) {
  reply.setCookie(COOKIE, token, { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: 'lax', path: '/', maxAge: Math.floor(maxAgeMs / 1000) });
}
export const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(COOKIE, { path: '/' });

export async function createSession(ctx: Ctx, req: FastifyRequest, reply: FastifyReply, userId: string, stage: 'mfa' | 'full') {
  const token = randomToken(32), csrf = randomToken(24), ttl = stage === 'full' ? FULL_TTL : MFA_TTL;
  const [row] = await ctx.db.insert(sessions).values({ userId, tokenHash: sha256(token), csrfToken: csrf, stage, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200), expiresAt: new Date(ctx.now().getTime() + ttl) }).returning({ id: sessions.id });
  setSessionCookie(ctx, reply, token, ttl);
  return { id: row.id, csrf };
}
export const revokeSession = (ctx: Ctx, id: string) => ctx.db.update(sessions).set({ revokedAt: ctx.now() }).where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
export const revokeAllSessions = (ctx: Ctx, userId: string, exceptId?: string) =>
  ctx.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).then((rows) => Promise.all(rows.filter((r) => r.id !== exceptId).map((r) => revokeSession(ctx, r.id))));

/** Resolve o cookie em Actor (sessão completa) ou em um desafio de 2FA pendente. */
export async function resolveSession(ctx: Ctx, req: FastifyRequest): Promise<void> {
  req.actor = null; req.mfaUserId = null; req.mfaSessionId = null;
  const token = req.cookies?.[COOKIE];
  if (!token) return;
  const [s] = await ctx.db.select().from(sessions).where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, ctx.now()))).limit(1);
  if (!s) return;
  const [u] = await ctx.db.select().from(users).where(eq(users.id, s.userId)).limit(1);
  if (!u || u.status !== 'active') return;
  if (s.stage === 'mfa') { req.mfaUserId = u.id; req.mfaSessionId = s.id; return; }
  let nome = u.email, role: Actor['role'] = 'client', clientId: string | null = null;
  let perms = { criar: false, clientes: false, excluir: false, lucro: false, todos: false };
  if (u.kind === 'staff') {
    const [p] = await ctx.db.select().from(staffProfiles).where(eq(staffProfiles.userId, u.id)).limit(1);
    if (!p) return;
    nome = p.nome; role = p.role as 'admin' | 'staff';
    const admin = role === 'admin';
    perms = { criar: admin || p.permCriar, clientes: admin || p.permClientes, excluir: admin || p.permExcluir, lucro: admin || p.permLucro, todos: admin || p.permTodos };
  } else {
    const [c] = await ctx.db.select().from(clients).where(eq(clients.userId, u.id)).limit(1);
    if (!c || c.deletedAt || c.anonymizedAt || !c.portalEnabled) return;
    nome = c.nome; clientId = c.id;
  }
  req.actor = { userId: u.id, orgId: u.orgId, kind: u.kind as 'staff' | 'client', role, nome, email: u.email, perms, clientId, sessionId: s.id, csrf: s.csrfToken, totpEnabled: u.totpEnabled, ip: req.ip, ua: String(req.headers['user-agent'] ?? '') };
}
