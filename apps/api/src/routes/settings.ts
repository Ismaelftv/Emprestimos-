import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { settings } from '../db/schema.js';
import { audit, verifyAuditChain } from '../lib/audit.js';
import { auditLog } from '../db/schema.js';
import { and, desc, lt } from 'drizzle-orm';
import { parse } from '../lib/http.js';
import { badRequest } from '../lib/errors.js';
import { auditActor, needAdmin, needStaff } from '../auth/guards.js';
import { getSettings, publicConfig } from './me.js';

const bps = z.number().int().min(0).max(100000);
export async function settingsRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.get('/settings', async (req) => {
    const a = needStaff(req);
    const s = await getSettings(ctx, a.orgId);
    return a.role === 'admin' ? s : publicConfig(s);
  });
  app.patch('/settings', async (req) => {
    const a = needAdmin(req);
    const b = parse(z.object({
      empresa: z.string().min(1).max(80), multaBps: bps, moraBpsMes: bps, descQuitBps: z.number().int().min(0).max(10000),
      pixKey: z.string().max(140), pixNome: z.string().max(80), aceitaPix: z.boolean(), aceitaDinheiro: z.boolean(), whatsapp: z.string().max(30),
      minValorCents: z.number().int().min(100), maxValorCents: z.number().int().min(100), maxParcelas: z.number().int().min(1).max(360),
      taxasBps: z.object({ '1': bps, '7': bps, '15': bps, '30': bps }), exigir2faAdmin: z.boolean(), retencaoDocumentosAnos: z.number().int().min(1).max(20),
    }).partial(), req.body);
    const cur = await getSettings(ctx, a.orgId);
    const next = { ...cur, ...b };
    if (next.minValorCents > next.maxValorCents) throw badRequest('Valor mínimo maior que o máximo');
    if (b.exigir2faAdmin && !a.totpEnabled) throw badRequest('Ative o seu próprio 2FA antes de exigir 2FA dos administradores');
    if (!next.aceitaPix && !next.aceitaDinheiro) b.aceitaPix = true;
    await ctx.db.update(settings).set({ ...b, updatedAt: ctx.now() }).where(eq(settings.orgId, a.orgId));
    await audit(ctx.db, auditActor(a), { action: 'ajustes.alterou', entity: 'settings', summary: 'Alterou os ajustes', meta: b }, ctx.now());
    return getSettings(ctx, a.orgId);
  });

  app.get('/audit', async (req) => {
    const a = needAdmin(req);
    const q = parse(z.object({ before: z.coerce.number().optional(), limit: z.coerce.number().min(1).max(200).default(50) }), req.query);
    const rows = await ctx.db.select({ seq: auditLog.seq, at: auditLog.at, actor: auditLog.actorName, kind: auditLog.actorKind, action: auditLog.action, summary: auditLog.summary, ip: auditLog.ip, entity: auditLog.entity, entityId: auditLog.entityId })
      .from(auditLog).where(q.before ? and(eq(auditLog.orgId, a.orgId), lt(auditLog.seq, q.before)) : eq(auditLog.orgId, a.orgId)).orderBy(desc(auditLog.seq)).limit(q.limit);
    return { items: rows, next: rows.length === q.limit ? rows.at(-1)!.seq : null };
  });
  app.get('/audit/verify', async (req) => verifyAuditChain(ctx.db, needAdmin(req).orgId));
}
