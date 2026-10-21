import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { addStaff, api, JPEG, login, makeEnv, upload, type Sess, type TestEnv } from './helpers.js';
import { auditLog, cashOps, loans, paymentReports } from '../src/db/schema.js';
import { runDueJobs } from '../src/lib/queue.js';
import { makeHandlers } from '../src/jobs.js';

let env: TestEnv, admin: Sess, maria: Sess, anaId: string;
let clientId: string, requestId: string, loanId: string;

beforeAll(async () => {
  env = await makeEnv('2026-10-20T15:00:00.000Z');
  await addStaff(env, { email: 'admin@caixa.app', role: 'admin', nome: 'Dono' });
  admin = await login(env, 'admin@caixa.app');
});
afterAll(() => env.close());

describe('fluxo completo: solicita → aprova → aceita → paga parcial → recibo → quita', () => {
  it('cliente cria a conta e simula', async () => {
    const r = await api(env, null).post('/auth/signup', { nome: 'Maria Souza', whatsapp: '11987654321', cpf: '529.982.247-25', email: 'maria@cli.com', password: 'minha-senha-123', consent: true });
    expect(r.status).toBe(201); clientId = r.body.me.clientId;
    maria = await login(env, 'maria@cli.com', 'minha-senha-123');
    const sim = await api(env, maria).post('/me/simulate', { valorCents: 40000, nParcelas: 4, freqDays: 7 });
    expect(sim.body).toMatchObject({ jurosBps: 2000, totalCents: 48000, parcelaCents: 12000 });
  });
  it('valida limites da solicitação e permite uma por vez', async () => {
    const m = api(env, maria);
    expect((await m.post('/me/requests', { valorCents: 5000, nParcelas: 4, freqDays: 7 })).body.error).toBe('valor_fora_do_limite');
    expect((await m.post('/me/requests', { valorCents: 900000, nParcelas: 4, freqDays: 7 })).body.error).toBe('valor_fora_do_limite');
    expect((await m.post('/me/requests', { valorCents: 40000, nParcelas: 30, freqDays: 7 })).body.error).toBe('parcelas_demais');
    const ok = await m.post('/me/requests', { valorCents: 40000, nParcelas: 4, freqDays: 7, motivo: 'capital de giro' });
    expect(ok.status).toBe(201); requestId = ok.body.id;
    expect((await m.post('/me/requests', { valorCents: 40000, nParcelas: 4, freqDays: 7 })).body.error).toBe('solicitacao_pendente');
  });
  it('equipe vê o contexto e aprova ajustando as condições → proposta; cliente é avisado por e-mail', async () => {
    const a = api(env, admin);
    const list = (await a.get('/requests')).body; expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ clienteNome: 'Maria Souza', cadastroVerificado: false, parcelasAtrasadas: 0, jurosSugeridoBps: 2000 });
    expect((await a.get('/inbox')).body.solicitacoes).toBe(1);
    const ap = await a.post(`/requests/${requestId}/approve`, { valorCents: 30000, jurosBps: 3000, nParcelas: 3, firstDue: '2026-10-27' });
    expect(ap.status).toBe(200); loanId = ap.body.loanId;
    expect((await a.post(`/requests/${requestId}/approve`, { firstDue: '2026-10-27' })).status).toBe(409);
    const [l] = await env.ctx.db.select().from(loans).where(eq(loans.id, loanId));
    expect(l).toMatchObject({ status: 'proposta', valorCents: 30000, totalCents: 39000, nParcelas: 3, requestId });
    await runDueJobs(env.ctx.db, makeHandlers(env.ctx), env.clock.now);
    expect(env.mailer.last('maria@cli.com')!.subject).toMatch(/proposta/i);
  });
  it('proposta ainda não vale: não aparece como parcela a receber nem aceita pagamento', async () => {
    const lv = (await api(env, admin).get(`/loans/${loanId}`)).body;
    expect(lv.status).toBe('proposta');
    expect((await api(env, admin).post(`/installments/${lv.installments[0].id}/payments`, { valorCents: 100, method: 'pix' })).body.error).toBe('emprestimo_inativo');
    expect((await api(env, admin).get('/installments')).body.items).toEqual([]);
    const mine = (await api(env, maria).get('/me/requests')).body[0];
    expect(mine.status).toBe('aprovada'); expect(mine.proposta).toMatchObject({ valorCents: 30000, parcelaCents: 13000, totalCents: 39000, status: 'proposta' });
    expect((await api(env, maria).get(`/loans/${loanId}/contract`)).body.text).toMatch(/R\$\s300,00/);
  });
  it('cliente aceita o contrato (registrado com data, IP e versão); só uma vez', async () => {
    const m = api(env, maria);
    expect((await m.post(`/loans/${loanId}/accept`, { aceito: false })).status).toBe(400);
    expect((await m.post(`/loans/${loanId}/accept`, { aceito: true })).status).toBe(200);
    expect((await m.post(`/loans/${loanId}/accept`, { aceito: true })).status).toBe(409);
    const [l] = await env.ctx.db.select().from(loans).where(eq(loans.id, loanId));
    expect(l.status).toBe('ativo'); expect(l.acceptedAt).not.toBeNull(); expect(l.acceptedIp).toBeTruthy(); expect(l.contractVersion).toBeTruthy();
    const acc = await env.ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'proposta.aceitou'))); expect(acc).toHaveLength(1);
  });
  it('equipe libera o valor em dinheiro (saída no caixa)', async () => {
    expect((await api(env, admin).post(`/loans/${loanId}/disburse`, { method: 'dinheiro' })).status).toBe(200);
    expect((await env.ctx.db.select().from(cashOps).where(eq(cashOps.loanId, loanId)))[0]).toMatchObject({ valorCents: 30000, tipo: 'emprestimo' });
  });
  it('cliente envia comprovante Pix; equipe confere e confirma pagamento PARCIAL; sai o recibo', async () => {
    const lv = (await api(env, maria).get('/me/loans')).body[0]; const inst = lv.installments[0];
    expect((await upload(env, maria, `/me/installments/${inst.id}/report?method=pix`, Buffer.from('nao e imagem'))).status).toBe(400);
    expect((await api(env, maria).post(`/me/installments/${inst.id}/report?method=pix`)).status).toBe(400); // sem arquivo
    const rep = await upload(env, maria, `/me/installments/${inst.id}/report?method=pix`); expect(rep.status).toBe(201);
    expect((await upload(env, maria, `/me/installments/${inst.id}/report?method=pix`)).body.error).toBe('aviso_pendente');
    expect((await api(env, maria).get('/me/loans')).body[0].installments[0].relato).toMatchObject({ status: 'pendente', method: 'pix' });
    const a = api(env, admin);
    const pend = (await a.get('/payment-reports')).body; expect(pend).toHaveLength(1); expect(pend[0]).toMatchObject({ valorCents: 13000, clienteNome: 'Maria Souza' });
    expect((await a.get(`/files/${pend[0].fileId}`)).status).toBe(200); // equipe vê o comprovante
    const ok = await a.post(`/payment-reports/${pend[0].id}/confirm`, { valorCents: 5000 });
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ quitada: false, saldoCents: 8000 });
    expect((await a.post(`/payment-reports/${pend[0].id}/confirm`)).status).toBe(409);
    const mine = (await api(env, maria).get('/me/loans')).body[0].installments[0];
    expect(mine.balanceCents).toBe(8000); expect(mine.partial).toBe(true); expect(mine.pagamentos[0]).toMatchObject({ valorCents: 5000, method: 'pix', receiptNo: ok.body.receiptNo });
    const receipt = await api(env, maria).get(`/payments/${mine.pagamentos[0].id}/receipt`);
    expect(receipt.body).toMatchObject({ no: ok.body.receiptNo, valorCents: 5000, saldoRestanteCents: 8000, clienteNome: 'Maria Souza' });
    const [r] = await env.ctx.db.select().from(paymentReports); expect(r.status).toBe('confirmado');
  });
  it('aviso de dinheiro recusado com motivo aparece para o cliente', async () => {
    const inst = (await api(env, maria).get('/me/loans')).body[0].installments[1];
    expect((await api(env, maria).post(`/me/installments/${inst.id}/report?method=dinheiro&note=sexta%2010h`)).status).toBe(201);
    const a = api(env, admin); const rep = (await a.get('/payment-reports')).body[0];
    expect(rep.method).toBe('dinheiro'); expect(rep.note).toBe('sexta 10h');
    await a.post(`/payment-reports/${rep.id}/refuse`, { motivo: 'não combinamos isso' });
    expect((await api(env, maria).get('/me/loans')).body[0].installments[1].relato).toMatchObject({ status: 'recusado', motivoRecusa: 'não combinamos isso' });
  });
  it('cliente pede a quitação; equipe confirma; empréstimo quitado e recibo único', async () => {
    const m = api(env, maria);
    const req = await upload(env, maria, `/me/loans/${loanId}/payoff-request?method=pix`); expect(req.status).toBe(201);
    expect(req.body.descontoCents).toBeGreaterThan(0);
    expect((await upload(env, maria, `/me/loans/${loanId}/payoff-request?method=pix`)).body.error).toBe('quitacao_pendente');
    expect((await m.get('/me/loans')).body[0].quitacaoPendente).toBe(true);
    const a = api(env, admin); const pend = (await a.get('/payoff-requests')).body; expect(pend).toHaveLength(1);
    expect(pend[0].valorHojeCents).toBe(req.body.valorCents);
    const done = await a.post(`/payoff-requests/${pend[0].id}/confirm`); expect(done.status).toBe(200);
    expect(done.body.receiptNo).toMatch(/^R-\d{6}$/);
    const lv = (await m.get('/me/loans')).body[0];
    expect(lv.status).toBe('quitado'); expect(lv.installments.every((i: any) => i.status === 'paid')).toBe(true); expect(lv.quitacaoPendente).toBe(false);
    expect((await a.post(`/payoff-requests/${pend[0].id}/confirm`)).status).toBe(409);
  });
  it('toda a cadeia ficou na auditoria, que continua íntegra', async () => {
    const a = api(env, admin); const acts = (await a.get('/audit?limit=200')).body.items.map((i: any) => i.action);
    for (const x of ['cliente.autocadastro', 'solicitacao.criou', 'solicitacao.aprovou', 'proposta.aceitou', 'emprestimo.liberou', 'comprovante.enviou', 'pagamento.recebeu', 'comprovante.recusou', 'quitacao.solicitou', 'emprestimo.quitou']) expect(acts, x).toContain(x);
    expect((await a.get('/audit/verify')).body.ok).toBe(true);
  });
});

