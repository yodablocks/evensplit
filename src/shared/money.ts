// Money logic shared by server and client. Pure functions only: no database,
// no HTTP. All amounts are integer cents; percentages are integer basis
// points (33.33% = 3333). See SPEC.md, "Money rules".

export const MAX_AMOUNT_CENTS = 1_000_000_000; // $10,000,000.00
export const FULL_PERCENT_BP = 10_000; // 100.00%
export const EXACT_SETTLE_UP_LIMIT = 15; // people with a non-zero balance

export type SplitType = 'equal' | 'exact' | 'percent';

export interface SplitEntry {
  memberId: number;
  /** Cents for exact, basis points for percent, absent for equal. */
  value?: number;
}

export interface Split {
  type: SplitType;
  entries: SplitEntry[];
}

export interface Share {
  memberId: number;
  shareCents: number;
}

export interface Balance {
  memberId: number;
  balanceCents: number;
}

export interface Payment {
  from: number;
  to: number;
  amountCents: number;
}

export class MoneyValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MoneyValidationError';
  }
}

// ---------------------------------------------------------------------------
// Parsing and formatting

/** "12.5" → 1250. At most two decimals, no signs, no exponents. */
export function parseAmount(text: string): number {
  const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) {
    throw new MoneyValidationError('invalid_amount', 'Enter an amount like 12.50', { text });
  }
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  validateAmountCents(cents);
  return cents;
}

/** "33.33" → 3333. At most two decimals, between 0 and 100. */
export function parsePercent(text: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  const bp = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : NaN;
  if (!(bp <= FULL_PERCENT_BP)) {
    throw new MoneyValidationError(
      'invalid_percent',
      'Enter a percentage like 33.33, at most two decimals',
      { text },
    );
  }
  return bp;
}

/** 123456 → "$1,234.56", -3334 → "-$33.34". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Shares

export function validateAmountCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > MAX_AMOUNT_CENTS) {
    throw new MoneyValidationError(
      'invalid_amount',
      'Amount must be between $0.01 and $10,000,000.00',
      { amountCents },
    );
  }
}

/**
 * Splits an expense into per-member shares that sum exactly to the amount.
 * Result is sorted by member id (member order).
 */
export function computeShares(input: {
  amountCents: number;
  paidBy: number;
  split: Split;
}): Share[] {
  const { amountCents, paidBy, split } = input;
  validateAmountCents(amountCents);
  const entries = validateEntries(split);

  switch (split.type) {
    case 'exact': {
      expectSum(entries, amountCents);
      return entries.map((e) => ({ memberId: e.memberId, shareCents: e.value! }));
    }
    case 'percent': {
      expectSum(entries, FULL_PERCENT_BP);
      return allocate(amountCents, paidBy, entries.map((e) => ({ memberId: e.memberId, weight: e.value! })));
    }
    case 'equal':
      return allocate(amountCents, paidBy, entries.map((e) => ({ memberId: e.memberId, weight: 1 })));
  }
}

function validateEntries(split: Split): SplitEntry[] {
  if (!['equal', 'exact', 'percent'].includes(split.type)) {
    throw new MoneyValidationError('invalid_split', 'Unknown split type', { type: split.type });
  }
  if (split.entries.length === 0) {
    throw new MoneyValidationError('invalid_split', 'Pick at least one person to split with');
  }
  const seen = new Set<number>();
  for (const entry of split.entries) {
    if (!Number.isInteger(entry.memberId) || entry.memberId < 1) {
      throw new MoneyValidationError('invalid_split', 'Invalid member id', { memberId: entry.memberId });
    }
    if (seen.has(entry.memberId)) {
      throw new MoneyValidationError('invalid_split', 'A person appears twice in the split', {
        memberId: entry.memberId,
      });
    }
    seen.add(entry.memberId);

    if (split.type === 'equal') {
      if (entry.value !== undefined) {
        throw new MoneyValidationError('invalid_split', 'An equal split takes no values', {
          memberId: entry.memberId,
        });
      }
    } else if (!Number.isInteger(entry.value) || entry.value! < 1) {
      throw new MoneyValidationError('invalid_split', 'Each value must be a whole number above zero', {
        memberId: entry.memberId,
        value: entry.value,
      });
    }
  }
  return [...split.entries].sort((a, b) => a.memberId - b.memberId);
}

function expectSum(entries: SplitEntry[], expected: number): void {
  const actual = entries.reduce((sum, e) => sum + e.value!, 0);
  if (actual !== expected) {
    throw new MoneyValidationError('split_sum_mismatch', `Split adds up to ${actual}, expected ${expected}`, {
      expected,
      actual,
    });
  }
}

/**
 * Floor each share, then hand out the leftover cents one at a time by:
 * largest remainder, then the payer, then member order.
 * Entries must be sorted by member id. amount × weight stays below 2^53
 * because amount ≤ MAX_AMOUNT_CENTS and weight ≤ FULL_PERCENT_BP.
 */
