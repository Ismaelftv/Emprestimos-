import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { addStaff, api, cookieOf, login, makeEnv, type TestEnv } from './helpers.js';
import { totpAt, hashPassword } from '../src/lib/crypto.js';
import { settings, auditLog, authTokens, loginThrottle, payments, users } from '../src/db/schema.js';
import { openString } from '../src/lib/crypto.js';
import { verifyAuditChain } from '../src/lib/audit.js';
import { sql } from 'drizzle-orm';

let env: TestEnv;
beforeAll(async () => { env = await makeEnv(); await addStaff(env, { email: 'admin@caixa.app', role: 'admin', nome: 'Dono' }); await addStaff(env, { email: 'carla@caixa.app', nome: 'Carla' }); });
afterAll(() => env.close());

describe('login e sessão', () => {
  it('rotas protegidas exigem sessão', async () => {
    for (const u of ['/me', '/staff', '/settings', '/audit']) expect((await api(env, null).get(u)).status).toBe(401);
  });
  it('login correto devolve cookie httpOnly e CSRF; senha errada não diz qual campo errou', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@caixa.app', password: 'senha-forte-1' } });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(r.headers['set-cookie'])).toMatch(/SameSite=Lax/i);
    expect(r.json().me.role).toBe('admin');
    const bad1 = await api(env, null).post('/auth/login', { email: 'admin@caixa.app', password: 'x' });
    const bad2 = await api(env, null).post('/auth/login', { email: 'ninguem@caixa.app', password: 'x' });
    expect(bad1.status).toBe(401); expect(bad2.status).toBe(401); expect(bad1.body.message).toBe(bad2.body.message);
  });
  it('mutação sem token CSRF é recusada', async () => {
    const s = await login(env, 'admin@caixa.app');
    const r = await env.app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: { empresa: 'X' }, headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(403); expect(r.json().error).toBe('csrf');
  });
  it('logout revoga a sessão', async () => {
    const s = await login(env, 'carla@caixa.app'); const c = api(env, s);
    expect((await c.get('/me')).status).toBe(200);
    await c.post('/auth/logout');
    expect((await c.get('/me')).status).toBe(401);
  });
  it('senha nunca fica em texto no banco', async () => {
    const [u] = await env.ctx.db.select().from(users).where(eq(users.email, 'carla@caixa.app'));
    expect(u.passwordHash).toMatch(/^\$argon2id\$/); expect(u.passwordHash).not.toContain('senha-forte-1');
  });
});

describe('bloqueio após 5 tentativas (persistido no banco)', () => {
  it('bloqueia 5 min, mesmo com a senha certa, e libera depois', async () => {
    await addStaff(env, { email: 'lock@caixa.app' });
    for (let i = 0; i < 4; i++) expect((await api(env, null).post('/auth/login', { email: 'lock@caixa.app', password: 'errada' })).status).toBe(401);
    const fifth = await api(env, null).post('/auth/login', { email: 'lock@caixa.app', password: 'errada' });
    expect(fifth.status).toBe(401); expect(fifth.body.message).toMatch(/5 min/);
    const locked = await api(env, null).post('/auth/login', { email: 'lock@caixa.app', password: 'senha-forte-1' });
    expect(locked.status).toBe(429);
    const [row] = await env.ctx.db.select().from(loginThrottle).where(eq(loginThrottle.key, 'acct:lock@caixa.app'));
    expect(row.lockedUntil).not.toBeNull();
    env.clock.now = new Date(env.clock.now.getTime() + 5 * 60_000 + 1000);
    expect((await api(env, null).post('/auth/login', { email: 'lock@caixa.app', password: 'senha-forte-1' })).status).toBe(200);
  });
});