describe('recusa e desistência', () => {
  it('equipe recusa com motivo; cliente vê o motivo; pode pedir de novo', async () => {
    const m = api(env, maria), a = api(env, admin);
    const r = await m.post('/me/requests', { valorCents: 20000, nParcelas: 2, freqDays: 15 }); expect(r.status).toBe(201);
    expect((await a.post(`/requests/${r.body.id}/refuse`, { motivo: 'x' })).status).toBe(400);
    expect((await a.post(`/requests/${r.body.id}/refuse`, { motivo: 'existe parcela em atraso' })).status).toBe(200);
    const mine = (await m.get('/me/requests')).body.find((x: any) => x.id === r.body.id);
    expect(mine).toMatchObject({ status: 'recusada', motivoRecusa: 'existe parcela em atraso' });
    expect((await a.post(`/requests/${r.body.id}/refuse`, { motivo: 'outra vez' })).status).toBe(409);
  });
  it('cliente recusa a proposta: empréstimo cancelado e solicitação marcada', async () => {
    const m = api(env, maria), a = api(env, admin);
    const r = await m.post('/me/requests', { valorCents: 20000, nParcelas: 2, freqDays: 15 });
    const ap = await a.post(`/requests/${r.body.id}/approve`, { firstDue: '2026-11-05' });
    expect((await m.post(`/loans/${ap.body.loanId}/decline`)).status).toBe(200);
    expect((await a.get(`/loans/${ap.body.loanId}`)).body.status).toBe('cancelado');
    expect((await m.get('/me/requests')).body.find((x: any) => x.id === r.body.id).motivoRecusa).toMatch(/não aceita/i);
    expect((await m.post(`/loans/${ap.body.loanId}/accept`, { aceito: true })).status).toBe(409);
  });
  it('cliente bloqueado não pode solicitar', async () => {
    await api(env, admin).patch(`/clients/${clientId}`, { bloqueado: true });
    expect((await api(env, maria).post('/me/requests', { valorCents: 20000, nParcelas: 2, freqDays: 15 })).body.error).toBe('cliente_bloqueado');
  });
  void JPEG;
});
