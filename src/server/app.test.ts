import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExpenseInput, GroupSnapshot } from './store';
import { createApp } from './app';
import { openDb } from './db';

type App = ReturnType<typeof createApp>;

let app: App;

beforeEach(() => {
  app = createApp(openDb(':memory:'));
});

async function call(method: string, path: string, body?: unknown, target: App = app) {
  const res = await target.request(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function createGroup(members = ['Ana', 'Ben', 'Chloé'], target: App = app) {
  const res = await call('POST', '/groups', { name: 'Lisbon', members }, target);
  expect(res.status).toBe(201);
  const snapshot = res.body as GroupSnapshot;
  const id = (name: string) => snapshot.members.find((m) => m.name === name)!.id;
  return { groupId: snapshot.group.id, id, snapshot };
}

function equalExpense(amountCents: number, paidBy: number, memberIds: number[]): ExpenseInput {
  return {
    description: 'Dinner',
    amountCents,
    paidBy,
    split: { type: 'equal', entries: memberIds.map((memberId) => ({ memberId })) },
  };
}

async function snapshot(groupId: string, target: App = app): Promise<GroupSnapshot> {
  return (await call('GET', `/groups/${groupId}`, undefined, target)).body;
}

describe('groups', () => {
  it('creates a group with members in the order given', async () => {
    const { snapshot } = await createGroup();
    expect(snapshot.group.name).toBe('Lisbon');
    expect(snapshot.members.map((m) => m.name)).toEqual(['Ana', 'Ben', 'Chloé']);
    expect(snapshot.expenses).toEqual([]);
    expect(snapshot.settlement).toEqual([]);
  });

  it('rejects an empty name and no members, with field details', async () => {
    const res = await call('POST', '/groups', { name: '  ', members: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(['name', 'members']);
  });

  it('rejects names that only differ by case, including accents', async () => {
    const res = await call('POST', '/groups', { name: 'Lisbon', members: ['Chloé', 'CHLOÉ'] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate_name');
  });

  it('rejects malformed JSON', async () => {
    const res = await call('POST', '/groups', '{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('returns 404 for an unknown group', async () => {
    const res = await call('GET', '/groups/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('group_not_found');
  });
});

describe('expenses and balances', () => {
  it('$100 split three ways, Ana pays: balances and settle-up', async () => {
    const { groupId, id } = await createGroup();
    const res = await call(
      'POST',
      `/groups/${groupId}/expenses`,
      equalExpense(10000, id('Ana'), [id('Ana'), id('Ben'), id('Chloé')]),
    );
    expect(res.status).toBe(201);
    expect(res.body.shares.map((s: { shareCents: number }) => s.shareCents)).toEqual([3334, 3333, 3333]);

    const snap = await snapshot(groupId);
    expect(snap.balances.map((b) => b.balanceCents)).toEqual([6666, -3333, -3333]);
    expect(snap.settlement).toEqual([
      { from: id('Ben'), to: id('Ana'), amountCents: 3333 },
      { from: id('Chloé'), to: id('Ana'), amountCents: 3333 },
    ]);
  });

  it('stores what the user entered for percentages, and ignores client-computed shares', async () => {
    const { groupId, id } = await createGroup();
    const res = await call('POST', `/groups/${groupId}/expenses`, {
      description: 'Hotel',
      amountCents: 100,
      paidBy: id('Ana'),
      split: {
        type: 'percent',
        entries: [
          { memberId: id('Ana'), value: 1010, shareCents: 99 },
          { memberId: id('Ben'), value: 4545, shareCents: 1 },
          { memberId: id('Chloé'), value: 4445, shareCents: 0 },
        ],
      },
      shares: [{ memberId: id('Ana'), shareCents: 100 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.split.entries.map((e: { value: number }) => e.value)).toEqual([1010, 4545, 4445]);
    expect(res.body.shares.map((s: { shareCents: number }) => s.shareCents)).toEqual([10, 46, 44]);
  });

  it('rejects percentages that sum to 99.99, with the actual sum', async () => {
    const { groupId, id } = await createGroup();
    const res = await call('POST', `/groups/${groupId}/expenses`, {
      description: 'Hotel',
      amountCents: 10000,
      paidBy: id('Ana'),
      split: {
        type: 'percent',
        entries: [id('Ana'), id('Ben'), id('Chloé')].map((memberId) => ({ memberId, value: 3333 })),
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'split_sum_mismatch',
      details: { expected: 10000, actual: 9999 },
    });
  });

  it('rejects bad amounts and wrong types', async () => {
    const { groupId, id } = await createGroup();
    const zero = await call('POST', `/groups/${groupId}/expenses`, equalExpense(0, id('Ana'), [id('Ana')]));
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('invalid_amount');

    const asText = await call('POST', `/groups/${groupId}/expenses`, {
      ...equalExpense(100, id('Ana'), [id('Ana')]),
      amountCents: '100',
    });
    expect(asText.status).toBe(400);
    expect(asText.body.error.code).toBe('invalid_input');

    const noDescription = await call('POST', `/groups/${groupId}/expenses`, {
      ...equalExpense(100, id('Ana'), [id('Ana')]),
      description: ' ',
    });
    expect(noDescription.status).toBe(400);
  });

  it('returns 404 for a member from another group', async () => {
    const lisbon = await createGroup();
    const porto = await createGroup(['Dan']);
    const res = await call(
      'POST',
      `/groups/${lisbon.groupId}/expenses`,
      equalExpense(100, lisbon.id('Ana'), [lisbon.id('Ana'), porto.id('Dan')]),
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('member_not_found');
    expect((await snapshot(lisbon.groupId)).expenses).toEqual([]);
  });
});

describe('editing and deleting', () => {
  async function groupWithExpense() {
    const group = await createGroup();
    const created = await call(
      'POST',
      `/groups/${group.groupId}/expenses`,
      equalExpense(10000, group.id('Ana'), [group.id('Ana'), group.id('Ben'), group.id('Chloé')]),
    );
    return { ...group, expense: created.body };
  }

  it('an edit recomputes only that expense and bumps both versions', async () => {
    const { groupId, id, expense } = await groupWithExpense();
    const before = await snapshot(groupId);

    const res = await call('PUT', `/groups/${groupId}/expenses/${expense.id}`, {
      ...equalExpense(3000, id('Ben'), [id('Ben'), id('Chloé')]),
      version: expense.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(expense.version + 1);
    expect(res.body.shares).toEqual([
      { memberId: id('Ben'), shareCents: 1500 },
      { memberId: id('Chloé'), shareCents: 1500 },
    ]);

    const after = await snapshot(groupId);
    expect(after.group.version).toBe(before.group.version + 1);
    expect(after.balances.map((b) => b.balanceCents)).toEqual([0, 1500, -1500]);
  });

  it('editing with a stale version returns 409 with the current expense, and changes nothing', async () => {
    const { groupId, id, expense } = await groupWithExpense();
    const edit = { ...equalExpense(5000, id('Ana'), [id('Ana'), id('Ben')]), version: expense.version };
    expect((await call('PUT', `/groups/${groupId}/expenses/${expense.id}`, edit)).status).toBe(200);
    const before = await snapshot(groupId);

    const stale = await call('PUT', `/groups/${groupId}/expenses/${expense.id}`, {
      ...equalExpense(9999, id('Chloé'), [id('Chloé')]),
      version: expense.version,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(stale.body.error.details.current.amountCents).toBe(5000);
    expect(await snapshot(groupId)).toEqual(before);
  });

  it('deleting with a stale version returns 409, and changes nothing', async () => {
    const { groupId, id, expense } = await groupWithExpense();
    await call('PUT', `/groups/${groupId}/expenses/${expense.id}`, {
      ...equalExpense(5000, id('Ana'), [id('Ana'), id('Ben')]),
      version: expense.version,
    });
    const before = await snapshot(groupId);

    const stale = await call('DELETE', `/groups/${groupId}/expenses/${expense.id}?version=${expense.version}`);
    expect(stale.status).toBe(409);
    expect(await snapshot(groupId)).toEqual(before);
  });

  it('deleting puts balances back exactly where they were', async () => {
    const { groupId, id } = await createGroup();
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(3000, id('Ben'), [id('Ben'), id('Chloé')]));
    const before = await snapshot(groupId);

    const added = await call(
      'POST',
      `/groups/${groupId}/expenses`,
      equalExpense(10001, id('Chloé'), [id('Ana'), id('Ben'), id('Chloé')]),
    );
    const del = await call('DELETE', `/groups/${groupId}/expenses/${added.body.id}?version=${added.body.version}`);
    expect(del.status).toBe(204);

    const after = await snapshot(groupId);
    expect(after.balances).toEqual(before.balances);
    expect(after.settlement).toEqual(before.settlement);
    expect(after.expenses).toEqual(before.expenses);
  });

  it('a deleted expense can no longer be edited', async () => {
    const { groupId, id, expense } = await groupWithExpense();
    await call('DELETE', `/groups/${groupId}/expenses/${expense.id}?version=${expense.version}`);
    const res = await call('PUT', `/groups/${groupId}/expenses/${expense.id}`, {
      ...equalExpense(100, id('Ana'), [id('Ana')]),
      version: expense.version + 1,
    });
    expect(res.status).toBe(404);
  });

  it('delete without a version is rejected', async () => {
    const { groupId, expense } = await groupWithExpense();
    expect((await call('DELETE', `/groups/${groupId}/expenses/${expense.id}`)).status).toBe(400);
  });
});

describe('members', () => {
  it('adds and renames a member; a rename changes no history', async () => {
    const { groupId, id } = await createGroup(['Ana', 'Ben']);
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(1000, id('Ana'), [id('Ana'), id('Ben')]));
    const before = await snapshot(groupId);

    expect((await call('POST', `/groups/${groupId}/members`, { name: 'Dan' })).status).toBe(201);
    const renamed = await call('PATCH', `/groups/${groupId}/members/${id('Ben')}`, { name: 'Benjamin' });
    expect(renamed.status).toBe(200);

    const after = await snapshot(groupId);
    expect(after.members.map((m) => m.name)).toEqual(['Ana', 'Benjamin', 'Dan']);
    expect(after.expenses).toEqual(before.expenses);
  });

  it('rejects a duplicate name, case-insensitively', async () => {
    const { groupId, id } = await createGroup();
    expect((await call('POST', `/groups/${groupId}/members`, { name: 'CHLOÉ' })).status).toBe(409);
    expect((await call('PATCH', `/groups/${groupId}/members/${id('Ana')}`, { name: 'ben' })).status).toBe(409);
    // Renaming to your own name with different case is fine.
    expect((await call('PATCH', `/groups/${groupId}/members/${id('Ana')}`, { name: 'ANA' })).status).toBe(200);
  });

  it('removes a member with no history', async () => {
    const { groupId, id } = await createGroup();
    expect((await call('DELETE', `/groups/${groupId}/members/${id('Chloé')}`)).status).toBe(204);
    expect((await snapshot(groupId)).members.map((m) => m.name)).toEqual(['Ana', 'Ben']);
  });

  it('refuses to remove a member with history, and says how many expenses', async () => {
    const { groupId, id } = await createGroup();
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(100, id('Ana'), [id('Ana'), id('Ben')]));
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(100, id('Ben'), [id('Ana')]));
    const res = await call('DELETE', `/groups/${groupId}/members/${id('Ben')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'member_has_expenses', details: { expenseCount: 2 } });
  });

  it('refuses to remove a member who only appears in a deleted expense', async () => {
    const { groupId, id } = await createGroup();
    const added = await call('POST', `/groups/${groupId}/expenses`, equalExpense(100, id('Ana'), [id('Chloé')]));
    await call('DELETE', `/groups/${groupId}/expenses/${added.body.id}?version=${added.body.version}`);
    const res = await call('DELETE', `/groups/${groupId}/members/${id('Chloé')}`);
    expect(res.status).toBe(409);
    expect(res.body.error.details.expenseCount).toBe(1);
  });
});

describe('sync and persistence', () => {
  it('the version changes on every write, so polling clients refetch', async () => {
    const { groupId, id } = await createGroup();
    const v = async () => (await call('GET', `/groups/${groupId}/version`)).body.version;
    const v1 = await v();
    await call('POST', `/groups/${groupId}/members`, { name: 'Dan' });
    const v2 = await v();
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(100, id('Ana'), [id('Ana')]));
    const v3 = await v();
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
  });

  it('a failed write does not bump the version', async () => {
    const { groupId, id } = await createGroup();
    const before = (await call('GET', `/groups/${groupId}/version`)).body.version;
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(0, id('Ana'), [id('Ana')]));
    await call('POST', `/groups/${groupId}/members`, { name: 'ana' });
    expect((await call('GET', `/groups/${groupId}/version`)).body.version).toBe(before);
  });

  it('data survives a restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'evensplit-')), 'test.db');
    const first = createApp(openDb(path));
    const { groupId, id } = await createGroup(['Ana', 'Ben'], first);
    await call('POST', `/groups/${groupId}/expenses`, equalExpense(1000, id('Ana'), [id('Ana'), id('Ben')]), first);
    const before = await snapshot(groupId, first);

    const second = createApp(openDb(path));
    expect(await snapshot(groupId, second)).toEqual(before);
  });
});