describe('2FA TOTP', () => {
  it('ativa, exige o código no login e bloqueia código errado repetido', async () => {
    await addStaff(env, { email: 'mfa@caixa.app', role: 'admin' });
    const s = await login(env, 'mfa@caixa.app'); const c = api(env, s);
    const setup = await c.post('/me/2fa/setup'); expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    // segredo cifrado em repouso
    const [u0] = await env.ctx.db.select().from(users).where(eq(users.email, 'mfa@caixa.app'));
    expect(u0.totpSecretEnc).not.toContain(setup.body.secret); expect(openString(env.ctx.config.fileKey, u0.totpSecretEnc!)).toBe(setup.body.secret);
    expect((await c.post('/me/2fa/enable', { code: '000000' })).status).toBe(400);
    expect((await c.post('/me/2fa/enable', { code: totpAt(setup.body.secret, env.clock.now.getTime()) })).status).toBe(200);

    const r1 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'mfa@caixa.app', password: 'senha-forte-1' } });
    expect(r1.json().mfa).toBe(true);
    const pending = { cookie: cookieOf(r1), csrf: '', userId: '' };
    // com a sessão "pendente" ainda não dá para acessar nada
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: pending.cookie } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/v1/auth/2fa', payload: { code: '123456' }, headers: { cookie: pending.cookie } })).statusCode).toBe(401);
    const ok = await env.app.inject({ method: 'POST', url: '/api/v1/auth/2fa', payload: { code: totpAt(setup.body.secret, env.clock.now.getTime()) }, headers: { cookie: pending.cookie } });
    expect(ok.statusCode).toBe(200); expect(ok.json().me.totpEnabled).toBe(true);
    expect(cookieOf(ok)).not.toBe(pending.cookie); // sessão rotacionada
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: pending.cookie } })).statusCode).toBe(401);

    // 5 códigos errados => sessão pendente invalidada e conta travada
    const r2 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'mfa@caixa.app', password: 'senha-forte-1' } });
    const ck = cookieOf(r2); let last = 0;
    for (let i = 0; i < 5; i++) last = (await env.app.inject({ method: 'POST', url: '/api/v1/auth/2fa', payload: { code: '000000' }, headers: { cookie: ck } })).statusCode;
    expect(last).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/v1/auth/2fa', payload: { code: totpAt(setup.body.secret, env.clock.now.getTime()) }, headers: { cookie: ck } })).statusCode).toBe(401);
  });
  it('quando exigido, admin sem 2FA só consegue configurar o 2FA', async () => {
    await addStaff(env, { email: 'adm2@caixa.app', role: 'admin' });
    const root = api(env, await login(env, 'admin@caixa.app'));
    expect((await root.patch('/settings', { exigir2faAdmin: true })).status).toBe(400); // quem exige precisa ter o seu próprio 2FA
    await env.ctx.db.update(settings).set({ exigir2faAdmin: true }).where(eq(settings.orgId, env.orgId));
    const c = api(env, await login(env, 'adm2@caixa.app'));
    const me = await c.get('/me'); expect(me.body.mustSetup2fa).toBe(true);
    const blocked = await c.get('/staff'); expect(blocked.status).toBe(403); expect(blocked.body.error).toBe('exige_2fa');
    expect((await c.post('/me/2fa/setup')).status).toBe(200);
    await env.ctx.db.update(settings).set({ exigir2faAdmin: false }).where(eq(settings.orgId, env.orgId));
  });
});

