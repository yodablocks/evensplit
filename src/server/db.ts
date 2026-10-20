import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Member order = id (order added). AUTOINCREMENT never reuses an id.
CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL, -- lowercased in the app: SQLite NOCASE only folds ASCII
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, name_key)
);

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id     TEXT NOT NULL REFERENCES groups(id),
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_by      INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  split_type   TEXT NOT NULL CHECK (split_type IN ('equal', 'exact', 'percent')),
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at   TEXT
);

-- What the user entered (input_value) and what the server computed (share_cents).
CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id  INTEGER NOT NULL REFERENCES expenses(id),
  member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  input_value INTEGER NOT NULL, -- cents (exact), basis points (percent), 1 (equal)
  share_cents INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

-- Balance queries read this view, so the deleted filter can't be forgotten.
CREATE VIEW IF NOT EXISTS active_expenses AS
  SELECT * FROM expenses WHERE deleted_at IS NULL;
`;

/** Opens (and creates if needed) the database. Use ':memory:' in tests. */
export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn in one transaction: all of it is saved, or none of it. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
