import { daysBetween, type ISODate } from './dates.js';
import { pct } from './money.js';

export interface PenaltyCfg { multaBps: number; moraBpsMes: number }
export interface InstallmentLike { amountCents: number; due: ISODate; waived?: boolean }

export function lateCharges(i: InstallmentLike, cfg: PenaltyCfg, today: ISODate) {
  const days = Math.max(0, daysBetween(i.due, today));
  if (!days || i.waived) return { days, multaCents: 0, moraCents: 0, extraCents: 0 };
  const multaCents = pct(i.amountCents, cfg.multaBps);
  // mora proporcional: % ao mês * dias/30
  const moraCents = Math.floor((i.amountCents * cfg.moraBpsMes * days + 150000) / 300000);
  return { days, multaCents, moraCents, extraCents: multaCents + moraCents };
}

export type InstStatus = 'paid' | 'late' | 'today' | 'open';
export interface InstallmentState {
  days: number; extraCents: number; multaCents: number; moraCents: number;
  paidCents: number; balanceCents: number; status: InstStatus; partial: boolean;
}

/**
 * Estado derivado. Se a parcela já foi quitada (settled), os encargos ficam congelados
 * no valor do dia da quitação; senão são calculados para "hoje".
 */
export function installmentState(
  i: InstallmentLike & { settledExtraCents?: number | null; settled?: boolean },
  paidCents: number, cfg: PenaltyCfg, today: ISODate,
): InstallmentState {
  if (i.settled) {
    return { days: 0, extraCents: i.settledExtraCents ?? 0, multaCents: 0, moraCents: 0, paidCents, balanceCents: 0, status: 'paid', partial: false };
  }
  const c = lateCharges(i, cfg, today);
  const balanceCents = Math.max(0, i.amountCents + c.extraCents - paidCents);
  const status: InstStatus = balanceCents === 0 ? 'paid' : i.due < today ? 'late' : i.due === today ? 'today' : 'open';
  return { ...c, paidCents, balanceCents, status, partial: paidCents > 0 && balanceCents > 0 };
}
