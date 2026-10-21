import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { cpfOk, normalizeWhatsApp } from '@caixa/core';
import { clientDocuments, clients, loans, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { readUpload, saveFile } from '../lib/files.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { emailNorm, parse } from '../lib/http.js';
import { auditActor, needActor, needPerm, needStaff } from '../auth/guards.js';
import { revokeAllSessions } from '../auth/session.js';
import { clientScope, visibleClient } from '../services/scope.js';
import { clientDto, cpfDigits, DOC_TIPOS, documentsOf, sealCpf } from '../services/clients.js';
import { createInvite } from './staff.js';
import { clientSummaries } from '../services/loans.js';

const cpfField = z.string().refine((v) => cpfOk(v), 'CPF inválido');

export async function clientRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const idParam = z.object({ id: z.string().uuid() });
  async function assertStaff(userId: string, orgId: string) {
    const [u] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.orgId, orgId), eq(users.kind, 'staff'), eq(users.status, 'active'))).limit(1);
    if (!u) throw badRequest('Responsável inválido');
  }
  async function assertCpfFree(hash: string, orgId: string) {
    const [d] = await ctx.db.select({ id: clients.id }).from(clients).where(and(eq(clients.orgId, orgId), eq(clients.cpfHash, hash), sql`${clients.deletedAt} is null`)).limit(1);
    if (d) throw conflict('Já existe um cliente com esse CPF', 'cpf_em_uso');
  }

  app.get('/clients', async (req) => {
    const a = needStaff(req);
    const q = parse(z.object({ q: z.string().max(80).optional() }), req.query).q?.trim();
    const where = q ? and(clientScope(a), or(ilike(clients.nome, `%${q.replace(/[%_]/g, '')}%`), ilike(clients.whatsapp, `%${q.replace(/\D/g, '') || '@@'}%`))) : clientScope(a);
    const rows = await ctx.db.select().from(clients).where(where).orderBy(desc(clients.createdAt)).limit(500);
    const sums = await clientSummaries(ctx, a.orgId, rows.map((r) => r.id));
    return Promise.all(rows.map(async (c) => ({ ...(await clientDto(ctx, c, { fullCpf: false })), resumo: sums.get(c.id) ?? { abertas: 0, emAbertoCents: 0, atrasado: false } })));
  });

  app.post('/clients', async (req, reply) => {
    const a = needPerm(req, 'clientes');
    const b = parse(z.object({ nome: z.string().min(2).max(120), whatsapp: z.string().max(30).default(''), cpf: cpfField.optional().or(z.literal('')), cidade: z.string().max(80).default(''), obs: z.string().max(500).default(''), responsavelId: z.string().uuid().optional() }), req.body);
    if (b.responsavelId && b.responsavelId !== a.userId && a.role !== 'admin') throw forbidden('Só o administrador escolhe outro responsável');
    const resp = b.responsavelId ?? a.userId;
    if (resp !== a.userId) await assertStaff(resp, a.orgId);
    const seal = b.cpf ? sealCpf(ctx, b.cpf) : null;
    if (seal) await assertCpfFree(seal.cpfHash, a.orgId);
    const [c] = await ctx.db.insert(clients).values({ orgId: a.orgId, nome: b.nome.trim(), whatsapp: b.whatsapp.trim(), cidade: b.cidade, obs: b.obs, responsavelId: resp, ...(seal ?? {}) }).returning();
    await audit(ctx.db, auditActor(a), { action: 'cliente.criou', entity: 'client', entityId: c.id, summary: `Cadastrou o cliente ${c.nome}` }, ctx.now());
    reply.code(201);
    return clientDto(ctx, c, { fullCpf: true });
  });

  app.get('/clients/:id', async (req) => {
    const a = needStaff(req);
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    return { ...(await clientDto(ctx, c, { fullCpf: true })), documentos: await documentsOf(ctx, c.id) };
  });

  app.patch('/clients/:id', async (req) => {
    const a = needPerm(req, 'clientes');
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    const b = parse(z.object({ nome: z.string().min(2).max(120), whatsapp: z.string().max(30), cpf: cpfField.or(z.literal('')), cidade: z.string().max(80), obs: z.string().max(500),
      responsavelId: z.string().uuid(), situacao: z.enum(['verificado', 'em_verificacao']), bloqueado: z.boolean(), limiteCents: z.number().int().min(0).nullable() }).partial(), req.body);
    const adminOnly = ['responsavelId', 'situacao', 'bloqueado', 'limiteCents'] as const;
    if (a.role !== 'admin' && adminOnly.some((k) => b[k] !== undefined)) throw forbidden('Somente o administrador altera situação, bloqueio, limite e responsável');
    if (b.responsavelId) await assertStaff(b.responsavelId, a.orgId);
    const set: Partial<typeof clients.$inferInsert> = {};
    if (b.nome !== undefined) set.nome = b.nome.trim(); if (b.whatsapp !== undefined) set.whatsapp = b.whatsapp.trim(); if (b.cidade !== undefined) set.cidade = b.cidade; if (b.obs !== undefined) set.obs = b.obs;
    for (const k of adminOnly) if (b[k] !== undefined) (set as Record<string, unknown>)[k] = k === 'limiteCents' && b[k] === 0 ? null : b[k];
    if (b.cpf !== undefined) {
      if (b.cpf === '') Object.assign(set, { cpfEnc: null, cpfHash: null, cpfLast4: null });
      else { const seal = sealCpf(ctx, b.cpf); if (seal.cpfHash !== c.cpfHash) await assertCpfFree(seal.cpfHash, a.orgId); Object.assign(set, seal); }
    }
    if (Object.keys(set).length) await ctx.db.update(clients).set(set).where(eq(clients.id, id));
    await audit(ctx.db, auditActor(a), { action: 'cliente.editou', entity: 'client', entityId: id, summary: `Editou o cliente ${b.nome ?? c.nome}`, meta: { campos: Object.keys(b).filter((k) => k !== 'cpf') } }, ctx.now());
    const [n] = await ctx.db.select().from(clients).where(eq(clients.id, id));
    return clientDto(ctx, n, { fullCpf: true });
  });

  app.delete('/clients/:id', async (req) => {
    const a = needPerm(req, 'excluir');
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    const [open] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(loans).where(and(eq(loans.clientId, id), inArray(loans.status, ['proposta', 'ativo'])));
    if (open.n) throw conflict('O cliente tem empréstimo em andamento. Quite ou cancele antes de excluir.', 'cliente_com_emprestimo');
    await ctx.db.update(clients).set({ deletedAt: ctx.now(), portalEnabled: false }).where(eq(clients.id, id));
    if (c.userId) { await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, c.userId)); await revokeAllSessions(ctx, c.userId); }
    await audit(ctx.db, auditActor(a), { action: 'cliente.excluiu', entity: 'client', entityId: id, summary: `Excluiu o cliente ${c.nome}` }, ctx.now());
    return { ok: true };
  });

  // ---- acesso ao portal (sem senha provisória: convite de uso único) ----
  app.post('/clients/:id/portal-invite', async (req) => {
    const a = needPerm(req, 'clientes');
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    const b = parse(z.object({ email: z.string().email().optional() }), req.body);
    let userId = c.userId, email = '';
    if (!userId) {
      if (!b.email) throw badRequest('Informe o e-mail do cliente');
      email = emailNorm(b.email);
      const [dup] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.orgId, a.orgId), eq(users.email, email))).limit(1);
      if (dup) throw conflict('Esse e-mail já está em uso', 'email_em_uso');
      const [u] = await ctx.db.insert(users).values({ orgId: a.orgId, kind: 'client', email, status: 'invited' }).returning();
      userId = u.id; await ctx.db.update(clients).set({ userId, portalEnabled: true }).where(eq(clients.id, id));
    } else {
      const [u] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
      email = u.email;
      if (u.status === 'active') throw conflict('O cliente já tem acesso. Se esqueceu a senha, ele pode usar "Esqueci minha senha".', 'ja_tem_acesso');
      if (u.status === 'disabled') await ctx.db.update(users).set({ status: u.passwordHash ? 'active' : 'invited' }).where(eq(users.id, userId));
      await ctx.db.update(clients).set({ portalEnabled: true }).where(eq(clients.id, id));
    }
    const inviteUrl = await createInvite(ctx, userId, a.orgId, c.nome.split(' ')[0], email);
    await audit(ctx.db, auditActor(a), { action: 'cliente.convite_portal', entity: 'client', entityId: id, summary: `Enviou convite de acesso ao portal para ${c.nome}` }, ctx.now());
    return { inviteUrl, email };
  });

  app.post('/clients/:id/portal-disable', async (req) => {
    const a = needPerm(req, 'clientes');
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    await ctx.db.update(clients).set({ portalEnabled: false }).where(eq(clients.id, id));
    if (c.userId) { await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, c.userId)); await revokeAllSessions(ctx, c.userId); }
    await audit(ctx.db, auditActor(a), { action: 'cliente.portal_desativado', entity: 'client', entityId: id, summary: `Desativou o acesso ao portal de ${c.nome}` }, ctx.now());
    return { ok: true };
  });

  // ---- documentos (equipe) ----
  app.get('/clients/:id/documents', async (req) => {
    const a = needStaff(req);
    const { id } = parse(idParam, req.params);
    return documentsOf(ctx, (await visibleClient(ctx, a, id)).id);
  });
  app.post('/clients/:id/documents', async (req, reply) => {
    const a = needPerm(req, 'clientes');
    const { id } = parse(idParam, req.params);
    const c = await visibleClient(ctx, a, id);
    return uploadDoc(app, req, reply, c.id, a, 'staff');
  });
  app.patch('/clients/:id/documents/:docId', async (req) => {
    const a = needPerm(req, 'clientes');
    const { id, docId } = parse(z.object({ id: z.string().uuid(), docId: z.string().uuid() }), req.params);
    const c = await visibleClient(ctx, a, id);
    const b = parse(z.object({ status: z.enum(['aprovado', 'recusado']), motivo: z.string().max(200).optional() }), req.body);
    const [d] = await ctx.db.select().from(clientDocuments).where(and(eq(clientDocuments.id, docId), eq(clientDocuments.clientId, id))).limit(1);
    if (!d || d.status === 'arquivado') throw notFound('Documento não encontrado');
    await ctx.db.update(clientDocuments).set({ status: b.status, motivo: b.status === 'recusado' ? (b.motivo?.trim() || 'Imagem ilegível') : null, reviewedBy: a.userId, reviewedAt: ctx.now() }).where(eq(clientDocuments.id, docId));
    const docs = await documentsOf(ctx, id);
    const todos = docs.every((x) => x.status === 'aprovado');
    if (todos && c.situacao !== 'verificado') await ctx.db.update(clients).set({ situacao: 'verificado' }).where(eq(clients.id, id));
    await audit(ctx.db, auditActor(a), { action: b.status === 'aprovado' ? 'documento.aprovou' : 'documento.recusou', entity: 'client', entityId: id, summary: `${b.status === 'aprovado' ? 'Aprovou' : 'Recusou'} documento (${d.tipo}) de ${c.nome}` }, ctx.now());
    return { ok: true, verificado: todos };
  });
}

