import type { FastifyInstance } from 'fastify';
import PDFDocument from 'pdfkit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { brl, buildSchedule, FREQS, isValidDate, type Freq } from '@caixa/core';
import type { Actor, Ctx } from '../context.js';
import { clients, installments, loans, payments, staffProfiles } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { auditActor, needActor, needPerm, needStaff } from '../auth/guards.js';
import { clientScope, visibleClient, visibleClientIds } from '../services/scope.js';
import { addCashOut, createLoan, doPayoff, loadLoans, quoteLoan, receiptData, recordPayment, reversePayment, today, type LoanView } from '../services/loans.js';
import { enqueue } from '../lib/queue.js';

export const freqSchema = z.number().refine((f): f is Freq => (FREQS as number[]).includes(f), 'Frequência inválida');
const dateSchema = z.string().refine(isValidDate, 'Data inválida');
const idP = z.object({ id: z.string().uuid() });
export const loanScope = (a: Actor) => and(eq(loans.orgId, a.orgId), sql`${loans.clientId} in ${visibleClientIds(a)}`)!;

/** Pagamentos de cada parcela, no formato de tela (sem expor nada além do necessário ao cliente). */
export async function paymentLines(ctx: Ctx, loanIds: string[], forClient: boolean) {
  if (!loanIds.length) return new Map<string, unknown[]>();
  const insts = await ctx.db.select({ id: installments.id }).from(installments).where(inArray(installments.loanId, loanIds));
  if (!insts.length) return new Map();
  const rows = await ctx.db.select({ p: payments, by: staffProfiles.nome }).from(payments).leftJoin(staffProfiles, eq(staffProfiles.userId, payments.receivedBy)).where(inArray(payments.installmentId, insts.map((i) => i.id)));
  const rev = new Set(rows.filter((r) => r.p.reversesPaymentId).map((r) => r.p.reversesPaymentId));
  const out = new Map<string, unknown[]>();
  for (const { p, by } of rows) {
    if (p.kind === 'estorno') continue;
    const line = { id: p.id, valorCents: p.valorCents, method: p.method, kind: p.kind, data: p.receivedOn, receiptNo: p.receiptNo, estornado: rev.has(p.id), ...(forClient ? {} : { recebidoPor: by, recebidoPorId: p.receivedBy }) };
    (out.get(p.installmentId) ?? out.set(p.installmentId, []).get(p.installmentId)!).push(line);
  }
  return out;
}
export async function loanWithPayments(ctx: Ctx, view: LoanView, forClient: boolean) {
  const lines = await paymentLines(ctx, [view.id], forClient);
  return { ...view, installments: view.installments.map((i) => ({ ...i, pagamentos: lines.get(i.id) ?? [] })) };
}

