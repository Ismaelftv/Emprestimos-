import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { addClientUser, addStaff, api, JPEG, login, makeEnv, upload, type Sess, type TestEnv } from './helpers.js';
import { clientDocuments, clients, files } from '../src/db/schema.js';
import { DOC_TIPOS } from '../src/services/clients.js';

let env: TestEnv;
let admin: Sess, ana: Sess, bruno: Sess, anaTodos: Sess, ca: Sess, cb: Sess;
let anaId: string, brunoId: string;
let clientA: { userId: string; clientId: string }, clientB: { userId: string; clientId: string };
const CPF = '529.982.247-25', CPF2 = '111.444.777-35';

beforeAll(async () => {
  env = await makeEnv();
  await addStaff(env, { email: 'admin@caixa.app', role: 'admin' });
  anaId = await addStaff(env, { email: 'ana@caixa.app', nome: 'Ana' });
  brunoId = await addStaff(env, { email: 'bruno@caixa.app', nome: 'Bruno' });
  await addStaff(env, { email: 'todos@caixa.app', nome: 'Todos', perms: { todos: true } });
  clientA = await addClientUser(env, { nome: 'Cliente A', email: 'a@cli.com', responsavelId: anaId });
  clientB = await addClientUser(env, { nome: 'Cliente B', email: 'b@cli.com', responsavelId: brunoId });
  [admin, ana, bruno, anaTodos, ca, cb] = await Promise.all(['admin', 'ana', 'bruno', 'todos'].map((n) => login(env, `${n}@caixa.app`)).concat([login(env, 'a@cli.com'), login(env, 'b@cli.com')]));
});
afterAll(() => env.close());

describe('escopo do funcionário', () => {
  it('sem "ver todos" só enxerga os clientes sob sua responsabilidade', async () => {
    const a = api(env, ana), b = api(env, bruno);
    expect((await a.get('/clients')).body.map((c: any) => c.nome)).toEqual(['Cliente A']);
    expect((await b.get('/clients')).body.map((c: any) => c.nome)).toEqual(['Cliente B']);
    expect((await a.get(`/clients/${clientA.clientId}`)).status).toBe(200);
    // cliente de outro: 404 em tudo (nem confirma que existe)
    expect((await a.get(`/clients/${clientB.clientId}`)).status).toBe(404);
    expect((await a.patch(`/clients/${clientB.clientId}`, { nome: 'Invadido' })).status).toBe(404);
    await addStaff(env, { email: 'ex@caixa.app', perms: { excluir: true } });
    expect((await api(env, await login(env, 'ex@caixa.app')).del(`/clients/${clientB.clientId}`)).status).toBe(404); // pode excluir, mas não é dele
    expect((await a.get(`/clients/${clientB.clientId}/documents`)).status).toBe(404);
    expect((await a.post(`/clients/${clientB.clientId}/portal-invite`, { email: 'x@y.com' })).status).toBe(404);
    expect((await a.get('/clients?q=Cliente B')).body).toEqual([]);
  });
  it('com "ver todos" enxerga todos; admin também', async () => {
    expect((await api(env, anaTodos).get('/clients')).body).toHaveLength(2);
    expect((await api(env, admin).get('/clients')).body).toHaveLength(2);
  });
  it('só o admin troca responsável, bloqueio e limite', async () => {
    const a = api(env, ana);
    expect((await a.patch(`/clients/${clientA.clientId}`, { bloqueado: true })).status).toBe(403);
    expect((await a.patch(`/clients/${clientA.clientId}`, { responsavelId: brunoId })).status).toBe(403);
    expect((await api(env, admin).patch(`/clients/${clientA.clientId}`, { limiteCents: 100000, bloqueado: false })).body.limiteCents).toBe(100000);
  });
  it('permissões do funcionário: sem "clientes" não cadastra; sem "excluir" não exclui', async () => {
    await addStaff(env, { email: 'semperm@caixa.app', perms: { clientes: false, excluir: false } });
    const s = api(env, await login(env, 'semperm@caixa.app'));
    expect((await s.post('/clients', { nome: 'Fulano de Tal' })).status).toBe(403);
    expect((await api(env, ana).del(`/clients/${clientA.clientId}`)).status).toBe(403);
  });
});

