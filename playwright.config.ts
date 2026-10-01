import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end workflows run against the production build (`vite preview`) so
 * they are not affected by dev-server hot reloads. WebGL uses the GPU via
 * ANGLE when available.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 960 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 } }, grep: /@tablet/ },
  ],
  webServer: [
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 240_000,
    },
    {
      command: 'npx tsx server/index.ts',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
