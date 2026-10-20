# evensplit: spec

evensplit keeps track of who owes whom on a shared trip. A group has members;
each expense records who paid, the amount, and how it is shared out (evenly,
in fixed amounts, or in percentages). From that, the app computes everyone's
balance and the shortest list of payments that gets everyone back to zero.

## Principles

- **Never guess with money.** Bad input is rejected with a clear error, never
  corrected silently. A conflicting edit is rejected, never silently
  overwritten.
- **The server is the only authority.** All money math lives in one pure
  TypeScript module. The client uses it for previews only; the server
  recomputes everything on save.
- **Small and finished over big and half-done.** Anything designed here but
  not built is listed under "Next".

## Scope

Must work:

- Create a group, add members by name
- Add, edit, delete expenses with the three split types
- Balances and settle-up plan
- Data survives a server restart
- Two browsers see each other's changes
- Adding an expense is fast on a phone

Not in scope: accounts and login, multiple currencies, offline use, deleting
groups.

If time runs out, cut in this order (each stays designed here and goes to
"Next"): member rename, the friendly 409 message on member removal, exact
settle-up (falls back to greedy).

## Money rules

### Amounts

- All amounts are integer cents. No floats anywhere in money logic.
- The user types an amount like `12.5` or `12.50`; it is parsed as a string
  into cents (at most two decimals). `12.505` is rejected.
- An expense amount is between 1 cent and 1,000,000,000 cents
  ($10,000,000.00), so `amount × 10000` stays a safe integer.

### Split types

Every split lists its participants. Each participant appears once and must be
a member of the group.

| Type    | User enters per participant      | Stored as          | Rule                         |
|---------|----------------------------------|--------------------|------------------------------|
| equal   | nothing (just who is in)         | weight 1           | at least one participant     |
| exact   | an amount, e.g. `30.00`          | cents              | each > 0, sum = amount       |
| percent | a percent, e.g. `33.33`          | basis points (3333)| each > 0, at most two decimals, sum = 10000 |

If exact amounts or percentages don't add up, the API returns 400 with the
actual sum. Nothing is fixed silently.

### Rounding (equal and percent)

Each participant has a weight `w` (1 for equal, basis points for percent) and
`W` is the total weight.

1. Floor each share: `floor(amount × w / W)`.
2. Remainder for sorting: `(amount × w) mod W`, compared as integers.
3. Leftover cents = amount minus the sum of floored shares. It is always less
   than the number of participants, so each person gets at most one extra cent.
4. Give leftover cents one at a time, sorted by: largest remainder first, then
   the payer, then member order (order members were added).

Shares always sum exactly to the amount. In an equal split all remainders tie,
so the payer gets the first extra cent: they chose to pay, so they absorb the
rounding, and over a trip it spreads across whoever pays.

Each expense's shares depend only on that expense. Editing one expense never
changes another.

### Balances

`balance = total paid − total of shares`, over non-deleted expenses. Positive
means the group owes you. Balances are never stored; they are always computed
from shares.

### Settle up

- Fewest payments = (people with a non-zero balance) − (most groups whose
  balances cancel exactly), because a group of k people needs k−1 payments.
- Up to 15 people with a non-zero balance: search over subsets for the most
  groups that cancel. Above 15: greedy over everyone. The README states the cap.
- Inside each group, greedy makes the payments: largest debtor pays largest
  creditor the smaller of the two amounts, repeat.
- Deterministic: subsets are checked in member order and greedy ties go by
  member order, so the same data always gives the same plan.

### Tests (written first)

- $100.00 equal over Ana, Ben, Chloé, Ana pays → 3334 / 3333 / 3333
- $100.01 equal, Ben pays → Ana 3334, Ben 3334, Chloé 3333
- $1.00 percent Ana 10.10 / Ben 45.45 / Chloé 44.45, Ana pays → 10 / 46 / 44
- $100.00 equal over Ben and Chloé only, Ana pays (not in the split) →
  Ben 5000, Chloé 5000; $100.01 → Ben 5001, Chloé 5000 (member order)
- Percentages 33.33 × 3 (sum 99.99) → rejected with the sum
- Percentage `33.333` → rejected
- Exact amounts that don't sum to the amount → rejected with the sum
- Shares always sum to the amount (over many random inputs)
- Settle-up: Ana +4, Ben +3, Chloé +2, Dan −5, Eve −4 → 3 payments, not 4
- Settle-up: all balances zero → no payments
- Settle-up with two equally good plans: Ana +5, Ben +5, Chloé −5, Dan −5 →
  always "Chloé pays Ana 5, Dan pays Ben 5"
- Deleting an expense puts balances back exactly where they were
- An edited expense's shares still sum to its new amount
- Editing or deleting an expense with a stale version → 409 with the current
  expense, and nothing changes
- Removing a member who appears only in a deleted expense → 409

## Data model (SQLite)

```
groups           id (random, unguessable), name, version, created_at
members          id, group_id, name, created_at
                 unique (group_id, name) case-insensitive
expenses         id, group_id, description, amount_cents, paid_by → members,
                 split_type (equal | exact | percent), version,
                 created_at, updated_at, deleted_at
expense_splits   expense_id → expenses, member_id → members,
                 input_value (cents, basis points, or 1 for equal),
                 share_cents
                 primary key (expense_id, member_id)
view active_expenses = expenses where deleted_at is null
```

