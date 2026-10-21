import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authTokens, clients, staffProfiles, users } from '../db/schema.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { emailNorm, parse } from '../lib/http.js';
import { tpl } from '../lib/mailer.js';
import { enqueue } from '../lib/queue.js';
import { auditActor, needAdmin, needStaff } from '../auth/guards.js';
import { revokeAllSessions } from '../auth/session.js';
import { getSettings } from './me.js';

const permsShape = { permCriar: z.boolean(), permClientes: z.boolean(), permExcluir: z.boolean(), permLucro: z.boolean(), permTodos: z.boolean() };

/** Gera convite de uso único (7 dias). Devolve a URL para o admin também poder enviar por WhatsApp. */
export async function createInvite(ctx: Ctx, userId: string, orgId: string, nome: string, email: string) {
  await ctx.db.update(authTokens).set({ usedAt: ctx.now() }).where(and(eq(authTokens.userId, userId), eq(authTokens.kind, 'invite'), sql`${authTokens.usedAt} is null`));
  const token = randomToken(32);
  await ctx.db.insert(authTokens).values({ userId, kind: 'invite', tokenHash: sha256(token), expiresAt: new Date(ctx.now().getTime() + 7 * 24 * 3600_000) });
  const url = `${ctx.config.publicUrl}/#/convite/${token}`;
  const s = await getSettings(ctx, orgId);
  await enqueue(ctx, 'email', { to: email, ...tpl.invite(nome, url, s.empresa) });
  return url;
}

