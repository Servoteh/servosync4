import { test, expect } from '@playwright/test';
import { captureWrites, recordProbe, type ProbeResult } from '../../utils/netzero';

// RN nema urgency/prioritet flag → najčistiji net-zero je boolean Zaključaj⇄Otključaj.
// Otvorimo prvi nalog (inline expand, čist GET), pročitamo lock stanje, toggle-ujemo pa vratimo.
test('RN: Zaključaj⇄Otključaj (edit→revert, net-zero)', async ({ page }) => {
  const writes = captureWrites(page);
  const notes: string[] = [];
  let writeVerified = false;
  let reverted = false;
  let verifiedGone = false;
  let residue: string | null = null;
  let skipped = false;

  const lockBtn = () => page.getByRole('button', { name: /^(Zaključaj|Otključaj)$/ }).first();
  const ensureDetailOpen = async () => {
    if ((await lockBtn().count()) > 0) return;
    await page.locator('table tbody tr').first().click();
    await page.waitForTimeout(900);
  };

  try {
    await page.goto('/work-orders', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await firstRow.click();
    await page.waitForTimeout(900);

    await ensureDetailOpen();
    if ((await lockBtn().count()) === 0) {
      skipped = true;
      notes.push('nema Zaključaj/Otključaj dugmeta (rn.write ili nema naloga)');
      throw new Error('SKIP');
    }
    const initial = (await lockBtn().innerText()).trim(); // "Zaključaj"=otključan · "Otključaj"=zaključan
    notes.push(`početno stanje: ${initial === 'Zaključaj' ? 'otključan' : 'zaključan'}`);

    // toggle 1
    await lockBtn().click();
    await page.waitForTimeout(1400);
    await ensureDetailOpen();
    const afterToggle = (await lockBtn().innerText()).trim();
    writeVerified = writes.some((w) => /POST .*\/lock$/.test(w)) && afterToggle !== initial;

    // toggle back (revert)
    await lockBtn().click();
    await page.waitForTimeout(1400);
    await ensureDetailOpen();
    const restored = (await lockBtn().innerText()).trim();
    verifiedGone = restored === initial;
    reverted = writes.filter((w) => /POST .*\/lock$/.test(w)).length >= 2;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'SKIP') notes.push('greška: ' + msg.slice(0, 160));
  } finally {
    if (writeVerified && !verifiedGone) {
      residue = 'RN je možda ostao u izmenjenom lock stanju — proveri ručno i vrati na početno.';
    }
    const status: ProbeResult['status'] = skipped
      ? 'SKIP'
      : residue
        ? 'RESIDUE'
        : writeVerified && verifiedGone
          ? 'PASS'
          : 'FAIL';
    recordProbe({
      module: 'Radni nalozi',
      probe: 'Zaključaj⇄Otključaj',
      kind: 'edit-revert',
      status,
      writeVerified,
      reverted,
      verifiedGone,
      residue,
      writes: writes.filter((w) => /\/lock$/.test(w)),
      notes,
    });
    if (!skipped) {
      expect(residue, residue ?? undefined).toBeNull();
      expect(writeVerified, 'lock upis nije potvrđen (POST /lock)').toBeTruthy();
      expect(verifiedGone, 'lock nije vraćen na početno stanje').toBeTruthy();
    }
  }
});
