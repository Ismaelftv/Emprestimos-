import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { loginThrottle } from '../db/schema.js';
import { tooMany } from '../lib/errors.js';

const LOCK_MS = 5 * 60_000, RESET_AFTER_MS = 15 * 60_000;

/** Lança 429 se a chave estiver bloqueada (persistido no banco, vale para todas as instâncias). */
export async function assertNotLocked(ctx: Ctx, key: string) {
  const [r] = await ctx.db.select().from(loginThrottle).where(eq(loginThrottle.key, key)).limit(1);
  if (r?.lockedUntil && r.lockedUntil > ctx.now()) throw tooMany(`Muitas tentativas. Tente de novo em ${Math.ceil((r.lockedUntil.getTime() - ctx.now().getTime()) / 60000)} min.`);
}
export async function registerFailure(ctx: Ctx, key: string, limit = 5) {
  const now = ctx.now();
  const [r] = await ctx.db.select().from(loginThrottle).where(eq(loginThrottle.key, key)).limit(1);
  let count = (r && now.getTime() - r.updatedAt.getTime() < RESET_AFTER_MS ? r.failCount : 0) + 1, lockedUntil: Date | null = null;
  if (count >= limit) { lockedUntil = new Date(now.getTime() + LOCK_MS); count = 0; }
  await ctx.db.insert(loginThrottle).values({ key, failCount: count, lockedUntil, updatedAt: now }).onConflictDoUpdate({ target: loginThrottle.key, set: { failCount: count, lockedUntil, updatedAt: now } });
  return !!lockedUntil;
}
export const clearFailures = (ctx: Ctx, key: string) => ctx.db.delete(loginThrottle).where(eq(loginThrottle.key, key));
