import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  // In dev, Vite serves the client and forwards API calls to the server.
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
