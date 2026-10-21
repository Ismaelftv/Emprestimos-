import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { brl, buildSchedule, installmentState, payoffQuote, todaySP, type Freq, type ISODate } from '@caixa/core';
import type { Ctx } from '../context.js';
import type { Db, Tx } from '../db/index.js';
import { cashOps, clients, installments, loans, payments, receiptSequences } from '../db/schema.js';
import { audit, type AuditActor } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { getSettings } from '../routes/me.js';
import { contractText, CONTRACT_VERSION } from './contract.js';
import { readCpf } from './clients.js';

export const today = (ctx: Pick<Ctx, 'now'>): ISODate => todaySP(ctx.now());
type LoanRow = typeof loans.$inferSelect;
type InstRow = typeof installments.$inferSelect;
type PayRow = typeof payments.$inferSelect;

export interface InstView {
  id: string; loanId: string; numero: number; nTotal: number; dueDate: string; amountCents: number;
  status: 'paid' | 'late' | 'today' | 'open'; days: number; multaCents: number; moraCents: number; extraCents: number;
  paidCents: number; recebidoCents: number; descontoCents: number; balanceCents: number; partial: boolean; waived: boolean; settledAt: string | null;
}
export interface LoanView {
  id: string; clientId: string; clientNome: string; status: string; valorCents: number; jurosBps: number; freqDays: number; nParcelas: number; totalCents: number; lucroCents: number;
  pulaDomingo: boolean; multaBps: number; moraBpsMes: number; descQuitBps: number; createdAt: Date; createdBy: string; acceptedAt: Date | null; disbursedAt: Date | null; disbursedMethod: string | null;
  pagas: number; installments: InstView[]; hasPayoffPending?: boolean;
}

export function instView(i: InstRow, loan: LoanRow, pays: PayRow[], dayToday: ISODate): InstView {
  const paid = pays.reduce((a, p) => a + p.valorCents, 0);
  const recebido = pays.filter((p) => p.method !== 'desconto').reduce((a, p) => a + p.valorCents, 0);
  const desconto = pays.filter((p) => p.method === 'desconto').reduce((a, p) => a + p.valorCents, 0);
  const st = installmentState({ amountCents: i.amountCents, due: i.dueDate, waived: i.waived, settled: !!i.settledAt, settledExtraCents: i.settledExtraCents }, paid, { multaBps: loan.multaBps, moraBpsMes: loan.moraBpsMes }, dayToday);
  return { id: i.id, loanId: i.loanId, numero: i.numero, nTotal: loan.nParcelas, dueDate: i.dueDate, amountCents: i.amountCents, status: st.status, days: st.days, multaCents: st.multaCents, moraCents: st.moraCents,
    extraCents: st.extraCents, paidCents: paid, recebidoCents: recebido, descontoCents: desconto, balanceCents: st.balanceCents, partial: st.partial, waived: i.waived, settledAt: i.settledAt };
}

/** Carrega empréstimos (já filtrados por `where`) com parcelas e estado calculado. */
export async function loadLoans(ctx: Ctx, where: SQL, opts: { limit?: number } = {}): Promise<{ view: LoanView; instRows: InstRow[]; pays: Map<string, PayRow[]> }[]> {
  const day = today(ctx);
  const rows = await ctx.db.select({ loan: loans, cliente: clients.nome }).from(loans).innerJoin(clients, eq(clients.id, loans.clientId)).where(where).orderBy(sql`${loans.createdAt} desc`).limit(opts.limit ?? 1000);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.loan.id);
  const insts: InstRow[] = [], pays: PayRow[] = [];
  for (let k = 0; k < ids.length; k += 2000) {
    const chunk = ids.slice(k, k + 2000);
    const ii = await ctx.db.select().from(installments).where(inArray(installments.loanId, chunk)).orderBy(asc(installments.numero));
    insts.push(...ii);
    for (let j = 0; j < ii.length; j += 5000) pays.push(...await ctx.db.select().from(payments).where(inArray(payments.installmentId, ii.slice(j, j + 5000).map((x) => x.id))));
  }
  const payBy = new Map<string, PayRow[]>(); for (const p of pays) (payBy.get(p.installmentId) ?? payBy.set(p.installmentId, []).get(p.installmentId)!).push(p);
  const instBy = new Map<string, InstRow[]>(); for (const i of insts) (instBy.get(i.loanId) ?? instBy.set(i.loanId, []).get(i.loanId)!).push(i);
  return rows.map(({ loan, cliente }) => {
    const ir = instBy.get(loan.id) ?? [], views = ir.map((i) => instView(i, loan, payBy.get(i.id) ?? [], day));
    return { instRows: ir, pays: payBy, view: { id: loan.id, clientId: loan.clientId, clientNome: cliente, status: loan.status, valorCents: loan.valorCents, jurosBps: loan.jurosBps, freqDays: loan.freqDays, nParcelas: loan.nParcelas, totalCents: loan.totalCents, lucroCents: loan.totalCents - loan.valorCents,
      pulaDomingo: loan.pulaDomingo, multaBps: loan.multaBps, moraBpsMes: loan.moraBpsMes, descQuitBps: loan.descQuitBps, createdAt: loan.createdAt, createdBy: loan.createdBy, acceptedAt: loan.acceptedAt, disbursedAt: loan.disbursedAt, disbursedMethod: loan.disbursedMethod,
      pagas: views.filter((v) => v.status === 'paid').length, installments: views } };
  });
}

