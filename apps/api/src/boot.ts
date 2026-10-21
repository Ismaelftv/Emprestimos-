import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, type Config } from './config.js';
import { createDb, type DbHandle } from './db/index.js';
import type { Ctx } from './context.js';
import { DiskStorage } from './lib/files.js';
import { MemoryMailer, SmtpMailer } from './lib/mailer.js';
import { makePushSender } from './lib/push.js';

export async function bootCtx(config: Config = loadConfig()): Promise<{ ctx: Ctx; handle: DbHandle }> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const url = config.databaseUrl ?? 'file://' + path.resolve(config.dataDir, 'pglite');
  const handle = await createDb(url);
  const log = (s: string) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: s }));
  const ctx: Ctx = {
    db: handle.db, config, now: () => new Date(), light: false, log,
    mailer: config.smtpUrl ? new SmtpMailer(config.smtpUrl, config.smtpFrom) : new MemoryMailer(log),
    storage: new DiskStorage(path.resolve(config.dataDir, 'files')),
    push: makePushSender(config),
  };
  return { ctx, handle };
}
