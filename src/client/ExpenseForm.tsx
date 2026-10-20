import { type FormEvent, useState } from 'react';
import {
  FULL_PERCENT_BP,
  type SplitEntry,
  type SplitType,
  computeShares,
  formatCents,
  parseAmount,
  parsePercent,
} from '../shared/money';
import type { Expense, ExpenseInput, Member } from '../shared/types';
import { RequestError, api } from './api';
import { bpToInput, centsToInput } from './format';

interface FormState {
  amount: string;
  description: string;
  paidBy: number;
  type: SplitType;
  included: number[]; // equal split: who is in
  values: Record<number, string>; // exact or percent: what each person typed
}

const lastPayerKey = (groupId: string) => `evensplit:lastPayer:${groupId}`;
const DEFAULT_DESCRIPTION = 'Expense';

function initialState(groupId: string, members: Member[], expense?: Expense): FormState {
  if (expense) {
    const { type, entries } = expense.split;
    return {
      amount: centsToInput(expense.amountCents),
      description: expense.description,
      paidBy: expense.paidBy,
      type,
      included: type === 'equal' ? entries.map((e) => e.memberId) : members.map((m) => m.id),
      values:
        type === 'equal'
          ? {}
          : Object.fromEntries(
              entries.map((e) => [e.memberId, type === 'exact' ? centsToInput(e.value!) : bpToInput(e.value!)]),
            ),
    };
  }
  // Paid by defaults to the last payer used on this device.
  const lastPayer = Number(localStorage.getItem(lastPayerKey(groupId)));
  return {
    amount: '',
    description: '',
    paidBy: members.some((m) => m.id === lastPayer) ? lastPayer : members[0]!.id,
    type: 'equal',
    included: members.map((m) => m.id),
    values: {},
  };
}

function tryParse(parse: (text: string) => number, text: string): number | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/**
 * Live preview with the same money module the server uses. The server still
 * recomputes everything on save; this only tells the user what will happen.
 */
function preview(form: FormState, members: Member[]) {
  const shares = new Map<number, number>();
  const badValues = new Set<number>();
  const amountCents = tryParse(parseAmount, form.amount);

  let entries: SplitEntry[];
  if (form.type === 'equal') {
    entries = members.filter((m) => form.included.includes(m.id)).map((m) => ({ memberId: m.id }));
  } else {
    const parse = form.type === 'exact' ? parseAmount : parsePercent;
    entries = [];
    for (const m of members) {
      const text = form.values[m.id]?.trim();
      if (!text) continue;
      const value = tryParse(parse, text);
      if (value === null || value === 0) badValues.add(m.id);
      else entries.push({ memberId: m.id, value });
    }
  }

  let status = '';
  if (amountCents === null) {
    status = form.amount.trim() ? 'Amount looks wrong: use a format like 12.50' : 'Enter an amount';
  } else if (badValues.size > 0) {
    status = form.type === 'exact' ? 'Use amounts like 12.50' : 'Use percentages like 33.33';
  } else if (entries.length === 0) {
    status = 'Pick at least one person';
  } else if (form.type !== 'equal') {
    const target = form.type === 'exact' ? amountCents : FULL_PERCENT_BP;
    const left = target - entries.reduce((sum, e) => sum + e.value!, 0);
    const show = (n: number) => (form.type === 'exact' ? formatCents(n) : `${bpToInput(n)}%`);
    if (left > 0) status = `${show(left)} left to assign`;
    if (left < 0) status = `${show(-left)} too much`;
  }

  let input: ExpenseInput | null = null;
  if (!status && amountCents !== null) {
    input = {
      // Saving with just an amount is the fast path; the server still requires a description.
      description: form.description.trim() || DEFAULT_DESCRIPTION,
      amountCents,
      paidBy: form.paidBy,
      split: { type: form.type, entries },
    };
    for (const s of computeShares(input)) shares.set(s.memberId, s.shareCents);
  }
  return { input, shares, badValues, status };
}

