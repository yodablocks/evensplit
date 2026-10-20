# evensplit

Group expense splitter: groups, members, expenses split equally, by exact
amounts, or by percentages, with balances and a settle-up plan.
The design is in [SPEC.md](SPEC.md). Read it before changing behavior.

## Stack

- TypeScript, one package, Node 22 LTS (`.nvmrc`, `engines >=22.13`)
- `src/shared`: money module. Pure functions, no database, no HTTP.
  Imported by server and client.
- `src/server`: Hono API, SQLite via built-in `node:sqlite`
- `src/client`: React + Vite
- Tests: Vitest

## Commands

```
nvm use             # Node 22
npm install
npm start           # build the client, serve app and API on :3000
npm run dev         # API (:3000) and Vite (:5173) in watch mode
npm test            # Vitest: money module and API
npm run typecheck   # server and client
```

## Money rules

- Money is integer cents. Percentages are integer basis points
  (33.33% = 3333, total exactly 10000). No floats in money logic.
- Rounding: floor each share, then give leftover cents one at a time by
  largest remainder, then the payer, then member order. Shares always sum
  to the amount.
- The server is the only authority: it recomputes shares from the user's
  input on every save and ignores amounts sent by the client.
- Bad input is rejected with a clear error, never corrected silently.
- Balances are computed from shares, never stored. Balance queries read
  the `active_expenses` view.

## Conventions

- Money logic changes come with tests, written first.
- Every write runs in one transaction and bumps the group version.
- Edits and deletes check the expense version; a mismatch is a 409.
- Errors use `{ "error": { "code", "message", "details" } }`.
- Work on a branch with one PR per change; never push to `main`.
- One commit per logical change.
- Don't add packages without asking first.
