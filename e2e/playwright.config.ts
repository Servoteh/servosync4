import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Kredencijali iz postojećeg (gitignored) frontend/.env.test.local:
//   TEST_EMAIL, TEST_PASSWORD.  Override iz okruženja ima prednost.
dotenv.config({ path: path.resolve(__dirname, '../frontend/.env.test.local') });

// Deploy-ovani front. Posle hard-flip-a 17.07 javna adresa servira 2.0.
// Override: E2E_BASE_URL=https://servosync2.servoteh.com npm test
const BASE_URL = process.env.E2E_BASE_URL || 'https://servosync.servoteh.com';

export default defineConfig({
  testDir: './tests',
  outputDir: './report/artifacts',
  timeout: 90_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report/html', open: 'never' }],
    ['json', { outputFile: 'report/results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'modules',
      dependencies: ['setup'],
      testMatch: /modules\.smoke\.spec\.ts/,
      use: { storageState: '.auth/state.json' },
    },
    {
      // Nivo 1.5 — read-only drill-down (otvori stvaran RN/TP/Kvalitet detalj +
      // kiosk/MRP površina; hvata 500 na detalj GET/relacijama). Bez pisanja.
      name: 'core-read',
      dependencies: ['setup'],
      testMatch: /core-read\.spec\.ts/,
      use: { storageState: '.auth/state.json' },
    },
    {
      // Nivo 2 — net-zero write probe (create→delete / edit→revert) na živoj bazi.
      name: 'netzero',
      dependencies: ['setup'],
      testMatch: /\.probe\.spec\.ts/,
      use: { storageState: '.auth/state.json' },
    },
    {
      // Dijagnostika prijavljenih prod bug-ova.
      name: 'diag',
      dependencies: ['setup'],
      testMatch: /\.diag\.spec\.ts/,
      use: { storageState: '.auth/state.json' },
    },
  ],
});
