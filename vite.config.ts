import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  // Sub-path hosting (e.g. GitHub Pages at /vitalis/): set VITE_BASE at build time
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true } },
  },
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@react-three')) return 'r3f';
        },
      },
    },
  },
});
