import { addDays, addMonthsClamped, weekday, type ISODate } from './dates.js';
import { pct } from './money.js';

export type Freq = 1 | 7 | 15 | 30;
export const FREQS: Freq[] = [1, 7, 15, 30];
export const FREQ_LABEL: Record<Freq, string> = { 1: 'diário', 7: 'semanal', 15: 'quinzenal', 30: 'mensal' };

export interface ScheduleInput {
  valorCents: number;
  jurosBps: number; // juros TOTAL sobre o valor
  freq: Freq;
  n: number;
  start: ISODate; // 1º vencimento
  skipSundays?: boolean; // só vale para diário
}
export interface ScheduledInstallment { numero: number; due: ISODate; amountCents: number }
export interface Schedule { totalCents: number; lucroCents: number; installments: ScheduledInstallment[] }

/** Juros simples sobre o total. Parcela = floor(total/n); a última absorve os centavos. */
export function buildSchedule(inp: ScheduleInput): Schedule {
  const { valorCents, jurosBps, freq, n, start } = inp;
  if (!Number.isInteger(valorCents) || valorCents <= 0) throw new Error('valor inválido');
  if (!Number.isInteger(n) || n < 1 || n > 360) throw new Error('número de parcelas inválido');
  if (jurosBps < 0) throw new Error('juros inválido');
  const totalCents = valorCents + pct(valorCents, jurosBps);
  const base = Math.floor(totalCents / n);
  const out: ScheduledInstallment[] = [];
  for (let i = 0; i < n; i++) {
    let due: ISODate;
    if (freq === 30) due = addMonthsClamped(start, i);
    else if (freq === 1 && inp.skipSundays) {
      let c = start, k = 0;
      while (k < i) { c = addDays(c, 1); if (weekday(c) !== 0) k++; }
      due = weekday(c) === 0 ? addDays(c, 1) : c;
    } else due = addDays(start, freq * i);
    out.push({ numero: i + 1, due, amountCents: i === n - 1 ? totalCents - base * (n - 1) : base });
  }
  return { totalCents, lucroCents: totalCents - valorCents, installments: out };
}
