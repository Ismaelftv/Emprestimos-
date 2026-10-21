import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addClientUser, addStaff, api, login, makeEnv, type Sess, type TestEnv } from './helpers.js';
import { staffProfiles } from '../src/db/schema.js';
import { csvCell } from '../src/routes/reports.js';

let env: TestEnv, admin: Sess, ana: Sess, bruno: Sess, ca: Sess;
let anaId: string, A: { clientId: string }, B: { clientId: string };
const emails: [() => Sess, string][] = [[() => admin, 'admin@caixa.app'], [() => ana, 'ana@caixa.app'], [() => bruno, 'bruno@caixa.app'], [() => ca, 'a@cli.com']];
const setNow = async (iso: string) => { env.clock.now = new Date(iso); for (const [get, e] of emails) Object.assign(get(), await login(env, e)); };

beforeAll(async () => {
  env = await makeEnv('2026-10-20T15:00:00.000Z');
  await addStaff(env, { email: 'admin@caixa.app', role: 'admin', nome: 'Dono' });
  anaId = await addStaff(env, { email: 'ana@caixa.app', nome: 'Ana', perms: { criar: true } });
  const brunoId = await addStaff(env, { email: 'bruno@caixa.app', nome: 'Bruno', perms: { lucro: true } });
  A = await addClientUser(env, { nome: '=HYPERLINK("http://x")', email: 'a@cli.com', responsavelId: anaId });
  B = await addClientUser(env, { nome: 'Cliente B', email: 'b@cli.com', responsavelId: brunoId });
  [admin, ana, bruno, ca] = await Promise.all(emails.map(([, e]) => login(env, e)));
  await env.ctx.db.update(staffProfiles).set({ comissaoBps: 500 }).where(eq(staffProfiles.userId, anaId));
});
afterAll(() => env.close());

const loanOf = async (s: Sess, clientId: string, o: Record<string, unknown> = {}) => {
  const r = await api(env, s).post('/loans', { clientId, valorCents: 50000, jurosBps: 2000, freqDays: 7, nParcelas: 4, firstDue: '2026-10-20', ...o }); expect(r.status).toBe(201);
  return (await api(env, s).get(`/loans/${r.body.id}`)).body;
};

describe('caixa diário', () => {
  let loan: any;
  it('esperado = inicial + dinheiro recebido − saídas; Pix é só informativo; empréstimo entregue em dinheiro sai do caixa', async () => {
    loan = await loanOf(ana, A.clientId, { valorCents: 10000, jurosBps: 0, nParcelas: 1, entrega: 'dinheiro' }); // saída 10000 (parcela única 10000)
    const l2 = await loanOf(ana, A.clientId, { firstDue: '2026-10-20' });
    await api(env, ana).post(`/installments/${l2.installments[0].id}/payments`, { valorCents: 15000, method: 'dinheiro' });
    await api(env, ana).post(`/installments/${l2.installments[1].id}/payments`, { valorCents: 5000, method: 'pix' });
    expect((await api(env, ana).post('/cash/ops', { tipo: 'despesa', valorCents: 2000, descricao: 'gasolina' })).status).toBe(201);
    const c = (await api(env, ana).get('/cash')).body;
    expect(c).toMatchObject({ inicialCents: 0, dinheiroCents: 15000, pixCents: 5000, saidasCents: 12000, esperadoCents: 3000 });
    expect(c.movimentos).toHaveLength(2); expect(c.saidas.map((s: any) => s.tipo).sort()).toEqual(['despesa', 'emprestimo']);
  });
  it('estorno entra no caixa do dia como saída de dinheiro', async () => {
    const l = (await api(env, ana).get('/loans?status=ativo')).body.find((x: any) => x.nParcelas === 4);
    const pg = l.installments[0].pagamentos[0];
    await api(env, ana).post(`/payments/${pg.id}/reverse`, { reason: 'lançado por engano' });
    const c = (await api(env, ana).get('/cash')).body;
    expect(c.dinheiroCents).toBe(0); expect(c.esperadoCents).toBe(-12000); expect(c.movimentos.some((m: any) => m.estorno)).toBe(true);
    await api(env, ana).post(`/installments/${l.installments[0].id}/payments`, { valorCents: 15000, method: 'dinheiro' }); // refaz
  });
  it('fechamento registra a diferença; fechar de novo atualiza; depois de fechado não aceita saída', async () => {
    const a = api(env, ana);
    const f = await a.post('/cash/close', { contadoCents: 2500, obs: 'faltou troco' });
    expect(f.body).toMatchObject({ esperadoCents: 3000, contadoCents: 2500, diffCents: -500 });
    expect((await a.post('/cash/ops', { tipo: 'despesa', valorCents: 100 })).body.error).toBe('caixa_fechado');
    expect((await a.post('/cash/close', { contadoCents: 3000 })).body.diffCents).toBe(0);
    expect((await a.get('/cash/closings')).body).toHaveLength(1);
    expect((await a.get('/cash')).body.fechamento).toMatchObject({ contadoCents: 3000, diffCents: 0 });
  });
  it('no dia seguinte o saldo inicial é o dinheiro contado no fechamento', async () => {
    await setNow('2026-10-21T15:00:00Z');
    const c = (await api(env, ana).get('/cash')).body;
    expect(c).toMatchObject({ date: '2026-10-21', inicialCents: 3000, dinheiroCents: 0, esperadoCents: 3000 });
  });
  it('cada um vê só o seu caixa; admin vê todos', async () => {
    expect((await api(env, bruno).get(`/cash?staffId=${anaId}`)).status).toBe(403);
    expect((await api(env, admin).get(`/cash?staffId=${anaId}&date=2026-10-20`)).body.dinheiroCents).toBe(15000);
    expect((await api(env, ca).get('/cash')).status).toBe(403);
    expect((await api(env, bruno).get('/cash/closings')).body).toEqual([]);
    expect((await api(env, admin).get('/cash/closings')).body).toHaveLength(1);
  });
});

