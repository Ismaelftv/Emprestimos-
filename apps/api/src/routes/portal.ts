import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { cpfOk } from '@caixa/core';
import { clients, staffProfiles, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { hashPassword } from '../lib/crypto.js';
import { loadFile } from '../lib/files.js';
import { conflict, notFound } from '../lib/errors.js';
import { emailNorm, parse } from '../lib/http.js';
import { auditActor, needActor, needClient } from '../auth/guards.js';
import { createSession } from '../auth/session.js';
import { clientScope } from '../services/scope.js';
import { documentsOf, sealCpf } from '../services/clients.js';
import { uploadDoc } from './clients.js';
import { meDto } from './me.js';
import { passwordSchema } from './auth.js';

export const CONSENT_VERSION = 'v1-2026-10';

export async function portalRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // autocadastro público: entra "em verificação" e já pode solicitar (a equipe decide)
  app.post('/auth/signup', { config: { rateLimit: { max: ctx.config.env === 'test' ? 10_000 : 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = parse(z.object({ nome: z.string().min(3).max(120), whatsapp: z.string().min(8).max(30), cpf: z.string().refine(cpfOk, 'CPF inválido'), email: z.string().email(), password: passwordSchema, consent: z.literal(true, { errorMap: () => ({ message: 'É preciso concordar com o uso dos dados (LGPD)' }) }) }), req.body);
    const email = emailNorm(b.email);
    const [org] = await ctx.db.select({ id: users.orgId }).from(users).where(eq(users.kind, 'staff')).limit(1);
    if (!org) throw notFound();
    const orgId = org.id;
    const seal = sealCpf(ctx, b.cpf);
    const [dupE] = await ctx.db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.email, email))).limit(1);
    if (dupE) throw conflict('Já existe uma conta com esse e-mail', 'email_em_uso');
    const [dupC] = await ctx.db.select({ id: clients.id }).from(clients).where(and(eq(clients.orgId, orgId), eq(clients.cpfHash, seal.cpfHash))).limit(1);
    if (dupC) throw conflict('Já existe um cadastro com esse CPF. Fale com a equipe.', 'cpf_em_uso');
    const [adm] = await ctx.db.select({ id: staffProfiles.userId }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId)).where(and(eq(staffProfiles.role, 'admin'), eq(users.status, 'active'), eq(users.orgId, orgId))).orderBy(asc(users.createdAt)).limit(1);
    const [u] = await ctx.db.insert(users).values({ orgId, kind: 'client', email, passwordHash: await hashPassword(b.password, ctx.light), status: 'active' }).returning();
    const [c] = await ctx.db.insert(clients).values({ orgId, userId: u.id, nome: b.nome.trim(), whatsapp: b.whatsapp.trim(), obs: 'Cadastro feito pelo portal', responsavelId: adm?.id ?? null, situacao: 'em_verificacao', portalEnabled: true, consentAt: ctx.now(), consentVersion: CONSENT_VERSION, ...seal }).returning();
    const s = await createSession(ctx, req, reply, u.id, 'full');
    await audit(ctx.db, { orgId, userId: u.id, kind: 'client', nome: c.nome, ip: req.ip }, { action: 'cliente.autocadastro', entity: 'client', entityId: c.id, summary: `${c.nome} criou a conta pelo portal (consentimento ${CONSENT_VERSION})` }, ctx.now());
    reply.code(201);
    return { csrf: s.csrf, me: await meDto(ctx, u.id) };
  });

  app.patch('/me/profile', async (req) => {
    const a = needClient(req);
    const b = parse(z.object({ whatsapp: z.string().min(8).max(30), cidade: z.string().max(80) }).partial(), req.body);
    await ctx.db.update(clients).set(b).where(and(clientScope(a), eq(clients.id, a.clientId)));
    await audit(ctx.db, auditActor(a), { action: 'cliente.perfil', entity: 'client', entityId: a.clientId, summary: 'Atualizou os próprios dados de contato' }, ctx.now());
    return meDto(ctx, a.userId);
  });

  app.get('/me/documents', async (req) => documentsOf(ctx, needClient(req).clientId));
  app.post('/me/documents', async (req, reply) => { const a = needClient(req); return uploadDoc(app, req, reply, a.clientId, a, 'client'); });

  // arquivo privado: só quem tem acesso ao dono (cliente = o próprio; equipe = dentro do escopo)
  app.get('/files/:id', async (req, reply) => {
    const a = needActor(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const f = await loadFile(ctx.db, ctx.storage, ctx.config.fileKey, id).catch(() => { throw notFound('Arquivo não encontrado'); });
    const owner = f.meta.ownerClientId;
    if (!owner || f.meta.orgId !== a.orgId) { if (a.role !== 'admin' || f.meta.orgId !== a.orgId) throw notFound('Arquivo não encontrado'); }
    else {
      const [ok] = await ctx.db.select({ id: clients.id }).from(clients).where(and(clientScope(a), eq(clients.id, owner))).limit(1);
      if (!ok) throw notFound('Arquivo não encontrado');
    }
    reply.header('Content-Type', f.meta.mime).header('Content-Disposition', 'inline').header('Cache-Control', 'private, no-store');
    return reply.send(f.data);
  });
}
