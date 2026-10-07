import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Self-contained browser testing:
 * - a disposable SQLite file (wiped at the start of every run) is used for storage,
 * - the deterministic clinic date is pinned to 2026-10-07,
 * - the app is rebuilt and started by Playwright itself on a dedicated port, so the suite
 *   never depends on (and never reuses) a developer's running server.
 */
const port = Number(process.env.CAREGRID_E2E_PORT ?? 4183);
const host = '127.0.0.1';
const baseURL = `http://${host}:${port}`;
const today = '2026-10-07';

const dbFile = resolve(
  process.env.CAREGRID_E2E_DB_FILE ?? join('data', 'e2e', 'playwright.sqlite'),
);

// Runs while the config is loaded, i.e. before Playwright starts the server.
mkdirSync(dirname(dbFile), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${dbFile}${suffix}`, { force: true });
}

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    testIdAttribute: 'data-testid',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run build && npm start',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NODE_ENV: 'production',
      HOST: host,
      PORT: String(port),
      CAREGRID_DB_FILE: dbFile,
      CAREGRID_TODAY: today,
    },
  },
});