describe('relatórios', () => {
  it('resumo exige permissão de lucro; mostra lucro previsto, % recebido, inadimplência por faixa e a receber por mês', async () => {
    expect((await api(env, ana).get('/reports/summary')).status).toBe(403);
    await loanOf(bruno, B.clientId, { firstDue: '2026-10-01' }); // parcelas vencidas em 01/10, 08/10, 15/10 e 22/10
    await setNow('2026-10-21T15:00:00Z');
    const s = (await api(env, bruno).get('/reports/summary')).body; // Bruno só enxerga a carteira dele
    expect(s.emprestimos).toBe(1); expect(s.lucroPrevistoCents).toBe(10000);
    const faixas = Object.fromEntries(s.inadimplencia.map((f: any) => [f.faixa, f.parcelas]));
    expect(faixas).toEqual({ '1–7 dias': 1, '8–30 dias': 2, 'Mais de 30 dias': 0 }); // 15/10 (6d), 08/10 (13d), 01/10 (20d)
    expect(s.aReceberPorMes).toEqual([{ mes: '2026-10', valorCents: 60000 }]);
    const adm = (await api(env, admin).get('/reports/summary')).body; expect(adm.emprestimos).toBeGreaterThan(s.emprestimos);
  });
  it('detalhe da inadimplência por faixa', async () => {
    const d = (await api(env, bruno).get('/reports/delinquency')).body;
    expect(d.map((x: any) => x.itens.length)).toEqual([1, 2, 0]); expect(d[1].itens[0].days).toBeGreaterThanOrEqual(d[1].itens[1].days);
  });
  it('recebido no mês por funcionário e comissão (só admin)', async () => {
    expect((await api(env, ana).get('/reports/received-by-staff')).status).toBe(403);
    const r = (await api(env, admin).get('/reports/received-by-staff?month=2026-10')).body.itens.find((x: any) => x.staffId === anaId);
    expect(r.recebidoCents).toBe(20000); expect(r.recebimentos).toBeGreaterThanOrEqual(3); expect(r.comissaoCents).toBe(1000); // 5% de R$ 200,00
    expect((await api(env, admin).get('/reports/received-by-staff?month=2026-9')).status).toBe(400);
  });
  it('painel inicial respeita o escopo e a permissão de lucro', async () => {
    const a = (await api(env, ana).get('/dashboard')).body, b = (await api(env, bruno).get('/dashboard')).body;
    expect(a.emprestadoCents).toBeNull(); expect(b.emprestadoCents).toBe(50000);
    expect(b.atrasadas).toBe(3); expect(a.atrasadas).toBe(1); // a parcela única de R$ 100,00 (venceu 20/10) – só a carteira da Ana
    expect(b.emAtrasoCents).toBeGreaterThan(45000);
    expect(a.recebiHojeCents).toBe(0);
  });
});

describe('exportações', () => {
  it('CSV neutraliza fórmulas e usa ; e BOM', async () => {
    expect(csvCell('=1+1')).toBe("'=1+1"); expect(csvCell('@x')).toBe("'@x"); expect(csvCell('a;b')).toBe('"a;b"'); expect(csvCell('-5')).toBe("'-5");
    const r = await api(env, ana).get('/export/installments.csv');
    expect(r.raw.headers['content-type']).toContain('text/csv'); expect(r.raw.body.charCodeAt(0)).toBe(0xfeff);
    expect(r.raw.body).toContain(`'=HYPERLINK`); expect(r.raw.body).not.toContain('Cliente B'); // escopo
  });
  it('livro de recebimentos para o contador exige permissão e pode filtrar por mês', async () => {
    expect((await api(env, ana).get('/export/payments.csv')).status).toBe(403);
    const r = await api(env, admin).get('/export/payments.csv?month=2026-10');
    expect(r.raw.body.split('\r\n')[0]).toContain('recibo'); expect(r.raw.body).toContain('estorno');
  });
  it('backup: só admin, sem hashes de senha nem segredos, e fica na auditoria', async () => {
    expect((await api(env, bruno).get('/export/backup')).status).toBe(403);
    const r = await api(env, admin).get('/export/backup');
    expect(r.status).toBe(200);
    const txt = r.raw.body; expect(txt).not.toMatch(/argon2/); expect(txt).not.toMatch(/passwordHash|totpSecret|tokenHash/);
    const d = JSON.parse(txt); expect(d.clientes.length).toBe(2); expect(d.emprestimos.length).toBeGreaterThan(2); expect(d.clientes[0].cpf).toBeDefined();
    expect((await api(env, admin).get('/audit?limit=5')).body.items.some((i: any) => i.action === 'exportacao.backup')).toBe(true);
  });
});
