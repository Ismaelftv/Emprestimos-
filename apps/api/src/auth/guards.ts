import type { FastifyRequest } from 'fastify';
import type { Actor, Perms } from '../context.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export function needActor(req: FastifyRequest): Actor { if (!req.actor) throw unauthorized(); return req.actor; }
export function needStaff(req: FastifyRequest): Actor { const a = needActor(req); if (a.kind !== 'staff') throw forbidden('Área da equipe'); return a; }
export function needAdmin(req: FastifyRequest): Actor { const a = needStaff(req); if (a.role !== 'admin') throw forbidden('Somente o administrador'); return a; }
export function needClient(req: FastifyRequest): Actor & { clientId: string } { const a = needActor(req); if (a.kind !== 'client' || !a.clientId) throw forbidden('Área do cliente'); return a as Actor & { clientId: string }; }
export function needPerm(req: FastifyRequest, p: keyof Perms): Actor { const a = needStaff(req); if (!a.perms[p]) throw forbidden('Você não tem permissão para isso'); return a; }
export const auditActor = (a: Actor) => ({ orgId: a.orgId, userId: a.userId, kind: a.kind as 'staff' | 'client', nome: a.nome, ip: a.ip, ua: a.ua });
