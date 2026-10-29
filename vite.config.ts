import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { momDanceLocalApiPlugin } from './scripts/vite-local-api';

export default defineConfig({
  plugins: [vue(), momDanceLocalApiPlugin()],
  build: {
    target: 'es2019',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
});
