// All database reads and writes. Every write runs in one transaction that
// also bumps the group version, so polling clients see the change.

import { randomBytes } from 'node:crypto';
import {
  type Balance,
  type Payment,
  type Share,
  type Split,
  type SplitType,
  computeBalances,
  computeShares,
  settleUp,
} from '../shared/money';
import { type Db, transaction } from './db';
import { ApiError } from './errors';

export interface Member {
  id: number;
  name: string;
}

export interface ExpenseInput {
  description: string;
  amountCents: number;
  paidBy: number;
  split: Split;
}

export interface Expense extends ExpenseInput {
  id: number;
  shares: Share[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupSnapshot {
  group: { id: string; name: string; version: number };
  members: Member[];
  expenses: Expense[]; // newest first, deleted ones excluded
  balances: Balance[];
  settlement: Payment[];
}

interface ExpenseRow {
  id: number;
  description: string;
  amount_cents: number;
  paid_by: number;
  split_type: SplitType;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SplitRow {
  expense_id: number;
  member_id: number;
  input_value: number;
  share_cents: number;
}

/** Case-insensitive key for member names, with full Unicode rules. */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

// ---------------------------------------------------------------------------
// Groups

export function createGroup(db: Db, name: string, memberNames: string[]): string {
  const keys = new Set<string>();
  for (const memberName of memberNames) {
    if (keys.has(nameKey(memberName))) throw duplicateName(memberName);
    keys.add(nameKey(memberName));
  }

  const groupId = randomBytes(16).toString('base64url'); // 128 random bits: the link is the only access control
  transaction(db, () => {
    db.prepare('INSERT INTO groups (id, name) VALUES (?, ?)').run(groupId, name);
    const insert = db.prepare('INSERT INTO members (group_id, name, name_key) VALUES (?, ?, ?)');
    for (const memberName of memberNames) insert.run(groupId, memberName, nameKey(memberName));
  });
  return groupId;
}

export function getVersion(db: Db, groupId: string): number {
  return requireGroup(db, groupId).version;
}

export function getSnapshot(db: Db, groupId: string): GroupSnapshot {
  const group = requireGroup(db, groupId);
  const members = db
    .prepare('SELECT id, name FROM members WHERE group_id = ? ORDER BY id')
    .all(groupId) as unknown as Member[];
  const rows = db
    .prepare('SELECT * FROM active_expenses WHERE group_id = ? ORDER BY id DESC')
    .all(groupId) as unknown as ExpenseRow[];
  const splits = db
    .prepare(
      `SELECT s.* FROM expense_splits s
       JOIN active_expenses e ON e.id = s.expense_id
       WHERE e.group_id = ? ORDER BY s.member_id`,
    )
    .all(groupId) as unknown as SplitRow[];

  const expenses = rows.map((row) => toExpense(row, splits.filter((s) => s.expense_id === row.id)));
  const balances = computeBalances(
    members.map((m) => m.id),
    expenses,
  );
  return { group, members, expenses, balances, settlement: settleUp(balances) };
}

function requireGroup(db: Db, groupId: string) {
  const group = db.prepare('SELECT id, name, version FROM groups WHERE id = ?').get(groupId) as
    | { id: string; name: string; version: number }
    | undefined;
  if (!group) throw new ApiError(404, 'group_not_found', 'Group not found', { groupId });
  return group;
}

function bumpVersion(db: Db, groupId: string): void {
  db.prepare('UPDATE groups SET version = version + 1 WHERE id = ?').run(groupId);
}

// ---------------------------------------------------------------------------
// Members

export function addMember(db: Db, groupId: string, name: string): Member {
  requireGroup(db, groupId);
  return transaction(db, () => {
    ensureNameFree(db, groupId, name);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO members (group_id, name, name_key) VALUES (?, ?, ?)')
      .run(groupId, name, nameKey(name));
    bumpVersion(db, groupId);
    return { id: Number(lastInsertRowid), name };
  });
}

export function renameMember(db: Db, groupId: string, memberId: number, name: string): Member {
  requireMember(db, groupId, memberId);
  return transaction(db, () => {
    ensureNameFree(db, groupId, name, memberId);
    db.prepare('UPDATE members SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey(name), memberId);
    bumpVersion(db, groupId);
    return { id: memberId, name };
  });
}

/** Only members with no history at all, including deleted expenses. */
export function removeMember(db: Db, groupId: string, memberId: number): void {
  requireMember(db, groupId, memberId);
  transaction(db, () => {
    // Reads the table, not active_expenses: deleted expenses count too.
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM expenses e
         WHERE e.paid_by = ?
            OR EXISTS (SELECT 1 FROM expense_splits s WHERE s.expense_id = e.id AND s.member_id = ?)`,
      )
      .get(memberId, memberId) as { count: number };
    if (count > 0) {
      throw new ApiError(
        409,
        'member_has_expenses',
        `This person is in ${count} expense${count === 1 ? '' : 's'} and can't be removed`,
        { expenseCount: count },
      );
    }
    db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
    bumpVersion(db, groupId);
  });
}

function requireMember(db: Db, groupId: string, memberId: number): void {
  const found = db.prepare('SELECT 1 FROM members WHERE id = ? AND group_id = ?').get(memberId, groupId);
  if (!found) {
    requireGroup(db, groupId);
    throw new ApiError(404, 'member_not_found', 'Member not found in this group', { memberId });
  }
}

function ensureNameFree(db: Db, groupId: string, name: string, exceptMemberId = 0): void {
  const taken = db
    .prepare('SELECT 1 FROM members WHERE group_id = ? AND name_key = ? AND id != ?')
    .get(groupId, nameKey(name), exceptMemberId);
  if (taken) throw duplicateName(name);
}

function duplicateName(name: string): ApiError {
  return new ApiError(409, 'duplicate_name', `There is already someone called ${name}`, { name });
}

// ---------------------------------------------------------------------------
// Expenses

export function createExpense(db: Db, groupId: string, input: ExpenseInput): Expense {
  const shares = validateExpense(db, groupId, input);
  const expenseId = transaction(db, () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO expenses (group_id, description, amount_cents, paid_by, split_type)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(groupId, input.description, input.amountCents, input.paidBy, input.split.type);
    const id = Number(lastInsertRowid);
    insertSplits(db, id, input.split, shares);
    bumpVersion(db, groupId);
    return id;
  });
  return getExpense(db, expenseId)!;
}

/** Applies only if `version` still matches; otherwise 409 with the current expense. */
export function updateExpense(
  db: Db,
  groupId: string,
  expenseId: number,
  version: number,
  input: ExpenseInput,
): Expense {
  const shares = validateExpense(db, groupId, input);
  transaction(db, () => {
    requireCurrentVersion(db, groupId, expenseId, version);
    db.prepare(
      `UPDATE expenses
       SET description = ?, amount_cents = ?, paid_by = ?, split_type = ?,
           version = version + 1, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(input.description, input.amountCents, input.paidBy, input.split.type, expenseId);
    db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expenseId);
    insertSplits(db, expenseId, input.split, shares);
    bumpVersion(db, groupId);
  });
  return getExpense(db, expenseId)!;
}

/** Soft delete. Applies only if `version` still matches. */
export function deleteExpense(db: Db, groupId: string, expenseId: number, version: number): void {
  requireGroup(db, groupId);
  transaction(db, () => {
    requireCurrentVersion(db, groupId, expenseId, version);
    db.prepare(
      `UPDATE expenses SET deleted_at = datetime('now'), version = version + 1 WHERE id = ?`,
    ).run(expenseId);
    bumpVersion(db, groupId);
  });
}

/** Checks the people exist in this group, then computes shares (400 on bad money input). */
function validateExpense(db: Db, groupId: string, input: ExpenseInput): Share[] {
  requireMember(db, groupId, input.paidBy);
  for (const entry of input.split.entries) requireMember(db, groupId, entry.memberId);
  return computeShares(input);
}

function requireCurrentVersion(db: Db, groupId: string, expenseId: number, version: number): void {
  const row = db
    .prepare('SELECT version FROM active_expenses WHERE id = ? AND group_id = ?')
    .get(expenseId, groupId) as { version: number } | undefined;
  if (!row) throw new ApiError(404, 'expense_not_found', 'Expense not found', { expenseId });
  if (row.version !== version) {
    throw new ApiError(409, 'version_conflict', 'Someone else changed this expense', {
      current: getExpense(db, expenseId),
    });
  }
}

function insertSplits(db: Db, expenseId: number, split: Split, shares: Share[]): void {
  const insert = db.prepare(
    'INSERT INTO expense_splits (expense_id, member_id, input_value, share_cents) VALUES (?, ?, ?, ?)',
  );
  const inputs = new Map(split.entries.map((e) => [e.memberId, e.value ?? 1]));
  for (const share of shares) insert.run(expenseId, share.memberId, inputs.get(share.memberId)!, share.shareCents);
}

function getExpense(db: Db, expenseId: number): Expense | undefined {
  const row = db.prepare('SELECT * FROM active_expenses WHERE id = ?').get(expenseId) as unknown as
    | ExpenseRow
    | undefined;
  if (!row) return undefined;
  const splits = db
    .prepare('SELECT * FROM expense_splits WHERE expense_id = ? ORDER BY member_id')
    .all(expenseId) as unknown as SplitRow[];
  return toExpense(row, splits);
}

function toExpense(row: ExpenseRow, splits: SplitRow[]): Expense {
  return {
    id: row.id,
    description: row.description,
    amountCents: row.amount_cents,
    paidBy: row.paid_by,
    split: {
      type: row.split_type,
      entries: splits.map((s) =>
        row.split_type === 'equal' ? { memberId: s.member_id } : { memberId: s.member_id, value: s.input_value },
      ),
    },
    shares: splits.map((s) => ({ memberId: s.member_id, shareCents: s.share_cents })),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
