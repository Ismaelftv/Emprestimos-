import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { jobs } from '../db/schema.js';

export type JobHandler = (payload: any, job: { id: string; attempts: number }) => Promise<void>;
export interface EnqueueOpts { runAt?: Date; dedupeKey?: string; maxAttempts?: number }

export async function enqueue(ctx: { db: Pick<Db, 'insert'>; now: () => Date }, kind: string, payload: unknown, o: EnqueueOpts = {}) {
  await ctx.db.insert(jobs).values({ kind, payload: payload as never, runAt: o.runAt ?? ctx.now(), dedupeKey: o.dedupeKey, maxAttempts: o.maxAttempts ?? 6 }).onConflictDoNothing();
}

/** Processa jobs vencidos. Falhou? tenta de novo com espera exponencial (30s, 1m, 2m, ...) e fica persistido. */
export async function runDueJobs(db: Db, handlers: Record<string, JobHandler>, now = new Date(), limit = 20): Promise<number> {
  let done = 0;
  const due = await db.select().from(jobs).where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now))).orderBy(asc(jobs.runAt)).limit(limit);
  for (const j of due) {
    // "reserva" otimista: só um worker avança esta linha
    const claimed = await db.update(jobs).set({ attempts: sql`${jobs.attempts} + 1`, runAt: new Date(now.getTime() + 60_000) }).where(and(eq(jobs.id, j.id), eq(jobs.status, 'pending'), eq(jobs.attempts, j.attempts))).returning({ id: jobs.id });
    if (!claimed.length) continue;
    try {
      const h = handlers[j.kind]; if (!h) throw new Error('sem handler: ' + j.kind);
      await h(j.payload, { id: j.id, attempts: j.attempts + 1 });
      await db.update(jobs).set({ status: 'done', doneAt: new Date(), lastError: null }).where(eq(jobs.id, j.id)); done++;
    } catch (err) {
      const attempts = j.attempts + 1, dead = attempts >= j.maxAttempts;
      await db.update(jobs).set({ status: dead ? 'failed' : 'pending', lastError: String((err as Error).message).slice(0, 500), runAt: new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)) }).where(eq(jobs.id, j.id));
    }
  }
  return done;
}
