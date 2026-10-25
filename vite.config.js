import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(here, '../..'),
  server: {
    host: '0.0.0.0', port: 4001,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
