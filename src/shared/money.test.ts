import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_CENTS,
  MoneyValidationError,
  type Payment,
  type Split,
  computeBalances,
  computeShares,
  formatCents,
  parseAmount,
  parsePercent,
  settleUp,
} from './money';

// Member ids double as member order (order added).
const ANA = 1;
const BEN = 2;
const CHLOE = 3;
const DAN = 4;
const EVE = 5;

function shares(amountCents: number, paidBy: number, split: Split) {
  return Object.fromEntries(
    computeShares({ amountCents, paidBy, split }).map((s) => [s.memberId, s.shareCents]),
  );
}

function equal(...memberIds: number[]): Split {
  return { type: 'equal', entries: memberIds.map((memberId) => ({ memberId })) };
}

function expectValidationError(fn: () => unknown, code: string, details?: object) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MoneyValidationError);
    expect((err as MoneyValidationError).code).toBe(code);
    if (details) expect((err as MoneyValidationError).details).toMatchObject(details);
    return;
  }
  throw new Error('expected a MoneyValidationError');
}

// Small seeded generator so "random" tests are reproducible.
function seededRandom(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseAmount', () => {
  it('parses dollars and cents into integer cents', () => {
    expect(parseAmount('100')).toBe(10000);
    expect(parseAmount('12.5')).toBe(1250);
    expect(parseAmount('12.50')).toBe(1250);
    expect(parseAmount('0.01')).toBe(1);
    expect(parseAmount(' 7.25 ')).toBe(725);
  });

  it('rejects more than two decimals, signs, exponents and junk', () => {
    for (const text of ['12.505', '-1', '+1', '1e3', '', '.5', '12.', 'abc', '1,000']) {
      expectValidationError(() => parseAmount(text), 'invalid_amount');
    }
  });

  it('rejects zero and amounts above the cap', () => {
    expectValidationError(() => parseAmount('0'), 'invalid_amount');
    expectValidationError(() => parseAmount('10000000.01'), 'invalid_amount');
    expect(parseAmount('10000000.00')).toBe(MAX_AMOUNT_CENTS);
  });
});

describe('parsePercent', () => {
  it('parses percentages into basis points', () => {
    expect(parsePercent('33.33')).toBe(3333);
    expect(parsePercent('50')).toBe(5000);
    expect(parsePercent('0.5')).toBe(50);
    expect(parsePercent('100')).toBe(10000);
  });

  it('rejects more than two decimals and values above 100', () => {
    expectValidationError(() => parsePercent('33.333'), 'invalid_percent');
    expectValidationError(() => parsePercent('100.01'), 'invalid_percent');
    expectValidationError(() => parsePercent('-5'), 'invalid_percent');
  });
});

