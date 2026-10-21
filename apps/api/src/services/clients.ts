import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { clientDocuments, clients, users } from '../db/schema.js';
import { hmac, openString, sealString } from '../lib/crypto.js';

export const DOC_TIPOS = ['rg_frente', 'rg_verso', 'residencia', 'selfie'] as const;
export type DocTipo = (typeof DOC_TIPOS)[number];

export const cpfDigits = (v: string) => v.replace(/\D/g, '');
export function sealCpf(ctx: Ctx, cpf: string) {
  const d = cpfDigits(cpf);
  return { cpfEnc: sealString(ctx.config.fileKey, d), cpfHash: hmac(ctx.config.secret, 'cpf:' + d), cpfLast4: d.slice(-4) };
}
export const readCpf = (ctx: Ctx, c: typeof clients.$inferSelect) => (c.cpfEnc ? openString(ctx.config.fileKey, c.cpfEnc) : '');
export const maskCpf = (cpf: string) => (cpf.length === 11 ? `***.${cpf.slice(3, 6)}.***-**` : '');

export async function clientDto(ctx: Ctx, c: typeof clients.$inferSelect, o: { fullCpf: boolean }) {
  const cpf = readCpf(ctx, c);
  let email: string | null = null, portalStatus: string | null = null;
  if (c.userId) { const [u] = await ctx.db.select({ email: users.email, status: users.status }).from(users).where(eq(users.id, c.userId)).limit(1); email = u?.email ?? null; portalStatus = u?.status ?? null; }
  return { id: c.id, nome: c.nome, whatsapp: c.whatsapp, cpf: o.fullCpf ? cpf : maskCpf(cpf), cidade: c.cidade, obs: o.fullCpf ? c.obs : undefined, responsavelId: c.responsavelId, situacao: c.situacao,
    bloqueado: c.bloqueado, limiteCents: c.limiteCents, portalEnabled: c.portalEnabled, email, portalStatus, consentAt: c.consentAt, createdAt: c.createdAt };
}

export async function documentsOf(ctx: Ctx, clientId: string) {
  const rows = await ctx.db.select().from(clientDocuments).where(and(eq(clientDocuments.clientId, clientId), inArray(clientDocuments.status, ['enviado', 'aprovado', 'recusado'])));
  return DOC_TIPOS.map((tipo) => {
    const d = rows.filter((r) => r.tipo === tipo).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return d ? { id: d.id, tipo, status: d.status, motivo: d.motivo, fileId: d.fileId, createdAt: d.createdAt } : { tipo, status: 'pendente' as const };
  });
}