- Member order = member id (order added).
- Names are trimmed and compared case-insensitively in the app (lowercased
  with full Unicode rules), because SQLite's `NOCASE` only folds ASCII and
  would let "Chloé" and "CHLOÉ" both exist.
- Foreign keys to members use `ON DELETE RESTRICT`, and
  `PRAGMA foreign_keys = ON` is set on every connection. A member who appears
  in any expense, deleted or not, can't be removed.
- I store both what the user entered (so the edit form shows it as typed) and
  the computed shares (so a future change to the rounding rule can't silently
  rewrite old expenses).
- Balance queries read `active_expenses`, so the deleted filter can't be
  forgotten. Integrity checks read the tables.
- Deletes are soft (`deleted_at`). For now this is a safety net; there is no
  "deleted expenses" view.
- Every write runs in one transaction that also bumps `groups.version`.

## API

JSON over HTTP under `/api`. Money in the API is always integer cents and
basis points. Errors look like `{ "error": { "code", "message", "details" } }`.

| Method | Path | Does |
|---|---|---|
| POST   | `/api/groups` | Create a group with a name and member names |
| GET    | `/api/groups/:groupId` | Everything the screen needs: group, members, active expenses with splits, balances, settle-up plan |
| GET    | `/api/groups/:groupId/version` | `{ version }`, for polling |
| POST   | `/api/groups/:groupId/members` | Add a member |
| PATCH  | `/api/groups/:groupId/members/:memberId` | Rename a member |
| DELETE | `/api/groups/:groupId/members/:memberId` | Remove a member with no history |
| POST   | `/api/groups/:groupId/expenses` | Add an expense |
| PUT    | `/api/groups/:groupId/expenses/:expenseId` | Edit an expense (sends `version`) |
| DELETE | `/api/groups/:groupId/expenses/:expenseId?version=N` | Soft-delete an expense |

Expense body:

```json
{
  "description": "Dinner",
  "amountCents": 10000,
  "paidBy": 1,
  "split": {
    "type": "percent",
    "entries": [
      { "memberId": 1, "value": 3334 },
      { "memberId": 2, "value": 3333 },
      { "memberId": 3, "value": 3333 }
    ]
  },
  "version": 3
}
```

For `equal`, entries have no `value`. `version` is only sent on edit.

Status codes:

- **400**: invalid input (missing fields, wrong types, amount out of range,
  more than two decimals, sums that don't match, duplicate participants,
  empty description). `details` says which field and why.
- **404**: unknown group, member, or expense, or a member from another group.
- **409**: duplicate member name; removing a member who has history (with how
  many expenses involve them); editing or deleting an expense whose version
  changed (with the current expense).

The server ignores any computed amounts from the client. On save it recomputes
the shares from the input with the shared money module and stores them.

## Sync between browsers

- The client checks `GET /version` every 3 seconds and when the window gets
  focus, and refetches the group only when the version changed.
- Edits and deletes use optimistic concurrency: the update only applies if the
  expense version still matches. Otherwise 409 with the current expense; the
  client shows it so the user can redo their change.

A 3-second delay is fine for trip expenses. The group version makes a later
switch to server-sent events easy.

## Screens

Mobile first. One page per group; the group link is how people join. There is
no login: anyone with the link can view and edit the group. The README names
this as a tradeoff.

1. **Start**: group name and member names (type a name, Enter, next). Create →
   go to the group page, with a "copy link" button.
2. **Group page**, top to bottom:
   - **Settle up**: "Dan pays Ana $4.00", one line per payment. Shown first,
     because that's what people open the app for.
   - **Balances**: each member with their balance, green when owed, red when
     they owe.
   - **Expenses**: newest first, showing description, amount, who paid. Tap to
     edit.
   - **Members**: add, rename, remove.
   - A fixed **Add expense** button at the bottom, in thumb reach.
3. **Expense form** (full screen on a phone):
   - Amount first, focused, with the decimal keypad.
   - Description.
   - Paid by: defaults to the last payer used on this device.
   - Split: equal by default with everyone ticked. Switch to exact or percent.
   - Live preview of each person's share, and what's left to assign
     ("$12.00 left" or "0.01% left"). Save is disabled until it adds up.
   - When editing: a Delete button. On a 409, a banner says someone else
     changed this expense and shows their version.

Fast path: Add expense → type amount → type description → Save.

## Stack

- TypeScript everywhere, one package:
  - `src/shared`: the money module (pure, no database, no HTTP)
  - `src/server`: Hono API and SQLite access
  - `src/client`: React + Vite
- SQLite through Node's built-in `node:sqlite` (no native build, no extra
  package), in a local file (no account, no cloud). It runs without a flag
  from Node 22.13. It is still marked experimental and prints one
  `ExperimentalWarning` line at startup; nothing else changes.
- Node pinned to 22 LTS with `.nvmrc` and `engines` (`>=22.13`).
- Tests: Vitest. Unit tests on the money module first, then API tests.

Fallback: if `node:sqlite` causes a real problem (for example in the test
runner), switch to `better-sqlite3`. Only the database access file changes.

## Next (designed, not built)

- Archive members: kept in history, hidden from new expenses
- Full edit history per expense
- A view of deleted expenses, with undo
- Server-sent events instead of polling
- Exact settle-up above 15 people, or a faster exact method
- Anything cut from the build, from the cut order above
