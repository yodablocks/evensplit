// Shapes the API sends and receives, shared by server and client.

import type { Balance, Payment, Share, Split } from './money';

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
