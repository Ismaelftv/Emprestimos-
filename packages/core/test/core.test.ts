import { describe, it, expect } from 'vitest';
import { buildSchedule, lateCharges, installmentState, payoffQuote, todaySP, addMonthsClamped, cpfOk, parseMoney, pct } from '../src/index.js';

describe('schedule', () => {
  it('juros simples sobre o total; última parcela absorve centavos', () => {
    const s = buildSchedule({ valorCents: 50000, jurosBps: 2000, freq: 7, n: 4, start: '2026-10-10' });
    expect(s.totalCents).toBe(60000);
    expect(s.installments.map((i) => i.amountCents)).toEqual([15000, 15000, 15000, 15000]);
    const t = buildSchedule({ valorCents: 10000, jurosBps: 1000, freq: 7, n: 3, start: '2026-10-10' });
    expect(t.totalCents).toBe(11000);
    expect(t.installments.map((i) => i.amountCents)).toEqual([3666, 3666, 3668]);
    expect(t.installments.reduce((a, i) => a + i.amountCents, 0)).toBe(11000);
  });
  it('semanal/quinzenal somam dias', () => {
    expect(buildSchedule({ valorCents: 100, jurosBps: 0, freq: 15, n: 3, start: '2026-01-01' }).installments.map((i) => i.due)).toEqual(['2026-01-01', '2026-01-16', '2026-01-31']);
  });
  it('mensal mantém o dia 31 (31/jan -> 28/fev -> 31/mar)', () => {
    const s = buildSchedule({ valorCents: 30000, jurosBps: 0, freq: 30, n: 4, start: '2026-01-31' });
    expect(s.installments.map((i) => i.due)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
  });
  it('diário pulando domingos', () => {
    // 2026-10-23 é sexta
    const s = buildSchedule({ valorCents: 600, jurosBps: 0, freq: 1, n: 4, start: '2026-10-23', skipSundays: true });
    expect(s.installments.map((i) => i.due)).toEqual(['2026-10-23', '2026-10-24', '2026-10-26', '2026-10-27']);
    const dom = buildSchedule({ valorCents: 600, jurosBps: 0, freq: 1, n: 2, start: '2026-10-25', skipSundays: true });
    expect(dom.installments[0].due).toBe('2026-10-26');
  });
  it('rejeita entradas inválidas', () => {
    expect(() => buildSchedule({ valorCents: 0, jurosBps: 0, freq: 7, n: 1, start: '2026-01-01' })).toThrow();
    expect(() => buildSchedule({ valorCents: 100, jurosBps: 0, freq: 7, n: 0, start: '2026-01-01' })).toThrow();
  });
});

describe('fuso', () => {
  it('23h em São Paulo continua sendo hoje (UTC já virou o dia)', () => {
    expect(todaySP(new Date('2026-10-21T02:30:00Z'))).toBe('2026-10-20');
    expect(todaySP(new Date('2026-10-21T03:00:00Z'))).toBe('2026-10-21');
  });
});

const cfg = { multaBps: 200, moraBpsMes: 100 };
describe('multa e mora', () => {
  it('sem atraso não cobra nada', () => {
    expect(lateCharges({ amountCents: 15000, due: '2026-10-20' }, cfg, '2026-10-20').extraCents).toBe(0);
  });
  it('multa única + mora proporcional aos dias', () => {
    const c = lateCharges({ amountCents: 15000, due: '2026-10-01' }, cfg, '2026-10-16'); // 15 dias
    expect(c.days).toBe(15);
    expect(c.multaCents).toBe(300);
    expect(c.moraCents).toBe(75); // 15000 * 1% * 15/30
    expect(c.extraCents).toBe(375);
  });
  it('perdoada zera os encargos', () => {
    expect(lateCharges({ amountCents: 15000, due: '2026-10-01', waived: true }, cfg, '2026-10-16').extraCents).toBe(0);
  });
});

describe('estado da parcela', () => {
  it('parcial deixa saldo e marca partial', () => {
    const s = installmentState({ amountCents: 15000, due: '2026-10-20' }, 5000, cfg, '2026-10-20');
    expect(s.balanceCents).toBe(10000); expect(s.partial).toBe(true); expect(s.status).toBe('today');
  });
  it('atrasada inclui encargos no saldo', () => {
    const s = installmentState({ amountCents: 15000, due: '2026-10-01' }, 0, cfg, '2026-10-16');
    expect(s.balanceCents).toBe(15375); expect(s.status).toBe('late');
  });
  it('quitada congela encargos', () => {
    const s = installmentState({ amountCents: 15000, due: '2026-10-01', settled: true, settledExtraCents: 375 }, 15375, cfg, '2027-01-01');
    expect(s.balanceCents).toBe(0); expect(s.status).toBe('paid'); expect(s.extraCents).toBe(375);
  });
});

describe('quitação antecipada', () => {
  it('desconta parte dos juros só das parcelas futuras', () => {
    const loan = { valorCents: 50000, totalCents: 60000, nParcelas: 4, descQuitBps: 5000 };
    const insts = [1, 2, 3, 4].map((n) => ({ id: 'i' + n, numero: n, due: `2026-10-${String(10 + 7 * (n - 1)).padStart(2, '0')}`, amountCents: 15000, paidCents: n === 1 ? 15000 : 0, settled: n === 1 }));
    const q = payoffQuote(loan, insts, cfg, '2026-10-20');
    // parcela 2 (17/10) venceu: integral + encargos (3 dias); 3 e 4 futuras: juros/parcela 2500, 50% = 1250
    expect(q.parts.find((p) => p.numero === 3)!.discountCents).toBe(1250);
    expect(q.discountCents).toBe(2500);
    const p2 = q.parts.find((p) => p.numero === 2)!;
    expect(p2.discountCents).toBe(0); expect(p2.payCents).toBeGreaterThan(15000);
  });
});

describe('utilitários', () => {
  it('cpf', () => { expect(cpfOk('529.982.247-25')).toBe(true); expect(cpfOk('111.111.111-11')).toBe(false); expect(cpfOk('123')).toBe(false); });
  it('dinheiro', () => { expect(parseMoney('1.234,56')).toBe(123456); expect(parseMoney('R$ 10')).toBe(1000); expect(pct(15000, 200)).toBe(300); });
});