function allocate(
  amountCents: number,
  paidBy: number,
  entries: { memberId: number; weight: number }[],
): Share[] {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  const rows = entries.map((e) => ({
    memberId: e.memberId,
    shareCents: Math.floor((amountCents * e.weight) / totalWeight),
    remainder: (amountCents * e.weight) % totalWeight,
  }));

  let leftover = amountCents - rows.reduce((sum, r) => sum + r.shareCents, 0);
  const order = [...rows].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      Number(b.memberId === paidBy) - Number(a.memberId === paidBy) ||
      a.memberId - b.memberId,
  );
  for (const row of order) {
    if (leftover === 0) break;
    row.shareCents += 1;
    leftover -= 1;
  }
  return rows.map(({ memberId, shareCents }) => ({ memberId, shareCents }));
}

// ---------------------------------------------------------------------------
// Balances

/** balance = total paid − total of shares. Positive means the group owes you. */
export function computeBalances(
  memberIds: number[],
  expenses: { paidBy: number; amountCents: number; shares: Share[] }[],
): Balance[] {
  const balances = new Map(memberIds.map((id) => [id, 0]));
  const add = (memberId: number, cents: number) =>
    balances.set(memberId, (balances.get(memberId) ?? 0) + cents);

  for (const expense of expenses) {
    add(expense.paidBy, expense.amountCents);
    for (const share of expense.shares) add(share.memberId, -share.shareCents);
  }
  return memberIds.map((memberId) => ({ memberId, balanceCents: balances.get(memberId)! }));
}

// ---------------------------------------------------------------------------
// Settle up

/**
 * Fewest payments = (people with a non-zero balance) − (most groups whose
 * balances cancel exactly), since a group of k people needs k − 1 payments.
 * Up to EXACT_SETTLE_UP_LIMIT people: exact search for those groups.
 * Above: greedy over everyone (at most n − 1 payments, not always minimal).
 * Deterministic: same balances, same plan.
 */
export function settleUp(balances: Balance[]): Payment[] {
  const total = balances.reduce((sum, b) => sum + b.balanceCents, 0);
  if (total !== 0) throw new Error(`Balances must sum to zero, got ${total}`);

  const people = balances
    .filter((b) => b.balanceCents !== 0)
    .sort((a, b) => a.memberId - b.memberId);
  if (people.length === 0) return [];

  const groups = people.length <= EXACT_SETTLE_UP_LIMIT ? zeroSumGroups(people) : [people];
  return groups.flatMap(greedyPayments).sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Splits people into the most groups whose balances sum to zero.
 *
 * best[mask] = most zero-sum groups we can close when the people in `mask`
 * are lined up in some order and we cut a group every time the running total
 * hits zero. Adding person i last to mask \ {i} closes one more group exactly
 * when the whole mask sums to zero. O(2^n · n).
 */
function zeroSumGroups(people: Balance[]): Balance[][] {
  const n = people.length;
  const full = (1 << n) - 1;
  const sums = new Array<number>(full + 1).fill(0);
  const best = new Array<number>(full + 1).fill(0);

  for (let mask = 1; mask <= full; mask++) {
    const lowest = 31 - Math.clz32(mask & -mask);
    sums[mask] = sums[mask & (mask - 1)]! + people[lowest]!.balanceCents;

    let most = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) most = Math.max(most, best[mask ^ (1 << i)]!);
    }
    best[mask] = most + (sums[mask] === 0 ? 1 : 0);
  }

  // Walk back from the full set, always removing the lowest member index that
  // keeps the optimum. That rebuilds the line-up back to front.
  const lineUp: Balance[] = [];
  for (let mask = full; mask !== 0; ) {
    const closes = sums[mask] === 0 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const bit = 1 << i;
      if (mask & bit && best[mask ^ bit]! + closes === best[mask]) {
        lineUp.unshift(people[i]!);
        mask ^= bit;
        break;
      }
    }
  }

  const groups: Balance[][] = [];
  let current: Balance[] = [];
  let running = 0;
  for (const person of lineUp) {
    current.push(person);
    running += person.balanceCents;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/**
 * Largest debtor pays largest creditor the smaller of the two amounts, repeat.
 * Ties go to member order. Each payment zeroes at least one person, so a
 * group of k people needs at most k − 1 payments.
 */
function greedyPayments(group: Balance[]): Payment[] {
  const left = [...group]
    .sort((a, b) => a.memberId - b.memberId)
    .map((b) => ({ ...b }));
  const payments: Payment[] = [];

  for (;;) {
    let debtor: Balance | undefined;
    let creditor: Balance | undefined;
    for (const b of left) {
      if (b.balanceCents < 0 && (!debtor || b.balanceCents < debtor.balanceCents)) debtor = b;
      if (b.balanceCents > 0 && (!creditor || b.balanceCents > creditor.balanceCents)) creditor = b;
    }
    if (!debtor || !creditor) return payments;

    const amountCents = Math.min(-debtor.balanceCents, creditor.balanceCents);
    payments.push({ from: debtor.memberId, to: creditor.memberId, amountCents });
    debtor.balanceCents += amountCents;
    creditor.balanceCents -= amountCents;
  }
}
