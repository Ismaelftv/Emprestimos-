import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Mailer } from './lib/mailer.js';
import type { Storage } from './lib/files.js';
import type { PushSender } from './lib/push.js';

export interface Ctx {
  db: Db; config: Config; mailer: Mailer; storage: Storage; push: PushSender;
  now: () => Date;            // relógio injetável (testes)
  light: boolean;             // argon2 leve em testes
  log: (s: string) => void;
}
export interface Perms { criar: boolean; clientes: boolean; excluir: boolean; lucro: boolean; todos: boolean }
export interface Actor {
  userId: string; orgId: string; kind: 'staff' | 'client'; role: 'admin' | 'staff' | 'client'; nome: string; email: string;
  perms: Perms; clientId: string | null; sessionId: string; csrf: string; totpEnabled: boolean; ip: string; ua: string;
}
declare module 'fastify' {
  interface FastifyRequest { actor: Actor | null; mfaUserId: string | null; mfaSessionId: string | null }
  interface FastifyInstance { ctx: Ctx }
}
