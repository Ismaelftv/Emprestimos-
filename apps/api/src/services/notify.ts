import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { clients, users } from '../db/schema.js';
import { enqueue } from '../lib/queue.js';

export async function pushTo(ctx: Ctx, userId: string | null | undefined, title: string, body: string, url = '/', tag?: string) {
  if (!userId) return;
  await enqueue(ctx, 'push', { userId, title, body, url, tag });
}
/** Avisa o funcionário responsável pelo cliente. */
export async function notifyResponsible(ctx: Ctx, clientId: string, title: string, body: string, url = '/#/solicitacoes') {
  const [c] = await ctx.db.select({ r: clients.responsavelId }).from(clients).where(eq(clients.id, clientId));
  await pushTo(ctx, c?.r, title, body, url);
}
export async function notifyClient(ctx: Ctx, clientId: string, title: string, body: string, url = '/') {
  const [c] = await ctx.db.select({ u: clients.userId }).from(clients).where(eq(clients.id, clientId));
  await pushTo(ctx, c?.u, title, body, url);
}
export async function clientEmail(ctx: Ctx, clientId: string): Promise<{ email: string; nome: string } | null> {
  const [r] = await ctx.db.select({ email: users.email, nome: clients.nome, status: users.status }).from(clients).innerJoin(users, eq(users.id, clients.userId)).where(eq(clients.id, clientId));
  return r && r.status === 'active' ? { email: r.email, nome: r.nome } : null;
}
