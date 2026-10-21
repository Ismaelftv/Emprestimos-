import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { brl } from '@caixa/core';
import { clientDocuments, clients, installments, loanRequests, loans, privacyRequests, pushSubscriptions, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { randomToken } from '../lib/crypto.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { waLink } from '../lib/whatsapp.js';
import { auditActor, needActor, needAdmin, needClient, needStaff } from '../auth/guards.js';
import { revokeAllSessions } from '../auth/session.js';
import { loadLoans, today } from '../services/loans.js';
import { readCpf } from '../services/clients.js';
import { visibleClient } from '../services/scope.js';
import { loanScope } from './loans.js';
import { getSettings } from './me.js';
import { purgeClientFiles } from '../jobs.js';
import { pushTo } from '../services/notify.js';

const fd = (s: string) => s.split('-').reverse().slice(0, 2).join('/');

export async function miscRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ---------- Web Push ----------
  app.get('/push/key', async (req) => { needActor(req); return { publicKey: ctx.config.vapid?.publicKey ?? null }; });
  app.post('/push/subscribe', async (req) => {
    const a = needActor(req);
    const b = parse(z.object({ endpoint: z.string().url().max(600), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }), req.body);
    await ctx.db.insert(pushSubscriptions).values({ userId: a.userId, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth }).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: a.userId, p256dh: b.keys.p256dh, auth: b.keys.auth } });
    return { ok: true };
  });
  app.post('/push/unsubscribe', async (req) => {
    const a = needActor(req);
    const { endpoint } = parse(z.object({ endpoint: z.string().max(600) }), req.body);
    await ctx.db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, a.userId)));
    return { ok: true };
  });

  // ---------- lembretes de cobrança por WhatsApp (link wa.me com mensagem pronta) ----------
  app.get('/reminders/today', async (req) => {
    const a = needStaff(req);
    const day = today(ctx);
    const ls = await loadLoans(ctx, and(loanScope(a), eq(loans.status, 'ativo'))!, { limit: 3000 });
    const phones = new Map((await ctx.db.select({ id: clients.id, f: clients.whatsapp }).from(clients).where(eq(clients.orgId, a.orgId))).map((c) => [c.id, c.f]));
    const items = ls.flatMap((l) => l.view.installments.filter((i) => i.status === 'late' || i.status === 'today').map((i) => ({ l: l.view, i })));
    const sent = items.length ? new Map((await ctx.db.select({ id: installments.id, e: installments.lembreteEm }).from(installments).where(inArray(installments.id, items.map((x) => x.i.id)))).map((r) => [r.id, r.e])) : new Map();
    return { hoje: day, itens: items.sort((x, y) => x.i.dueDate.localeCompare(y.i.dueDate)).map(({ l, i }) => {
      const first = l.clientNome.split(' ')[0];
      const text = i.status === 'late'
        ? `Oi ${first}, tudo bem? Sua parcela ${i.numero}/${i.nTotal} de ${brl(i.amountCents)} venceu em ${fd(i.dueDate)} (${i.days} dia(s) de atraso, total hoje ${brl(i.balanceCents)}). Consegue me passar o comprovante hoje?`
        : `Oi ${first}, tudo bem? Lembrete: sua parcela ${i.numero}/${i.nTotal} de ${brl(i.amountCents)} vence hoje.`;
      return { installmentId: i.id, clientId: l.clientId, clientNome: l.clientNome, numero: i.numero, nTotal: i.nTotal, dueDate: i.dueDate, status: i.status, balanceCents: i.balanceCents, mensagem: text, whatsappLink: waLink(phones.get(l.clientId) ?? '', text), enviado: sent.get(i.id) === day };
    }) };
  });
  app.post('/installments/:id/reminder-sent', async (req) => {
    const a = needStaff(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await ctx.db.select({ id: installments.id }).from(installments).innerJoin(loans, eq(loans.id, installments.loanId)).where(and(eq(installments.id, id), loanScope(a))).limit(1);
    if (!row) throw notFound('Parcela não encontrada');
    await ctx.db.update(installments).set({ lembreteEm: today(ctx) }).where(eq(installments.id, id));
    return { ok: true };
  });

  // ---------- LGPD ----------
  const exportClient = async (clientId: string) => {
    const [c] = await ctx.db.select().from(clients).where(eq(clients.id, clientId));
    const [u] = c.userId ? await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, c.userId)) : [];
    const ls = await loadLoans(ctx, eq(loans.clientId, clientId));
    return { geradoEm: ctx.now().toISOString(),
      titular: { nome: c.nome, cpf: readCpf(ctx, c), whatsapp: c.whatsapp, cidade: c.cidade, email: u?.email ?? null, cadastradoEm: c.createdAt, consentimento: c.consentAt ? { em: c.consentAt, versao: c.consentVersion } : null },
      emprestimos: ls.map((l) => ({ id: l.view.id, status: l.view.status, valorCents: l.view.valorCents, totalCents: l.view.totalCents, parcelas: l.view.installments.map((i) => ({ numero: i.numero, vencimento: i.dueDate, valorCents: i.amountCents, situacao: i.status, recebidoCents: i.recebidoCents })) })),
      solicitacoes: await ctx.db.select({ valorCents: loanRequests.valorCents, status: loanRequests.status, em: loanRequests.createdAt }).from(loanRequests).where(eq(loanRequests.clientId, clientId)),
      documentos: (await ctx.db.select({ tipo: clientDocuments.tipo, status: clientDocuments.status, em: clientDocuments.createdAt }).from(clientDocuments).where(eq(clientDocuments.clientId, clientId))),
      observacao: 'Registros financeiros são mantidos pelo prazo legal mesmo após pedido de exclusão.' };
  };
  app.get('/me/privacy/export', async (req, reply) => {
    const a = needClient(req);
    await ctx.db.insert(privacyRequests).values({ orgId: a.orgId, clientId: a.clientId, tipo: 'exportacao', status: 'feito', requestedBy: a.userId });
    await audit(ctx.db, auditActor(a), { action: 'lgpd.exportou', entity: 'client', entityId: a.clientId, summary: 'Exportou os próprios dados (LGPD)' }, ctx.now());
    reply.header('Content-Disposition', 'attachment; filename="meus-dados.json"');
    return exportClient(a.clientId);
  });
  app.get('/clients/:id/privacy/export', async (req, reply) => {
    const a = needAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await visibleClient(ctx, a, id);
    await audit(ctx.db, auditActor(a), { action: 'lgpd.exportou', entity: 'client', entityId: id, summary: 'Exportou os dados do titular a pedido dele (LGPD)' }, ctx.now());
    reply.header('Content-Disposition', 'attachment; filename="dados-titular.json"');
    return exportClient(id);
  });
  app.post('/me/privacy/erase-request', async (req) => {
    const a = needClient(req);
    const [dup] = await ctx.db.select({ id: privacyRequests.id }).from(privacyRequests).where(and(eq(privacyRequests.clientId, a.clientId), eq(privacyRequests.tipo, 'exclusao'), eq(privacyRequests.status, 'pendente'))).limit(1);
    if (dup) throw conflict('Você já pediu a exclusão dos seus dados', 'ja_solicitado');
    await ctx.db.insert(privacyRequests).values({ orgId: a.orgId, clientId: a.clientId, tipo: 'exclusao', status: 'pendente', requestedBy: a.userId });
    await audit(ctx.db, auditActor(a), { action: 'lgpd.pediu_exclusao', entity: 'client', entityId: a.clientId, summary: 'Pediu a exclusão dos próprios dados (LGPD)' }, ctx.now());
    const [adm] = await ctx.db.execute(sql_admins(a.orgId)).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
    await pushTo(ctx, adm?.id, 'Pedido LGPD', `${a.nome} pediu a exclusão dos dados`, '/#/privacidade');
    return { ok: true };
  });
  app.get('/privacy/requests', async (req) => {
    const a = needAdmin(req);
    const rows = await ctx.db.select({ r: privacyRequests, nome: clients.nome }).from(privacyRequests).innerJoin(clients, eq(clients.id, privacyRequests.clientId)).where(and(eq(privacyRequests.orgId, a.orgId), eq(privacyRequests.status, 'pendente'))).orderBy(desc(privacyRequests.createdAt));
    return rows.map(({ r, nome }) => ({ id: r.id, clientId: r.clientId, nome: nome, tipo: r.tipo, em: r.createdAt }));
  });

  /** Anonimiza o titular: apaga identificação e documentos; mantém só o necessário para obrigação legal/financeira (valores e datas). */
  app.post('/clients/:id/anonymize', async (req) => {
    const a = needAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await visibleClient(ctx, a, id);
    const [open] = await ctx.db.select({ id: loans.id }).from(loans).where(and(eq(loans.clientId, id), inArray(loans.status, ['proposta', 'ativo']))).limit(1);
    if (open) throw conflict('Há empréstimo em andamento. Quite ou cancele antes de anonimizar.', 'cliente_com_emprestimo');
    const nomeAnterior = c.nome;
    await ctx.db.transaction(async (tx) => {
      await tx.update(clients).set({ nome: 'Cliente removido', whatsapp: '', cidade: '', obs: '', cpfEnc: null, cpfHash: null, cpfLast4: null, portalEnabled: false, anonymizedAt: ctx.now(), deletedAt: c.deletedAt ?? ctx.now() }).where(eq(clients.id, id));
      if (c.userId) await tx.update(users).set({ status: 'disabled', email: `removido-${randomToken(8).toLowerCase()}@removido.invalid`, passwordHash: null, totpSecretEnc: null, totpEnabled: false }).where(eq(users.id, c.userId));
      await tx.update(privacyRequests).set({ status: 'feito' }).where(and(eq(privacyRequests.clientId, id), eq(privacyRequests.status, 'pendente')));
      await tx.insert(privacyRequests).values({ orgId: a.orgId, clientId: id, tipo: 'exclusao', status: 'feito', requestedBy: a.userId });
      await audit(tx, auditActor(a), { action: 'lgpd.anonimizou', entity: 'client', entityId: id, summary: `Anonimizou os dados de ${nomeAnterior} (LGPD)` }, ctx.now());
    });
    const n = await purgeClientFiles(ctx, id);
    if (c.userId) await revokeAllSessions(ctx, c.userId);
    return { ok: true, arquivosApagados: n };
  });
}

import { sql } from 'drizzle-orm';
const sql_admins = (orgId: string) => sql`select u.id from users u join staff_profiles p on p.user_id = u.id where u.org_id = ${orgId} and p.role = 'admin' and u.status = 'active' order by u.created_at limit 1`;
export { forbidden };
