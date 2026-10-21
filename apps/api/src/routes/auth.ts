import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authTokens, clients, settings, staffProfiles, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword, hmac, openString, randomCode, safeEqual, sha256, totpVerify, verifyPassword } from '../lib/crypto.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { emailNorm, parse } from '../lib/http.js';
import { tpl } from '../lib/mailer.js';
import { enqueue } from '../lib/queue.js';
import { assertNotLocked, clearFailures, registerFailure } from '../auth/throttle.js';
import { clearSessionCookie, createSession, revokeAllSessions, revokeSession } from '../auth/session.js';
import { meDto } from './me.js';

export const passwordSchema = z.string().min(8, 'A senha precisa de 8+ caracteres').max(200);
const sys = (orgId: string, ip?: string) => ({ orgId, userId: null, kind: 'system' as const, nome: 'Sistema', ip });
const DUMMY = '$argon2id$v=19$m=1024,t=1,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXU';

export async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const tight = { config: { rateLimit: { max: ctx.config.env === 'test' ? 10_000 : 20, timeWindow: '1 minute' } } };

  app.post('/auth/login', tight, async (req, reply) => {
    const b = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
    const email = emailNorm(b.email), kAcct = 'acct:' + email, kIp = 'ip:' + req.ip;
    await assertNotLocked(ctx, kAcct); await assertNotLocked(ctx, kIp);
    const [u] = await ctx.db.select().from(users).where(eq(users.email, email)).limit(1);
    const okPw = u ? await verifyPassword(u.passwordHash, b.password) : (await verifyPassword(DUMMY, b.password), false);
    if (!u || !okPw || u.status === 'invited') {
      const locked = await registerFailure(ctx, kAcct, 5); await registerFailure(ctx, kIp, 30);
      if (u) await audit(ctx.db, sys(u.orgId, req.ip), { action: 'login.falha', entity: 'user', entityId: u.id, summary: `Senha incorreta para ${email}` }, ctx.now());
      throw new HttpError(401, locked ? 'Muitas tentativas. Tente de novo em 5 min.' : 'E-mail ou senha incorretos.', 'credenciais');
    }
    if (u.status === 'disabled') throw forbidden('Acesso desativado. Fale com o administrador.');
    await clearFailures(ctx, kAcct);
    if (u.totpEnabled) {
      await createSession(ctx, req, reply, u.id, 'mfa');
      return { mfa: true };
    }
    const s = await createSession(ctx, req, reply, u.id, 'full');
    await ctx.db.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, u.id));
    await audit(ctx.db, { orgId: u.orgId, userId: u.id, kind: u.kind as 'staff' | 'client', nome: email, ip: req.ip, ua: String(req.headers['user-agent'] ?? '') }, { action: 'login.ok', entity: 'user', entityId: u.id, summary: 'Entrou no sistema' }, ctx.now());
    return { mfa: false, csrf: s.csrf, me: await meDto(ctx, u.id) };
  });

  app.post('/auth/2fa', tight, async (req, reply) => {
    if (!req.mfaUserId || !req.mfaSessionId) throw unauthorized('Faça login novamente');
    const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    const key = 'mfa:' + req.mfaUserId;
    await assertNotLocked(ctx, key);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, req.mfaUserId)).limit(1);
    if (!u?.totpSecretEnc || !totpVerify(openString(ctx.config.fileKey, u.totpSecretEnc), code, ctx.now().getTime())) {
      const locked = await registerFailure(ctx, key, 5);
      if (locked) await revokeSession(ctx, req.mfaSessionId);
      throw new HttpError(401, locked ? 'Muitas tentativas. Aguarde 5 min.' : 'Código incorreto.', 'codigo_incorreto');
    }
    await clearFailures(ctx, key);
    await revokeSession(ctx, req.mfaSessionId); // rotaciona a sessão (evita fixação)
    const s = await createSession(ctx, req, reply, u.id, 'full');
    await ctx.db.update(users).set({ lastLoginAt: ctx.now() }).where(eq(users.id, u.id));
    await audit(ctx.db, { orgId: u.orgId, userId: u.id, kind: u.kind as 'staff' | 'client', nome: u.email, ip: req.ip }, { action: 'login.ok', entity: 'user', entityId: u.id, summary: 'Entrou no sistema (2FA)' }, ctx.now());
    return { mfa: false, csrf: s.csrf, me: await meDto(ctx, u.id) };
  });

  app.post('/auth/logout', async (req, reply) => {
    const id = req.actor?.sessionId ?? req.mfaSessionId;
    if (id) await revokeSession(ctx, id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---- recuperação de senha: resposta sempre igual (não revela se o e-mail existe) ----
  app.post('/auth/forgot', tight, async (req) => {
    const { email: raw } = parse(z.object({ email: z.string().email() }), req.body);
    const email = emailNorm(raw);
    const generic = { ok: true, message: 'Se o e-mail existir, enviamos um código de 6 dígitos.' };
    if (await assertNotLocked(ctx, 'forgot:' + email).then(() => false, () => true)) return generic;
    const [u] = await ctx.db.select().from(users).where(and(eq(users.email, email), eq(users.status, 'active'))).limit(1);
    await registerFailure(ctx, 'forgot:' + email, 5); // no máx. 5 pedidos por janela
    if (u) {
      const code = randomCode(), nome = await displayName(ctx, u.id);
      await ctx.db.update(authTokens).set({ usedAt: ctx.now() }).where(and(eq(authTokens.userId, u.id), eq(authTokens.kind, 'reset'), isNull(authTokens.usedAt)));
      await ctx.db.insert(authTokens).values({ userId: u.id, kind: 'reset', tokenHash: hmac(ctx.config.secret, u.id + ':' + code), expiresAt: new Date(ctx.now().getTime() + 15 * 60_000) });
      const t = tpl.reset(code);
      await enqueue(ctx, 'email', { to: u.email, ...t, nome });
      await audit(ctx.db, sys(u.orgId, req.ip), { action: 'senha.codigo_enviado', entity: 'user', entityId: u.id, summary: 'Pedido de recuperação de senha' }, ctx.now());
    }
    return generic;
  });

  app.post('/auth/reset', tight, async (req) => {
    const b = parse(z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/), password: passwordSchema }), req.body);
    const email = emailNorm(b.email);
    const bad = () => badRequest('Código inválido ou expirado', 'codigo_invalido');
    const [u] = await ctx.db.select().from(users).where(and(eq(users.email, email), eq(users.status, 'active'))).limit(1);
    if (!u) throw bad();
    const [t] = await ctx.db.select().from(authTokens).where(and(eq(authTokens.userId, u.id), eq(authTokens.kind, 'reset'), isNull(authTokens.usedAt), gt(authTokens.expiresAt, ctx.now()))).orderBy(desc(authTokens.createdAt)).limit(1);
    if (!t || t.attempts >= 5) throw bad();
    if (!safeEqual(t.tokenHash, hmac(ctx.config.secret, u.id + ':' + b.code))) {
      await ctx.db.update(authTokens).set({ attempts: sql`${authTokens.attempts} + 1` }).where(eq(authTokens.id, t.id));
      throw bad();
    }
    const used = await ctx.db.update(authTokens).set({ usedAt: ctx.now() }).where(and(eq(authTokens.id, t.id), isNull(authTokens.usedAt))).returning({ id: authTokens.id });
    if (!used.length) throw bad(); // uso único, mesmo sob concorrência
    await ctx.db.update(users).set({ passwordHash: await hashPassword(b.password, ctx.light) }).where(eq(users.id, u.id));
    await revokeAllSessions(ctx, u.id);
    await clearFailures(ctx, 'acct:' + email);
    await audit(ctx.db, { orgId: u.orgId, userId: u.id, kind: u.kind as 'staff' | 'client', nome: email, ip: req.ip }, { action: 'senha.redefinida', entity: 'user', entityId: u.id, summary: 'Redefiniu a senha por código' }, ctx.now());
    return { ok: true };
  });

  // ---- convite: define a primeira senha (equipe e clientes) ----
  app.post('/auth/invite/accept', tight, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(100), password: passwordSchema }), req.body);
    const [t] = await ctx.db.select().from(authTokens).where(and(eq(authTokens.kind, 'invite'), eq(authTokens.tokenHash, sha256(b.token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, ctx.now()))).limit(1);
    if (!t) throw badRequest('Convite inválido ou expirado', 'convite_invalido');
    const used = await ctx.db.update(authTokens).set({ usedAt: ctx.now() }).where(and(eq(authTokens.id, t.id), isNull(authTokens.usedAt))).returning({ id: authTokens.id });
    if (!used.length) throw badRequest('Convite inválido ou expirado', 'convite_invalido');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, t.userId)).limit(1);
    if (!u || u.status === 'disabled') throw forbidden('Acesso desativado');
    await ctx.db.update(users).set({ passwordHash: await hashPassword(b.password, ctx.light), status: 'active' }).where(eq(users.id, u.id));
    await audit(ctx.db, { orgId: u.orgId, userId: u.id, kind: u.kind as 'staff' | 'client', nome: u.email, ip: req.ip }, { action: 'convite.aceito', entity: 'user', entityId: u.id, summary: 'Criou a senha pelo convite' }, ctx.now());
    return { ok: true, email: u.email };
  });
}

export async function displayName(ctx: { db: import('../db/index.js').Db }, userId: string): Promise<string> {
  const [p] = await ctx.db.select({ nome: staffProfiles.nome }).from(staffProfiles).where(eq(staffProfiles.userId, userId)).limit(1);
  if (p) return p.nome;
  const [c] = await ctx.db.select({ nome: clients.nome }).from(clients).where(eq(clients.userId, userId)).limit(1);
  return c?.nome ?? '';
}
