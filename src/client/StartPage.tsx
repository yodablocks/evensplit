import { type FormEvent, useState } from 'react';
import { RequestError, api } from './api';

export function StartPage({ onCreated }: { onCreated: (groupId: string) => void }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [nextMember, setNextMember] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addMember() {
    const trimmed = nextMember.trim();
    if (!trimmed) return;
    if (members.some((m) => m.toLowerCase() === trimmed.toLowerCase())) {
      setError(`${trimmed} is already in the group`);
      return;
    }
    setMembers([...members, trimmed]);
    setNextMember('');
    setError(null);
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    // A name still in the box counts, so nobody loses the last person typed.
    const all = nextMember.trim() ? [...members, nextMember.trim()] : members;
    setBusy(true);
    try {
      const snapshot = await api.createGroup(name, all);
      onCreated(snapshot.group.id);
    } catch (err) {
      setError((err as RequestError).message);
      setBusy(false);
    }
  }

  const canCreate = name.trim() !== '' && (members.length > 0 || nextMember.trim() !== '');

  return (
    <main className="page">
      <h1>evensplit</h1>
      <p className="muted">Split trip costs with friends. No accounts: share the link.</p>

      <form onSubmit={create} className="card stack">
        <label>
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lisbon trip" autoFocus />
        </label>

        <label>
          People
          <div className="row">
            <input
              value={nextMember}
              onChange={(e) => setNextMember(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addMember();
                }
              }}
              placeholder="Name, then Enter"
              enterKeyHint="next"
            />
            <button type="button" className="secondary" onClick={addMember}>
              Add
            </button>
          </div>
        </label>

        {members.length > 0 && (
          <ul className="chips">
            {members.map((m) => (
              <li key={m}>
                {m}
                <button
                  type="button"
                  aria-label={`Remove ${m}`}
                  onClick={() => setMembers(members.filter((x) => x !== m))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={!canCreate || busy}>
          Create group
        </button>
      </form>
    </main>
  );
}
