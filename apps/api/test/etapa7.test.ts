import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addClientUser, addStaff, api, JPEG, login, makeEnv, upload, type Sess, type TestEnv } from './helpers.js';
import { clients, files, jobs, pushSubscriptions, users } from '../src/db/schema.js';
import { runDueJobs } from '../src/lib/queue.js';
import { ensureDailyJobs, makeHandlers } from '../src/jobs.js';

let env: TestEnv, admin: Sess, ana: Sess, bia: Sess, anaId: string, biaId: string, loanId: string;
const run = () => runDueJobs(env.ctx.db, makeHandlers(env.ctx), env.clock.now);

beforeAll(async () => {
  env = await makeEnv('2026-10-20T15:00:00.000Z');
  await addStaff(env, { email: 'admin@caixa.app', role: 'admin', nome: 'Dono' });
  admin = await login(env, 'admin@caixa.app');
  ({ clientId: anaId } = await addClientUser(env, { nome: 'Ana Lima', email: 'ana@cli.com' }));
  ({ clientId: biaId } = await addClientUser(env, { nome: 'Bia Costa', email: 'bia@cli.com' }));
  await env.ctx.db.update(clients).set({ whatsapp: '11999990000' }).where(eq(clients.id, anaId));
  ana = await login(env, 'ana@cli.com'); bia = await login(env, 'bia@cli.com');
  const l = await api(env, admin).post('/loans', { clientId: anaId, valorCents: 10000, jurosBps: 2000, nParcelas: 2, freqDays: 7, firstDue: '2026-10-13', pularDomingo: false });
  loanId = l.body.id;
});
afterAll(() => env.close());

describe('push', () => {
  it('inscreve, envia e remove inscrição expirada', async () => {
    const a = api(env, admin);
    expect((await a.post('/push/subscribe', { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } })).status).toBe(200);
    expect(await api(env, null).post('/push/subscribe', { endpoint: 'https://x/', keys: { p256dh: 'p', auth: 'a' } }).then((r) => r.status)).toBe(401);
    await env.ctx.db.insert(jobs).values({ kind: 'push', payload: { userId: admin.userId, title: 'T', body: 'B' }, runAt: env.clock.now });
    await run();
    expect(env.push.sent.some((s) => s.p.title === 'T')).toBe(true);
    // 'gone' apaga a inscrição
    env.push.send = async () => 'gone';
    await env.ctx.db.insert(jobs).values({ kind: 'push', payload: { userId: admin.userId, title: 'X', body: 'Y' }, runAt: env.clock.now });
    await run();
    expect(await env.ctx.db.select().from(pushSubscriptions)).toHaveLength(0);
  });
});

describe('lembretes', () => {
  it('lista parcelas vencidas com link wa.me e marca como enviado', async () => {
    const a = api(env, admin);
    const r = (await a.get('/reminders/today')).body;
    expect(r.itens.length).toBeGreaterThan(0);
    const it1 = r.itens[0];
    expect(it1.whatsappLink).toContain('https://wa.me/55');
    expect(decodeURIComponent(it1.whatsappLink)).toContain('Ana');
    expect(it1.enviado).toBe(false);
    expect((await a.post(`/installments/${it1.installmentId}/reminder-sent`)).status).toBe(200);
    expect((await a.get('/reminders/today')).body.itens.find((x: any) => x.installmentId === it1.installmentId).enviado).toBe(true);
    expect((await api(env, ana).get('/reminders/today')).status).toBe(403);
  });
  it('job diário é idempotente e gera push para quem tem inscrição', async () => {
    env.push.send = async (sub, p) => { env.push.sent.push({ sub, p }); return 'ok'; };
    await api(env, ana).post('/push/subscribe', { endpoint: 'https://push.example/ana', keys: { p256dh: 'p', auth: 'a' } });
    await ensureDailyJobs(env.ctx); await ensureDailyJobs(env.ctx);
    expect((await env.ctx.db.select().from(jobs)).filter((j) => j.kind === 'reminders')).toHaveLength(1);
    env.clock.now = new Date('2026-10-20T12:00:00.000Z'); // depois das 08:00 SP
    env.push.sent.length = 0;
    await run(); await run();
    expect(env.push.sent.some((s) => s.sub.endpoint.endsWith('/ana') && /atraso/.test(s.p.body))).toBe(true);
  });
});

describe('LGPD', () => {
  it('cliente exporta só os próprios dados', async () => {
    const r = await api(env, ana).get('/me/privacy/export');
    expect(r.status).toBe(200);
    expect(r.body.titular.nome).toBe('Ana Lima');
    expect(r.body.emprestimos).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('Bia');
    expect((await api(env, ana).get(`/clients/${biaId}/privacy/export`)).status).toBe(403);
  });
  it('pedido de exclusão não duplica e aparece para o admin', async () => {
    expect((await api(env, bia).post('/me/privacy/erase-request')).status).toBe(200);
    expect((await api(env, bia).post('/me/privacy/erase-request')).status).toBe(409);
    expect((await api(env, admin).get('/privacy/requests')).body).toHaveLength(1);
  });
  it('anonimizar é bloqueado com empréstimo ativo e funciona depois, apagando arquivos e acesso', async () => {
    const a = api(env, admin);
    expect((await a.post(`/clients/${anaId}/anonymize`)).body.error).toBe('cliente_com_emprestimo');
    expect((await upload(env, ana, '/me/documents?tipo=rg_frente')).status).toBe(201);
    expect((await a.post(`/loans/${loanId}/cancel`, { motivo: 'teste' })).status).toBe(200);
    const r = await a.post(`/clients/${anaId}/anonymize`);
    expect(r.status).toBe(200); expect(r.body.arquivosApagados).toBeGreaterThan(0);
    const [c] = await env.ctx.db.select().from(clients).where(eq(clients.id, anaId));
    expect(c).toMatchObject({ nome: 'Cliente removido', whatsapp: '', cpfEnc: null });
    expect(c.anonymizedAt).not.toBeNull();
    const [u] = await env.ctx.db.select().from(users).where(eq(users.id, c.userId!));
    expect(u.status).toBe('disabled');
    expect((await env.ctx.db.select().from(files).where(eq(files.ownerClientId, anaId))).every((f) => f.purgedAt)).toBe(true);
    expect((await api(env, ana).get('/me')).status).toBe(401); // sessões revogadas
    expect((await a.get('/audit')).body.items.some((x: any) => x.action === 'lgpd.anonimizou')).toBe(true);
  });
});
