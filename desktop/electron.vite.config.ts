import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  // Keep every desktop process in ESM mode. Electron only supports ESM
  // preload scripts outside renderer sandbox mode; renderer Node integration
  // remains disabled and APIs remain behind contextBridge IPC.
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['electron'],
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },
  // Reuse the repository's canonical brand assets in the packaged renderer.
  renderer: {
    publicDir: resolve(desktopRoot, '../logo'),
    plugins: [react(), tailwindcss(), Icons({ compiler: 'jsx', autoInstall: false })],
  },
});
