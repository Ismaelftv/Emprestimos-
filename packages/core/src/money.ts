// Dinheiro sempre em centavos (inteiros). Percentuais em basis points (1% = 100).
/** a * bps / 10000, arredondado (meio para cima), só com inteiros. */
export function pct(cents: number, bps: number): number {
  return Math.floor((cents * bps + 5000) / 10000);
}
export const brl = (cents: number): string => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** "1.234,56" | "1234.56" | "R$ 10" -> centavos */
export function parseMoney(input: string | number): number {
  if (typeof input === 'number') return Math.round(input * 100);
  const s = String(input).replace(/[^\d,.-]/g, '');
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = parseFloat(norm);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