describe('cadastro de cliente', () => {
  it('valida CPF, guarda criptografado, bloqueia duplicado e mascara para quem não precisa', async () => {
    const a = api(env, ana);
    expect((await a.post('/clients', { nome: 'Cliente Novo', cpf: '123.456.789-00' })).status).toBe(400);
    const ok = await a.post('/clients', { nome: 'Cliente Novo', cpf: CPF, whatsapp: '11987654321' });
    expect(ok.status).toBe(201); expect(ok.body.cpf).toBe('52998224725'); expect(ok.body.responsavelId).toBe(anaId);
    const [row] = await env.ctx.db.select().from(clients).where(eq(clients.id, ok.body.id));
    expect(row.cpfEnc).not.toContain('52998224725'); expect(row.cpfLast4).toBe('4725');
    expect((await a.post('/clients', { nome: 'Outro', cpf: CPF })).status).toBe(409);
    expect((await a.get('/clients')).body.find((c: any) => c.id === ok.body.id).cpf).toBe('***.982.***-**');
    // funcionário comum não atribui a outro
    expect((await a.post('/clients', { nome: 'Outro Nome', responsavelId: brunoId })).status).toBe(403);
    expect((await api(env, admin).post('/clients', { nome: 'Do Bruno', responsavelId: brunoId })).body.responsavelId).toBe(brunoId);
  });
  it('exclusão é lógica e derruba o acesso do cliente', async () => {
    const adm = api(env, admin);
    const novo = await adm.post('/clients', { nome: 'Para Excluir' });
    expect((await adm.del(`/clients/${novo.body.id}`)).status).toBe(200);
    expect((await adm.get(`/clients/${novo.body.id}`)).status).toBe(404);
    const [row] = await env.ctx.db.select().from(clients).where(eq(clients.id, novo.body.id));
    expect(row.deletedAt).not.toBeNull();
  });
});

describe('isolamento do cliente do portal', () => {
  const staffRoutes: [string, string][] = [['GET', '/clients'], ['POST', '/clients'], ['GET', '/staff'], ['POST', '/staff'], ['GET', '/settings'], ['PATCH', '/settings'], ['GET', '/audit'], ['GET', '/audit/verify'], ['POST', '/me/2fa/disable-x']];
  it('cliente nunca acessa rotas da equipe', async () => {
    const c = api(env, ca);
    for (const [m, u] of staffRoutes.slice(0, 8)) {
      const r = await (m === 'GET' ? c.get(u) : m === 'POST' ? c.post(u, { nome: 'x y z', email: 'x@y.com' }) : c.patch(u, { empresa: 'Hack' }));
      expect([401, 403], `${m} ${u}`).toContain(r.status); expect(r.status, `${m} ${u}`).not.toBe(200);
    }
    expect((await c.get(`/clients/${clientA.clientId}`)).status).toBe(403); // nem o próprio pela rota da equipe
    expect((await c.patch(`/clients/${clientA.clientId}`, { bloqueado: false, limiteCents: 99999999 })).status).toBe(403);
    expect((await c.post(`/clients/${clientA.clientId}/portal-invite`, { email: 'z@z.com' })).status).toBe(403);
  });
  it('não altera dados de outro cliente nem os próprios campos sensíveis pelo /me/profile', async () => {
    const c = api(env, ca);
    const r = await c.patch('/me/profile', { whatsapp: '11999990000', clientId: clientB.clientId, limiteCents: 999999999, bloqueado: false });
    expect(r.status).toBe(200);
    const [a] = await env.ctx.db.select().from(clients).where(eq(clients.id, clientA.clientId)); const [b] = await env.ctx.db.select().from(clients).where(eq(clients.id, clientB.clientId));
    expect(a.whatsapp).toBe('11999990000'); expect(b.whatsapp).toBe('');
    expect(a.limiteCents).toBe(100000); // não mudou pelo cliente
  });
  it('documentos e arquivos: cliente só vê/baixa os próprios', async () => {
    const upA = await upload(env, ca, '/me/documents?tipo=rg_frente'); expect(upA.status).toBe(201);
    const upB = await upload(env, cb, '/me/documents?tipo=rg_frente'); expect(upB.status).toBe(201);
    const docsA = (await api(env, ca).get('/me/documents')).body, docsB = (await api(env, cb).get('/me/documents')).body;
    const fa = docsA.find((d: any) => d.tipo === 'rg_frente').fileId, fb = docsB.find((d: any) => d.tipo === 'rg_frente').fileId;
    expect((await api(env, ca).get(`/files/${fa}`)).status).toBe(200);
    expect((await api(env, ca).get(`/files/${fb}`)).status).toBe(404); // arquivo de B
    expect((await api(env, cb).get(`/files/${fa}`)).status).toBe(404);
    expect((await api(env, ana).get(`/files/${fa}`)).status).toBe(200); expect((await api(env, ana).get(`/files/${fb}`)).status).toBe(404); // Ana só vê da carteira dela
    expect((await api(env, anaTodos).get(`/files/${fb}`)).status).toBe(200);
    expect((await api(env, null).get(`/files/${fa}`)).status).toBe(401);
    expect((await api(env, ca).get('/files/not-a-uuid')).status).toBe(400);
  });
  it('cliente não consegue enviar documento para outro cliente (o id vem da sessão)', async () => {
    await upload(env, ca, `/me/documents?tipo=selfie&clientId=${clientB.clientId}`);
    const docsB = await env.ctx.db.select().from(clientDocuments).where(eq(clientDocuments.clientId, clientB.clientId));
    expect(docsB.some((d) => d.tipo === 'selfie')).toBe(false);
  });
});