export interface ClientSummary { abertas: number; emAbertoCents: number; atrasado: boolean }
export async function clientSummaries(ctx: Ctx, orgId: string, clientIds: string[]): Promise<Map<string, ClientSummary>> {
  const out = new Map<string, ClientSummary>();
  if (!clientIds.length) return out;
  const ls = await loadLoans(ctx, and(eq(loans.orgId, orgId), inArray(loans.clientId, clientIds), eq(loans.status, 'ativo'))!, { limit: 5000 });
  for (const { view } of ls) for (const i of view.installments) {
    if (i.status === 'paid') continue;
    const s = out.get(view.clientId) ?? { abertas: 0, emAbertoCents: 0, atrasado: false };
    s.abertas++; s.emAbertoCents += i.balanceCents; if (i.status === 'late') s.atrasado = true; out.set(view.clientId, s);
  }
  return out;
}

// ---------------- criação ----------------
export interface NewLoan { clientId: string; valorCents: number; jurosBps: number; freq: Freq; n: number; firstDue: ISODate; pulaDomingo: boolean; status: 'proposta' | 'ativo'; requestId?: string; createdBy: string }
export async function createLoan(ctx: Ctx, tx: Db | Tx, orgId: string, l: NewLoan) {
  const [cl] = await tx.select().from(clients).where(and(eq(clients.id, l.clientId), eq(clients.orgId, orgId))).limit(1);
  if (!cl) throw notFound('Cliente não encontrado');
  const st = await getSettings({ db: tx as Db }, orgId);
  const sch = buildSchedule({ valorCents: l.valorCents, jurosBps: l.jurosBps, freq: l.freq, n: l.n, start: l.firstDue, skipSundays: l.pulaDomingo && l.freq === 1 });
  const text = contractText({ empresa: st.empresa, pixNome: st.pixNome, devedorNome: cl.nome, devedorCpf: readCpf(ctx, cl), valorCents: l.valorCents, jurosBps: l.jurosBps, totalCents: sch.totalCents, freq: l.freq,
    parcelas: sch.installments.map((i) => ({ due: i.due, amountCents: i.amountCents })), multaBps: st.multaBps, moraBpsMes: st.moraBpsMes, descQuitBps: st.descQuitBps });
  const [loan] = await tx.insert(loans).values({ orgId, clientId: l.clientId, requestId: l.requestId ?? null, valorCents: l.valorCents, jurosBps: l.jurosBps, freqDays: l.freq, nParcelas: l.n, pulaDomingo: l.pulaDomingo && l.freq === 1,
    totalCents: sch.totalCents, status: l.status, multaBps: st.multaBps, moraBpsMes: st.moraBpsMes, descQuitBps: st.descQuitBps, contractText: text, contractVersion: CONTRACT_VERSION, createdBy: l.createdBy }).returning();
  await tx.insert(installments).values(sch.installments.map((i) => ({ loanId: loan.id, numero: i.numero, dueDate: i.due, amountCents: i.amountCents })));
  return { loan, client: cl, schedule: sch };
}

