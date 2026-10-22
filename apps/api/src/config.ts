import { z } from 'zod';
import crypto from 'node:crypto';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().optional(), // vazio => PGlite em ./data
  DATA_DIR: z.string().default('./data'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  SECRET_KEY: z.string().min(32, 'SECRET_KEY precisa de 32+ caracteres').optional(), // HMAC/pepper
  FILE_KEY: z.string().optional(), // 32 bytes em base64: chave mestra dos arquivos/segredos
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_URL: z.string().optional(), SMTP_FROM: z.string().default('Caixa <no-reply@localhost>'),
  VAPID_PUBLIC_KEY: z.string().optional(), VAPID_PRIVATE_KEY: z.string().optional(), VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().optional(), BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(), BOOTSTRAP_ADMIN_NAME: z.string().default('Administrador'),
  WEB_DIR: z.string().optional(),
});
export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const e = schema.parse(env);
  const prod = e.NODE_ENV === 'production';
  if (prod && !e.SECRET_KEY) throw new Error('SECRET_KEY é obrigatório em produção');
  if (prod && !e.FILE_KEY) throw new Error('FILE_KEY é obrigatório em produção');
  const secret = e.SECRET_KEY ?? crypto.createHash('sha256').update('dev-secret').digest('hex');
  const fileKey = e.FILE_KEY ? Buffer.from(e.FILE_KEY, 'base64') : crypto.createHash('sha256').update('dev-file-key').digest();
  if (fileKey.length !== 32) throw new Error('FILE_KEY deve ter 32 bytes em base64 (openssl rand -base64 32)');
  return {
    env: e.NODE_ENV, isProd: prod, port: e.PORT, databaseUrl: e.DATABASE_URL, dataDir: e.DATA_DIR, publicUrl: e.PUBLIC_URL,
    secret, fileKey, cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : prod,
    smtpUrl: e.SMTP_URL, smtpFrom: e.SMTP_FROM, vapid: e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY ? { publicKey: e.VAPID_PUBLIC_KEY, privateKey: e.VAPID_PRIVATE_KEY, subject: e.VAPID_SUBJECT } : null,
    trustProxy: e.TRUST_PROXY === 'true', webDir: e.WEB_DIR,
    bootstrap: e.BOOTSTRAP_ADMIN_EMAIL ? { email: e.BOOTSTRAP_ADMIN_EMAIL, password: e.BOOTSTRAP_ADMIN_PASSWORD ?? null, nome: e.BOOTSTRAP_ADMIN_NAME } : null,
  };
}