describe('formatCents', () => {
  it('formats cents as dollars', () => {
    expect(formatCents(10000)).toBe('$100.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(-3334)).toBe('-$33.34');
  });
});

describe('computeShares: equal', () => {
  it('$100.00 over three, Ana pays: the payer absorbs the extra cent', () => {
    expect(shares(10000, ANA, equal(ANA, BEN, CHLOE))).toEqual({
      [ANA]: 3334,
      [BEN]: 3333,
      [CHLOE]: 3333,
    });
  });

  it('$100.00 over three, Chloé pays: the extra cent goes to her, not to Ana', () => {
    expect(shares(10000, CHLOE, equal(ANA, BEN, CHLOE))).toEqual({
      [ANA]: 3333,
      [BEN]: 3333,
      [CHLOE]: 3334,
    });
  });

  it('$100.01 over three, Ben pays: payer first, then member order', () => {
    expect(shares(10001, BEN, equal(ANA, BEN, CHLOE))).toEqual({
      [ANA]: 3334,
      [BEN]: 3334,
      [CHLOE]: 3333,
    });
  });

  it('payer not in the split: leftover cents go by member order', () => {
    expect(shares(10000, ANA, equal(BEN, CHLOE))).toEqual({ [BEN]: 5000, [CHLOE]: 5000 });
    expect(shares(10001, ANA, equal(BEN, CHLOE))).toEqual({ [BEN]: 5001, [CHLOE]: 5000 });
  });

  it('member order does not depend on the order entries are sent in', () => {
    expect(shares(10001, ANA, equal(CHLOE, BEN))).toEqual({ [BEN]: 5001, [CHLOE]: 5000 });
  });

  it('one participant gets the whole amount', () => {
    expect(shares(999, ANA, equal(BEN))).toEqual({ [BEN]: 999 });
  });

  it('1 cent over three people: only one person pays it', () => {
    expect(shares(1, CHLOE, equal(ANA, BEN, CHLOE))).toEqual({
      [ANA]: 0,
      [BEN]: 0,
      [CHLOE]: 1,
    });
  });
});

describe('computeShares: percent', () => {
  it('largest remainder beats the payer', () => {
    const split: Split = {
      type: 'percent',
      entries: [
        { memberId: ANA, value: 1010 },
        { memberId: BEN, value: 4545 },
        { memberId: CHLOE, value: 4445 },
      ],
    };
    expect(shares(100, ANA, split)).toEqual({ [ANA]: 10, [BEN]: 46, [CHLOE]: 44 });
  });

  it('33.34 / 33.33 / 33.33 of $100.00', () => {
    const split: Split = {
      type: 'percent',
      entries: [
        { memberId: ANA, value: 3334 },
        { memberId: BEN, value: 3333 },
        { memberId: CHLOE, value: 3333 },
      ],
    };
    expect(shares(10000, BEN, split)).toEqual({ [ANA]: 3334, [BEN]: 3333, [CHLOE]: 3333 });
  });

  it('rejects percentages that sum to 99.99, with the actual sum', () => {
    const split: Split = {
      type: 'percent',
      entries: [
        { memberId: ANA, value: 3333 },
        { memberId: BEN, value: 3333 },
        { memberId: CHLOE, value: 3333 },
      ],
    };
    expectValidationError(() => shares(10000, ANA, split), 'split_sum_mismatch', {
      expected: 10000,
      actual: 9999,
    });
  });

  it('rejects zero and non-integer basis points', () => {
    expectValidationError(
      () =>
        shares(10000, ANA, {
          type: 'percent',
          entries: [
            { memberId: ANA, value: 10000 },
            { memberId: BEN, value: 0 },
          ],
        }),
      'invalid_split',
    );
    expectValidationError(
      () =>
        shares(10000, ANA, {
          type: 'percent',
          entries: [
            { memberId: ANA, value: 3333.3 },
            { memberId: BEN, value: 6666.7 },
          ],
        }),
      'invalid_split',
    );
  });
});

describe('computeShares: exact', () => {
  it('uses the amounts as entered', () => {
    const split: Split = {
      type: 'exact',
      entries: [
        { memberId: ANA, value: 7000 },
        { memberId: BEN, value: 3000 },
      ],
    };
    expect(shares(10000, ANA, split)).toEqual({ [ANA]: 7000, [BEN]: 3000 });
  });

  it('rejects amounts that do not sum to the total, with the actual sum', () => {
    const split: Split = {
      type: 'exact',
      entries: [
        { memberId: ANA, value: 7000 },
        { memberId: BEN, value: 2999 },
      ],
    };
    expectValidationError(() => shares(10000, ANA, split), 'split_sum_mismatch', {
      expected: 10000,
      actual: 9999,
    });
  });
});

describe('computeShares: input validation', () => {
  it('rejects an empty split', () => {
    expectValidationError(() => shares(10000, ANA, equal()), 'invalid_split');
  });

  it('rejects duplicate participants', () => {
    expectValidationError(() => shares(10000, ANA, equal(ANA, ANA)), 'invalid_split');
  });

  it('rejects amounts that are not whole cents in range', () => {
    expectValidationError(() => shares(0, ANA, equal(ANA)), 'invalid_amount');
    expectValidationError(() => shares(10.5, ANA, equal(ANA)), 'invalid_amount');
    expectValidationError(() => shares(MAX_AMOUNT_CENTS + 1, ANA, equal(ANA)), 'invalid_amount');
  });

  it('rejects values on an equal split', () => {
    expectValidationError(
      () => shares(10000, ANA, { type: 'equal', entries: [{ memberId: ANA, value: 5000 }] }),
      'invalid_split',
    );
  });
});

describe('computeShares: invariants', () => {
  it('shares always sum to the amount and differ from exact by under one cent', () => {
    const random = seededRandom(42);
    for (let run = 0; run < 2000; run++) {
      const amountCents = 1 + Math.floor(random() * 1_000_000);
      const count = 1 + Math.floor(random() * 8);
      const memberIds = Array.from({ length: count }, (_, i) => i + 1);
      const paidBy = 1 + Math.floor(random() * 9); // sometimes not in the split

      let split: Split;
      let weights: number[];
      if (random() < 0.5) {
        split = equal(...memberIds);
        weights = memberIds.map(() => 1);
      } else {
        // Random basis points that sum to exactly 10000, each at least 1.
        const cuts = Array.from({ length: count - 1 }, () => 1 + Math.floor(random() * 9999))
          .sort((a, b) => a - b);
        weights = [...cuts, 10000].map((cut, i) => cut - (i === 0 ? 0 : cuts[i - 1]!));
        if (weights.some((w) => w <= 0)) continue;
        split = {
          type: 'percent',
          entries: memberIds.map((memberId, i) => ({ memberId, value: weights[i]! })),
        };
      }

      const result = computeShares({ amountCents, paidBy, split });
      expect(result.reduce((sum, s) => sum + s.shareCents, 0)).toBe(amountCents);

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      result.forEach((s, i) => {
        const exact = (amountCents * weights[i]!) / totalWeight;
        expect(Math.abs(s.shareCents - exact)).toBeLessThan(1);
      });
    }
  });
});

describe('computeBalances', () => {
  it('balance = paid minus shares, and adds up to zero', () => {
    const balances = computeBalances(
      [ANA, BEN, CHLOE],
      [
        {
          paidBy: ANA,
          amountCents: 10000,
          shares: computeShares({ amountCents: 10000, paidBy: ANA, split: equal(ANA, BEN, CHLOE) }),
        },
        {
          paidBy: BEN,
          amountCents: 3000,
          shares: computeShares({ amountCents: 3000, paidBy: BEN, split: equal(BEN, CHLOE) }),
        },
      ],
    );
    expect(balances).toEqual([
      { memberId: ANA, balanceCents: 6666 },
      { memberId: BEN, balanceCents: -1833 },
      { memberId: CHLOE, balanceCents: -4833 },
    ]);
  });

  it('members with no expenses have a zero balance', () => {
    expect(computeBalances([ANA, BEN], [])).toEqual([
      { memberId: ANA, balanceCents: 0 },
      { memberId: BEN, balanceCents: 0 },
    ]);
  });
});

function applyPayments(balances: Map<number, number>, payments: Payment[]) {
  const result = new Map(balances);
  for (const p of payments) {
    expect(p.amountCents).toBeGreaterThan(0);
    result.set(p.from, result.get(p.from)! + p.amountCents);
    result.set(p.to, result.get(p.to)! - p.amountCents);
  }
  return result;
}

function balancesOf(entries: [number, number][]) {
  return entries.map(([memberId, balanceCents]) => ({ memberId, balanceCents }));
}

describe('settleUp', () => {
  it('all balances zero: no payments', () => {
    expect(settleUp(balancesOf([[ANA, 0], [BEN, 0]]))).toEqual([]);
  });

  it('finds 3 payments where greedy needs 4', () => {
    const balances = balancesOf([
      [ANA, 4],
      [BEN, 3],
      [CHLOE, 2],
      [DAN, -5],
      [EVE, -4],
    ]);
    const payments = settleUp(balances);
    expect(payments).toHaveLength(3);
    const after = applyPayments(new Map(balances.map((b) => [b.memberId, b.balanceCents])), payments);
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });

  it('two equally good plans: always picks the same one', () => {
    const balances = balancesOf([
      [ANA, 5],
      [BEN, 5],
      [CHLOE, -5],
      [DAN, -5],
    ]);
    const expected = [
      { from: CHLOE, to: ANA, amountCents: 5 },
      { from: DAN, to: BEN, amountCents: 5 },
    ];
    expect(settleUp(balances)).toEqual(expected);
    expect(settleUp([...balances].reverse())).toEqual(expected);
  });

  it('above the cap, falls back to greedy and still settles everyone', () => {
    // 20 people: 10 owed 100..1000, 10 owing the same amounts.
    const balances = balancesOf(
      Array.from({ length: 20 }, (_, i) => [i + 1, (i < 10 ? 1 : -1) * ((i % 10) + 1) * 100]),
    );
    const payments = settleUp(balances);
    expect(payments.length).toBeLessThanOrEqual(19);
    const after = applyPayments(new Map(balances.map((b) => [b.memberId, b.balanceCents])), payments);
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });

  it('random balances always settle to zero in at most n-1 payments', () => {
    const random = seededRandom(7);
    for (let run = 0; run < 300; run++) {
      const count = 2 + Math.floor(random() * 10);
      const values = Array.from({ length: count - 1 }, () => Math.floor(random() * 20001) - 10000);
      values.push(-values.reduce((a, b) => a + b, 0));
      const balances = balancesOf(values.map((v, i) => [i + 1, v]));
      const payments = settleUp(balances);
      const nonZero = values.filter((v) => v !== 0).length;
      expect(payments.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
      const after = applyPayments(new Map(balances.map((b) => [b.memberId, b.balanceCents])), payments);
      expect([...after.values()].every((v) => v === 0)).toBe(true);
    }
  });

  it('rejects balances that do not sum to zero', () => {
    expect(() => settleUp(balancesOf([[ANA, 5], [BEN, -4]]))).toThrow();
  });
});
