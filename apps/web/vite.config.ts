import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runtimePaths } from '../server/src/paths.js';

function apiPort(): number {
  const paths = runtimePaths();
  const filename = existsSync(paths.configPath)
    ? paths.configPath
    : `${paths.resourceRoot}/config/barbarian.yaml`;
  if (!existsSync(filename)) return 4142;
  const value = parse(readFileSync(filename, 'utf8')) as { server?: { port?: unknown } };
  return typeof value.server?.port === 'number' ? value.server.port : 4142;
}

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4141,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${apiPort()}` },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
