# evensplit

Split shared trip costs with friends. Create a group, add people by name, log
who paid what and how it's shared (equally, exact amounts, or percentages).
The app shows everyone's balance and the fewest payments that settle all
debts. Open the same group link on two devices and each sees the other's
changes within a few seconds.

## Run it

Needs Node 22.13 or newer (`.nvmrc` pins 22).

```
nvm use
npm install
npm start
```

Open http://localhost:3000. `npm start` builds the client and serves the app
and the API on one port. Data goes to `data/evensplit.db` (SQLite), so it
survives restarts.

Other commands:

```
npm test            # 56 tests: money module and API
npm run typecheck   # server and client
npm run dev         # API on :3000 and Vite on :5173 with hot reload
```

- To try it on a phone, use `http://<your-computer-ip>:3000` on the same Wi-Fi.
  On macOS, allow incoming connections for `node` if asked.
- `PORT` and `EVENSPLIT_DB` change the port and the database file.
- On startup Node prints one `ExperimentalWarning` about SQLite. That's
  expected: the app uses Node's built-in `node:sqlite`, so there's no native
  package to compile.

## Design decisions

The full design is in [SPEC.md](SPEC.md). The main decisions:

### Money

- **Integer cents everywhere.** Percentages are integer basis points
  (33.33% = 3333, total exactly 10000). Typed amounts are parsed from text,
  never through floats, and more than two decimals is an error.
- **Rounding.** Each share is rounded down, then the leftover cents go one at
  a time by largest remainder, then to the payer, then by the order members
  were added. Shares always sum exactly to the amount, and every share is
  within one cent of its exact value. $100 split three ways is
  33.34 / 33.33 / 33.33, and the extra cent goes to whoever paid: they chose
  to pay, and over a trip it spreads across whoever pays instead of always
  landing on the first person in the group.
- **Never guess.** Percentages that sum to 99.99, or exact amounts that don't
  match the total, are rejected with a 400 that includes the actual sum. The
  form shows "0.01% left to assign" live, so this rarely reaches the server.
- **Settle up uses the fewest payments, not just a short list.** Fewest
  payments = people with a non-zero balance minus the most groups whose
  balances cancel out exactly. A subset search finds those groups (instant up
  to 15 people with a non-zero balance), and greedy makes the payments inside
  each group. Plain greedy isn't always minimal: for +4, +3, +2, −5, −4 it
  makes 4 payments where 3 are enough, and that case is a test. Above
  15 people it falls back to greedy (at most n − 1 payments). The plan is
  deterministic: same balances, same plan.

### Where the calculation lives

All money logic is one pure module, `src/shared/money.ts`, with no database
and no HTTP. The server is the only authority: on every save it recomputes
the shares from what the user entered and ignores anything the client
computed. The client imports the same module only to preview shares as you
type, so the preview and the saved result come from the same function.

### Data model

- `groups`, `members`, `expenses`, `expense_splits` in SQLite.
- Each split row stores what the user entered (`input_value`: cents, basis
  points, or 1 for equal) and the computed `share_cents`. The edit form shows
  what was typed, and a future change to the rounding rule can't silently
  rewrite old expenses.
- Balances are never stored. They're summed from shares, so they can't drift.
- An edit recomputes only that expense, in one transaction. Nothing else
  moves.
- Deletes are soft (`deleted_at`). Balance queries read an `active_expenses`
  view, so the "not deleted" filter can't be forgotten.
- Expenses reference members by id, so renaming changes no history. A member
  can only be removed if they appear in no expense, deleted ones included.
  Foreign keys enforce that, and the API returns a 409 saying how many
  expenses involve them.
