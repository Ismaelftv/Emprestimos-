import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { bootCtx } from './boot.js';
import { ensureAdmin, ensureOrg } from './bootstrap.js';
import { ensureDailyJobs, makeHandlers } from './jobs.js';
import { runDueJobs } from './lib/queue.js';

const { ctx, handle } = await bootCtx();
const orgId = await ensureOrg(ctx);
if (ctx.config.bootstrap) {
  // Sem senha no .env, gera uma aleatória e mostra UMA vez no log (nunca fica gravada em arquivo/git).
  const gerada = ctx.config.bootstrap.password ? null : randomBytes(12).toString('base64url');
  const b = { ...ctx.config.bootstrap, password: ctx.config.bootstrap.password ?? gerada! };
  if (await ensureAdmin(ctx, orgId, b)) {
    ctx.log('Administrador inicial criado: ' + b.email);
    if (gerada) ctx.log(`SENHA INICIAL (aparece só agora, troque no primeiro acesso): ${gerada}`);
  }
}
if (!ctx.config.smtpUrl) ctx.log('AVISO: SMTP_URL não definido; e-mails serão apenas registrados no log.');

const app = await buildApp(ctx);
const handlers = makeHandlers(ctx);
let busy = false;
const tick = async () => {
  if (busy) return; busy = true;
  try { await ensureDailyJobs(ctx); await runDueJobs(ctx.db, handlers, ctx.now()); } catch (e) { app.log.error(e, 'worker'); } finally { busy = false; }
};
const timer = setInterval(tick, 15_000); void tick();

await app.listen({ port: ctx.config.port, host: '0.0.0.0' });
const stop = async (sig: string) => { app.log.info('encerrando ' + sig); clearInterval(timer); await app.close(); await handle.close(); process.exit(0); };
process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