// ---------------- pagamentos (livro-razão) ----------------
export async function nextReceiptNo(tx: Db | Tx, orgId: string): Promise<string> {
  const [r] = await tx.insert(receiptSequences).values({ orgId, lastNo: 1 }).onConflictDoUpdate({ target: receiptSequences.orgId, set: { lastNo: sql`${receiptSequences.lastNo} + 1` } }).returning({ n: receiptSequences.lastNo });
  return `R-${String(r.n).padStart(6, '0')}`;
}
async function lockInst(tx: Db | Tx, id: string) {
  const [i] = await tx.select().from(installments).where(eq(installments.id, id)).for('update').limit(1);
  if (!i) throw notFound('Parcela não encontrada');
  const [loan] = await tx.select().from(loans).where(eq(loans.id, i.loanId)).limit(1);
  const pays = await tx.select().from(payments).where(eq(payments.installmentId, id));
  return { i, loan, pays };
}
async function refreshLoanStatus(tx: Db | Tx, loanId: string) {
  const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(installments).where(and(eq(installments.loanId, loanId), sql`${installments.settledAt} is null`));
  const [loan] = await tx.select({ status: loans.status }).from(loans).where(eq(loans.id, loanId)).limit(1);
  if (loan.status === 'ativo' && open.n === 0) await tx.update(loans).set({ status: 'quitado' }).where(eq(loans.id, loanId));
  if (loan.status === 'quitado' && open.n > 0) await tx.update(loans).set({ status: 'ativo' }).where(eq(loans.id, loanId));
}

export async function recordPayment(ctx: Ctx, tx: Db | Tx, actor: AuditActor & { userId: string }, p: { installmentId: string; valorCents: number; method: 'pix' | 'dinheiro'; reportId?: string }) {
  const day = today(ctx);
  const { i, loan, pays } = await lockInst(tx, p.installmentId);
  if (loan.status !== 'ativo') throw conflict('Este empréstimo não está ativo', 'emprestimo_inativo');
  const view = instView(i, loan, pays, day);
  if (view.status === 'paid') throw conflict('Esta parcela já está quitada', 'parcela_quitada');
  if (!Number.isInteger(p.valorCents) || p.valorCents <= 0) throw badRequest('Informe um valor válido');
  if (p.valorCents > view.balanceCents) throw badRequest(`O valor é maior que o saldo da parcela (${brl(view.balanceCents)})`, 'acima_do_saldo');
  const receiptNo = await nextReceiptNo(tx, loan.orgId);
  const [pay] = await tx.insert(payments).values({ orgId: loan.orgId, installmentId: i.id, valorCents: p.valorCents, method: p.method, kind: 'parcela', receivedBy: actor.userId, receivedAt: ctx.now(), receivedOn: day, receiptNo, reportId: p.reportId ?? null }).returning();
  const full = p.valorCents === view.balanceCents;
  if (full) await tx.update(installments).set({ settledAt: day, settledExtraCents: view.extraCents }).where(eq(installments.id, i.id));
  await refreshLoanStatus(tx, loan.id);
  const [cl] = await tx.select({ nome: clients.nome }).from(clients).where(eq(clients.id, loan.clientId));
  await audit(tx, actor, { action: 'pagamento.recebeu', entity: 'payment', entityId: pay.id, summary: `Recebeu ${brl(p.valorCents)} em ${p.method === 'dinheiro' ? 'dinheiro' : 'Pix'} de ${cl.nome} (parcela ${i.numero}/${loan.nParcelas}${full ? '' : ', parcial'})`, meta: { receiptNo } }, ctx.now());
  return { paymentId: pay.id, receiptNo, quitada: full, saldoCents: view.balanceCents - p.valorCents, loanId: loan.id, clientId: loan.clientId };
}

