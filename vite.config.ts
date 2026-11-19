import { fileURLToPath } from 'node:url';
import type { UserConfig } from 'vite';

export const clientRoot = fileURLToPath(new URL('./src/client/', import.meta.url));
export default {
  root: clientRoot,
  envPrefix: [], // No server environment variables belong in the browser bundle.
  build: {
    outDir: fileURLToPath(new URL('./dist/client/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
  },
} satisfies UserConfig;
