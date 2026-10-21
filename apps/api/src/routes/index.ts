import type { FastifyInstance } from 'fastify';
import { clientRoutes } from './clients.js';
import { portalRoutes } from './portal.js';
import { loanRoutes } from './loans.js';
import { requestRoutes } from './requests.js';

export async function registerBusinessRoutes(api: FastifyInstance) {
  await api.register(clientRoutes);
  await api.register(portalRoutes);
  await api.register(loanRoutes);
  await api.register(requestRoutes);
}
