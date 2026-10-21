import { and, eq, isNull, SQL, sql } from 'drizzle-orm';
import type { Actor, Ctx } from '../context.js';
import { clients } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

/**
 * ÚNICO ponto onde a visibilidade de clientes é decidida.
 *  - cliente do portal: somente o próprio registro (id vem da sessão, nunca da requisição)
 *  - funcionário com "ver todos": toda a carteira da empresa
 *  - funcionário sem "ver todos": só os clientes sob a sua responsabilidade
 */
export function clientScope(a: Actor): SQL {
  const base = and(eq(clients.orgId, a.orgId), isNull(clients.deletedAt))!;
  if (a.kind === 'client') return and(base, eq(clients.id, a.clientId ?? '00000000-0000-0000-0000-000000000000'))!;
  if (a.perms.todos) return base;
  return and(base, eq(clients.responsavelId, a.userId))!;
}
export async function visibleClient(ctx: Pick<Ctx, 'db'>, a: Actor, id: string) {
  const [c] = await ctx.db.select().from(clients).where(and(clientScope(a), eq(clients.id, id))).limit(1);
  if (!c) throw notFound('Cliente não encontrado'); // 404 também quando existe mas é de outro (não revela existência)
  return c;
}
/** ids de clientes visíveis (para filtrar empréstimos/parcelas/pagamentos). */
export const visibleClientIds = (a: Actor) => sql`(select id from clients where ${clientScope(a)})`;
