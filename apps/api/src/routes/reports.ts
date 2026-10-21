import type { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { addMonthsClamped } from '@caixa/core';
import type { Actor, Ctx } from '../context.js';
import { auditLog, cashClosings, cashOps, clientDocuments, clients, installments, loanRequests, loans, payments, settings, staffProfiles, users } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { forbidden } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { auditActor, needAdmin, needPerm, needStaff } from '../auth/guards.js';
import { loadLoans, today } from '../services/loans.js';
import { decorateStaff, loanScope } from './loans.js';
import { readCpf } from '../services/clients.js';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const bands = [['1–7 dias', 1, 7], ['8–30 dias', 8, 30], ['Mais de 30 dias', 31, 99999]] as const;

/** Neutraliza fórmulas (=, +, -, @) em células de CSV para não executarem no Excel/Planilhas. */
export const csvCell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const csv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

export async function receivedByStaff(ctx: Ctx, orgId: string, month: string) {
  const from = month + '-01', to = addMonthsClamped(from, 1);
  const rows = await ctx.db.select({ staffId: payments.receivedBy, total: sql<number>`sum(${payments.valorCents})::bigint`, n: sql<number>`count(*) filter (where ${payments.valorCents} > 0)::int` })
    .from(payments).where(and(eq(payments.orgId, orgId), gte(payments.receivedOn, from), lt(payments.receivedOn, to), sql`${payments.method} <> 'desconto'`)).groupBy(payments.receivedBy);
  const staff = await ctx.db.select({ id: staffProfiles.userId, nome: staffProfiles.nome, role: staffProfiles.role, comissaoBps: staffProfiles.comissaoBps, status: users.status }).from(staffProfiles).innerJoin(users, eq(users.id, staffProfiles.userId)).where(eq(users.orgId, orgId));
  return staff.map((s) => { const r = rows.find((x) => x.staffId === s.id); const total = Number(r?.total ?? 0); return { staffId: s.id, nome: s.nome, role: s.role, status: s.status, recebidoCents: total, recebimentos: r?.n ?? 0, comissaoCents: Math.floor((total * s.comissaoBps + 5000) / 10000) }; });
}

export async function reportRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const scopedLoans = (a: Actor, statuses: string[]) => and(loanScope(a), inArray(loans.status, statuses))!;

  app.get('/dashboard', async (req) => {
    const a = needStaff(req);
    const day = today(ctx);
    const ls = await loadLoans(ctx, scopedLoans(a, ['ativo', 'quitado']), { limit: 3000 });
    const insts = ls.flatMap((l) => l.view.installments.map((i) => ({ ...i, clientNome: l.view.clientNome, clientId: l.view.clientId })));
    const abertas = insts.filter((i) => i.status !== 'paid');
    const atrasadas = abertas.filter((i) => i.status === 'late');
    const [meu] = await ctx.db.select({ t: sql<number>`coalesce(sum(${payments.valorCents}),0)::bigint` }).from(payments).where(and(eq(payments.orgId, a.orgId), eq(payments.receivedBy, a.userId), eq(payments.receivedOn, day), sql`${payments.method} <> 'desconto'`));
    const [pend] = a.perms.criar ? await ctx.db.select({ n: sql<number>`count(*)::int` }).from(loanRequests).where(and(eq(loanRequests.orgId, a.orgId), eq(loanRequests.status, 'analise'), sql`${loanRequests.clientId} in (select id from clients where ${clientScopeSql(a)})`)) : [{ n: 0 }];
    return {
      hoje: day, aReceberCents: abertas.reduce((s, i) => s + i.balanceCents, 0), recebidoCents: insts.reduce((s, i) => s + i.recebidoCents, 0), emAtrasoCents: atrasadas.reduce((s, i) => s + i.balanceCents, 0),
      vencemHoje: abertas.filter((i) => i.status === 'today').length, atrasadas: atrasadas.length, solicitacoesPendentes: pend.n,
      emprestadoCents: a.perms.lucro ? ls.reduce((s, l) => s + l.view.valorCents, 0) : null, recebiHojeCents: Number(meu.t),
      proximas: await decorateStaff(ctx, abertas.filter((i) => i.dueDate >= day).sort((x, y) => x.dueDate.localeCompare(y.dueDate)).slice(0, 6)),
      emAtraso: await decorateStaff(ctx, atrasadas.sort((x, y) => x.dueDate.localeCompare(y.dueDate)).slice(0, 5)),
    };
  });

  app.get('/reports/summary', async (req) => {
    const a = needPerm(req, 'lucro');
    const ls = await loadLoans(ctx, scopedLoans(a, ['ativo', 'quitado']), { limit: 3000 });
    const insts = ls.flatMap((l) => l.view.installments.map((i) => ({ ...i, clientNome: l.view.clientNome })));
    const totalCents = ls.reduce((s, l) => s + l.view.totalCents, 0), recebido = insts.reduce((s, i) => s + i.recebidoCents, 0);
    const porMes: Record<string, number> = {};
    for (const i of insts.filter((x) => x.status !== 'paid')) porMes[i.dueDate.slice(0, 7)] = (porMes[i.dueDate.slice(0, 7)] ?? 0) + i.amountCents;
    return {
      lucroPrevistoCents: ls.reduce((s, l) => s + l.view.lucroCents, 0), emprestimos: ls.length, percentualRecebido: totalCents ? Math.round((recebido / totalCents) * 100) : 0,
      inadimplencia: bands.map(([faixa, min, max]) => { const ps = insts.filter((i) => i.status === 'late' && i.days >= min && i.days <= max); return { faixa, parcelas: ps.length, valorCents: ps.reduce((s, i) => s + i.balanceCents, 0) }; }),
      aReceberPorMes: Object.entries(porMes).sort().map(([mes, valorCents]) => ({ mes, valorCents })),
    };
  });

  app.get('/reports/delinquency', async (req) => {
    const a = needPerm(req, 'lucro');
    const ls = await loadLoans(ctx, scopedLoans(a, ['ativo']), { limit: 3000 });
    const late = ls.flatMap((l) => l.view.installments.filter((i) => i.status === 'late').map((i) => ({ clientId: l.view.clientId, clientNome: l.view.clientNome, loanId: l.view.id, numero: i.numero, nTotal: i.nTotal, dueDate: i.dueDate, days: i.days, balanceCents: i.balanceCents })));
    return bands.map(([faixa, min, max]) => ({ faixa, itens: late.filter((i) => i.days >= min && i.days <= max).sort((x, y) => y.days - x.days) }));
  });

  app.get('/reports/received-by-staff', async (req) => {
    const a = needAdmin(req);
    const { month } = parse(z.object({ month: monthSchema.default(today(ctx).slice(0, 7)) }), req.query);
    return { month, itens: await receivedByStaff(ctx, a.orgId, month) };
  });

  // ---------------- exportações ----------------
  app.get('/export/installments.csv', async (req, reply) => {
    const a = needStaff(req);
    const ls = await loadLoans(ctx, scopedLoans(a, ['ativo', 'quitado']), { limit: 5000 });
    const rows: unknown[][] = [['cliente', 'parcela', 'vencimento', 'valor', 'situacao', 'saldo', 'recebido']];
    for (const l of ls) for (const i of l.view.installments) rows.push([l.view.clientNome, `${i.numero}/${i.nTotal}`, i.dueDate, money(i.amountCents), { paid: 'paga', late: 'atrasada', today: 'vence hoje', open: 'a vencer' }[i.status], money(i.balanceCents), money(i.recebidoCents)]);
    await audit(ctx.db, auditActor(a), { action: 'exportacao.parcelas', summary: `Exportou ${rows.length - 1} parcelas (CSV)` }, ctx.now());
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="parcelas-${today(ctx)}.csv"`);
    return csv(rows);
  });

  // livro de recebimentos para o contador
  app.get('/export/payments.csv', async (req, reply) => {
    const a = needPerm(req, 'lucro');
    const q = parse(z.object({ month: monthSchema.optional() }), req.query);
    const conds = [eq(payments.orgId, a.orgId), sql`${payments.installmentId} in (select i.id from installments i join loans l on l.id = i.loan_id where ${loanScope(a)})`];
    if (q.month) { conds.push(gte(payments.receivedOn, q.month + '-01'), lt(payments.receivedOn, addMonthsClamped(q.month + '-01', 1))); }
    const rows = await ctx.db.select({ p: payments, cliente: clients.nome, numero: installments.numero, por: staffProfiles.nome }).from(payments)
      .innerJoin(installments, eq(installments.id, payments.installmentId)).innerJoin(loans, eq(loans.id, installments.loanId)).innerJoin(clients, eq(clients.id, loans.clientId)).leftJoin(staffProfiles, eq(staffProfiles.userId, payments.receivedBy))
      .where(and(...conds)).orderBy(payments.receivedAt);
    const out: unknown[][] = [['data', 'recibo', 'tipo', 'cliente', 'parcela', 'forma', 'valor', 'recebido_por', 'motivo_estorno']];
    for (const { p, cliente, numero, por } of rows) out.push([p.receivedOn, p.receiptNo ?? '', p.kind, cliente, numero, p.method, money(p.valorCents), por ?? '', p.reversalReason ?? '']);
    await audit(ctx.db, auditActor(a), { action: 'exportacao.recebimentos', summary: `Exportou ${out.length - 1} lançamentos (CSV)` }, ctx.now());
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="recebimentos-${q.month ?? 'todos'}.csv"`);
    return csv(out);
  });

  // backup lógico (dados da empresa; sem senhas, tokens, segredos de 2FA e sem os arquivos binários)
  app.get('/export/backup', async (req, reply) => {
    const a = needAdmin(req);
    const o = a.orgId;
    const clientRows = (await ctx.db.select().from(clients).where(eq(clients.orgId, o))).map((c) => ({ ...c, cpf: readCpf(ctx, c), cpfEnc: undefined, cpfHash: undefined }));
    const dump = {
      geradoEm: ctx.now().toISOString(), versao: 1, aviso: 'Contém dados pessoais (CPF, telefone). Guarde em local seguro e criptografado.',
      settings: await ctx.db.select().from(settings).where(eq(settings.orgId, o)),
      equipe: await ctx.db.select({ id: users.id, email: users.email, status: users.status, nome: staffProfiles.nome, role: staffProfiles.role, comissaoBps: staffProfiles.comissaoBps, permCriar: staffProfiles.permCriar, permClientes: staffProfiles.permClientes, permExcluir: staffProfiles.permExcluir, permLucro: staffProfiles.permLucro, permTodos: staffProfiles.permTodos }).from(users).innerJoin(staffProfiles, eq(staffProfiles.userId, users.id)).where(eq(users.orgId, o)),
      clientes: clientRows,
      documentos: await ctx.db.select({ id: clientDocuments.id, clientId: clientDocuments.clientId, tipo: clientDocuments.tipo, status: clientDocuments.status, fileId: clientDocuments.fileId, createdAt: clientDocuments.createdAt }).from(clientDocuments).innerJoin(clients, eq(clients.id, clientDocuments.clientId)).where(eq(clients.orgId, o)),
      solicitacoes: await ctx.db.select().from(loanRequests).where(eq(loanRequests.orgId, o)),
      emprestimos: await ctx.db.select().from(loans).where(eq(loans.orgId, o)),
      parcelas: await ctx.db.select().from(installments).where(sql`${installments.loanId} in (select id from loans where org_id = ${o})`),
      pagamentos: await ctx.db.select().from(payments).where(eq(payments.orgId, o)),
      caixaSaidas: await ctx.db.select().from(cashOps).where(eq(cashOps.orgId, o)),
      caixaFechamentos: await ctx.db.select().from(cashClosings).where(eq(cashClosings.orgId, o)),
      auditoria: await ctx.db.select().from(auditLog).where(eq(auditLog.orgId, o)),
    };
    await audit(ctx.db, auditActor(a), { action: 'exportacao.backup', summary: 'Gerou backup completo (JSON)' }, ctx.now());
    reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="caixa-backup-${today(ctx)}.json"`);
    return JSON.stringify(dump);
  });
}

const clientScopeSql = (a: Actor) => (a.perms.todos ? sql`org_id = ${a.orgId} and deleted_at is null` : sql`org_id = ${a.orgId} and deleted_at is null and responsavel_id = ${a.userId}`);
export { forbidden };
