import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(__dirname, '../.auth/state.json');

// Login jednom preko UI-a; sesija (token u localStorage['servosync.token'])
// se sačuva u storageState i deli svim modul-testovima.
setup('login', async ({ page }) => {
  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'Nedostaju TEST_EMAIL/TEST_PASSWORD. Očekujem ih u frontend/.env.test.local ' +
        '(ili iz okruženja). Login nije moguć.',
    );
  }

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Prijavi se' }).click();

  // Uspeh = odlazak sa /login (redirect na /work-orders) ILI token u storage-u.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 45_000 });
  const token = await page.evaluate(() => localStorage.getItem('servosync.token'));
  expect(token, 'nema tokena posle login-a (proveri email/lozinku ili E2E_BASE_URL)').toBeTruthy();

  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  await page.context().storageState({ path: STATE });
});
