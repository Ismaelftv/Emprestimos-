import type { Ctx } from './context.js';
import type { JobHandler } from './lib/queue.js';

export function makeHandlers(ctx: Ctx): Record<string, JobHandler> {
  return {
    receipt: async () => { /* Etapa 7 */ },
    email: async (p) => { await ctx.mailer.send({ to: p.to, subject: p.subject, text: p.text, html: p.html }); },
  };
}