/** Estorna um recebimento (e, se for quitação, o grupo inteiro do mesmo recibo). Nada é apagado: entram lançamentos negativos. */
export async function reversePayment(ctx: Ctx, tx: Db | Tx, actor: AuditActor & { userId: string; isAdmin: boolean }, paymentId: string, reason: string) {
  const day = today(ctx);
  const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p || p.orgId !== (actor.orgId)) throw notFound('Pagamento não encontrado');
  if (p.kind === 'estorno') throw badRequest('Este lançamento já é um estorno');
  if (!actor.isAdmin && p.receivedBy !== actor.userId) throw badRequest('Só o administrador ou quem recebeu pode desfazer', 'sem_permissao_estorno');
  const group = p.receiptNo ? await tx.select().from(payments).where(and(eq(payments.orgId, p.orgId), eq(payments.receiptNo, p.receiptNo), sql`${payments.kind} <> 'estorno'`)) : [p];
  const reversed = new Set((await tx.select({ r: payments.reversesPaymentId }).from(payments).where(inArray(payments.reversesPaymentId, group.map((g) => g.id)))).map((x) => x.r));
  const todo = group.filter((g) => !reversed.has(g.id));
  if (!todo.length) throw conflict('Este pagamento já foi desfeito', 'ja_estornado');
  const instIds = [...new Set(todo.map((g) => g.installmentId))];
  for (const iid of instIds) await lockInst(tx, iid);
  for (const g of todo) await tx.insert(payments).values({ orgId: g.orgId, installmentId: g.installmentId, valorCents: -g.valorCents, method: g.method, kind: 'estorno', receivedBy: actor.userId, receivedAt: ctx.now(), receivedOn: day, receiptNo: g.receiptNo, reversesPaymentId: g.id, reversalReason: reason });
  await tx.update(installments).set({ settledAt: null, settledExtraCents: null }).where(inArray(installments.id, instIds));
  const loanIds = new Set<string>();
  for (const iid of instIds) { const [i] = await tx.select({ l: installments.loanId }).from(installments).where(eq(installments.id, iid)); loanIds.add(i.l); }
  for (const lid of loanIds) await refreshLoanStatus(tx, lid);
  const total = todo.filter((g) => g.method !== 'desconto').reduce((a, g) => a + g.valorCents, 0);
  await audit(tx, actor, { action: 'pagamento.estornou', entity: 'payment', entityId: paymentId, summary: `Desfez recebimento ${p.receiptNo ?? ''} de ${brl(total)}: ${reason}`, meta: { reason, linhas: todo.length } }, ctx.now());
  return { reversed: todo.length };
}

// ---------------- quitação antecipada ----------------
export async function quoteLoan(ctx: Ctx, loanId: string, db: Db | Tx = ctx.db) {
  const [loan] = await db.select().from(loans).where(eq(loans.id, loanId)).limit(1);
  if (!loan) throw notFound('Empréstimo não encontrado');
  const insts = await db.select().from(installments).where(eq(installments.loanId, loanId)).orderBy(asc(installments.numero));
  const pays = insts.length ? await db.select().from(payments).where(inArray(payments.installmentId, insts.map((i) => i.id))) : [];
  const paidBy = new Map<string, number>(); for (const p of pays) paidBy.set(p.installmentId, (paidBy.get(p.installmentId) ?? 0) + p.valorCents);
  const q = payoffQuote({ valorCents: loan.valorCents, totalCents: loan.totalCents, nParcelas: loan.nParcelas, descQuitBps: loan.descQuitBps },
    insts.map((i) => ({ id: i.id, numero: i.numero, due: i.dueDate, amountCents: i.amountCents, waived: i.waived, paidCents: paidBy.get(i.id) ?? 0, settled: !!i.settledAt })), { multaBps: loan.multaBps, moraBpsMes: loan.moraBpsMes }, today(ctx));
  return { loan, insts, quote: q };
}