export async function loanRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const findLoan = async (a: Actor, id: string) => {
    const [r] = await loadLoans(ctx, and(loanScope(a), eq(loans.id, id))!, { limit: 1 });
    if (!r) throw notFound('Empréstimo não encontrado');
    return r;
  };

  const newLoanBody = z.object({ clientId: z.string().uuid(), valorCents: z.number().int().min(100).max(100_000_000_00), jurosBps: z.number().int().min(0).max(100000), freqDays: freqSchema, nParcelas: z.number().int().min(1).max(360), firstDue: dateSchema, pulaDomingo: z.boolean().default(false), entrega: z.enum(['nenhuma', 'dinheiro', 'pix']).default('nenhuma') });

  app.post('/loans/preview', async (req) => {
    needStaff(req);
    const b = parse(z.object({ valorCents: z.number().int().min(100), jurosBps: z.number().int().min(0).max(100000), freqDays: freqSchema, nParcelas: z.number().int().min(1).max(360), firstDue: dateSchema, pulaDomingo: z.boolean().default(false) }), req.body);
    return buildSchedule({ valorCents: b.valorCents, jurosBps: b.jurosBps, freq: b.freqDays as Freq, n: b.nParcelas, start: b.firstDue, skipSundays: b.pulaDomingo });
  });

  app.post('/loans', async (req, reply) => {
    const a = needPerm(req, 'criar');
    const b = parse(newLoanBody, req.body);
    const c = await visibleClient(ctx, a, b.clientId);
    if (c.bloqueado) throw conflict('Cliente bloqueado para novos empréstimos', 'cliente_bloqueado');
    if (c.limiteCents && b.valorCents > c.limiteCents) throw conflict(`Acima do limite deste cliente (${brl(c.limiteCents)})`, 'acima_do_limite');
    const out = await ctx.db.transaction(async (tx) => {
      const r = await createLoan(ctx, tx, a.orgId, { clientId: c.id, valorCents: b.valorCents, jurosBps: b.jurosBps, freq: b.freqDays as Freq, n: b.nParcelas, firstDue: b.firstDue, pulaDomingo: b.pulaDomingo, status: 'ativo', createdBy: a.userId });
      if (b.entrega !== 'nenhuma') {
        await tx.update(loans).set({ disbursedAt: ctx.now(), disbursedMethod: b.entrega, disbursedBy: a.userId }).where(eq(loans.id, r.loan.id));
        if (b.entrega === 'dinheiro') await addCashOut(ctx, tx, a.orgId, a.userId, b.valorCents, `Empréstimo para ${c.nome}`, r.loan.id);
      }
      await audit(tx, auditActor(a), { action: 'emprestimo.criou', entity: 'loan', entityId: r.loan.id, summary: `Criou empréstimo de ${brl(b.valorCents)} para ${c.nome} (${b.nParcelas}x, ${b.freqDays}d)`, meta: { entrega: b.entrega } }, ctx.now());
      return r;
    });
    reply.code(201);
    return { id: out.loan.id, totalCents: out.schedule.totalCents };
  });

  app.get('/loans', async (req) => {
    const a = needStaff(req);
    const q = parse(z.object({ clientId: z.string().uuid().optional(), status: z.enum(['proposta', 'ativo', 'quitado', 'cancelado']).optional() }), req.query);
    const conds = [loanScope(a)]; if (q.clientId) conds.push(eq(loans.clientId, q.clientId)); if (q.status) conds.push(eq(loans.status, q.status));
    const rs = await loadLoans(ctx, and(...conds)!);
    return Promise.all(rs.map((r) => loanWithPayments(ctx, r.view, false)));
  });
  app.get('/loans/:id', async (req) => {
    const a = needStaff(req);
    const { id } = parse(idP, req.params);
    return loanWithPayments(ctx, (await findLoan(a, id)).view, false);
  });

  app.get('/loans/:id/contract', async (req) => {
    const a = needActor(req);
    const { id } = parse(idP, req.params);
    const r = await findLoan(a, id);
    const [l] = await ctx.db.select().from(loans).where(eq(loans.id, id));
    return { text: l.contractText, version: l.contractVersion, aceitoEm: l.acceptedAt, status: r.view.status };
  });

  app.get('/installments', async (req) => {
    const a = needStaff(req);
    const q = parse(z.object({ filtro: z.enum(['todos', 'atraso', 'hoje', 'semana', 'pagos']).default('todos'), q: z.string().max(80).optional(), clientId: z.string().uuid().optional() }), req.query);
    const day = today(ctx);
    const conds = [loanScope(a), inArray(loans.status, ['ativo', 'quitado'])]; if (q.clientId) conds.push(eq(loans.clientId, q.clientId));
    const rs = await loadLoans(ctx, and(...conds)!, { limit: 3000 });
    const lim = new Date(day + 'T12:00:00Z'); lim.setUTCDate(lim.getUTCDate() + 7); const limIso = lim.toISOString().slice(0, 10);
    let items = rs.flatMap((r) => r.view.installments.map((i) => ({ ...i, clientId: r.view.clientId, clientNome: r.view.clientNome })));
    items = items.filter((i) => ({ todos: i.status !== 'paid', atraso: i.status === 'late', hoje: i.status === 'today', semana: i.status !== 'paid' && i.dueDate >= day && i.dueDate <= limIso, pagos: i.status === 'paid' })[q.filtro]);
    if (q.q) items = items.filter((i) => i.clientNome.toLowerCase().includes(q.q!.toLowerCase()));
    items.sort((x, y) => (q.filtro === 'pagos' ? y.dueDate.localeCompare(x.dueDate) : x.dueDate.localeCompare(y.dueDate)));
    return { hoje: day, items: items.slice(0, 1000) };
  });

  // ---- recebimentos ----
  app.post('/installments/:id/payments', async (req, reply) => {
    const a = needStaff(req);
    const { id } = parse(idP, req.params);
    const b = parse(z.object({ valorCents: z.number().int().min(1), method: z.enum(['pix', 'dinheiro']) }), req.body);
    const [row] = await ctx.db.select({ l: loans.clientId }).from(installments).innerJoin(loans, eq(loans.id, installments.loanId)).where(and(eq(installments.id, id), loanScope(a))).limit(1);
    if (!row) throw notFound('Parcela não encontrada');
    const r = await ctx.db.transaction((tx) => recordPayment(ctx, tx, auditActor(a) as never, { installmentId: id, ...b }).then((x) => x));
    await afterPayment(ctx, r);
    reply.code(201);
    return r;
  });

  app.post('/payments/:id/reverse', async (req) => {
    const a = needStaff(req);
    const { id } = parse(idP, req.params);
    const { reason } = parse(z.object({ reason: z.string().min(3).max(200) }), req.body);
    await visiblePayment(ctx, a, id);
    return ctx.db.transaction((tx) => reversePayment(ctx, tx, { ...auditActor(a), isAdmin: a.role === 'admin' } as never, id, reason));
  });

  const visiblePayment = async (c: Ctx, a: Actor, id: string) => {
    const [r] = await c.db.select({ p: payments }).from(payments).innerJoin(installments, eq(installments.id, payments.installmentId)).innerJoin(loans, eq(loans.id, installments.loanId)).where(and(eq(payments.id, id), loanScope(a))).limit(1);
    if (!r) throw notFound('Pagamento não encontrado');
    return r.p;
  };
  app.get('/payments/:id/receipt', async (req) => { const a = needActor(req); const { id } = parse(idP, req.params); await visiblePayment(ctx, a, id); return receiptData(ctx, id); });
  app.get('/payments/:id/receipt.pdf', async (req, reply) => {
    const a = needActor(req); const { id } = parse(idP, req.params); await visiblePayment(ctx, a, id);
    const r = await receiptData(ctx, id);
    const doc = new PDFDocument({ size: 'A5', margin: 40 }), chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise<void>((res) => doc.on('end', () => res()));
    const fd = (s: string) => s.split('-').reverse().join('/');
    doc.fontSize(20).text(r.empresa).fontSize(10).fillColor('#666').text(`Recibo nº ${r.no}${r.estornado ? ' — ESTORNADO' : ''}`).moveDown();
    doc.fillColor('#000').fontSize(28).text(brl(r.valorCents)).moveDown(0.5).fontSize(11);
    const row = (k: string, v: string) => doc.fillColor('#666').text(k, { continued: true }).fillColor('#000').text('  ' + v);
    row('Cliente:', r.clienteNome);
    row('Referente a:', r.kind === 'quitacao' ? `Quitação antecipada (${r.parcelas.length} parcela(s))` : `Parcela ${r.parcelas[0]?.numero}/${r.nTotal} (venc. ${r.parcelas[0] ? fd(r.parcelas[0].due) : ''})`);
    row('Forma:', r.forma === 'dinheiro' ? 'Dinheiro' : 'Pix'); row('Data:', fd(r.data)); row('Recebido por:', r.recebidoPor);
    if (r.descontoCents) row('Desconto concedido:', brl(r.descontoCents));
    if (r.kind === 'parcela') row('Situação da parcela:', r.saldoRestanteCents ? `Saldo restante ${brl(r.saldoRestanteCents)}` : 'Quitada');
    doc.moveDown().fontSize(8).fillColor('#888').text('Documento gerado eletronicamente. Guarde este comprovante.');
    doc.end(); await done;
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="recibo-${r.no}.pdf"`);
    return reply.send(Buffer.concat(chunks));
  });

  // ---- ações no empréstimo ----
  app.post('/loans/:id/waive', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const r = await findLoan(a, id);
    const late = r.view.installments.filter((i) => i.status === 'late' && !i.waived);
    if (late.length) await ctx.db.update(installments).set({ waived: true, waivedBy: a.userId }).where(inArray(installments.id, late.map((i) => i.id)));
    await audit(ctx.db, auditActor(a), { action: 'emprestimo.perdoou', entity: 'loan', entityId: id, summary: `Perdoou multa/mora de ${late.length} parcela(s) de ${r.view.clientNome}` }, ctx.now());
    return { perdoadas: late.length };
  });
  app.post('/loans/:id/cancel', async (req) => {
    const a = needPerm(req, 'excluir');
    const { id } = parse(idP, req.params);
    const r = await findLoan(a, id);
    if (!['proposta', 'ativo'].includes(r.view.status)) throw conflict('Este empréstimo não pode ser cancelado', 'status_invalido');
    if (r.view.installments.some((i) => i.recebidoCents > 0)) throw conflict('Há pagamentos neste empréstimo. Desfaça os recebimentos antes de cancelar.', 'tem_pagamentos');
    await ctx.db.update(loans).set({ status: 'cancelado', canceledAt: ctx.now(), canceledBy: a.userId }).where(eq(loans.id, id));
    await audit(ctx.db, auditActor(a), { action: 'emprestimo.cancelou', entity: 'loan', entityId: id, summary: `Cancelou empréstimo de ${brl(r.view.valorCents)} (${r.view.clientNome})` }, ctx.now());
    return { ok: true };
  });
  app.post('/loans/:id/disburse', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const { method } = parse(z.object({ method: z.enum(['pix', 'dinheiro']) }), req.body);
    const r = await findLoan(a, id);
    if (r.view.status !== 'ativo') throw conflict('Só empréstimo ativo pode ter o valor liberado', 'status_invalido');
    if (r.view.disbursedAt) throw conflict('O valor já foi liberado', 'ja_liberado');
    await ctx.db.transaction(async (tx) => {
      await tx.update(loans).set({ disbursedAt: ctx.now(), disbursedMethod: method, disbursedBy: a.userId }).where(eq(loans.id, id));
      if (method === 'dinheiro') await addCashOut(ctx, tx, a.orgId, a.userId, r.view.valorCents, `Empréstimo para ${r.view.clientNome}`, id);
      await audit(tx, auditActor(a), { action: 'emprestimo.liberou', entity: 'loan', entityId: id, summary: `Liberou ${brl(r.view.valorCents)} para ${r.view.clientNome} (${method === 'dinheiro' ? 'dinheiro' : 'Pix'})` }, ctx.now());
    });
    return { ok: true };
  });

  app.get('/loans/:id/payoff-quote', async (req) => {
    const a = needActor(req);
    const { id } = parse(idP, req.params);
    await findLoan(a, id);
    const { quote } = await quoteLoan(ctx, id);
    return quote;
  });
  app.post('/loans/:id/payoff', async (req) => {
    const a = needPerm(req, 'criar');
    const { id } = parse(idP, req.params);
    const { method } = parse(z.object({ method: z.enum(['pix', 'dinheiro']) }), req.body);
    await findLoan(a, id);
    const r = await ctx.db.transaction((tx) => doPayoff(ctx, tx, auditActor(a) as never, id, method));
    return r;
  });
}

/** Efeitos colaterais de um recebimento: recibo por e-mail ao cliente (se tiver acesso). */
export async function afterPayment(ctx: Ctx, r: { clientId: string; receiptNo: string }) {
  void r; void ctx; // gancho para notificações (Etapa 7 registra o handler 'receipt')
  await enqueue(ctx, 'receipt', { clientId: r.clientId, receiptNo: r.receiptNo }, { dedupeKey: 'receipt:' + r.receiptNo });
}
export { clientScope, forbidden, badRequest };
