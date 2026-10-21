import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { brl, buildSchedule, FREQ_LABEL, type Freq } from '@caixa/core';
import type { Actor } from '../context.js';
import type { Db } from '../db/index.js';
import { clients, installments, loanRequests, loans, paymentReports, payoffRequests } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { readUpload, saveFile } from '../lib/files.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { tpl } from '../lib/mailer.js';
import { enqueue } from '../lib/queue.js';
import { auditActor, needActor, needClient, needPerm, needStaff } from '../auth/guards.js';
import { clientScope, visibleClientIds } from '../services/scope.js';
import { createLoan, doPayoff, loadLoans, quoteLoan, recordPayment, today } from '../services/loans.js';
import { clientEmail, notifyClient, notifyResponsible } from '../services/notify.js';
import { getSettings } from './me.js';
import { afterPayment, freqSchema, loanWithPayments } from './loans.js';

const idP = z.object({ id: z.string().uuid() });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function requestRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const inScope = (a: Actor) => sql`${clients.id} in ${visibleClientIds(a)}`;
  const rate = { config: { rateLimit: { max: ctx.config.env === 'test' ? 10_000 : 30, timeWindow: '1 minute' } } };

  // ================= lado do cliente =================
  app.get('/me/loans', async (req) => {
    const a = needClient(req);
    const rs = await loadLoans(ctx, and(eq(loans.orgId, a.orgId), eq(loans.clientId, a.clientId))!);
    const reps = await ctx.db.select().from(paymentReports).where(and(eq(paymentReports.clientId, a.clientId), sql`${paymentReports.installmentId} is not null`)).orderBy(desc(paymentReports.createdAt));
    const pf = await ctx.db.select().from(payoffRequests).where(and(eq(payoffRequests.clientId, a.clientId), eq(payoffRequests.status, 'pendente')));
    const out = [];
    for (const r of rs) {
      if (r.view.status === 'cancelado') continue;
      const full = await loanWithPayments(ctx, r.view, true);
      out.push({ ...full, quitacaoPendente: pf.some((x) => x.loanId === r.view.id),
        installments: full.installments.map((i) => { const rep = reps.find((x) => x.installmentId === i.id); return { ...i, relato: rep ? { id: rep.id, status: rep.status, method: rep.method, motivoRecusa: rep.motivoRecusa } : null }; }) });
    }
    return out;
  });

  app.post('/me/simulate', async (req) => {
    const a = needClient(req);
    const b = parse(z.object({ valorCents: z.number().int().min(100), nParcelas: z.number().int().min(1).max(360), freqDays: freqSchema }), req.body);
    const st = await getSettings(ctx, a.orgId), jurosBps = st.taxasBps[String(b.freqDays)] ?? 2000;
    const s = buildSchedule({ valorCents: b.valorCents, jurosBps, freq: b.freqDays as Freq, n: b.nParcelas, start: today(ctx) });
    return { jurosBps, totalCents: s.totalCents, parcelaCents: s.installments[0].amountCents, estimativa: true };
  });

  app.post('/me/requests', rate, async (req, reply) => {
    const a = needClient(req);
    const b = parse(z.object({ valorCents: z.number().int().min(100), nParcelas: z.number().int().min(1).max(360), freqDays: freqSchema, motivo: z.string().max(120).default('') }), req.body);
    const [c] = await ctx.db.select().from(clients).where(eq(clients.id, a.clientId));
    const st = await getSettings(ctx, a.orgId);
    if (c.bloqueado) throw conflict('Novos empréstimos indisponíveis para o seu cadastro. Fale com a equipe.', 'cliente_bloqueado');
    const max = Math.min(st.maxValorCents, c.limiteCents ?? Infinity);
    if (b.valorCents < st.minValorCents || b.valorCents > max) throw badRequest(`O valor deve ficar entre ${brl(st.minValorCents)} e ${brl(max)}`, 'valor_fora_do_limite');
    if (b.nParcelas > st.maxParcelas) throw badRequest(`No máximo ${st.maxParcelas} parcelas`, 'parcelas_demais');
    const [pend] = await ctx.db.select({ id: loanRequests.id }).from(loanRequests).where(and(eq(loanRequests.clientId, a.clientId), eq(loanRequests.status, 'analise'))).limit(1);
    if (pend) throw conflict('Você já tem uma solicitação em análise', 'solicitacao_pendente');
    const [r] = await ctx.db.insert(loanRequests).values({ orgId: a.orgId, clientId: a.clientId, valorCents: b.valorCents, nParcelas: b.nParcelas, freqDays: b.freqDays, motivo: b.motivo.trim() }).returning();
    await audit(ctx.db, auditActor(a), { action: 'solicitacao.criou', entity: 'request', entityId: r.id, summary: `Solicitou empréstimo de ${brl(b.valorCents)} em ${b.nParcelas}x ${FREQ_LABEL[b.freqDays as Freq]}` }, ctx.now());
    await notifyResponsible(ctx, a.clientId, 'Nova solicitação', `${c.nome} pediu ${brl(b.valorCents)}`);
    reply.code(201);
    return r;
  });
  app.get('/me/requests', async (req) => {
    const a = needClient(req);
    const rs = await ctx.db.select().from(loanRequests).where(eq(loanRequests.clientId, a.clientId)).orderBy(desc(loanRequests.createdAt));
    const lids = rs.map((r) => r.loanId).filter(Boolean) as string[];
    const ls = lids.length ? await loadLoans(ctx, and(inArray(loans.id, lids), eq(loans.clientId, a.clientId))!) : [];
    return rs.map((r) => { const l = ls.find((x) => x.view.id === r.loanId)?.view; return { id: r.id, valorCents: r.valorCents, nParcelas: r.nParcelas, freqDays: r.freqDays, motivo: r.motivo, status: r.status, motivoRecusa: r.motivoRecusa, createdAt: r.createdAt,
      proposta: l ? { loanId: l.id, status: l.status, valorCents: l.valorCents, nParcelas: l.nParcelas, parcelaCents: l.installments[0]?.amountCents, totalCents: l.totalCents, jurosBps: l.jurosBps, primeiroVencimento: l.installments[0]?.dueDate } : null }; });
  });

  app.post('/loans/:id/accept', async (req) => {
    const a = needClient(req);
    const { id } = parse(idP, req.params);
    parse(z.object({ aceito: z.literal(true) }), req.body);
    const [l] = await ctx.db.select().from(loans).where(and(eq(loans.id, id), eq(loans.clientId, a.clientId))).limit(1);
    if (!l) throw notFound('Proposta não encontrada');
    const done = await ctx.db.update(loans).set({ status: 'ativo', acceptedAt: ctx.now(), acceptedIp: a.ip, acceptedBy: a.userId }).where(and(eq(loans.id, id), eq(loans.status, 'proposta'))).returning({ id: loans.id });
    if (!done.length) throw conflict('Esta proposta não está mais disponível', 'status_invalido');
    await audit(ctx.db, auditActor(a), { action: 'proposta.aceitou', entity: 'loan', entityId: id, summary: `Aceitou a proposta de ${brl(l.valorCents)} (${l.nParcelas}x)`, meta: { contrato: l.contractVersion } }, ctx.now());
    await notifyResponsible(ctx, a.clientId, 'Proposta aceita', `${a.nome} aceitou ${brl(l.valorCents)}. Libere o valor.`, '/#/clientes');
    return { ok: true };
  });
  app.post('/loans/:id/decline', async (req) => {
    const a = needClient(req);
    const { id } = parse(idP, req.params);
    const [l] = await ctx.db.select().from(loans).where(and(eq(loans.id, id), eq(loans.clientId, a.clientId))).limit(1);
    if (!l) throw notFound('Proposta não encontrada');
    const done = await ctx.db.update(loans).set({ status: 'cancelado', canceledAt: ctx.now(), canceledBy: a.userId }).where(and(eq(loans.id, id), eq(loans.status, 'proposta'))).returning({ id: loans.id });
    if (!done.length) throw conflict('Esta proposta não está mais disponível', 'status_invalido');
    if (l.requestId) await ctx.db.update(loanRequests).set({ status: 'recusada', motivoRecusa: 'Proposta não aceita pelo cliente' }).where(eq(loanRequests.id, l.requestId));
    await audit(ctx.db, auditActor(a), { action: 'proposta.recusou', entity: 'loan', entityId: id, summary: 'Recusou a proposta aprovada' }, ctx.now());
    return { ok: true };
  });

  // comprovante Pix / aviso de dinheiro (multipart quando for Pix)
  app.post('/me/installments/:id/report', rate, async (req, reply) => {
    const a = needClient(req);
    const { id } = parse(idP, req.params);
    const q = parse(z.object({ method: z.enum(['pix', 'dinheiro']), note: z.string().max(140).default('') }), req.query);
    const st = await getSettings(ctx, a.orgId);
    if ((q.method === 'pix' && !st.aceitaPix) || (q.method === 'dinheiro' && !st.aceitaDinheiro)) throw badRequest('Forma de pagamento indisponível');
    const [row] = await ctx.db.select({ loanId: installments.loanId }).from(installments).innerJoin(loans, eq(loans.id, installments.loanId)).where(and(eq(installments.id, id), eq(loans.clientId, a.clientId), eq(loans.status, 'ativo'))).limit(1);
    if (!row) throw notFound('Parcela não encontrada');
    const [lv] = await loadLoans(ctx, and(eq(loans.id, row.loanId), eq(loans.clientId, a.clientId))!, { limit: 1 });
    const inst = lv.view.installments.find((i) => i.id === id)!;
    if (inst.status === 'paid') throw conflict('Esta parcela já está paga', 'parcela_quitada');
    const [dup] = await ctx.db.select({ id: paymentReports.id }).from(paymentReports).where(and(eq(paymentReports.installmentId, id), eq(paymentReports.status, 'pendente'))).limit(1);
    if (dup) throw conflict('Já existe um aviso desta parcela aguardando a equipe', 'aviso_pendente');
    let fileId: string | null = null;
    if (q.method === 'pix') {
      const data = await readUpload(req);
      fileId = await saveFile(ctx.db, ctx.storage, ctx.config.fileKey, { orgId: a.orgId, data, ownerClientId: a.clientId, createdBy: a.userId });
    }
    const [r] = await ctx.db.insert(paymentReports).values({ orgId: a.orgId, clientId: a.clientId, installmentId: id, method: q.method, valorCents: inst.balanceCents, fileId, note: q.note.trim() }).returning();
    await audit(ctx.db, auditActor(a), { action: 'comprovante.enviou', entity: 'installment', entityId: id, summary: q.method === 'dinheiro' ? `Avisou que vai pagar em dinheiro a parcela ${inst.numero}/${inst.nTotal} (${brl(inst.balanceCents)})` : `Enviou comprovante da parcela ${inst.numero}/${inst.nTotal} (${brl(inst.balanceCents)})` }, ctx.now());
    await notifyResponsible(ctx, a.clientId, q.method === 'dinheiro' ? 'Pagamento em dinheiro combinado' : 'Comprovante recebido', `${a.nome}: ${brl(inst.balanceCents)}`, '/#/agenda');
    reply.code(201);
    return { id: r.id, status: r.status };
  });

  app.post('/me/loans/:id/payoff-request', rate, async (req, reply) => {
    const a = needClient(req);
    const { id } = parse(idP, req.params);
    const q = parse(z.object({ method: z.enum(['pix', 'dinheiro']), note: z.string().max(140).default('') }), req.query);
    const [l] = await ctx.db.select().from(loans).where(and(eq(loans.id, id), eq(loans.clientId, a.clientId), eq(loans.status, 'ativo'))).limit(1);
    if (!l) throw notFound('Empréstimo não encontrado');
    const [dup] = await ctx.db.select({ id: payoffRequests.id }).from(payoffRequests).where(and(eq(payoffRequests.loanId, id), eq(payoffRequests.status, 'pendente'))).limit(1);
    if (dup) throw conflict('Já existe um pedido de quitação em análise', 'quitacao_pendente');
    const { quote } = await quoteLoan(ctx, id);
    if (!quote.parts.length) throw conflict('Não há parcelas em aberto', 'nada_a_quitar');
    let fileId: string | null = null;
    if (q.method === 'pix') {
      const data = await readUpload(req);
      fileId = await saveFile(ctx.db, ctx.storage, ctx.config.fileKey, { orgId: a.orgId, data, ownerClientId: a.clientId, createdBy: a.userId });
    }
    const [r] = await ctx.db.insert(payoffRequests).values({ orgId: a.orgId, loanId: id, clientId: a.clientId, method: q.method, fileId, note: q.note.trim(), valorCents: quote.totalCents }).returning();
    await audit(ctx.db, auditActor(a), { action: 'quitacao.solicitou', entity: 'loan', entityId: id, summary: `Solicitou quitação de ${brl(quote.totalCents)} (${q.method === 'dinheiro' ? 'dinheiro' : 'Pix'})` }, ctx.now());
    await notifyResponsible(ctx, a.clientId, 'Pedido de quitação', `${a.nome}: ${brl(quote.totalCents)}`, '/#/solicitacoes');
    reply.code(201);
    return { id: r.id, valorCents: quote.totalCents, descontoCents: quote.discountCents };
  });

  // ================= lado da equipe =================
  app.get('/requests', async (req) => {
    const a = needPerm(req, 'criar');
    const { status } = parse(z.object({ status: z.enum(['analise', 'aprovada', 'recusada']).default('analise') }), req.query);
    const rows = await ctx.db.select({ r: loanRequests, c: clients }).from(loanRequests).innerJoin(clients, eq(clients.id, loanRequests.clientId)).where(and(eq(loanRequests.orgId, a.orgId), eq(loanRequests.status, status), inScope(a))).orderBy(desc(loanRequests.createdAt)).limit(200);
    const st = await getSettings(ctx, a.orgId);
    const out = [];
    for (const { r, c } of rows) {
      const ls = await loadLoans(ctx, and(eq(loans.clientId, c.id), eq(loans.orgId, a.orgId))!, { limit: 200 });
      const insts = ls.flatMap((l) => l.view.status === 'ativo' ? l.view.installments : []);
      out.push({ id: r.id, clientId: c.id, clienteNome: c.nome, whatsapp: c.whatsapp, valorCents: r.valorCents, nParcelas: r.nParcelas, freqDays: r.freqDays, motivo: r.motivo, status: r.status, motivoRecusa: r.motivoRecusa, createdAt: r.createdAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy, loanId: r.loanId,
        cadastroVerificado: c.situacao === 'verificado', parcelasAtrasadas: insts.filter((i) => i.status === 'late').length, emprestimosAbertos: ls.filter((l) => l.view.status === 'ativo').length, jurosSugeridoBps: st.taxasBps[String(r.freqDays)] ?? 2000 });
    }
    return out;
  });

  app.post('/requests/:id/approve', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const [row] = await ctx.db.select({ r: loanRequests, c: clients }).from(loanRequests).innerJoin(clients, eq(clients.id, loanRequests.clientId)).where(and(eq(loanRequests.id, id), eq(loanRequests.orgId, a.orgId), inScope(a))).limit(1);
    if (!row) throw notFound('Solicitação não encontrada');
    if (row.r.status !== 'analise') throw conflict('Esta solicitação já foi decidida', 'ja_decidida');
    const st = await getSettings(ctx, a.orgId);
    const b = parse(z.object({ valorCents: z.number().int().min(100).default(row.r.valorCents), jurosBps: z.number().int().min(0).max(100000).default(st.taxasBps[String(row.r.freqDays)] ?? 2000), nParcelas: z.number().int().min(1).max(360).default(row.r.nParcelas), firstDue: dateSchema }), req.body);
    if (row.c.bloqueado) throw conflict('Cliente bloqueado para novos empréstimos', 'cliente_bloqueado');
    if (row.c.limiteCents && b.valorCents > row.c.limiteCents) throw conflict(`Acima do limite deste cliente (${brl(row.c.limiteCents)})`, 'acima_do_limite');
    const loanId = await ctx.db.transaction(async (tx) => {
      const claimed = await tx.update(loanRequests).set({ status: 'aprovada', decidedBy: a.userId, decidedAt: ctx.now() }).where(and(eq(loanRequests.id, id), eq(loanRequests.status, 'analise'))).returning({ id: loanRequests.id });
      if (!claimed.length) throw conflict('Esta solicitação já foi decidida', 'ja_decidida');
      const { loan } = await createLoan(ctx, tx, a.orgId, { clientId: row.c.id, valorCents: b.valorCents, jurosBps: b.jurosBps, freq: row.r.freqDays as Freq, n: b.nParcelas, firstDue: b.firstDue, pulaDomingo: row.r.freqDays === 1, status: 'proposta', requestId: id, createdBy: a.userId });
      await tx.update(loanRequests).set({ loanId: loan.id }).where(eq(loanRequests.id, id));
      await audit(tx, auditActor(a), { action: 'solicitacao.aprovou', entity: 'request', entityId: id, summary: `Aprovou a solicitação de ${row.c.nome}: ${brl(b.valorCents)} em ${b.nParcelas}x`, meta: { loanId: loan.id } }, ctx.now());
      return loan.id;
    });
    const em = await clientEmail(ctx, row.c.id);
    if (em) await enqueue(ctx, 'email', { to: em.email, ...tpl.proposta(em.nome.split(' ')[0], st.empresa, ctx.config.publicUrl) });
    await notifyClient(ctx, row.c.id, 'Proposta pronta', 'Leia o contrato e aceite no app.');
    return { loanId };
  });
  app.post('/requests/:id/refuse', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const { motivo } = parse(z.object({ motivo: z.string().min(3).max(200) }), req.body);
    const [row] = await ctx.db.select({ r: loanRequests, c: clients }).from(loanRequests).innerJoin(clients, eq(clients.id, loanRequests.clientId)).where(and(eq(loanRequests.id, id), eq(loanRequests.orgId, a.orgId), inScope(a))).limit(1);
    if (!row) throw notFound('Solicitação não encontrada');
    const done = await ctx.db.update(loanRequests).set({ status: 'recusada', motivoRecusa: motivo, decidedBy: a.userId, decidedAt: ctx.now() }).where(and(eq(loanRequests.id, id), eq(loanRequests.status, 'analise'))).returning({ id: loanRequests.id });
    if (!done.length) throw conflict('Esta solicitação já foi decidida', 'ja_decidida');
    await audit(ctx.db, auditActor(a), { action: 'solicitacao.recusou', entity: 'request', entityId: id, summary: `Recusou a solicitação de ${row.c.nome}`, meta: { motivo } }, ctx.now());
    await notifyClient(ctx, row.c.id, 'Solicitação analisada', 'Veja a resposta no app.');
    return { ok: true };
  });

  // ---- comprovantes e avisos de dinheiro ----
  app.get('/payment-reports', async (req) => {
    const a = needStaff(req);
    const { status } = parse(z.object({ status: z.enum(['pendente', 'confirmado', 'recusado']).default('pendente') }), req.query);
    const rows = await ctx.db.select({ r: paymentReports, c: clients, i: installments }).from(paymentReports).innerJoin(clients, eq(clients.id, paymentReports.clientId)).innerJoin(installments, eq(installments.id, paymentReports.installmentId)).where(and(eq(paymentReports.orgId, a.orgId), eq(paymentReports.status, status), inScope(a))).orderBy(desc(paymentReports.createdAt)).limit(200);
    return rows.map(({ r, c, i }) => ({ id: r.id, installmentId: i.id, numero: i.numero, clientId: c.id, clienteNome: c.nome, method: r.method, valorCents: r.valorCents, fileId: r.fileId, note: r.note, status: r.status, motivoRecusa: r.motivoRecusa, createdAt: r.createdAt }));
  });
  const loadReport = async (a: Actor, id: string) => {
    const [x] = await ctx.db.select({ r: paymentReports }).from(paymentReports).innerJoin(clients, eq(clients.id, paymentReports.clientId)).where(and(eq(paymentReports.id, id), eq(paymentReports.orgId, a.orgId), inScope(a))).limit(1);
    if (!x) throw notFound('Aviso não encontrado');
    if (x.r.status !== 'pendente') throw conflict('Este aviso já foi conferido', 'ja_decidido');
    return x.r;
  };
  app.post('/payment-reports/:id/confirm', async (req, reply) => {
    const a = needStaff(req);
    const { id } = parse(idP, req.params);
    const r = await loadReport(a, id);
    const b = parse(z.object({ valorCents: z.number().int().min(1).optional() }), req.body);
    const out = await ctx.db.transaction(async (tx) => {
      const claimed = await tx.update(paymentReports).set({ status: 'confirmado', decidedBy: a.userId, decidedAt: ctx.now() }).where(and(eq(paymentReports.id, id), eq(paymentReports.status, 'pendente'))).returning({ id: paymentReports.id });
      if (!claimed.length) throw conflict('Este aviso já foi conferido', 'ja_decidido');
      const [lv] = await loadLoans({ ...ctx, db: tx as unknown as Db }, sql`${loans.id} = (select loan_id from installments where id = ${r.installmentId})`, { limit: 1 }); // dentro da transação
      const bal = lv.view.installments.find((i) => i.id === r.installmentId)!.balanceCents;
      return recordPayment(ctx, tx, auditActor(a) as never, { installmentId: r.installmentId!, valorCents: Math.min(b.valorCents ?? r.valorCents, bal), method: r.method as 'pix' | 'dinheiro', reportId: id });
    });
    await afterPayment(ctx, out);
    await notifyClient(ctx, out.clientId, 'Pagamento confirmado', `Recibo ${out.receiptNo}`);
    reply.code(200);
    return out;
  });
  app.post('/payment-reports/:id/refuse', async (req) => {
    const a = needStaff(req);
    const { id } = parse(idP, req.params);
    const r = await loadReport(a, id);
    const { motivo } = parse(z.object({ motivo: z.string().max(200).default('') }), req.body);
    const m = motivo.trim() || (r.method === 'dinheiro' ? 'Pagamento em dinheiro não confirmado' : 'Comprovante não confere');
    await ctx.db.update(paymentReports).set({ status: 'recusado', motivoRecusa: m, decidedBy: a.userId, decidedAt: ctx.now() }).where(eq(paymentReports.id, id));
    await audit(ctx.db, auditActor(a), { action: 'comprovante.recusou', entity: 'payment_report', entityId: id, summary: `Recusou comprovante: ${m}` }, ctx.now());
    await notifyClient(ctx, r.clientId, 'Comprovante recusado', m);
    return { ok: true };
  });

  // ---- pedidos de quitação ----
  app.get('/payoff-requests', async (req) => {
    const a = needStaff(req);
    const { status } = parse(z.object({ status: z.enum(['pendente', 'confirmado', 'recusado']).default('pendente') }), req.query);
    const rows = await ctx.db.select({ r: payoffRequests, c: clients }).from(payoffRequests).innerJoin(clients, eq(clients.id, payoffRequests.clientId)).where(and(eq(payoffRequests.orgId, a.orgId), eq(payoffRequests.status, status), inScope(a))).orderBy(desc(payoffRequests.createdAt)).limit(200);
    const out = [];
    for (const { r, c } of rows) { const q = r.status === 'pendente' ? (await quoteLoan(ctx, r.loanId)).quote : null; out.push({ id: r.id, loanId: r.loanId, clientId: c.id, clienteNome: c.nome, method: r.method, fileId: r.fileId, note: r.note, valorInformadoCents: r.valorCents, valorHojeCents: q?.totalCents ?? null, descontoCents: q?.discountCents ?? null, status: r.status, createdAt: r.createdAt }); }
    return out;
  });
  const loadPayoff = async (a: Actor, id: string) => {
    const [x] = await ctx.db.select({ r: payoffRequests }).from(payoffRequests).innerJoin(clients, eq(clients.id, payoffRequests.clientId)).where(and(eq(payoffRequests.id, id), eq(payoffRequests.orgId, a.orgId), inScope(a))).limit(1);
    if (!x) throw notFound('Pedido não encontrado');
    if (x.r.status !== 'pendente') throw conflict('Este pedido já foi decidido', 'ja_decidido');
    return x.r;
  };
  app.post('/payoff-requests/:id/confirm', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const r = await loadPayoff(a, id);
    return ctx.db.transaction(async (tx) => {
      const claimed = await tx.update(payoffRequests).set({ status: 'confirmado', decidedBy: a.userId, decidedAt: ctx.now() }).where(and(eq(payoffRequests.id, id), eq(payoffRequests.status, 'pendente'))).returning({ id: payoffRequests.id });
      if (!claimed.length) throw conflict('Este pedido já foi decidido', 'ja_decidido');
      return doPayoff(ctx, tx, auditActor(a) as never, r.loanId, r.method as 'pix' | 'dinheiro');
    });
  });
  app.post('/payoff-requests/:id/refuse', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const r = await loadPayoff(a, id);
    const { motivo } = parse(z.object({ motivo: z.string().max(200).default('') }), req.body);
    await ctx.db.update(payoffRequests).set({ status: 'recusado', motivoRecusa: motivo.trim() || 'Pedido não confirmado', decidedBy: a.userId, decidedAt: ctx.now() }).where(eq(payoffRequests.id, id));
    await audit(ctx.db, auditActor(a), { action: 'quitacao.recusou', entity: 'loan', entityId: r.loanId, summary: 'Recusou pedido de quitação' }, ctx.now());
    await notifyClient(ctx, r.clientId, 'Quitação não confirmada', motivo || 'Fale com a equipe.');
    return { ok: true };
  });

  // contadores para os selos do menu
  app.get('/inbox', async (req) => {
    const a = needStaff(req);
    const [s] = a.perms.criar ? await ctx.db.select({ n: sql<number>`count(*)::int` }).from(loanRequests).innerJoin(clients, eq(clients.id, loanRequests.clientId)).where(and(eq(loanRequests.orgId, a.orgId), eq(loanRequests.status, 'analise'), inScope(a))) : [{ n: 0 }];
    const [c] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(paymentReports).innerJoin(clients, eq(clients.id, paymentReports.clientId)).where(and(eq(paymentReports.orgId, a.orgId), eq(paymentReports.status, 'pendente'), inScope(a)));
    const [q] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(payoffRequests).innerJoin(clients, eq(clients.id, payoffRequests.clientId)).where(and(eq(payoffRequests.orgId, a.orgId), eq(payoffRequests.status, 'pendente'), inScope(a)));
    return { solicitacoes: s.n, comprovantes: c.n, quitacoes: q.n };
  });
}
export { needActor, forbidden, clientScope };
