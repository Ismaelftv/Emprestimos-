import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { addClientUser, addStaff, api, login, makeEnv, type Sess, type TestEnv } from './helpers.js';
import { cashOps, loans, payments, settings } from '../src/db/schema.js';

let env: TestEnv;
let admin: Sess, ana: Sess, bruno: Sess, ca: Sess, cb: Sess;
let anaId: string, brunoId: string;
let A: { userId: string; clientId: string }, B: { userId: string; clientId: string };
const D0 = '2026-10-20T15:00:00.000Z'; // 12h em São Paulo, 20/out/2026

const mkLoan = async (s: Sess, clientId: string, o: Record<string, unknown> = {}) => {
  const r = await api(env, s).post('/loans', { clientId, valorCents: 50000, jurosBps: 2000, freqDays: 7, nParcelas: 4, firstDue: '2026-10-27', ...o });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const emails: [() => Sess, string][] = [[() => admin, 'admin@caixa.app'], [() => ana, 'ana@caixa.app'], [() => bruno, 'bruno@caixa.app'], [() => ca, 'a@cli.com'], [() => cb, 'b@cli.com']];
/** Move o relógio de teste e renova as sessões (elas expiram em 7 dias, como em produção). */
const setNow = async (iso: string) => { env.clock.now = new Date(iso); for (const [get, email] of emails) Object.assign(get(), await login(env, email)); };
const detail = async (s: Sess, id: string) => (await api(env, s).get(`/loans/${id}`)).body;

beforeAll(async () => {
  env = await makeEnv(D0);
  await addStaff(env, { email: 'admin@caixa.app', role: 'admin' });
  anaId = await addStaff(env, { email: 'ana@caixa.app', nome: 'Ana', perms: { criar: true, excluir: true } });
  brunoId = await addStaff(env, { email: 'bruno@caixa.app', nome: 'Bruno' });
  A = await addClientUser(env, { nome: 'Cliente A', email: 'a@cli.com', responsavelId: anaId });
  B = await addClientUser(env, { nome: 'Cliente B', email: 'b@cli.com', responsavelId: brunoId });
  [admin, ana, bruno, ca, cb] = await Promise.all([login(env, 'admin@caixa.app'), login(env, 'ana@caixa.app'), login(env, 'bruno@caixa.app'), login(env, 'a@cli.com'), login(env, 'b@cli.com')]);
});
afterAll(() => env.close());

describe('criação de empréstimo', () => {
  it('juros simples sobre o total, parcelas e vencimentos corretos', async () => {
    const id = await mkLoan(ana, A.clientId);
    const l = await detail(ana, id);
    expect(l.totalCents).toBe(60000); expect(l.status).toBe('ativo'); expect(l.installments.map((i: any) => i.amountCents)).toEqual([15000, 15000, 15000, 15000]);
    expect(l.installments.map((i: any) => i.dueDate)).toEqual(['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
    expect(l.installments[0].status).toBe('open');
  });
  it('mensal no dia 31 mantém o dia; prévia não grava nada', async () => {
    const r = await api(env, ana).post('/loans/preview', { valorCents: 30000, jurosBps: 0, freqDays: 30, nParcelas: 4, firstDue: '2027-01-31' });
    expect(r.body.installments.map((i: any) => i.due)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });
  it('escopo e permissões: não cria para cliente de outro; sem permissão não cria; valores inválidos são recusados', async () => {
    const body = { valorCents: 10000, jurosBps: 1000, freqDays: 7, nParcelas: 2, firstDue: '2026-11-01' };
    expect((await api(env, ana).post('/loans', { ...body, clientId: B.clientId })).status).toBe(404);
    expect((await api(env, bruno).post('/loans', { ...body, clientId: A.clientId })).status).toBe(404);
    await addStaff(env, { email: 'semcriar@caixa.app', perms: { criar: false } });
    expect((await api(env, await login(env, 'semcriar@caixa.app')).post('/loans', { ...body, clientId: A.clientId })).status).toBe(403);
    expect((await api(env, ana).post('/loans', { ...body, clientId: A.clientId, freqDays: 5 })).status).toBe(400);
    expect((await api(env, ana).post('/loans', { ...body, clientId: A.clientId, firstDue: '2026-02-30' })).status).toBe(400);
    expect((await api(env, ana).post('/loans', { ...body, clientId: A.clientId, valorCents: -5 })).status).toBe(400);
  });
  it('cliente bloqueado e limite por cliente', async () => {
    const body = { valorCents: 80000, jurosBps: 1000, freqDays: 7, nParcelas: 2, firstDue: '2026-11-01', clientId: B.clientId };
    await api(env, admin).patch(`/clients/${B.clientId}`, { limiteCents: 50000 });
    const r = await api(env, bruno).post('/loans', body); expect(r.status).toBe(409); expect(r.body.error).toBe('acima_do_limite');
    await api(env, admin).patch(`/clients/${B.clientId}`, { limiteCents: 0, bloqueado: true });
    expect((await api(env, bruno).post('/loans', { ...body, valorCents: 1000 })).body.error).toBe('cliente_bloqueado');
    await api(env, admin).patch(`/clients/${B.clientId}`, { bloqueado: false });
  });
  it('"entregue em dinheiro" lança a saída no caixa do funcionário; liberar depois também', async () => {
    const id = await mkLoan(ana, A.clientId, { valorCents: 20000, entrega: 'dinheiro' });
    const ops = await env.ctx.db.select().from(cashOps).where(eq(cashOps.loanId, id));
    expect(ops).toHaveLength(1); expect(ops[0]).toMatchObject({ staffId: anaId, valorCents: 20000, tipo: 'emprestimo', date: '2026-10-20' });
    const id2 = await mkLoan(ana, A.clientId, { valorCents: 10000 });
    expect((await api(env, ana).post(`/loans/${id2}/disburse`, { method: 'dinheiro' })).status).toBe(200);
    expect((await api(env, ana).post(`/loans/${id2}/disburse`, { method: 'dinheiro' })).status).toBe(409);
    expect(await env.ctx.db.select().from(cashOps).where(eq(cashOps.loanId, id2))).toHaveLength(1);
  });
  it('as condições (multa/mora/desconto) ficam congeladas no empréstimo', async () => {
    const id = await mkLoan(ana, A.clientId);
    await env.ctx.db.update(settings).set({ multaBps: 1000, moraBpsMes: 500 }).where(eq(settings.orgId, env.orgId));
    const l = await detail(ana, id); expect(l.multaBps).toBe(200); expect(l.moraBpsMes).toBe(100);
    const novo = await detail(ana, await mkLoan(ana, A.clientId)); expect(novo.multaBps).toBe(1000);
    await env.ctx.db.update(settings).set({ multaBps: 200, moraBpsMes: 100 }).where(eq(settings.orgId, env.orgId));
    const c = (await api(env, ana).get(`/loans/${id}/contract`)).body.text as string;
    expect(c).toContain('Multa de 2%'); expect(c).toContain('R$'); expect(c).toContain('Cliente A');
  });
});

describe('recebimentos, atraso e livro-razão', () => {
  let id: string, inst: any[];
  beforeAll(async () => { id = await mkLoan(ana, A.clientId, { firstDue: '2026-10-27' }); inst = (await detail(ana, id)).installments; });

  it('pagamento parcial deixa saldo; recibos são numerados em sequência', async () => {
    const r1 = await api(env, ana).post(`/installments/${inst[0].id}/payments`, { valorCents: 5000, method: 'pix' });
    expect(r1.status).toBe(201); expect(r1.body.quitada).toBe(false); expect(r1.body.saldoCents).toBe(10000);
    const r2 = await api(env, ana).post(`/installments/${inst[0].id}/payments`, { valorCents: 10000, method: 'dinheiro' });
    expect(r2.body.quitada).toBe(true);
    expect(Number(r2.body.receiptNo.slice(2))).toBe(Number(r1.body.receiptNo.slice(2)) + 1);
    const l = await detail(ana, id); const i0 = l.installments[0];
    expect(i0.status).toBe('paid'); expect(i0.pagamentos).toHaveLength(2); expect(i0.recebidoCents).toBe(15000);
  });
  it('recusa valor acima do saldo, parcela já paga e valores inválidos', async () => {
    expect((await api(env, ana).post(`/installments/${inst[1].id}/payments`, { valorCents: 15001, method: 'pix' })).body.error).toBe('acima_do_saldo');
    expect((await api(env, ana).post(`/installments/${inst[0].id}/payments`, { valorCents: 100, method: 'pix' })).status).toBe(409);
    expect((await api(env, ana).post(`/installments/${inst[1].id}/payments`, { valorCents: 0, method: 'pix' })).status).toBe(400);
    expect((await api(env, ana).post(`/installments/${inst[1].id}/payments`, { valorCents: 100, method: 'cheque' })).status).toBe(400);
  });
  it('multa única + mora proporcional ao atraso; encargos congelam quando a parcela é paga', async () => {
    await setNow('2026-11-12T15:00:00Z'); // parcela 2 (03/nov) com 9 dias; parcela 3 (10/nov) com 2
    let l = await detail(ana, id);
    expect(l.installments[1]).toMatchObject({ status: 'late', days: 9, multaCents: 300, moraCents: 45, extraCents: 345, balanceCents: 15345 });
    const pay = await api(env, ana).post(`/installments/${inst[1].id}/payments`, { valorCents: 15345, method: 'pix' });
    expect(pay.body.quitada).toBe(true);
    await setNow('2027-03-01T15:00:00Z'); // meses depois: continua quitada, sem crescer
    l = await detail(ana, id);
    expect(l.installments[1]).toMatchObject({ status: 'paid', balanceCents: 0, extraCents: 345 });
    await setNow(D0);
  });
  it('perdoar multa e mora zera os encargos sem apagar nada', async () => {
    await setNow('2026-11-25T15:00:00Z');
    expect((await detail(ana, id)).installments[2].extraCents).toBeGreaterThan(0);
    const w = await api(env, ana).post(`/loans/${id}/waive`); expect(w.body.perdoadas).toBeGreaterThanOrEqual(1);
    const l = await detail(ana, id); expect(l.installments[2]).toMatchObject({ extraCents: 0, balanceCents: 15000, waived: true });
    await setNow(D0);
  });
  it('desfazer: só admin ou quem recebeu; vira estorno no livro-razão e reabre a parcela', async () => {
    const l = await detail(ana, id); const pg = l.installments[0].pagamentos[1];
    // outro funcionário (Bruno) nem enxerga o cliente => 404
    expect((await api(env, bruno).post(`/payments/${pg.id}/reverse`, { reason: 'engano' })).status).toBe(404);
    // funcionário com acesso total mas que não recebeu
    await addStaff(env, { email: 'todos@caixa.app', perms: { todos: true } });
    const todos = await login(env, 'todos@caixa.app');
    expect((await api(env, todos).post(`/payments/${pg.id}/reverse`, { reason: 'engano' })).status).toBe(400);
    expect((await api(env, ana).post(`/payments/${pg.id}/reverse`, { reason: 'x' })).status).toBe(400); // motivo curto
    expect((await api(env, ana).post(`/payments/${pg.id}/reverse`, { reason: 'valor lançado errado' })).status).toBe(200);
    expect((await api(env, admin).post(`/payments/${pg.id}/reverse`, { reason: 'de novo' })).status).toBe(409);
    const after = await detail(ana, id);
    expect(after.installments[0]).toMatchObject({ status: 'open', balanceCents: 10000, recebidoCents: 5000 });
    expect(after.installments[0].pagamentos.find((p: any) => p.id === pg.id).estornado).toBe(true);
    const ledger = await env.ctx.db.select().from(payments).where(eq(payments.installmentId, inst[0].id));
    expect(ledger.map((p) => p.valorCents).sort((a, b) => a - b)).toEqual([-10000, 5000, 10000]); // nada foi apagado
  });
  it('o livro-razão é imutável no banco', async () => {
    await expect(env.ctx.db.update(payments).set({ valorCents: 1 }).where(sql`true`)).rejects.toThrow();
    await expect(env.ctx.db.delete(payments).where(sql`true`)).rejects.toThrow();
  });
  it('empréstimo com recebimentos não pode ser cancelado; sem recebimentos pode (com permissão)', async () => {
    expect((await api(env, ana).post(`/loans/${id}/cancel`)).body.error).toBe('tem_pagamentos');
    const novo = await mkLoan(ana, A.clientId);
    await addStaff(env, { email: 'ex2@caixa.app', perms: { excluir: true } });
    expect((await api(env, await login(env, 'ex2@caixa.app')).post(`/loans/${novo}/cancel`)).status).toBe(404); // pode cancelar, mas o cliente não é dele
    expect((await api(env, bruno).post(`/loans/${novo}/cancel`)).status).toBe(403); // sem permissão de excluir
    expect((await api(env, ana).post(`/loans/${novo}/cancel`)).status).toBe(200);
    expect((await detail(ana, novo)).status).toBe('cancelado');
  });
  it('23h em São Paulo ainda é "hoje" (UTC já virou o dia)', async () => {
    const l2 = await mkLoan(ana, A.clientId, { firstDue: '2026-10-20' });
    await setNow('2026-10-21T02:30:00Z'); // 23:30 de 20/out em SP
    let d = await detail(ana, l2); expect(d.installments[0].status).toBe('today');
    await setNow('2026-10-21T03:05:00Z'); // 00:05 de 21/out
    d = await detail(ana, l2); expect(d.installments[0].status).toBe('late'); expect(d.installments[0].days).toBe(1);
    await setNow(D0);
  });
  it('agenda filtra por situação e respeita o escopo', async () => {
    await setNow('2026-11-12T15:00:00Z');
    const atraso = (await api(env, ana).get('/installments?filtro=atraso')).body.items;
    expect(atraso.length).toBeGreaterThan(0); expect(atraso.every((i: any) => i.status === 'late' && i.clientNome === 'Cliente A')).toBe(true);
    expect((await api(env, bruno).get('/installments?filtro=atraso')).body.items).toEqual([]);
    const pagos = (await api(env, ana).get('/installments?filtro=pagos')).body.items; expect(pagos.every((i: any) => i.status === 'paid')).toBe(true);
    await setNow(D0);
  });
});

describe('quitação antecipada', () => {
  it('desconta parte dos juros só das parcelas futuras e quita tudo com um recibo; estorno reabre', async () => {
    const id = await mkLoan(ana, A.clientId, { firstDue: '2026-10-10' }); // vencimentos 10/10, 17/10, 24/10, 31/10 (hoje 20/10)
    const inst = (await detail(ana, id)).installments;
    await api(env, ana).post(`/installments/${inst[0].id}/payments`, { valorCents: 15350, method: 'pix' }); // venceu há 10 dias: 15000 + multa 300 + mora 50
    const q = (await api(env, ana).get(`/loans/${id}/payoff-quote`)).body;
    // parcela 2 venceu há 3 dias (15000 + multa 300 + mora 15 = 15315); 3 e 4 futuras: 15000 - 1250 cada
    expect(q.parts.map((p: any) => [p.numero, p.payCents, p.discountCents])).toEqual([[2, 15315, 0], [3, 13750, 1250], [4, 13750, 1250]]);
    expect(q.totalCents).toBe(42815); expect(q.discountCents).toBe(2500);
    const r = await api(env, ana).post(`/loans/${id}/payoff`, { method: 'dinheiro' });
    expect(r.status).toBe(200); expect(r.body.totalCents).toBe(42815);
    const l = await detail(ana, id); expect(l.status).toBe('quitado'); expect(l.installments.every((i: any) => i.status === 'paid' && i.balanceCents === 0)).toBe(true);
    expect((await api(env, ana).post(`/loans/${id}/payoff`, { method: 'dinheiro' })).status).toBe(409);
    const pg = l.installments[2].pagamentos.find((p: any) => p.kind === 'quitacao');
    const rec = (await api(env, ana).get(`/payments/${pg.id}/receipt`)).body;
    expect(rec).toMatchObject({ valorCents: 42815, kind: 'quitacao', descontoCents: 2500, clienteNome: 'Cliente A' }); expect(rec.parcelas).toHaveLength(3);
    expect((await api(env, ana).post(`/payments/${pg.id}/reverse`, { reason: 'cliente desistiu' })).body.reversed).toBeGreaterThan(1);
    const re = await detail(ana, id); expect(re.status).toBe('ativo'); expect(re.installments[3].status).toBe('open'); expect(re.installments[0].status).toBe('paid');
  });
  it('recibo em PDF', async () => {
    const id = await mkLoan(ana, A.clientId); const i = (await detail(ana, id)).installments[0];
    await api(env, ana).post(`/installments/${i.id}/payments`, { valorCents: 15000, method: 'pix' });
    const pg = (await detail(ana, id)).installments[0].pagamentos[0];
    const pdf = await api(env, ana).get(`/payments/${pg.id}/receipt.pdf`);
    expect(pdf.raw.headers['content-type']).toBe('application/pdf'); expect(pdf.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('isolamento: cliente só vê o que é dele', () => {
  let loanA: string, loanB: string, payB: string, instA: string, instB: string;
  beforeAll(async () => {
    loanA = await mkLoan(ana, A.clientId); loanB = await mkLoan(bruno, B.clientId);
    instA = (await detail(ana, loanA)).installments[0].id; instB = (await detail(bruno, loanB)).installments[0].id;
    await api(env, bruno).post(`/installments/${instB}/payments`, { valorCents: 15000, method: 'pix' });
    payB = (await detail(bruno, loanB)).installments[0].pagamentos[0].id;
  });
  it('/me/loans devolve só os empréstimos do próprio cliente (sem dados internos da equipe)', async () => {
    const mine = (await api(env, ca).get('/me/loans')).body, theirs = (await api(env, cb).get('/me/loans')).body;
    expect(mine.every((l: any) => l.clientId === A.clientId)).toBe(true); expect(theirs.every((l: any) => l.clientId === B.clientId)).toBe(true);
    expect(mine.some((l: any) => l.id === loanB)).toBe(false);
    const pay = theirs.find((l: any) => l.id === loanB).installments[0].pagamentos[0];
    expect(pay.recebidoPor).toBeUndefined(); expect(pay.recebidoPorId).toBeUndefined();
  });
  it('cliente não lê nem altera empréstimo, parcela, recibo ou contrato de outro cliente', async () => {
    const c = api(env, ca);
    expect((await c.get(`/loans/${loanB}`)).status).toBe(403); // rota da equipe
    expect((await c.get(`/loans/${loanB}/contract`)).status).toBe(404);
    expect((await c.get(`/loans/${loanB}/payoff-quote`)).status).toBe(404);
    expect((await c.get(`/payments/${payB}/receipt`)).status).toBe(404);
    expect((await c.get(`/payments/${payB}/receipt.pdf`)).status).toBe(404);
    expect((await c.post(`/loans/${loanB}/accept`, { aceito: true })).status).toBe(404);
    expect((await c.post(`/loans/${loanB}/decline`)).status).toBe(404);
    expect((await c.post(`/me/installments/${instB}/report?method=dinheiro`)).status).toBe(404);
    expect((await c.post(`/me/loans/${loanB}/payoff-request?method=dinheiro`)).status).toBe(404);
    expect((await c.post(`/installments/${instB}/payments`, { valorCents: 100, method: 'pix' })).status).toBe(403);
    expect((await c.post(`/payments/${payB}/reverse`, { reason: 'tentativa' })).status).toBe(403);
    expect((await c.post(`/loans/${loanA}/payoff`, { method: 'pix' })).status).toBe(403); // cliente não quita sozinho
    expect((await c.post(`/loans/${loanA}/cancel`)).status).toBe(403);
    expect((await c.post('/loans', { clientId: A.clientId, valorCents: 10000, jurosBps: 0, freqDays: 7, nParcelas: 1, firstDue: '2026-11-01' })).status).toBe(403);
    expect((await c.get('/installments')).status).toBe(403);
    expect((await c.get('/inbox')).status).toBe(403);
    expect(await env.ctx.db.select().from(loans).where(eq(loans.id, loanB)).then((r) => r[0].status)).toBe('ativo');
    // o próprio recibo/contrato, sim
    const own = (await detail(ana, loanA)); expect((await c.get(`/loans/${loanA}/contract`)).status).toBe(200);
    void own; void instA;
  });
  it('funcionário sem acesso ao cliente não enxerga empréstimos/recebimentos dele', async () => {
    const b = api(env, bruno);
    expect((await b.get(`/loans/${loanA}`)).status).toBe(404);
    expect((await b.get(`/payments/${(await detail(ana, loanA)).installments[0].id}/receipt`)).status).toBe(404);
    expect((await b.post(`/installments/${instA}/payments`, { valorCents: 100, method: 'pix' })).status).toBe(404);
    expect((await b.get('/loans')).body.every((l: any) => l.clientId === B.clientId)).toBe(true);
  });
});
