// HTTP layer: checks request shapes with zod, calls the store, and maps
// errors to `{ error: { code, message, details } }`. Money rules (ranges,
// sums, rounding) are checked by the shared money module inside the store.

import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { MoneyValidationError } from '../shared/money';
import type { Db } from './db';
import { ApiError } from './errors';
import * as store from './store';

const memberName = z.string().trim().min(1, 'Required').max(50);

const groupBody = z.object({
  name: z.string().trim().min(1, 'Required').max(100),
  members: z.array(memberName).min(1, 'Add at least one person').max(50),
});

const memberBody = z.object({ name: memberName });

// Unknown keys (e.g. computed shares sent by a client) are dropped:
// the server always computes shares itself.
const expenseBody = z.object({
  description: z.string().trim().min(1, 'Required').max(100),
  amountCents: z.number().int(),
  paidBy: z.number().int().positive(),
  split: z.object({
    type: z.enum(['equal', 'exact', 'percent']),
    entries: z
      .array(
        z.object({
          memberId: z.number().int().positive(),
          value: z.number().int().optional(),
        }),
      )
      .max(100),
  }),
});

const expenseEditBody = expenseBody.extend({ version: z.number().int().positive() });

export function createApp(db: Db) {
  const app = new Hono().basePath('/api');

  app.post('/groups', async (c) => {
    const body = await readBody(c, groupBody);
    const groupId = store.createGroup(db, body.name, body.members);
    return c.json(store.getSnapshot(db, groupId), 201);
  });

  app.get('/groups/:groupId', (c) => c.json(store.getSnapshot(db, c.req.param('groupId'))));

  app.get('/groups/:groupId/version', (c) =>
    c.json({ version: store.getVersion(db, c.req.param('groupId')) }),
  );

  app.post('/groups/:groupId/members', async (c) => {
    const body = await readBody(c, memberBody);
    return c.json(store.addMember(db, c.req.param('groupId'), body.name), 201);
  });

  app.patch('/groups/:groupId/members/:memberId', async (c) => {
    const body = await readBody(c, memberBody);
    const memberId = idParam(c, 'memberId');
    return c.json(store.renameMember(db, c.req.param('groupId'), memberId, body.name));
  });

  app.delete('/groups/:groupId/members/:memberId', (c) => {
    store.removeMember(db, c.req.param('groupId'), idParam(c, 'memberId'));
    return c.body(null, 204);
  });

  app.post('/groups/:groupId/expenses', async (c) => {
    const body = await readBody(c, expenseBody);
    return c.json(store.createExpense(db, c.req.param('groupId'), body), 201);
  });

  app.put('/groups/:groupId/expenses/:expenseId', async (c) => {
    const { version, ...input } = await readBody(c, expenseEditBody);
    const expenseId = idParam(c, 'expenseId');
    return c.json(store.updateExpense(db, c.req.param('groupId'), expenseId, version, input));
  });

  app.delete('/groups/:groupId/expenses/:expenseId', (c) => {
    const version = Number(c.req.query('version'));
    if (!Number.isInteger(version) || version < 1) {
      throw new ApiError(400, 'invalid_input', 'Send the expense version as ?version=N');
    }
    store.deleteExpense(db, c.req.param('groupId'), idParam(c, 'expenseId'), version);
    return c.body(null, 204);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found', details: {} } }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError || err instanceof MoneyValidationError) {
      const status = err instanceof ApiError ? err.status : 400;
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, status);
    }
    console.error(err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong', details: {} } }, 500);
  });

  return app;
}

async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError(400, 'invalid_input', 'Some fields are missing or invalid', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function idParam(c: Context, name: string): number {
  const value = c.req.param(name) ?? '';
  if (!/^\d+$/.test(value)) throw new ApiError(404, 'not_found', 'Not found', { [name]: value });
  return Number(value);
}
