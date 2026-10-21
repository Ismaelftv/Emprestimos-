import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context.js';
import { clients, settings, staffProfiles, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword, newTotpSecret, openString, sealString, totpUri, totpVerify, verifyPassword } from '../lib/crypto.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { auditActor, needActor } from '../auth/guards.js';
import { revokeAllSessions } from '../auth/session.js';
import { passwordSchema } from './auth.js';

export async function getSettings(ctx: Pick<Ctx, 'db'>, orgId: string) {
  const [s] = await ctx.db.select().from(settings).where(eq(settings.orgId, orgId)).limit(1);
  return s!;
}
export function publicConfig(s: Awaited<ReturnType<typeof getSettings>>) {
  return { empresa: s.empresa, pixKey: s.pixKey, pixNome: s.pixNome, aceitaPix: s.aceitaPix, aceitaDinheiro: s.aceitaDinheiro, whatsapp: s.whatsapp,
    minValorCents: s.minValorCents, maxValorCents: s.maxValorCents, maxParcelas: s.maxParcelas, taxasBps: s.taxasBps, multaBps: s.multaBps, moraBpsMes: s.moraBpsMes, descQuitBps: s.descQuitBps };
}

export async function meDto(ctx: Ctx, userId: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  const s = await getSettings(ctx, u.orgId);
  const base = { id: u.id, kind: u.kind, email: u.email, totpEnabled: u.totpEnabled, config: publicConfig(s) } as Record<string, unknown>;
  if (u.kind === 'staff') {
    const [p] = await ctx.db.select().from(staffProfiles).where(eq(staffProfiles.userId, u.id)).limit(1);
    const admin = p.role === 'admin';
    Object.assign(base, { nome: p.nome, role: p.role, perms: { criar: admin || p.permCriar, clientes: admin || p.permClientes, excluir: admin || p.permExcluir, lucro: admin || p.permLucro, todos: admin || p.permTodos },
      mustSetup2fa: admin && s.exigir2faAdmin && !u.totpEnabled });
  } else {
    const [c] = await ctx.db.select().from(clients).where(eq(clients.userId, u.id)).limit(1);
    Object.assign(base, { role: 'client', nome: c?.nome ?? '', clientId: c?.id, situacao: c?.situacao, bloqueado: c?.bloqueado, limiteCents: c?.limiteCents, whatsapp: c?.whatsapp, cidade: c?.cidade });
  }
  return base;
}

export async function meRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.get('/me', async (req) => {
    const a = needActor(req);
    return { ...(await meDto(ctx, a.userId)), csrf: a.csrf };
  });

  app.post('/me/password', async (req) => {
    const a = needActor(req);
    const b = parse(z.object({ current: z.string().min(1), next: passwordSchema }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.userId)).limit(1);
    if (!(await verifyPassword(u.passwordHash, b.current))) throw badRequest('Senha atual incorreta', 'senha_incorreta');
    await ctx.db.update(users).set({ passwordHash: await hashPassword(b.next, ctx.light) }).where(eq(users.id, a.userId));
    await revokeAllSessions(ctx, a.userId, a.sessionId);
    await audit(ctx.db, auditActor(a), { action: 'senha.alterada', entity: 'user', entityId: a.userId, summary: 'Alterou a própria senha' }, ctx.now());
    return { ok: true };
  });

  // ---- 2FA TOTP ----
  app.post('/me/2fa/setup', async (req) => {
    const a = needActor(req);
    if (a.totpEnabled) throw badRequest('O 2FA já está ativo');
    const secret = newTotpSecret();
    await ctx.db.update(users).set({ totpSecretEnc: sealString(ctx.config.fileKey, secret) }).where(eq(users.id, a.userId));
    return { secret, uri: totpUri(secret, a.email) };
  });
  app.post('/me/2fa/enable', async (req) => {
    const a = needActor(req);
    const { code } = parse(z.object({ code: z.string().length(6) }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.userId)).limit(1);
    if (!u.totpSecretEnc) throw badRequest('Inicie a configuração do 2FA primeiro');
    if (!totpVerify(openString(ctx.config.fileKey, u.totpSecretEnc), code, ctx.now().getTime())) throw badRequest('Código incorreto', 'codigo_incorreto');
    await ctx.db.update(users).set({ totpEnabled: true }).where(eq(users.id, a.userId));
    await audit(ctx.db, auditActor(a), { action: '2fa.ativado', entity: 'user', entityId: a.userId, summary: 'Ativou o 2FA' }, ctx.now());
    return { ok: true };
  });
  app.post('/me/2fa/disable', async (req) => {
    const a = needActor(req);
    const b = parse(z.object({ password: z.string().min(1), code: z.string().length(6) }), req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, a.userId)).limit(1);
    if (!u.totpEnabled || !u.totpSecretEnc) throw badRequest('O 2FA não está ativo');
    if (a.role === 'admin' && (await getSettings(ctx, a.orgId)).exigir2faAdmin) throw forbidden('O 2FA é obrigatório para administradores');
    if (!(await verifyPassword(u.passwordHash, b.password))) throw badRequest('Senha incorreta', 'senha_incorreta');
    if (!totpVerify(openString(ctx.config.fileKey, u.totpSecretEnc), b.code, ctx.now().getTime())) throw badRequest('Código incorreto', 'codigo_incorreto');
    await ctx.db.update(users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(users.id, a.userId));
    await audit(ctx.db, auditActor(a), { action: '2fa.desativado', entity: 'user', entityId: a.userId, summary: 'Desativou o 2FA' }, ctx.now());
    return { ok: true };
  });
}