- Member names are unique per group, case-insensitive with full Unicode rules
  ("Chloé" and "CHLOÉ" clash). SQLite's `NOCASE` only folds ASCII, so the app
  stores a lowercased key.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/groups` | Create a group with its members |
| GET | `/api/groups/:id` | Everything the page needs: members, expenses, balances, settle-up |
| GET | `/api/groups/:id/version` | For polling |
| POST / PATCH / DELETE | `/api/groups/:id/members[/:memberId]` | Add, rename, remove |
| POST / PUT / DELETE | `/api/groups/:id/expenses[/:expenseId]` | Add, edit, delete |

- Money on the wire is integer cents and basis points.
- Errors are always `{ "error": { "code", "message", "details" } }`:
  - 400 for bad input, with the failing fields
  - 404 for unknown ids, including a member from another group
  - 409 for a duplicate name, a member with history, or a stale version
- Request shapes are checked with zod and money rules by the money module.

### Two devices

- **Seeing changes:** every write bumps a group version in the same
  transaction. The client checks the version every 3 seconds (while the tab
  is visible) and on focus, and refetches only when it changed.
- **Editing at the same time:** edits and deletes send the expense version.
  If someone else changed it first, the API returns 409 with their version,
  and the form shows it with a banner so you can redo your change. Nothing
  is silently overwritten.

### Frontend

The form is built for one hand on a phone:
- The amount is first, focused, with the decimal keypad.
- Paid by is one tap and defaults to the last payer on that device.
- Equal split with everyone is the default.
- The description is optional.
- So the fast path is: Add expense, type the amount, Save.

On the group page, the settle-up plan comes first ("Ben pays Ana $33.33"),
then balances in green or red.

## Tradeoffs and known limits

- **Access is link-only.** There are no accounts: anyone with the group link
  can view and edit. Group ids are 128 random bits, so they can't be guessed.
  - No rate limiting.
  - No request size limit.
  - A link can't be revoked.
- **Polling, not push.** Changes show up within about 3 seconds.
- **Soft delete is only a safety net.** There's no "deleted expenses" view
  and no undo yet.
- **No edit history.** An edit replaces the expense; only the version number
  shows it changed.
- **One currency**, shown as `$`.
- **The client has no automated tests.** It was tested by hand: two browser
  sessions at phone size, then a real iPhone and a laptop over Wi-Fi. The
  money math it shows comes from the tested shared module.
- **One server process with a SQLite file.** That's fine for friends on a
  trip; it isn't built to scale out.

## What's next

- Archive members: keep them in history, hide them from new expenses.
- Edit history per expense, and a deleted-expenses view with undo.
- Server-sent events instead of polling; the group version already supports
  it.
- Rate limiting, a request size limit, and revocable share links.
- Component tests for the expense form.
- Exact settle-up above 15 people with a faster method.

## Project layout

```
src/shared/money.ts   money logic (pure, tested)
src/shared/types.ts   API shapes shared by server and client
src/server/           Hono API, SQLite schema and queries, API tests
src/client/           React + Vite, mobile first
SPEC.md               the design, written before any code
CLAUDE.md             conventions for working in this repo with an AI assistant
```

## Timeline

All times on 2026-10-20 (UTC+8).

- **Design: DESIGN_TIME_TODO.** I worked out the design in a question-and-answer
  session with Claude, then wrote SPEC.md. The spec was the first commit
  (10:26), followed by CLAUDE.md (PR #1).
- **Build: 10:36 to 10:56, about 20 minutes.** Money logic and tests
  (PR #2), API (PR #3) and frontend (PR #4). I reviewed and merged each PR
  before the next branch started. My review time is included.
- **Phone test and fixes: 10:56 to 11:26, about 30 minutes.** I tested on an
  iPhone and a laptop over Wi-Fi and found three issues, which were fixed in
  PR #4 before I merged it.
- **README:** after the build.

The money logic was written test-first. The API tests were written right
after the API code, not before.

## How I worked with Claude

I used Claude Code for the whole project. How the work was split:
- **Design was mine.** Claude asked one question at a time, challenged each
  answer, then wrote SPEC.md from my answers. I reviewed every line before
  the first commit.
- **Claude wrote the code**, on one branch and pull request per layer
  (money, API, frontend, README). I reviewed and merged each PR myself.
- **I installed every package myself.** Claude proposed each one and said
  why.
- **I kept a log of what went wrong and who caught it.** These are the
  entries:

**Where the challenges changed my design**

- My first tie-break gave the extra cent to whoever was added first. Claude
  pointed out that this means the same person loses a cent on every equal
  split for the whole trip, so I changed it to the payer.
- I planned greedy settle-up and documented it as "near-optimal". Claude
  argued that if someone tries my own counterexample, the app shows 4
  payments where 3 were possible, so I switched to the exact search with a
  greedy fallback.
- I had optimistic concurrency near the top of my cut list. Claude noted that
  cutting it would mean "last write wins", the silent overwrite I had argued
  against, and that it's about 10 lines, so I moved it down.
- Claude pointed out that a removal check against active expenses only would
  let me remove someone who's in a deleted expense. I made it a foreign-key
  rule over all expenses.

**Mistakes by Claude, caught by Claude**

- While playing back my rounding rule, Claude reversed its order (payer
  before largest remainder). I accepted the reversed version and repeated
  it. Claude caught it one turn later with an example where the two orders
  give different cents, and my original order went into the spec.
- The first money tests all passed, so Claude broke each rule on purpose to
  see whether a test would fail. Removing the payer tie-break only failed
  one edge case, because the spec examples didn't tell the rules apart.
  Claude added a test where the payer is last in member order.
- The first "survives a restart" check was invalid: the old server was still
  running and answered the request. Claude saw this in the server logs and
  redid the check properly.
- "Copy link" assumed the clipboard works everywhere, but it's blocked on
  plain http, such as a phone on Wi-Fi. Claude added a fallback that shows
  the link.
- While retesting my fixes, a tap on "Remove" landed on the fixed
  "Add expense" bar. Claude added scroll padding so content stays clear of
  the bar.
- There were also small slips: a shell variable that's reserved in zsh, and a
  client tsconfig that checked no files. The type checker and the shell
  caught those.

**Other catches**

- An automated security review flagged 72-bit group ids as too weak for
  link-only access. Raised to 128 bits.
- Claude noticed that the Node types I installed were version 26 while the
  app runs on Node 22. I pinned `@types/node@22`.

**Caught by me in manual testing on a phone**

- The form required a description. Saving with just an amount should work,
  so an empty description now becomes "Expense".
- The "can't be removed" message showed far from the person, without their
  name, and still said "3 expenses" after I added a fourth. It now shows
  under that person's row and clears when the data refreshes.
- A link I pasted started with an invisible zero-width space. Claude checked
  the source, the build and the actual value of the share field, and none of
  them contain one. It most likely came from outside the app, but that's not
  confirmed.
