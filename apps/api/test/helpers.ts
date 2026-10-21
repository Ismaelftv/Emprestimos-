import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Ctx } from '../src/context.js';
import { createDb } from '../src/db/index.js';
import { clients, staffProfiles, users } from '../src/db/schema.js';
import { ensureOrg } from '../src/bootstrap.js';
import { hashPassword } from '../src/lib/crypto.js';
import { MemoryMailer } from '../src/lib/mailer.js';
import { MemoryStorage } from '../src/lib/files.js';
import { MemoryPush } from '../src/lib/push.js';

export interface TestEnv { app: FastifyInstance; ctx: Ctx; orgId: string; mailer: MemoryMailer; storage: MemoryStorage; push: MemoryPush; clock: { now: Date }; close: () => Promise<void> }
export interface Sess { cookie: string; csrf: string; userId: string }

export async function makeEnv(start = '2026-10-20T15:00:00.000Z'): Promise<TestEnv> {
  const handle = await createDb();
  const clock = { now: new Date(start) };
  const mailer = new MemoryMailer(), storage = new MemoryStorage(), push = new MemoryPush();
  const config = loadConfig({ NODE_ENV: 'test' });
  const ctx: Ctx = { db: handle.db, config, mailer, storage, push, now: () => clock.now, light: true, log: () => {} };
  const orgId = await ensureOrg(ctx);
  const app = await buildApp(ctx, { rateLimitMax: 100000 });
  return { app, ctx, orgId, mailer, storage, push, clock, close: async () => { await app.close(); await handle.close(); } };
}

export async function addStaff(env: TestEnv, o: { email: string; password?: string; nome?: string; role?: 'admin' | 'staff'; perms?: Partial<Record<'criar' | 'clientes' | 'excluir' | 'lucro' | 'todos', boolean>> }) {
  const [u] = await env.ctx.db.insert(users).values({ orgId: env.orgId, kind: 'staff', email: o.email, passwordHash: await hashPassword(o.password ?? 'senha-forte-1', true), status: 'active' }).returning();
  const p = o.perms ?? {}, admin = o.role === 'admin';
  await env.ctx.db.insert(staffProfiles).values({ userId: u.id, nome: o.nome ?? o.email.split('@')[0], role: o.role ?? 'staff', permCriar: admin || (p.criar ?? true), permClientes: admin || (p.clientes ?? true), permExcluir: admin || (p.excluir ?? false), permLucro: admin || (p.lucro ?? false), permTodos: admin || (p.todos ?? false) });
  return u.id;
}

export async function login(env: TestEnv, email: string, password = 'senha-forte-1'): Promise<Sess> {
  const r = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.statusCode} ${r.body}`);
  const body = r.json();
  if (body.mfa) throw new Error('mfa pendente');
  return { cookie: cookieOf(r), csrf: body.csrf, userId: body.me.id };
}
export const cookieOf = (r: { headers: Record<string, unknown> }) => {
  const sc = r.headers['set-cookie']; const v = Array.isArray(sc) ? sc[0] : String(sc);
  return v.split(';')[0];
};
export function api(env: TestEnv, s: Sess | null) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const headers: Record<string, string> = {};
    if (s) { headers.cookie = s.cookie; headers['x-csrf'] = s.csrf; }
    const r = await env.app.inject({ method: method as 'GET', url: '/api/v1' + url, payload: payload as never, headers });
    let json: any = null; try { json = r.json(); } catch { /* binário */ }
    return { status: r.statusCode, body: json, raw: r };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, b?: unknown) => call('POST', u, b ?? {}), patch: (u: string, b?: unknown) => call('PATCH', u, b ?? {}), del: (u: string) => call('DELETE', u) };
}
export async function addClientUser(env: TestEnv, o: { nome: string; email: string; password?: string; responsavelId?: string; cpf?: string }) {
  const [u] = await env.ctx.db.insert(users).values({ orgId: env.orgId, kind: 'client', email: o.email, passwordHash: await hashPassword(o.password ?? 'senha-forte-1', true), status: 'active' }).returning();
  const [c] = await env.ctx.db.insert(clients).values({ orgId: env.orgId, userId: u.id, nome: o.nome, portalEnabled: true, responsavelId: o.responsavelId ?? null }).returning();
  return { userId: u.id, clientId: c.id };
}
export { eq };

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake-image-bytes-for-tests'.repeat(10))]);
export function multipartBody(data: Buffer, filename = 'foto.jpg', mime = 'image/jpeg') {
  const boundary = '----caixaTest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}
export async function upload(env: TestEnv, s: Sess, url: string, data: Buffer = JPEG, filename = 'foto.jpg') {
  const m = multipartBody(data, filename);
  const r = await env.app.inject({ method: 'POST', url: '/api/v1' + url, payload: m.payload, headers: { cookie: s.cookie, 'x-csrf': s.csrf, 'content-type': m.contentType } });
  let json: any = null; try { json = r.json(); } catch { /* */ }
  return { status: r.statusCode, body: json };
}
