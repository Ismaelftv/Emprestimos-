import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { brl } from '@caixa/core';
import type { Actor, Ctx } from './context.js';
import { authTokens, clientDocuments, clients, files, loans, pushSubscriptions, sessions, staffProfiles, users, loginThrottle } from './db/schema.js';
import { enqueue, type JobHandler } from './lib/queue.js';
import { tpl } from './lib/mailer.js';
import { loadLoans, today } from './services/loans.js';
import { clientEmail } from './services/notify.js';
import { getSettings } from './routes/me.js';
import { loanScope } from './routes/loans.js';
import { receiptData } from './services/loans.js';

const SP_OFFSET_H = 3; // Brasil sem horário de verão desde 2019: 08:00 em SP = 11:00 UTC

async function actorFor(ctx: Ctx, userId: string): Promise<Actor | null> {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.status !== 'active') return null;
  if (u.kind === 'staff') {
    const [p] = await ctx.db.select().from(staffProfiles).where(eq(staffProfiles.userId, u.id)).limit(1);
    if (!p) return null;
    const admin = p.role === 'admin';
    return { userId: u.id, orgId: u.orgId, kind: 'staff', role: p.role as 'admin' | 'staff', nome: p.nome, email: u.email, perms: { criar: admin || p.permCriar, clientes: admin || p.permClientes, excluir: admin || p.permExcluir, lucro: admin || p.permLucro, todos: admin || p.permTodos }, clientId: null, sessionId: '', csrf: '', totpEnabled: u.totpEnabled, ip: '', ua: '' };
  }
  const [c] = await ctx.db.select().from(clients).where(eq(clients.userId, u.id)).limit(1);
  if (!c) return null;
  return { userId: u.id, orgId: u.orgId, kind: 'client', role: 'client', nome: c.nome, email: u.email, perms: { criar: false, clientes: false, excluir: false, lucro: false, todos: false }, clientId: c.id, sessionId: '', csrf: '', totpEnabled: u.totpEnabled, ip: '', ua: '' };
}

export function makeHandlers(ctx: Ctx): Record<string, JobHandler> {
  return {
    email: async (p) => { await ctx.mailer.send({ to: p.to, subject: p.subject, text: p.text, html: p.html }); },

    push: async (p) => {
      if (!ctx.push.enabled) return;
      const subs = await ctx.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, p.userId));
      for (const s of subs) {
        const r = await ctx.push.send({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }, { title: p.title, body: p.body, url: p.url, tag: p.tag });
        if (r === 'gone') await ctx.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)); // inscrição expirada
      }
    },

    receipt: async (p) => {
      const em = await clientEmail(ctx, p.clientId);
      if (!em) return;
      const [pay] = await ctx.db.execute(sql`select id from payments where receipt_no = ${p.receiptNo} and kind <> 'estorno' and method <> 'desconto' limit 1`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
      if (!pay) return;
      const r = await receiptData(ctx, pay.id), st = await getSettings(ctx, (await ctx.db.select({ o: clients.orgId }).from(clients).where(eq(clients.id, p.clientId)))[0].o);
      const t = tpl.recibo(em.nome.split(' ')[0], st.empresa, r.no, brl(r.valorCents));
      await ctx.mailer.send({ to: em.email, ...t });
    },

    // lembrete diário de vencimentos (equipe e clientes que ativaram avisos)
    reminders: async () => {
      const subUsers = await ctx.db.selectDistinct({ id: pushSubscriptions.userId }).from(pushSubscriptions);
      for (const { id } of subUsers) {
        const a = await actorFor(ctx, id); if (!a) continue;
        const ls = await loadLoans(ctx, and(loanScope(a), eq(loans.status, 'ativo'))!, { limit: 3000 });
        const open = ls.flatMap((l) => l.view.installments).filter((i) => i.status !== 'paid');
        const hoje = open.filter((i) => i.status === 'today').length, atraso = open.filter((i) => i.status === 'late').length;
        if (!hoje && !atraso) continue;
        const body = a.kind === 'staff' ? `${hoje} vencem hoje e ${atraso} em atraso.` : `${hoje ? hoje + ' parcela(s) vence(m) hoje. ' : ''}${atraso ? atraso + ' em atraso.' : ''}`.trim();
        await enqueue(ctx, 'push', { userId: id, title: (await getSettings(ctx, a.orgId)).empresa, body, url: a.kind === 'staff' ? '/#/agenda' : '/#/parcelas', tag: 'caixa-dia' });
      }
    },

    // limpeza diária: sessões/tokens vencidos e retenção de documentos (LGPD)
    purge: async () => {
      const now = ctx.now();
      await ctx.db.delete(authTokens).where(lt(authTokens.expiresAt, new Date(now.getTime() - 7 * 86400_000)));
      await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date(now.getTime() - 7 * 86400_000)));
      await ctx.db.delete(loginThrottle).where(lt(loginThrottle.updatedAt, new Date(now.getTime() - 86400_000)));
      const st = await ctx.db.execute(sql`select org_id, retencao_documentos_anos as anos from settings`).then((r) => (r as unknown as { rows: { org_id: string; anos: number }[] }).rows);
      for (const s of st) {
        const cutoff = new Date(now); cutoff.setFullYear(cutoff.getFullYear() - s.anos);
        // clientes sem empréstimo em andamento cuja última movimentação é anterior ao prazo de retenção
        const rows = await ctx.db.execute(sql`
          select c.id from clients c
          where c.org_id = ${s.org_id} and c.anonymized_at is null
            and not exists (select 1 from loans l where l.client_id = c.id and l.status in ('proposta','ativo'))
            and greatest(c.created_at, coalesce((select max(greatest(l.created_at, coalesce(l.canceled_at, l.created_at))) from loans l where l.client_id = c.id), c.created_at),
                         coalesce((select max(i.settled_at)::timestamptz from installments i join loans l on l.id = i.loan_id where l.client_id = c.id), c.created_at)) < ${cutoff.toISOString()}`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
        for (const { id } of rows) await purgeClientFiles(ctx, id);
      }
    },
  };
}

export async function purgeClientFiles(ctx: Ctx, clientId: string): Promise<number> {
  const fs = await ctx.db.select().from(files).where(and(eq(files.ownerClientId, clientId), isNull(files.purgedAt)));
  for (const f of fs) await ctx.storage.delete(f.storageKey).catch(() => undefined);
  if (fs.length) {
    await ctx.db.update(files).set({ purgedAt: ctx.now() }).where(inArray(files.id, fs.map((f) => f.id)));
    await ctx.db.update(clientDocuments).set({ status: 'arquivado' }).where(eq(clientDocuments.clientId, clientId));
  }
  return fs.length;
}

/** Garante que o lembrete das 08:00 (SP) e a limpeza de hoje estejam agendados (idempotente). */
export async function ensureDailyJobs(ctx: Ctx) {
  const day = today(ctx);
  const at = new Date(`${day}T${String(8 + SP_OFFSET_H).padStart(2, '0')}:00:00Z`);
  await enqueue(ctx, 'reminders', {}, { runAt: at, dedupeKey: 'reminders:' + day });
  await enqueue(ctx, 'purge', {}, { runAt: new Date(`${day}T06:00:00Z`), dedupeKey: 'purge:' + day });
}
