import crypto from 'node:crypto';
import argon2 from 'argon2';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret: string, s: string) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export const randomCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// argon2id (parâmetros do OWASP; mais leve em teste para não alongar a suíte)
export const hashPassword = (pw: string, light = false) =>
  argon2.hash(pw, { type: argon2.argon2id, memoryCost: light ? 1024 : 19456, timeCost: 2, parallelism: 1 });
export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  if (!hash) return false;
  try { return await argon2.verify(hash, pw); } catch { return false; }
}

// AES-256-GCM. Cada blob usa uma chave de dados própria, cifrada pela chave mestra (envelope).
export function sealBuffer(master: Buffer, data: Buffer) {
  const dek = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  const tag = c.getAuthTag();
  const kiv = crypto.randomBytes(12), kc = crypto.createCipheriv('aes-256-gcm', master, kiv);
  const wrapped = Buffer.concat([kc.update(dek), kc.final()]);
  const ktag = kc.getAuthTag();
  return { enc, iv: iv.toString('base64'), tag: JSON.stringify({ t: tag.toString('base64'), k: Buffer.concat([kiv, ktag, wrapped]).toString('base64') }) };
}
export function openBuffer(master: Buffer, enc: Buffer, ivB64: string, tagJson: string): Buffer {
  const { t, k } = JSON.parse(tagJson) as { t: string; k: string };
  const kb = Buffer.from(k, 'base64'), kiv = kb.subarray(0, 12), ktag = kb.subarray(12, 28), wrapped = kb.subarray(28);
  const kd = crypto.createDecipheriv('aes-256-gcm', master, kiv); kd.setAuthTag(ktag);
  const dek = Buffer.concat([kd.update(wrapped), kd.final()]);
  const d = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(ivB64, 'base64')); d.setAuthTag(Buffer.from(t, 'base64'));
  return Buffer.concat([d.update(enc), d.final()]);
}
export function sealString(master: Buffer, s: string): string {
  const r = sealBuffer(master, Buffer.from(s, 'utf8'));
  return JSON.stringify({ e: r.enc.toString('base64'), i: r.iv, t: r.tag });
}
export function openString(master: Buffer, packed: string): string {
  const p = JSON.parse(packed) as { e: string; i: string; t: string };
  return openBuffer(master, Buffer.from(p.e, 'base64'), p.i, p.t).toString('utf8');
}

// ---- TOTP (RFC 6238) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(buf: Buffer): string {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function b32decode(s: string): Buffer {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) throw new Error('base32'); bits += v.toString(2).padStart(5, '0'); }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));
export function totpAt(secret: string, timeMs: number): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest(), o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
export function totpVerify(secret: string, code: string, now = Date.now()): boolean {
  const c = String(code).trim();
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((d) => safeEqual(totpAt(secret, now + d * 30000), c));
}
export const totpUri = (secret: string, email: string, issuer = 'Caixa') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