export async function staffRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const dto = (u: typeof users.$inferSelect, p: typeof staffProfiles.$inferSelect, n = 0) => ({
    id: u.id, nome: p.nome, email: u.email, role: p.role, status: u.status, totpEnabled: u.totpEnabled, comissaoBps: p.comissaoBps, lastLoginAt: u.lastLoginAt,
    perms: { criar: p.permCriar, clientes: p.permClientes, excluir: p.permExcluir, lucro: p.permLucro, todos: p.permTodos }, clientes: n,
  });

  app.get('/staff', async (req) => {
    const a = needStaff(req);
    const rows = await ctx.db.select({ u: users, p: staffProfiles }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(and(eq(users.orgId, a.orgId), eq(users.kind, 'staff')));
    const counts = await ctx.db.select({ r: clients.responsavelId, n: sql<number>`count(*)::int` }).from(clients).where(and(eq(clients.orgId, a.orgId), sql`${clients.deletedAt} is null`)).groupBy(clients.responsavelId);
    const m = new Map(counts.map((c) => [c.r, c.n]));
    const list = rows.map((r) => dto(r.u, r.p, m.get(r.u.id) ?? 0));
    // funcionário vê só nomes (para escolher responsável/filtrar); detalhes de acesso são do admin
    return a.role === 'admin' ? list : list.map((x) => ({ id: x.id, nome: x.nome, role: x.role, status: x.status }));
  });

  app.post('/staff', async (req, reply) => {
    const a = needAdmin(req);
    const b = parse(z.object({ nome: z.string().min(2).max(120), email: z.string().email(), role: z.enum(['admin', 'staff']).default('staff'), comissaoBps: z.number().int().min(0).max(10000).default(0), perms: z.object({ criar: z.boolean(), clientes: z.boolean(), excluir: z.boolean(), lucro: z.boolean(), todos: z.boolean() }).default({ criar: true, clientes: true, excluir: false, lucro: false, todos: false }) }), req.body);
    const email = emailNorm(b.email);
    const [dup] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.orgId, a.orgId), eq(users.email, email))).limit(1);
    if (dup) throw conflict('Já existe alguém com esse e-mail', 'email_em_uso');
    const [u] = await ctx.db.insert(users).values({ orgId: a.orgId, kind: 'staff', email, status: 'invited' }).returning();
    await ctx.db.insert(staffProfiles).values({ userId: u.id, nome: b.nome.trim(), role: b.role, comissaoBps: b.comissaoBps, permCriar: b.perms.criar, permClientes: b.perms.clientes, permExcluir: b.perms.excluir, permLucro: b.perms.lucro, permTodos: b.perms.todos });
    const inviteUrl = await createInvite(ctx, u.id, a.orgId, b.nome, email);
    await audit(ctx.db, auditActor(a), { action: 'equipe.criou', entity: 'user', entityId: u.id, summary: `Adicionou o funcionário ${b.nome} (${b.role})` }, ctx.now());
    reply.code(201);
    return { id: u.id, inviteUrl };
  });

  app.patch('/staff/:id', async (req) => {
    const a = needAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(z.object({ nome: z.string().min(2).max(120).optional(), role: z.enum(['admin', 'staff']).optional(), comissaoBps: z.number().int().min(0).max(10000).optional(), status: z.enum(['active', 'disabled']).optional(), transferTo: z.string().uuid().optional(),
      perms: z.object({ criar: z.boolean(), clientes: z.boolean(), excluir: z.boolean(), lucro: z.boolean(), todos: z.boolean() }).optional() }), req.body);
    const [row] = await ctx.db.select({ u: users, p: staffProfiles }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(and(eq(users.id, id), eq(users.orgId, a.orgId), eq(users.kind, 'staff'))).limit(1);
    if (!row) throw notFound('Funcionário não encontrado');
    const willBeAdmin = (b.role ?? row.p.role) === 'admin', willBeActive = (b.status ?? (row.u.status === 'disabled' ? 'disabled' : 'active')) === 'active';
    if (id === a.userId && b.status === 'disabled') throw badRequest('Você não pode desativar o próprio acesso');
    if (row.p.role === 'admin' && row.u.status !== 'disabled' && (!willBeAdmin || !willBeActive)) {
      const others = await ctx.db.select({ id: users.id }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(and(eq(users.orgId, a.orgId), eq(staffProfiles.role, 'admin'), sql`${users.status} <> 'disabled'`, sql`${users.id} <> ${id}`));
      if (!others.length) throw badRequest('Precisa existir ao menos um administrador ativo');
    }
    await ctx.db.transaction(async (tx) => {
      const set: Partial<typeof staffProfiles.$inferInsert> = {};
      if (b.nome) set.nome = b.nome.trim(); if (b.role) set.role = b.role; if (b.comissaoBps !== undefined) set.comissaoBps = b.comissaoBps;
      if (b.perms) Object.assign(set, { permCriar: b.perms.criar, permClientes: b.perms.clientes, permExcluir: b.perms.excluir, permLucro: b.perms.lucro, permTodos: b.perms.todos });
      if (Object.keys(set).length) await tx.update(staffProfiles).set(set).where(eq(staffProfiles.userId, id));
      if (b.status === 'disabled' && row.u.status !== 'disabled') {
        await tx.update(users).set({ status: 'disabled' }).where(eq(users.id, id));
        const dest = b.transferTo ?? a.userId;
        const moved = await tx.update(clients).set({ responsavelId: dest }).where(and(eq(clients.responsavelId, id), eq(clients.orgId, a.orgId))).returning({ id: clients.id });
        await audit(tx, auditActor(a), { action: 'equipe.desativou', entity: 'user', entityId: id, summary: `Desativou ${row.p.nome}${moved.length ? ` e transferiu ${moved.length} cliente(s)` : ''}` }, ctx.now());
      } else if (b.status === 'active' && row.u.status === 'disabled') {
        await tx.update(users).set({ status: row.u.passwordHash ? 'active' : 'invited' }).where(eq(users.id, id));
        await audit(tx, auditActor(a), { action: 'equipe.reativou', entity: 'user', entityId: id, summary: `Reativou ${row.p.nome}` }, ctx.now());
      }
      if (b.role || b.perms || b.nome || b.comissaoBps !== undefined) await audit(tx, auditActor(a), { action: 'equipe.editou', entity: 'user', entityId: id, summary: `Editou o funcionário ${b.nome ?? row.p.nome}`, meta: { role: b.role, perms: b.perms } }, ctx.now());
    });
    if (b.status === 'disabled') await revokeAllSessions(ctx, id);
    if (b.role && b.role !== row.p.role) await revokeAllSessions(ctx, id); // permissões mudam: força novo login
    return { ok: true };
  });

  app.post('/staff/:id/invite', async (req) => {
    const a = needAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await ctx.db.select({ u: users, p: staffProfiles }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(and(eq(users.id, id), eq(users.orgId, a.orgId))).limit(1);
    if (!row) throw notFound('Funcionário não encontrado');
    if (row.u.status === 'disabled') throw badRequest('Reative o acesso antes de convidar');
    const inviteUrl = await createInvite(ctx, id, a.orgId, row.p.nome, row.u.email);
    await audit(ctx.db, auditActor(a), { action: 'equipe.convite', entity: 'user', entityId: id, summary: `Gerou novo convite para ${row.p.nome}` }, ctx.now());
    return { inviteUrl };
  });
}
