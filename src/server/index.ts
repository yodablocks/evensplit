import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app';
import { openDb } from './db';

const dbPath = process.env.EVENSPLIT_DB ?? 'data/evensplit.db';
const port = Number(process.env.PORT ?? 3000);

const app = new Hono();
app.route('/', createApp(openDb(dbPath)));
app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Not found', details: {} } }, 404));

// The built client (npm run build). Any other path gets index.html, so
// group links like /g/abc work on reload.
app.use('/*', serveStatic({ root: './dist/client' }));
app.get('*', serveStatic({ path: './dist/client/index.html' }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`evensplit on http://localhost:${info.port} (database: ${dbPath})`);
});
