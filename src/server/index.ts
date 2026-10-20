import { serve } from '@hono/node-server';
import { createApp } from './app';
import { openDb } from './db';

const dbPath = process.env.EVENSPLIT_DB ?? 'data/evensplit.db';
const port = Number(process.env.PORT ?? 3000);

const app = createApp(openDb(dbPath));
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`evensplit API on http://localhost:${info.port} (database: ${dbPath})`);
});
