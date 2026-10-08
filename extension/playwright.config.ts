import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/browser', workers: 1, timeout: 120_000,
  use: { actionTimeout: 10_000 },
  outputDir: '/tmp/sih26-playwright-results',
  reporter: [['list']],
  webServer: { command: 'npm run fixtures', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
