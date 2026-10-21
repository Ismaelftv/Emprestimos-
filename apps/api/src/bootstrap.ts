import { eq } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { orgs, settings, staffProfiles, users } from './db/schema.js';
import { hashPassword } from './lib/crypto.js';
import { audit } from './lib/audit.js';

export async function ensureOrg(ctx: Pick<Ctx, 'db'>, nome = 'Minha Carteira') {
  const [o] = await ctx.db.select().from(orgs).limit(1);
  if (o) return o.id;
  const [n] = await ctx.db.insert(orgs).values({ nome }).returning();
  await ctx.db.insert(settings).values({ orgId: n.id, empresa: nome });
  return n.id;
}
export async function ensureAdmin(ctx: Ctx, orgId: string, a: { email: string; password: string; nome: string }) {
  const [any] = await ctx.db.select({ id: users.id }).from(users).where(eq(users.kind, 'staff')).limit(1);
  if (any) return null;
  const [u] = await ctx.db.insert(users).values({ orgId, kind: 'staff', email: a.email.trim().toLowerCase(), passwordHash: await hashPassword(a.password, ctx.light), status: 'active' }).returning();
  await ctx.db.insert(staffProfiles).values({ userId: u.id, nome: a.nome, role: 'admin', permCriar: true, permClientes: true, permExcluir: true, permLucro: true, permTodos: true });
  await audit(ctx.db, { orgId, userId: null, kind: 'system', nome: 'Sistema' }, { action: 'sistema.admin_inicial', entity: 'user', entityId: u.id, summary: 'Administrador inicial criado' }, ctx.now());
  return u.id;
}
