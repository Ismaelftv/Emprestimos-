import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import type { Ctx } from './context.js';
import { HttpError } from './lib/errors.js';
import { safeEqual } from './lib/crypto.js';
import { resolveSession } from './auth/session.js';
import { getSettings } from './routes/me.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { staffRoutes } from './routes/staff.js';
import { settingsRoutes } from './routes/settings.js';
import { registerBusinessRoutes } from './routes/index.js';

const PUBLIC = new Set(['/api/v1/auth/login', '/api/v1/auth/2fa', '/api/v1/auth/logout', '/api/v1/auth/forgot', '/api/v1/auth/reset', '/api/v1/auth/invite/accept', '/api/v1/auth/signup', '/api/v1/health']);

export async function buildApp(ctx: Ctx, opts: { rateLimitMax?: number } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: ctx.config.env === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }, trustProxy: ctx.config.trustProxy, bodyLimit: 1024 * 1024 });
  app.decorate('ctx', ctx);
  app.decorateRequest('actor', null); app.decorateRequest('mfaUserId', null); app.decorateRequest('mfaSessionId', null);

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'blob:'], scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: opts.rateLimitMax ?? 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'dados_invalidos', message: err.issues.map((i) => i.message).join('; ') });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'requisicao_invalida', message: e.statusCode === 429 ? 'Muitas requisições. Aguarde um instante.' : e.message });
    req.log.error({ err }, 'erro interno');
    return reply.code(500).send({ error: 'erro_interno', message: 'Algo deu errado. Tente novamente.' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'nao_encontrado', message: 'Não encontrado' }));

  // autenticação + CSRF + 2FA obrigatório: seguro por padrão (toda rota /api exige sessão, salvo a lista PUBLIC)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    await resolveSession(ctx, req);
    if (PUBLIC.has(url)) return;
    if (!req.actor) return reply.code(401).send({ error: 'nao_autenticado', message: 'Não autenticado' });
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      const h = String(req.headers['x-csrf'] ?? '');
      if (!h || !safeEqual(h, req.actor.csrf)) return reply.code(403).send({ error: 'csrf', message: 'Sessão expirada. Recarregue a página.' });
    }
    if (req.actor.role === 'admin' && !req.actor.totpEnabled && !(url === '/api/v1/me' || url.startsWith('/api/v1/me/2fa') || url === '/api/v1/auth/logout')) {
      if ((await getSettings(ctx, req.actor.orgId)).exigir2faAdmin) return reply.code(403).send({ error: 'exige_2fa', message: 'Ative a verificação em duas etapas para continuar.' });
    }
  });
  app.addHook('onSend', async (req, reply) => { if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store'); });

  await app.register(async (api) => {
    api.get('/health', async () => { await ctx.db.execute(sql`select 1`); return { ok: true, time: ctx.now().toISOString() }; });
    await api.register(authRoutes); await api.register(meRoutes); await api.register(staffRoutes); await api.register(settingsRoutes);
    await registerBusinessRoutes(api);
  }, { prefix: '/api/v1' });

  const webDir = ctx.config.webDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) await app.register(fastifyStatic, { root: webDir, wildcard: true, setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } });
  return app;
}
