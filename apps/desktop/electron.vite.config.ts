import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Workspace packages ship TypeScript source, so they must be bundled rather than externalized.
const workspacePackages = ['@cy-ssh/shared', '@cy-ssh/sync-core', '@cy-ssh/vault-crypto', '@cy-ssh/key-formats'];

/** Strict CSP for production builds (dev needs inline scripts for React Fast Refresh). */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    name: 'cy-csp',
    apply: 'build',
    transformIndexHtml: (html: string) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  };
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'session-host': resolve(__dirname, 'src/session-host/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads can't require() node_modules, so bundle everything except electron.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss(), cspPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