export async function uploadDoc(app: FastifyInstance, req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, clientId: string, a: import('../context.js').Actor, by: 'staff' | 'client') {
  const ctx = app.ctx;
  const { tipo } = parse(z.object({ tipo: z.enum(DOC_TIPOS) }), req.query);
  const data = await readUpload(req);
  const [prev] = await ctx.db.select().from(clientDocuments).where(and(eq(clientDocuments.clientId, clientId), eq(clientDocuments.tipo, tipo), inArray(clientDocuments.status, ['enviado', 'aprovado', 'recusado']))).orderBy(desc(clientDocuments.createdAt)).limit(1);
  if (prev?.status === 'aprovado' && by === 'client') throw badRequest('Este documento já foi aprovado', 'documento_aprovado');
  const [cl] = await ctx.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  const fileId = await saveFile(ctx.db, ctx.storage, ctx.config.fileKey, { orgId: a.orgId, data, ownerClientId: clientId, createdBy: a.userId });
  await ctx.db.transaction(async (tx) => {
    if (prev) await tx.update(clientDocuments).set({ status: 'arquivado' }).where(eq(clientDocuments.id, prev.id));
    await tx.insert(clientDocuments).values({ clientId, tipo, fileId });
  });
  await audit(ctx.db, auditActor(a), { action: 'documento.enviou', entity: 'client', entityId: clientId, summary: `Enviou documento (${tipo}) ${by === 'staff' ? 'de ' + cl.nome : ''}`.trim() }, ctx.now());
  reply.code(201);
  return { ok: true };
}
export { needActor };