describe('recuperação de senha', () => {
  const lastCode = () => { const m = env.mailer.last('carla@caixa.app')!; return m.text.match(/\d{6}/)![0]; };
  it('não revela se o e-mail existe', async () => {
    const a = await api(env, null).post('/auth/forgot', { email: 'carla@caixa.app' }); const b = await api(env, null).post('/auth/forgot', { email: 'fantasma@x.com' });
    expect(a.status).toBe(200); expect(b.body).toEqual(a.body);
  });
  it('código de uso único, com tentativas limitadas e expiração; derruba sessões antigas', async () => {
    const old = await login(env, 'carla@caixa.app');
    await api(env, null).post('/auth/forgot', { email: 'carla@caixa.app' });
    const { runDueJobs } = await import('../src/lib/queue.js'); const { makeHandlers } = await import('../src/jobs.js');
    await runDueJobs(env.ctx.db, makeHandlers(env.ctx), env.clock.now);
    const code = lastCode();
    // errado várias vezes => o código verdadeiro também deixa de valer
    for (let i = 0; i < 5; i++) expect((await api(env, null).post('/auth/reset', { email: 'carla@caixa.app', code: '000000', password: 'nova-senha-123' })).status).toBe(400);
    expect((await api(env, null).post('/auth/reset', { email: 'carla@caixa.app', code, password: 'nova-senha-123' })).status).toBe(400);
    // novo pedido, usar corretamente uma vez
    await api(env, null).post('/auth/forgot', { email: 'carla@caixa.app' });
    await runDueJobs(env.ctx.db, makeHandlers(env.ctx), env.clock.now);
    const code2 = lastCode();
    const ok = await api(env, null).post('/auth/reset', { email: 'carla@caixa.app', code: code2, password: 'nova-senha-123' });
    expect(ok.status).toBe(200);
    expect((await api(env, null).post('/auth/reset', { email: 'carla@caixa.app', code: code2, password: 'outra-senha-123' })).status).toBe(400); // uso único
    expect((await api(env, old).get('/me')).status).toBe(401); // sessão antiga revogada
    await login(env, 'carla@caixa.app', 'nova-senha-123');
    await env.ctx.db.update(users).set({ passwordHash: await hashPassword('senha-forte-1', true) }).where(eq(users.email, 'carla@caixa.app'));
  });
  it('código expira em 15 minutos', async () => {
    await api(env, null).post('/auth/forgot', { email: 'carla@caixa.app' });
    const { runDueJobs } = await import('../src/lib/queue.js'); const { makeHandlers } = await import('../src/jobs.js');
    await runDueJobs(env.ctx.db, makeHandlers(env.ctx), env.clock.now);
    const code = lastCode(); const t0 = env.clock.now;
    env.clock.now = new Date(t0.getTime() + 16 * 60_000);
    expect((await api(env, null).post('/auth/reset', { email: 'carla@caixa.app', code, password: 'nova-senha-123' })).status).toBe(400);
    env.clock.now = t0;
  });
  it('o código não é guardado em texto', async () => {
    const rows = await env.ctx.db.select().from(authTokens).where(eq(authTokens.kind, 'reset'));
    for (const r of rows) expect(r.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('equipe e permissões', () => {
  it('funcionário não administra equipe, ajustes nem auditoria', async () => {
    const c = api(env, await login(env, 'carla@caixa.app'));
    expect((await c.post('/staff', { nome: 'X Y', email: 'x@y.com' })).status).toBe(403);
    expect((await c.patch('/settings', { empresa: 'Hack' })).status).toBe(403);
    expect((await c.get('/audit')).status).toBe(403);
    const list = await c.get('/staff'); expect(list.status).toBe(200); expect(list.body[0].email).toBeUndefined();
    expect((await c.get('/settings')).body.pixKey).toBeDefined();
    expect((await c.get('/settings')).body.exigir2faAdmin).toBeUndefined();
  });
  it('convite: admin cria, link de uso único define a senha, depois entra', async () => {
    const adm = api(env, await login(env, 'admin@caixa.app'));
    const r = await adm.post('/staff', { nome: 'Novo Func', email: 'Novo@Caixa.app', perms: { criar: true, clientes: true, excluir: false, lucro: false, todos: false } });
    expect(r.status).toBe(201);
    const token = r.body.inviteUrl.split('/').pop();
    expect((await api(env, null).post('/auth/login', { email: 'novo@caixa.app', password: 'qualquer-coisa' })).status).toBe(401); // convidado ainda não entra
    expect((await api(env, null).post('/auth/invite/accept', { token, password: 'curta' })).status).toBe(400);
    expect((await api(env, null).post('/auth/invite/accept', { token, password: 'minha-senha-nova' })).status).toBe(200);
    expect((await api(env, null).post('/auth/invite/accept', { token, password: 'minha-senha-nova' })).status).toBe(400);
    await login(env, 'novo@caixa.app', 'minha-senha-nova');
    expect((await adm.post('/staff', { nome: 'Dup', email: 'novo@caixa.app' })).status).toBe(409);
  });
  it('mudar permissões vale na hora (servidor valida) e desativar derruba a sessão', async () => {
    const adm = api(env, await login(env, 'admin@caixa.app'));
    const id = await addStaff(env, { email: 'perm@caixa.app', perms: { lucro: false } });
    const s = await login(env, 'perm@caixa.app'); const c = api(env, s);
    expect((await c.get('/me')).body.perms.lucro).toBe(false);
    await adm.patch(`/staff/${id}`, { perms: { criar: true, clientes: true, excluir: false, lucro: true, todos: false } });
    expect((await c.get('/me')).body.perms.lucro).toBe(true);
    expect((await adm.patch(`/staff/${id}`, { status: 'disabled' })).status).toBe(200);
    expect((await c.get('/me')).status).toBe(401);
    expect((await api(env, null).post('/auth/login', { email: 'perm@caixa.app', password: 'senha-forte-1' })).status).toBe(403);
  });
  it('sempre existe ao menos um admin ativo e ninguém desativa a si mesmo', async () => {
    const adm = await login(env, 'admin@caixa.app'); const c = api(env, adm);
    expect((await c.patch(`/staff/${adm.userId}`, { status: 'disabled' })).status).toBe(400);
    const others = await env.ctx.db.select().from(users).where(eq(users.kind, 'staff'));
    // rebaixa todos os outros admins; o último não pode ser rebaixado
    const { staffProfiles } = await import('../src/db/schema.js');
    const admins = (await env.ctx.db.select().from(staffProfiles).where(eq(staffProfiles.role, 'admin'))).filter((p) => p.userId !== adm.userId);
    for (const p of admins) await c.patch(`/staff/${p.userId}`, { role: 'staff' });
    expect((await c.patch(`/staff/${adm.userId}`, { role: 'staff' })).status).toBe(400);
    expect(others.length).toBeGreaterThan(1);
  });
});

describe('auditoria imutável', () => {
  it('registra ações sensíveis e a cadeia de hashes confere', async () => {
    const adm = api(env, await login(env, 'admin@caixa.app'));
    expect((await adm.patch('/settings', { empresa: 'Caixa Teste' })).status).toBe(200);
    const list = await adm.get('/audit'); expect(list.status).toBe(200);
    const actions = list.body.items.map((i: any) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['login.ok', 'login.falha', 'equipe.criou', 'ajustes.alterou']));
    expect((await adm.get('/audit/verify')).body.ok).toBe(true);
  });
  it('o banco recusa UPDATE/DELETE em audit_log (trigger)', async () => {
    await expect(env.ctx.db.update(auditLog).set({ summary: 'adulterado' }).where(sql`true`)).rejects.toThrow();
    await expect(env.ctx.db.delete(auditLog).where(sql`true`)).rejects.toThrow();
    await expect(env.ctx.db.update(payments).set({ valorCents: 1 }).where(sql`true`)).resolves.toBeDefined(); // sem linhas: trigger é por linha
  });
});
