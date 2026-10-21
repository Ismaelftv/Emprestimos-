import { bootCtx } from '../boot.js';
import { ensureAdmin, ensureOrg } from '../bootstrap.js';
import { clients } from './schema.js';

// Dados de demonstração. NÃO use em produção.
const { ctx, handle } = await bootCtx();
if (ctx.config.isProd) { console.error('Recusado em produção.'); process.exit(1); }
const orgId = await ensureOrg(ctx);
await ensureAdmin(ctx, orgId, { email: 'admin@demo.com', password: 'demo-senha-123', nome: 'Dono' });
const [c] = await ctx.db.insert(clients).values({ orgId, nome: 'Cliente Demo', whatsapp: '11999990000', cidade: 'São Paulo' }).returning();
console.log('Admin: admin@demo.com / demo-senha-123 — cliente demo', c.id, '(crie empréstimos pela interface)');
await handle.close();