describe('arquivos privados', () => {
  it('só imagem real (magic bytes), até 5 MB, armazenada criptografada', async () => {
    const txt = await upload(env, cb, '/me/documents?tipo=rg_verso', Buffer.from('<?php echo 1; ?>'), 'foto.jpg');
    expect(txt.status).toBe(400); expect(txt.body.error).toBe('tipo_invalido');
    const big = await upload(env, cb, '/me/documents?tipo=rg_verso', Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]));
    expect(big.status).toBe(400);
    const ok = await upload(env, cb, '/me/documents?tipo=rg_verso'); expect(ok.status).toBe(201);
    const [f] = await env.ctx.db.select().from(files).orderBy(files.createdAt).limit(1);
    const stored = await env.storage.get(f.storageKey);
    expect(stored.includes(Buffer.from('JFIF-fake-image'))).toBe(false); // em repouso está cifrado
    expect(f.storageKey).toMatch(/^[0-9a-f-]{36}$/); // nome aleatório
    const dl = await env.app.inject({ method: 'GET', url: `/api/v1/files/${f.id}`, headers: { cookie: admin.cookie } });
    expect(dl.rawPayload.equals(JPEG)).toBe(true); expect(dl.headers['content-type']).toBe('image/jpeg');
  });
  it('aprovar os 4 documentos marca o cadastro como verificado; aprovado não pode ser reenviado pelo cliente', async () => {
    const adm = api(env, admin);
    const c = await adm.post('/clients', { nome: 'Doc Completo', responsavelId: anaId });
    const id = c.body.id;
    for (const t of DOC_TIPOS) expect((await upload(env, admin, `/clients/${id}/documents?tipo=${t}`)).status).toBe(201);
    await adm.patch(`/clients/${id}`, { situacao: 'em_verificacao' });
    const docs = (await adm.get(`/clients/${id}/documents`)).body;
    for (const d of docs.slice(0, 3)) await adm.patch(`/clients/${id}/documents/${d.id}`, { status: 'aprovado' });
    expect((await adm.get(`/clients/${id}`)).body.situacao).toBe('em_verificacao');
    const last = await adm.patch(`/clients/${id}/documents/${docs[3].id}`, { status: 'aprovado' });
    expect(last.body.verificado).toBe(true); expect((await adm.get(`/clients/${id}`)).body.situacao).toBe('verificado');
    // recusa com motivo
    const r = await adm.patch(`/clients/${id}/documents/${docs[0].id}`, { status: 'recusado', motivo: 'Borrado' });
    expect(r.status).toBe(200); expect((await adm.get(`/clients/${id}/documents`)).body[0].motivo).toBe('Borrado');
  });
});

describe('autocadastro e convite do portal', () => {
  it('autocadastro exige consentimento e CPF válido; entra em verificação com o consentimento registrado', async () => {
    const base = { nome: 'Maria Souza', whatsapp: '11987654321', cpf: CPF2, email: 'maria@cli.com', password: 'minha-senha-123' };
    expect((await api(env, null).post('/auth/signup', { ...base, consent: false })).status).toBe(400);
    expect((await api(env, null).post('/auth/signup', { ...base, cpf: '111.111.111-11', consent: true })).status).toBe(400);
    const r = await api(env, null).post('/auth/signup', { ...base, consent: true });
    expect(r.status).toBe(201); expect(r.body.me.situacao).toBe('em_verificacao');
    const [c] = await env.ctx.db.select().from(clients).where(eq(clients.id, r.body.me.clientId));
    expect(c.consentAt).not.toBeNull(); expect(c.consentVersion).toBeTruthy(); expect(c.responsavelId).toBeTruthy();
    expect((await api(env, null).post('/auth/signup', { ...base, email: 'outro@cli.com', consent: true })).status).toBe(409); // CPF repetido
    expect((await api(env, null).post('/auth/signup', { ...base, cpf: CPF, consent: true })).status).toBe(409); // e-mail repetido
  });
  it('convite do portal: link de uso único (sem senha em mensagem), depois o cliente entra', async () => {
    const adm = api(env, admin);
    const c = await adm.post('/clients', { nome: 'Carlos Convidado', responsavelId: anaId });
    const inv = await api(env, ana).post(`/clients/${c.body.id}/portal-invite`, { email: 'carlos@cli.com' });
    expect(inv.status).toBe(200); expect(JSON.stringify(inv.body)).not.toMatch(/senha/i);
    const token = inv.body.inviteUrl.split('/').pop();
    expect((await api(env, null).post('/auth/invite/accept', { token, password: 'senha-do-carlos-1' })).status).toBe(200);
    const s = await login(env, 'carlos@cli.com', 'senha-do-carlos-1');
    expect((await api(env, s).get('/me')).body.nome).toBe('Carlos Convidado');
    expect((await api(env, ana).post(`/clients/${c.body.id}/portal-invite`, {})).status).toBe(409); // já tem acesso
    // desativar o portal derruba a sessão
    expect((await api(env, ana).post(`/clients/${c.body.id}/portal-disable`)).status).toBe(200);
    expect((await api(env, s).get('/me')).status).toBe(401);
  });
});
