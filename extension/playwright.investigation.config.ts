import { defineConfig } from '@playwright/test';
// Evidence-only investigation runs: invoke explicitly with
//   npx playwright test --config=playwright.investigation.config.ts ...
// Never picked up by the regular suite (testDir differs).
export default defineConfig({
  testDir: 'tests/investigation', workers: 1, timeout: 300_000,
  use: { actionTimeout: 15_000 },
  outputDir: '/tmp/sih26-investigation-results',
  reporter: [['line']],
  webServer: { command: 'npm run fixtures', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
