export const onlyDigits = (v: string) => String(v ?? '').replace(/\D/g, '');
export function cpfOk(v: string): boolean {
  const d = onlyDigits(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += +d[i] * (n + 1 - i);
    if (((sum * 10) % 11) % 10 !== +d[n]) return false;
  }
  return true;
}
export function normalizeWhatsApp(v: string): string {
  const d = onlyDigits(v);
  return d && d.length <= 11 ? '55' + d : d;
}
