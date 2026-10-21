import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/index.js';
import { auditLog } from '../db/schema.js';
import { sha256 } from './crypto.js';

export interface AuditActor { orgId: string; userId: string | null; kind: 'staff' | 'client' | 'system'; nome: string; ip?: string | null; ua?: string | null }
export interface AuditEntry { action: string; entity?: string; entityId?: string; summary: string; meta?: Record<string, unknown> }

const GENESIS = '0'.repeat(64);
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
const rowHash = (prev: string, r: { orgId: string; at: Date; actorUserId: string | null; actorKind: string; action: string; entity: string | null; entityId: string | null; summary: string; meta: unknown }) =>
  sha256([prev, r.orgId, r.at.toISOString(), r.actorUserId ?? '', r.actorKind, r.action, r.entity ?? '', r.entityId ?? '', r.summary, canon(r.meta ?? null)].join('|'));

/** Acrescenta uma linha encadeada (hash do anterior). Seguro para uso dentro de transação. */
export async function audit(dbOrTx: Db | Tx, actor: AuditActor, e: AuditEntry, now = new Date()): Promise<void> {
  await (dbOrTx as Db).transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.orgId}, 7))`);
    const [last] = await tx.select({ hash: auditLog.hash }).from(auditLog).where(eq(auditLog.orgId, actor.orgId)).orderBy(desc(auditLog.seq)).limit(1);
    const prevHash = last?.hash ?? GENESIS;
    const row = { orgId: actor.orgId, at: now, actorUserId: actor.userId, actorKind: actor.kind, action: e.action, entity: e.entity ?? null, entityId: e.entityId ?? null, summary: e.summary, meta: e.meta ?? null };
    await tx.insert(auditLog).values({ ...row, actorName: actor.nome, ip: actor.ip ?? null, ua: actor.ua?.slice(0, 200) ?? null, prevHash, hash: rowHash(prevHash, row) });
  });
}

/** Recalcula a cadeia inteira; devolve a primeira linha adulterada, se houver. */
export async function verifyAuditChain(db: Db, orgId: string): Promise<{ ok: boolean; checked: number; brokenAtSeq?: number }> {
  let prev = GENESIS, checked = 0, after = 0;
  for (;;) {
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.orgId, orgId), gt(auditLog.seq, after))).orderBy(asc(auditLog.seq)).limit(500);
    if (!rows.length) break;
    for (const r of rows) {
      if (r.prevHash !== prev || r.hash !== rowHash(prev, r)) return { ok: false, checked, brokenAtSeq: r.seq };
      prev = r.hash; checked++; after = r.seq;
    }
  }
  return { ok: true, checked };
}
