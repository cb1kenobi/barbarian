import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: new URL('.', import.meta.url).pathname,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4141,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4142' },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
