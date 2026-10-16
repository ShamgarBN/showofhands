import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /showofhands/
export default defineConfig({
  base: '/showofhands/',
  build: {
    rollupOptions: {
      input: {
        voter: resolve(__dirname, 'index.html'),
        present: resolve(__dirname, 'present.html'),
        admin: resolve(__dirname, 'admin.html'),
        moderate: resolve(__dirname, 'moderate.html'),
      },
    },
  },
});
