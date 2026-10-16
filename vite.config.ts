import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves the site from /showofhands/
export default defineConfig({
  base: '/showofhands/',
  build: {
    // Older phones in the audience: iOS 15 Safari and up, Android Chrome from ~2021.
    target: ['es2022', 'safari15', 'chrome96', 'firefox100'],
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
