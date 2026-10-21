import type { FastifyInstance } from 'fastify';
import { clientRoutes } from './clients.js';
import { portalRoutes } from './portal.js';
import { loanRoutes } from './loans.js';
import { requestRoutes } from './requests.js';
import { cashRoutes } from './cash.js';
import { reportRoutes } from './reports.js';
import { miscRoutes } from './misc.js';

export async function registerBusinessRoutes(api: FastifyInstance) {
  await api.register(clientRoutes);
  await api.register(portalRoutes);
  await api.register(loanRoutes);
  await api.register(requestRoutes);
  await api.register(cashRoutes);
  await api.register(reportRoutes);
  await api.register(miscRoutes);
}