export function ExpenseForm(props: {
  groupId: string;
  members: Member[];
  expense?: Expense;
  onDone: () => void;
}) {
  const { groupId, members, onDone } = props;
  // The version we are editing from. Replaced if someone else changed it.
  const [base, setBase] = useState(props.expense);
  const [form, setForm] = useState(() => initialState(groupId, members, props.expense));
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const { input, shares, badValues, status } = preview(form, members);
  const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch });

  function handleError(err: unknown) {
    const e = err as RequestError;
    if (e.code === 'version_conflict') {
      const current = e.details.current as Expense;
      setBase(current);
      setForm(initialState(groupId, members, current));
      setNotice('Someone else changed this expense while you were editing. Their version is below; make your change again.');
      setError(null);
    } else if (e.code === 'expense_not_found') {
      setNotice('Someone else deleted this expense.');
    } else {
      setError(e.message);
    }
    setConfirmDelete(false);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!input) return;
    setBusy(true);
    try {
      if (base) await api.updateExpense(groupId, base.id, base.version, input);
      else await api.createExpense(groupId, input);
      localStorage.setItem(lastPayerKey(groupId), String(input.paidBy));
      onDone();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!base) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api.deleteExpense(groupId, base.id, base.version);
      onDone();
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page with-bottom-bar">
      <header className="row spread">
        <h1>{base ? 'Edit expense' : 'Add expense'}</h1>
        <button type="button" className="secondary small" onClick={onDone}>
          Cancel
        </button>
      </header>

      {notice && <p className="notice">{notice}</p>}

      <form id="expense-form" onSubmit={save} className="stack">
        <label>
          Amount
          <input
            className="big-input"
            value={form.amount}
            onChange={(e) => update({ amount: e.target.value })}
            inputMode="decimal"
            placeholder="0.00"
            autoFocus={!base}
            enterKeyHint="next"
          />
        </label>

        <label>
          What for
          <input
            value={form.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder={`Optional (saved as "${DEFAULT_DESCRIPTION}")`}
            maxLength={100}
            enterKeyHint="done"
          />
        </label>

        <fieldset>
          <legend>Paid by</legend>
          <div className="pills">
            {members.map((m) => (
              <button
                key={m.id}
                type="button"
                className={form.paidBy === m.id ? 'pill selected' : 'pill'}
                aria-pressed={form.paidBy === m.id}
                onClick={() => update({ paidBy: m.id })}
              >
                {m.name}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Split</legend>
          <div className="tabs">
            {(['equal', 'exact', 'percent'] as const).map((type) => (
              <button
                key={type}
                type="button"
                className={form.type === type ? 'tab selected' : 'tab'}
                aria-pressed={form.type === type}
                // Values mean different things per type (cents vs %), so start fresh.
                onClick={() => form.type !== type && update({ type, values: {} })}
              >
                {type === 'equal' ? 'Equally' : type === 'exact' ? 'Amounts' : '%'}
              </button>
            ))}
          </div>

          <ul className="list">
            {members.map((m) => (
              <li key={m.id} className="row spread">
                {form.type === 'equal' ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.included.includes(m.id)}
                      onChange={(e) =>
                        update({
                          included: e.target.checked
                            ? [...form.included, m.id]
                            : form.included.filter((id) => id !== m.id),
                        })
                      }
                    />
                    {m.name}
                  </label>
                ) : (
                  <label className="row value-row">
                    <span className="value-name">{m.name}</span>
                    <input
                      className={badValues.has(m.id) ? 'value-input invalid' : 'value-input'}
                      value={form.values[m.id] ?? ''}
                      onChange={(e) => update({ values: { ...form.values, [m.id]: e.target.value } })}
                      inputMode="decimal"
                      placeholder={form.type === 'exact' ? '0.00' : '0'}
                    />
                    {form.type === 'percent' && <span>%</span>}
                  </label>
                )}
                <span className="amount muted">
                  {shares.has(m.id) ? formatCents(shares.get(m.id)!) : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className={status ? 'status' : 'status ok'}>{status || 'Adds up'}</p>
        </fieldset>

        {error && <p className="error">{error}</p>}

        {base && (
          <button type="button" className="danger-button" onClick={remove} disabled={busy}>
            {confirmDelete ? 'Tap again to delete' : 'Delete expense'}
          </button>
        )}
      </form>

      <div className="bottom-bar">
        <button type="submit" form="expense-form" disabled={!input || busy}>
          {base ? 'Save changes' : 'Save'}
        </button>
      </div>
    </main>
  );
}