export async function doPayoff(ctx: Ctx, tx: Db | Tx, actor: AuditActor & { userId: string }, loanId: string, method: 'pix' | 'dinheiro') {
  const day = today(ctx);
  const [loan0] = await tx.select().from(loans).where(eq(loans.id, loanId)).for('update').limit(1);
  if (!loan0) throw notFound('Empréstimo não encontrado');
  if (loan0.status !== 'ativo') throw conflict('Só é possível quitar empréstimo ativo', 'emprestimo_inativo');
  const { loan, insts, quote } = await quoteLoan(ctx, loanId, tx);
  if (!quote.parts.length) throw conflict('Não há parcelas em aberto', 'nada_a_quitar');
  const receiptNo = await nextReceiptNo(tx, loan.orgId);
  const extraBy = new Map<string, number>();
  const pays = await tx.select().from(payments).where(inArray(payments.installmentId, insts.map((i) => i.id)));
  for (const part of quote.parts) {
    const i = insts.find((x) => x.id === part.id)!;
    const view = instView(i, loan, pays.filter((p) => p.installmentId === i.id), day);
    extraBy.set(i.id, view.extraCents);
    if (part.payCents > 0) await tx.insert(payments).values({ orgId: loan.orgId, installmentId: i.id, valorCents: part.payCents, method, kind: 'quitacao', receivedBy: actor.userId, receivedAt: ctx.now(), receivedOn: day, receiptNo });
    if (part.discountCents > 0) await tx.insert(payments).values({ orgId: loan.orgId, installmentId: i.id, valorCents: part.discountCents, method: 'desconto', kind: 'desconto', receivedBy: actor.userId, receivedAt: ctx.now(), receivedOn: day, receiptNo });
    await tx.update(installments).set({ settledAt: day, settledExtraCents: extraBy.get(i.id) ?? 0 }).where(eq(installments.id, i.id));
  }
  await tx.update(loans).set({ status: 'quitado' }).where(eq(loans.id, loanId));
  const [cl] = await tx.select({ nome: clients.nome }).from(clients).where(eq(clients.id, loan.clientId));
  await audit(tx, actor, { action: 'emprestimo.quitou', entity: 'loan', entityId: loanId, summary: `Quitou o empréstimo de ${cl.nome} por ${brl(quote.totalCents)} (${method === 'dinheiro' ? 'dinheiro' : 'Pix'}, desconto ${brl(quote.discountCents)})`, meta: { receiptNo } }, ctx.now());
  return { receiptNo, totalCents: quote.totalCents, discountCents: quote.discountCents, clientId: loan.clientId };
}

export async function addCashOut(ctx: Ctx, tx: Db | Tx, orgId: string, staffId: string, valorCents: number, descricao: string, loanId?: string) {
  await tx.insert(cashOps).values({ orgId, staffId, date: today(ctx), tipo: 'emprestimo', valorCents, descricao, loanId: loanId ?? null });
}

/** Dados do recibo (para tela, WhatsApp e PDF). Para quitação agrupa todas as linhas do mesmo número. */
export async function receiptData(ctx: Ctx, paymentId: string) {
  const [p] = await ctx.db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p || !p.receiptNo) throw notFound('Recibo não encontrado');
  const group = await ctx.db.select().from(payments).where(and(eq(payments.orgId, p.orgId), eq(payments.receiptNo, p.receiptNo), sql`${payments.kind} <> 'estorno'`));
  const lines = [] as { numero: number; due: string; valorCents: number }[];
  let loan!: LoanRow; let clientNome = '', clientId = '';
  for (const g of group) {
    const [i] = await ctx.db.select().from(installments).where(eq(installments.id, g.installmentId));
    [loan] = await ctx.db.select().from(loans).where(eq(loans.id, i.loanId));
    if (g.method !== 'desconto') lines.push({ numero: i.numero, due: i.dueDate, valorCents: g.valorCents });
  }
  const [cl] = await ctx.db.select().from(clients).where(eq(clients.id, loan.clientId)); clientNome = cl.nome; clientId = cl.id;
  const st = await getSettings(ctx, p.orgId);
  const first = group.find((g) => g.method !== 'desconto') ?? p;
  const { staffProfiles } = await import('../db/schema.js');
  const [by] = await ctx.db.select({ nome: staffProfiles.nome }).from(staffProfiles).where(eq(staffProfiles.userId, first.receivedBy));
  const reversed = (await ctx.db.select({ id: payments.id }).from(payments).where(and(eq(payments.reversesPaymentId, first.id)))).length > 0;
  const total = lines.reduce((a, l) => a + l.valorCents, 0);
  let saldo = 0;
  if (p.kind === 'parcela') { const insts = await loadLoans(ctx, eq(loans.id, loan.id)); saldo = insts[0]?.view.installments.find((x) => x.id === p.installmentId)?.balanceCents ?? 0; }
  return { no: p.receiptNo, empresa: st.empresa, clientId, clienteNome: clientNome, valorCents: total, forma: first.method, kind: p.kind, data: first.receivedOn, recebidoPor: by?.nome ?? '', parcelas: lines, nTotal: loan.nParcelas,
    saldoRestanteCents: saldo, descontoCents: group.filter((g) => g.method === 'desconto').reduce((a, g) => a + g.valorCents, 0), estornado: reversed, loanId: loan.id };
}
