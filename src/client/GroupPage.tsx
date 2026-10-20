import { useState } from 'react';
import { formatCents } from '../shared/money';
import type { Expense, Member } from '../shared/types';
import { RequestError, api } from './api';
import { ExpenseForm } from './ExpenseForm';
import { useGroup } from './useGroup';

const SPLIT_LABELS = { equal: 'split equally', exact: 'split by amounts', percent: 'split by %' };

export function GroupPage({ groupId }: { groupId: string }) {
  const { snapshot, error, refresh } = useGroup(groupId);
  const [editing, setEditing] = useState<Expense | 'new' | null>(null);
  const [copied, setCopied] = useState(false);

  if (!snapshot) {
    return (
      <main className="page">
        {error ? (
          <>
            <p className="error">
              {error.status === 404 ? "This group doesn't exist. Check the link." : error.message}
            </p>
            <a href="/">Start a new group</a>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </main>
    );
  }

  const { group, members, expenses, balances, settlement } = snapshot;
  const nameOf = (id: number) => members.find((m) => m.id === id)?.name ?? 'Someone';

  if (editing) {
    return (
      <ExpenseForm
        groupId={groupId}
        members={members}
        expense={editing === 'new' ? undefined : editing}
        onDone={() => {
          setEditing(null);
          void refresh();
        }}
      />
    );
  }

  async function copyLink() {
    await navigator.clipboard.writeText(location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="page with-bottom-bar">
      <header className="row spread">
        <h1>{group.name}</h1>
        <button className="secondary small" onClick={copyLink}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </header>

      <section className="card">
        <h2>Settle up</h2>
        {settlement.length === 0 ? (
          <p className="muted">Everyone is even.</p>
        ) : (
          <ul className="list">
            {settlement.map((p) => (
              <li key={`${p.from}-${p.to}`} className="row spread">
                <span>
                  <strong>{nameOf(p.from)}</strong> pays <strong>{nameOf(p.to)}</strong>
                </span>
                <span className="amount">{formatCents(p.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Balances</h2>
        <ul className="list">
          {balances.map((b) => (
            <li key={b.memberId} className="row spread">
              <span>{nameOf(b.memberId)}</span>
              <span className={b.balanceCents > 0 ? 'pos' : b.balanceCents < 0 ? 'neg' : 'muted'}>
                {b.balanceCents > 0
                  ? `gets back ${formatCents(b.balanceCents)}`
                  : b.balanceCents < 0
                    ? `owes ${formatCents(-b.balanceCents)}`
                    : 'even'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Expenses</h2>
        {expenses.length === 0 ? (
          <p className="muted">No expenses yet.</p>
        ) : (
          <ul className="list">
            {expenses.map((e) => (
              <li key={e.id}>
                <button className="expense" onClick={() => setEditing(e)}>
                  <span>
                    <span className="expense-title">{e.description}</span>
                    <span className="muted small-text">
                      {nameOf(e.paidBy)} paid, {SPLIT_LABELS[e.split.type]}
                    </span>
                  </span>
                  <span className="amount">{formatCents(e.amountCents)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Members groupId={groupId} members={members} onChange={refresh} />

      <div className="bottom-bar">
        <button onClick={() => setEditing('new')}>Add expense</button>
      </div>
    </main>
  );
}

function Members(props: { groupId: string; members: Member[]; onChange: () => Promise<void> }) {
  const { groupId, members, onChange } = props;
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setError(null);
      await onChange();
      return true;
    } catch (err) {
      setError((err as RequestError).message);
      return false;
    }
  }

  return (
    <section className="card">
      <h2>People</h2>
      <ul className="list">
        {members.map((m) =>
          renaming?.id === m.id ? (
            <li key={m.id}>
              <form
                className="row"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => api.renameMember(groupId, m.id, renaming.name))) setRenaming(null);
                }}
              >
                <input
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: m.id, name: e.target.value })}
                  autoFocus
                />
                <button type="submit" className="small">Save</button>
                <button type="button" className="secondary small" onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </form>
            </li>
          ) : (
            <li key={m.id} className="row spread">
              <span>{m.name}</span>
              <span className="row">
                <button className="link" onClick={() => setRenaming({ id: m.id, name: m.name })}>
                  Rename
                </button>
                <button className="link danger" onClick={() => run(() => api.removeMember(groupId, m.id))}>
                  Remove
                </button>
              </span>
            </li>
          ),
        )}
      </ul>
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api.addMember(groupId, newName))) setNewName('');
        }}
      >
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add a person" />
        <button type="submit" className="secondary" disabled={!newName.trim()}>
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
