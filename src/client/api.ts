// Thin wrappers around the HTTP API. Money is always integer cents and
// basis points on the wire.

import type { Expense, ExpenseInput, GroupSnapshot, Member } from '../shared/types';

/** An error response from the API: `{ error: { code, message, details } }`. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RequestError(0, 'offline', "Can't reach the server. Check your connection.", {});
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = json.error ?? {};
    throw new RequestError(res.status, error.code ?? 'unknown', error.message ?? 'Something went wrong', error.details ?? {});
  }
  return json as T;
}

const group = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;

export const api = {
  createGroup: (name: string, members: string[]) =>
    request<GroupSnapshot>('POST', '/groups', { name, members }),
  getGroup: (groupId: string) => request<GroupSnapshot>('GET', group(groupId)),
  getVersion: (groupId: string) => request<{ version: number }>('GET', `${group(groupId)}/version`),

  addMember: (groupId: string, name: string) =>
    request<Member>('POST', `${group(groupId)}/members`, { name }),
  renameMember: (groupId: string, memberId: number, name: string) =>
    request<Member>('PATCH', `${group(groupId)}/members/${memberId}`, { name }),
  removeMember: (groupId: string, memberId: number) =>
    request<void>('DELETE', `${group(groupId)}/members/${memberId}`),

  createExpense: (groupId: string, input: ExpenseInput) =>
    request<Expense>('POST', `${group(groupId)}/expenses`, input),
  updateExpense: (groupId: string, expenseId: number, version: number, input: ExpenseInput) =>
    request<Expense>('PUT', `${group(groupId)}/expenses/${expenseId}`, { ...input, version }),
  deleteExpense: (groupId: string, expenseId: number, version: number) =>
    request<void>('DELETE', `${group(groupId)}/expenses/${expenseId}?version=${version}`),
};
