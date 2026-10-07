import { defineConfig } from 'vitest/config';

const apiPort = Number(process.env.CAREGRID_API_PORT ?? 4173);
const devPort = Number(process.env.CAREGRID_DEV_PORT ?? 5173);

export default defineConfig({
  // Note: relative imports may use an explicit ".js" extension (required by the NodeNext
  // server build). Vite and Vitest resolve those specifiers to the ".ts" sources themselves.
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: devPort,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['**/*.{test,spec}.ts'],
    passWithNoTests: true,
    pool: 'forks',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    server: {
      deps: {
        external: ['better-sqlite3'],
      },
    },
  },
});
