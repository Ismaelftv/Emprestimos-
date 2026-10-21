import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/index.js';
import { files } from '../db/schema.js';
import { openBuffer, sealBuffer, sha256 } from './crypto.js';
import { badRequest, notFound } from './errors.js';

export interface Storage { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer>; delete(key: string): Promise<void> }

export class DiskStorage implements Storage {
  constructor(private dir: string) {}
  private p(key: string) { if (!/^[a-f0-9-]{36}$/.test(key)) throw new Error('chave inválida'); return path.join(this.dir, key.slice(0, 2), key); }
  async put(key: string, data: Buffer) { const f = this.p(key); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.writeFile(f, data, { mode: 0o600 }); }
  async get(key: string) { return fs.readFile(this.p(key)); }
  async delete(key: string) { await fs.rm(this.p(key), { force: true }); }
}
export class MemoryStorage implements Storage {
  m = new Map<string, Buffer>();
  async put(k: string, d: Buffer) { this.m.set(k, d); } async get(k: string) { const v = this.m.get(k); if (!v) throw new Error('ENOENT'); return v; } async delete(k: string) { this.m.delete(k); }
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Confere o tipo pelos primeiros bytes (não confia no nome/Content-Type enviados). */
export function sniffMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (b.length > 5 && b.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

export async function saveFile(db: Db | Tx, storage: Storage, master: Buffer, p: { orgId: string; data: Buffer; ownerClientId?: string | null; createdBy?: string | null; allowPdf?: boolean; purgeAfter?: Date | null }) {
  if (!p.data.length) throw badRequest('Arquivo vazio');
  if (p.data.length > MAX_FILE_BYTES) throw badRequest('Arquivo maior que 5 MB', 'arquivo_grande');
  const mime = sniffMime(p.data);
  if (!mime || (mime === 'application/pdf' && !p.allowPdf)) throw badRequest('Envie uma foto (JPG, PNG ou WebP)', 'tipo_invalido');
  const id = crypto.randomUUID(), sealed = sealBuffer(master, p.data);
  await storage.put(id, sealed.enc);
  await db.insert(files).values({ id, orgId: p.orgId, storageKey: id, mime, size: p.data.length, sha256: sha256(p.data), encIv: sealed.iv, encTag: sealed.tag, ownerClientId: p.ownerClientId ?? null, createdBy: p.createdBy ?? null, purgeAfter: p.purgeAfter ?? null });
  return id;
}
export async function loadFile(db: Db | Tx, storage: Storage, master: Buffer, id: string) {
  const [f] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  if (!f || f.purgedAt) throw notFound('Arquivo não encontrado');
  const enc = await storage.get(f.storageKey);
  return { meta: f, data: openBuffer(master, enc, f.encIv, f.encTag) };
}

/** Lê o arquivo de uma requisição multipart; devolve 400 (e não 406/413) quando falta ou é grande demais. */
export async function readUpload(req: import('fastify').FastifyRequest): Promise<Buffer> {
  if (!req.isMultipart()) throw badRequest('Anexe o arquivo', 'sem_arquivo');
  const part = await req.file();
  if (!part) throw badRequest('Anexe o arquivo', 'sem_arquivo');
  return part.toBuffer().catch(() => { throw badRequest('Arquivo maior que 5 MB', 'arquivo_grande'); });
}
