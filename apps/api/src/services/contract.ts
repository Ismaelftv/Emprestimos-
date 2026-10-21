import { brl, type Freq } from '@caixa/core';
const PLURAL: Record<Freq, [string, string]> = { 1: ['diária', 'diárias'], 7: ['semanal', 'semanais'], 15: ['quinzenal', 'quinzenais'], 30: ['mensal', 'mensais'] };

const fd = (iso: string) => iso.split('-').reverse().join('/');
export const CONTRACT_VERSION = 'v1-modelo';

export interface ContractInput {
  empresa: string; pixNome: string; devedorNome: string; devedorCpf: string;
  valorCents: number; jurosBps: number; totalCents: number; freq: Freq;
  parcelas: { due: string; amountCents: number }[]; multaBps: number; moraBpsMes: number; descQuitBps: number;
}
const p = (bps: number) => (bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Texto do contrato congelado no empréstimo. MODELO ilustrativo: precisa de revisão jurídica. */
export function contractText(c: ContractInput): string {
  const n = c.parcelas.length, f = PLURAL[c.freq][n > 1 ? 1 : 0];
  const lista = c.parcelas.slice(0, 3).map((x) => `${fd(x.due)} ${brl(x.amountCents)}`).join(', ') + (n > 3 ? `… até ${fd(c.parcelas[n - 1].due)}` : '');
  return [
    'CONTRATO DE EMPRÉSTIMO PESSOAL',
    `Credor: ${c.empresa}${c.pixNome ? ` (${c.pixNome})` : ''}.`,
    `Devedor: ${c.devedorNome}${c.devedorCpf ? `, CPF ${c.devedorCpf}` : ''}.`,
    `1. Valor. O credor empresta ao devedor ${brl(c.valorCents)}.`,
    `2. Juros. Juros totais de ${p(c.jurosBps)}% sobre o valor, totalizando ${brl(c.totalCents)} a pagar.`,
    `3. Pagamento. ${n} ${n > 1 ? 'parcelas' : 'parcela'} ${f}: ${lista}.`,
    `4. Atraso. Multa de ${p(c.multaBps)}% e juros de mora de ${p(c.moraBpsMes)}% ao mês, proporcionais aos dias de atraso.`,
    `5. Quitação antecipada. Permitida a qualquer tempo, com desconto de ${p(c.descQuitBps)}% dos juros das parcelas ainda não vencidas.`,
    '6. Dados. Os dados do devedor serão tratados conforme a LGPD, exclusivamente para análise, cobrança e cumprimento deste contrato.',
    'Modelo ilustrativo: peça a um advogado para revisar o texto antes de usar.',
  ].join('\n');
}
