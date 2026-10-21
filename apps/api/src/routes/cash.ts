import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { brl, isValidDate } from '@caixa/core';
import type { Ctx } from '../context.js';
import { cashClosings, cashOps, clients, installments, loans, payments, staffProfiles } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { auditActor, needStaff } from '../auth/guards.js';
import { today } from '../services/loans.js';

const dateSchema = z.string().refine(isValidDate, 'Data inválida');

/** Caixa do dia de UM funcionário: dinheiro que entrou (líquido de estornos), Pix informativo, saídas e saldo esperado. */
export async function cashData(ctx: Ctx, orgId: string, staffId: string, date: string) {
  const pays = await ctx.db.select({ p: payments, cliente: clients.nome, numero: installments.numero }).from(payments)
    .innerJoin(installments, eq(installments.id, payments.installmentId)).innerJoin(loans, eq(loans.id, installments.loanId)).innerJoin(clients, eq(clients.id, loans.clientId))
    .where(and(eq(payments.orgId, orgId), eq(payments.receivedBy, staffId), eq(payments.receivedOn, date), sql`${payments.method} <> 'desconto'`)).orderBy(payments.receivedAt);
  const dinheiroCents = pays.filter((x) => x.p.method === 'dinheiro').reduce((a, x) => a + x.p.valorCents, 0);
  const pixCents = pays.filter((x) => x.p.method === 'pix').reduce((a, x) => a + x.p.valorCents, 0);
  const saidas = await ctx.db.select().from(cashOps).where(and(eq(cashOps.orgId, orgId), eq(cashOps.staffId, staffId), eq(cashOps.date, date))).orderBy(cashOps.createdAt);
  const saidasCents = saidas.reduce((a, o) => a + o.valorCents, 0);
  const [prev] = await ctx.db.select().from(cashClosings).where(and(eq(cashClosings.staffId, staffId), lt(cashClosings.date, date))).orderBy(desc(cashClosings.date)).limit(1);
  const inicialCents = prev?.contadoCents ?? 0;
  const [fech] = await ctx.db.select().from(cashClosings).where(and(eq(cashClosings.staffId, staffId), eq(cashClosings.date, date))).limit(1);
  return { staffId, date, inicialCents, dinheiroCents, pixCents, saidasCents, esperadoCents: inicialCents + dinheiroCents - saidasCents,
    movimentos: pays.map((x) => ({ id: x.p.id, cliente: x.cliente, parcela: x.numero, method: x.p.method, valorCents: x.p.valorCents, estorno: x.p.kind === 'estorno', receiptNo: x.p.receiptNo, em: x.p.receivedAt })),
    saidas: saidas.map((o) => ({ id: o.id, tipo: o.tipo, valorCents: o.valorCents, descricao: o.descricao })), fechamento: fech ? { contadoCents: fech.contadoCents, diffCents: fech.diffCents, obs: fech.obs, closedAt: fech.closedAt, esperadoCents: fech.esperadoCents } : null };
}

export async function cashRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.get('/cash', async (req) => {
    const a = needStaff(req);
    const q = parse(z.object({ staffId: z.string().uuid().optional(), date: dateSchema.optional() }), req.query);
    const staffId = q.staffId ?? a.userId;
    if (staffId !== a.userId && a.role !== 'admin') throw forbidden('Você só vê o seu próprio caixa');
    return cashData(ctx, a.orgId, staffId, q.date ?? today(ctx));
  });

  app.post('/cash/ops', async (req, reply) => {
    const a = needStaff(req);
    const b = parse(z.object({ tipo: z.enum(['despesa', 'sangria', 'emprestimo']), valorCents: z.number().int().min(1).max(100_000_000_00), descricao: z.string().max(120).default(''), date: dateSchema.optional() }), req.body);
    const date = b.date ?? today(ctx);
    if (date > today(ctx)) throw badRequest('Data no futuro');
    const [closed] = await ctx.db.select({ id: cashClosings.id }).from(cashClosings).where(and(eq(cashClosings.staffId, a.userId), eq(cashClosings.date, date))).limit(1);
    if (closed) throw conflict('O caixa deste dia já foi fechado', 'caixa_fechado');
    const [o] = await ctx.db.insert(cashOps).values({ orgId: a.orgId, staffId: a.userId, date, tipo: b.tipo, valorCents: b.valorCents, descricao: b.descricao.trim() }).returning();
    await audit(ctx.db, auditActor(a), { action: 'caixa.saida', entity: 'cash_op', entityId: o.id, summary: `Lançou saída de ${brl(b.valorCents)} no caixa (${b.tipo})` }, ctx.now());
    reply.code(201);
    return { id: o.id };
  });

  // Fechar de novo no mesmo dia atualiza o fechamento (ex.: entrou um recebimento depois); o histórico fica na auditoria.
  app.post('/cash/close', async (req) => {
    const a = needStaff(req);
    const b = parse(z.object({ contadoCents: z.number().int().min(0), obs: z.string().max(140).default(''), date: dateSchema.optional() }), req.body);
    const date = b.date ?? today(ctx);
    if (date > today(ctx)) throw badRequest('Data no futuro');
    const d = await cashData(ctx, a.orgId, a.userId, date);
    const diff = b.contadoCents - d.esperadoCents;
    const row = { orgId: a.orgId, staffId: a.userId, date, inicialCents: d.inicialCents, entradasCents: d.dinheiroCents, pixCents: d.pixCents, saidasCents: d.saidasCents, esperadoCents: d.esperadoCents, contadoCents: b.contadoCents, diffCents: diff, obs: b.obs.trim(), closedAt: ctx.now() };
    await ctx.db.insert(cashClosings).values(row).onConflictDoUpdate({ target: [cashClosings.staffId, cashClosings.date], set: row });
    await audit(ctx.db, auditActor(a), { action: 'caixa.fechou', entity: 'cash_closing', summary: `Fechou o caixa de ${date}: contado ${brl(b.contadoCents)} (esperado ${brl(d.esperadoCents)})`, meta: { diffCents: diff } }, ctx.now());
    return { esperadoCents: d.esperadoCents, contadoCents: b.contadoCents, diffCents: diff };
  });

  app.get('/cash/closings', async (req) => {
    const a = needStaff(req);
    const rows = await ctx.db.select({ c: cashClosings, nome: staffProfiles.nome }).from(cashClosings).innerJoin(staffProfiles, eq(staffProfiles.userId, cashClosings.staffId))
      .where(a.role === 'admin' ? eq(cashClosings.orgId, a.orgId) : and(eq(cashClosings.orgId, a.orgId), eq(cashClosings.staffId, a.userId))).orderBy(desc(cashClosings.closedAt)).limit(30);
    return rows.map(({ c, nome }) => ({ id: c.id, staffId: c.staffId, funcionario: nome, date: c.date, esperadoCents: c.esperadoCents, contadoCents: c.contadoCents, diffCents: c.diffCents, obs: c.obs, closedAt: c.closedAt }));
  });
}
