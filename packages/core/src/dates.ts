// Datas de calendário como string 'YYYY-MM-DD' (sem fuso). "Hoje" sempre em America/Sao_Paulo.
export type ISODate = string;
export const TZ = 'America/Sao_Paulo';

export function todaySP(now: Date = new Date()): ISODate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // en-CA => YYYY-MM-DD
}

const toUTC = (d: ISODate) => {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
};
const fromUTC = (ms: number): ISODate => new Date(ms).toISOString().slice(0, 10);

export function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return fromUTC(toUTC(d)) === d;
}
export const addDays = (d: ISODate, n: number): ISODate => fromUTC(toUTC(d) + n * 86400000);
export const daysBetween = (from: ISODate, to: ISODate): number => Math.round((toUTC(to) - toUTC(from)) / 86400000);
export const weekday = (d: ISODate): number => new Date(toUTC(d)).getUTCDay(); // 0 = domingo
export const daysInMonth = (y: number, m1: number): number => new Date(Date.UTC(y, m1, 0)).getUTCDate();

/** Soma meses mantendo o dia-âncora; em meses curtos cai no último dia (31/jan -> 28/fev -> 31/mar). */
export function addMonthsClamped(anchor: ISODate, months: number): ISODate {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}
