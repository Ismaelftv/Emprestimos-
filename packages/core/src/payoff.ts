import type { ISODate } from './dates.js';
import { lateCharges, type PenaltyCfg } from './penalty.js';

export interface PayoffInstallment { id: string; numero: number; due: ISODate; amountCents: number; waived?: boolean; paidCents: number; settled: boolean }
export interface PayoffPart { id: string; numero: number; payCents: number; discountCents: number }

/**
 * Quitação antecipada: parcelas vencidas/hoje entram integrais (com multa/mora);
 * parcelas futuras ganham desconto de descQuitBps sobre os juros embutidos em cada parcela.
 */
export function payoffQuote(
  loan: { valorCents: number; totalCents: number; nParcelas: number; descQuitBps: number },
  insts: PayoffInstallment[], cfg: PenaltyCfg, today: ISODate,
) {
  const jurosPorParcela = Math.floor((loan.totalCents - loan.valorCents) / loan.nParcelas);
  const parts: PayoffPart[] = [];
  let total = 0, disc = 0;
  for (const i of insts) {
    if (i.settled) continue;
    const c = lateCharges(i, cfg, today);
    let val = Math.max(0, i.amountCents + c.extraCents - i.paidCents), d = 0;
    if (i.due > today) { d = Math.min(val, Math.floor((jurosPorParcela * loan.descQuitBps + 5000) / 10000)); val -= d; }
    if (val > 0 || d > 0) parts.push({ id: i.id, numero: i.numero, payCents: val, discountCents: d });
    total += val; disc += d;
  }
  return { totalCents: total, discountCents: disc, parts };
}
