import { test, expect } from '@playwright/test';
import { captureWrites, recordProbe, testTag, type ProbeResult } from '../../utils/netzero';

// Reversi nema hard-delete za alat → najčistiji net-zero je baterija (plain CRUD child):
// kartica alata → tab Baterije → +Dodaj → Sačuvaj → 🗑 (native confirm) → verifikuj nestanak.
test('Reversi: baterija create→delete (net-zero)', async ({ page }) => {
  const writes = captureWrites(page);
  const tag = testTag('E2E'); // E2E-TEST-xxxxxx
  const notes: string[] = [];
  let writeVerified = false;
  let reverted = false;
  let verifiedGone = false;
  let residue: string | null = null;
  let skipped = false;
  let toolLabel = '';

  try {
    await page.goto('/reversi', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('tab', { name: 'Stanje magacina' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('tab', { name: 'Alat i oprema' }).click();
    await page.waitForTimeout(700);

    const openBtn = page.getByRole('button', { name: 'Pregled jedinice' }).first();
    if ((await openBtn.count()) === 0) {
      skipped = true;
      notes.push('nema aktivnog ručnog alata u listi — probe preskočen');
      throw new Error('SKIP');
    }
    await openBtn.click();
    const card = page.getByRole('dialog').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    toolLabel = (await card.getAttribute('aria-label')) || '';
    notes.push(`alat: ${toolLabel}`);

    await card.getByRole('tab', { name: /Baterije/ }).click();
    await page.waitForTimeout(500);
    await card.getByRole('button', { name: /Dodaj bateriju/ }).click();

    const modal = page.getByRole('dialog', { name: 'Nova baterija' });
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await modal.getByPlaceholder('npr. 527100599').fill(tag);
    await modal.getByRole('button', { name: 'Sačuvaj' }).click();
    await expect(modal).toBeHidden({ timeout: 10_000 });

    const row = card.getByRole('row', { name: new RegExp(tag) });
    await expect(row).toHaveCount(1, { timeout: 10_000 });
    writeVerified = writes.some((w) => /POST .*\/tools\/.*\/batteries$/.test(w));

    // brisanje (native window.confirm)
    page.once('dialog', (d) => d.accept());
    await row.getByRole('button', { name: '🗑' }).click();
    await page.waitForTimeout(1000);
    await expect(card.getByRole('row', { name: new RegExp(tag) })).toHaveCount(0, { timeout: 10_000 });
    verifiedGone = true;
    reverted = writes.some((w) => /DELETE .*\/tool-batteries\//.test(w));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'SKIP') notes.push('greška: ' + msg.slice(0, 160));
  } finally {
    if (writeVerified && !verifiedGone) {
      residue = `baterija "${tag}" na alatu "${toolLabel}" možda NIJE obrisana — proveri i obriši ručno.`;
    }
    const status: ProbeResult['status'] = skipped
      ? 'SKIP'
      : residue
        ? 'RESIDUE'
        : writeVerified && verifiedGone
          ? 'PASS'
          : 'FAIL';
    recordProbe({
      module: 'Reversi',
      probe: 'baterija create→delete',
      kind: 'create-delete',
      status,
      writeVerified,
      reverted,
      verifiedGone,
      residue,
      writes: writes.filter((w) => /batter|tool-batteries/.test(w)),
      notes,
    });
    if (!skipped) {
      expect(residue, residue ?? undefined).toBeNull();
      expect(writeVerified, 'baterija upis nije potvrđen (POST .../batteries)').toBeTruthy();
      expect(verifiedGone, 'baterija nije obrisana (red i dalje postoji)').toBeTruthy();
    }
  }
});
