import { test, expect } from '@playwright/test';
import { captureWrites, recordProbe, testTag, type ProbeResult } from '../../utils/netzero';
import { fillByLabel } from '../../utils/ui';

// Kvalitet: kreiraj DRAFT (dorada) → obriši nacrt. Broj škarta/dorade se NE troši (dodeljuje se tek
// na „Potvrdi izveštaj", koji NE diramo). Nacrt se sme brisati (backend dozvoljava DELETE za status 0).
test('Kvalitet: draft dorada create→delete (net-zero)', async ({ page }) => {
  const writes = captureWrites(page);
  const tag = testTag('ZZ'); // ZZ-TEST-xxxxxx (naziv pozicije = marker za pretragu)
  const notes: string[] = [];
  let writeVerified = false;
  let reverted = false;
  let verifiedGone = false;
  let residue: string | null = null;
  let skipped = false;

  try {
    await page.goto('/kvalitet', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('tab', { name: /Evidencija dorada/i }).click();
    await page.waitForTimeout(500);

    const newBtn = page.getByRole('button', { name: /Novi izveštaj/i });
    if ((await newBtn.count()) === 0) {
      skipped = true;
      notes.push('nema dugmeta „Novi izveštaj" (kvalitet.write?)');
      throw new Error('SKIP');
    }
    await newBtn.click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // minimalno validan draft: Količina>0 + Opis greške + Naziv pozicije (marker)
    await fillByLabel(dialog, 'Naziv pozicije', tag);
    await fillByLabel(dialog, 'Količina', '1');
    await fillByLabel(dialog, 'Opis greške', 'TEST — obrisati (net-zero provera)');

    await dialog.getByRole('button', { name: /Sačuvaj izveštaj/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    writeVerified = writes.some((w) => /POST .*\/kvalitet\/reports$/.test(w));

    // filter Status=Nacrti da suzim listu
    const statusSel = page.locator('select', { has: page.locator('option', { hasText: 'Nacrti' }) }).first();
    if (await statusSel.count()) {
      await statusSel.selectOption({ label: 'Nacrti' }).catch(() => {});
      await page.waitForTimeout(700);
    }

    const row = page.getByRole('row', { name: new RegExp(tag) }).first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click(); // expand → ReportDetail
    await page.waitForTimeout(700);

    // Obriši nacrt (u detalju) → potvrdni dijalog „Brisanje nacrta" → Obriši nacrt
    await page.getByRole('button', { name: 'Obriši nacrt' }).first().click();
    const confirm = page.getByRole('dialog', { name: /Brisanje nacrta/i });
    await expect(confirm).toBeVisible({ timeout: 6_000 });
    await confirm.getByRole('button', { name: 'Obriši nacrt' }).click();
    await page.waitForTimeout(1000);

    await expect(page.getByRole('row', { name: new RegExp(tag) })).toHaveCount(0, { timeout: 10_000 });
    verifiedGone = true;
    reverted = writes.some((w) => /DELETE .*\/kvalitet\/reports\//.test(w));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'SKIP') notes.push('greška: ' + msg.slice(0, 160));
  } finally {
    if (writeVerified && !verifiedGone) {
      residue = `draft dorada „${tag}" možda NIJE obrisan — nađi u /kvalitet (Status=Nacrti) i obriši ručno.`;
    }
    const status: ProbeResult['status'] = skipped
      ? 'SKIP'
      : residue
        ? 'RESIDUE'
        : writeVerified && verifiedGone
          ? 'PASS'
          : 'FAIL';
    recordProbe({
      module: 'Kontrola kvaliteta',
      probe: 'draft dorada create→delete',
      kind: 'create-delete',
      status,
      writeVerified,
      reverted,
      verifiedGone,
      residue,
      writes: writes.filter((w) => /kvalitet\/reports/.test(w)),
      notes,
    });
    if (!skipped) {
      expect(residue, residue ?? undefined).toBeNull();
      expect(writeVerified, 'draft upis nije potvrđen (POST /kvalitet/reports)').toBeTruthy();
      expect(verifiedGone, 'draft nije obrisan (red i dalje postoji)').toBeTruthy();
    }
  }
});
