import { test, expect } from '@playwright/test';
import { captureWrites, recordProbe, testTag, type ProbeResult } from '../../utils/netzero';

// Kadrovska: onboarding ŠABLON (čist konfig, bez PII/zarada/employeeId) create→delete.
// Dokazano bezbedan tok (cutover-audit 17.07). Caveat: soft-delete se verifikuje nestankom iz view-a.
test('Kadrovska: onboarding šablon create→delete (net-zero)', async ({ page }) => {
  const writes = captureWrites(page);
  const tag = testTag('E2E'); // E2E-TEST-xxxxxx
  const notes: string[] = [];
  let writeVerified = false;
  let reverted = false;
  let verifiedGone = false;
  let residue: string | null = null;
  let skipped = false;

  try {
    await page.goto('/kadrovska', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // HUB → grupa „Zaposleni"
    const grupa = page.getByRole('button', { name: 'Zaposleni' }).first();
    if (await grupa.count()) {
      await grupa.click();
      await page.waitForTimeout(600);
    }
    // tab „Uvođenje/Izlazak"
    const tab = page.getByRole('tab', { name: /Uvođenje/i });
    if ((await tab.count()) === 0) {
      skipped = true;
      notes.push('nema taba „Uvođenje/Izlazak" (kadrovska.manage?)');
      throw new Error('SKIP');
    }
    await tab.click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: /Novi šablon/i }).click();
    // WideModal nema aria-label → dialog lociramo po sadržaju naslova, ne po imenu role-a.
    const modal = page.getByRole('dialog').filter({ hasText: 'Novi šablon' }).first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await modal.getByPlaceholder('npr. Standardni onboarding').fill(tag);
    await modal.getByRole('button', { name: /^Sačuvaj$/ }).click();
    await expect(modal).toBeHidden({ timeout: 10_000 });
    writeVerified = writes.some((w) => /POST .*\/onboarding\/templates$/.test(w));

    // nađi karticu šablona sa markerom
    const card = page
      .locator('div')
      .filter({ hasText: tag })
      .filter({ has: page.getByRole('button', { name: '🗑' }) })
      .last();
    await expect(card).toBeVisible({ timeout: 10_000 });

    // brisanje (native window.confirm)
    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: '🗑' }).click();
    await page.waitForTimeout(1000);

    await expect(page.getByText(tag, { exact: false })).toHaveCount(0, { timeout: 10_000 });
    verifiedGone = true;
    reverted = writes.some((w) => /DELETE .*\/onboarding\/templates\//.test(w));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'SKIP') notes.push('greška: ' + msg.slice(0, 160));
  } finally {
    if (writeVerified && !verifiedGone) {
      residue = `onboarding šablon „${tag}" možda NIJE obrisan — nađi u Kadrovska › Uvođenje/Izlazak i obriši ručno.`;
    }
    const status: ProbeResult['status'] = skipped
      ? 'SKIP'
      : residue
        ? 'RESIDUE'
        : writeVerified && verifiedGone
          ? 'PASS'
          : 'FAIL';
    recordProbe({
      module: 'Kadrovska',
      probe: 'onboarding šablon create→delete',
      kind: 'create-delete',
      status,
      writeVerified,
      reverted,
      verifiedGone,
      residue,
      writes: writes.filter((w) => /onboarding\/templates/.test(w)),
      notes: [...notes, 'caveat: mogući soft-delete/audit trag (sistemski, kao 17.07 audit)'],
    });
    if (!skipped) {
      expect(residue, residue ?? undefined).toBeNull();
      expect(writeVerified, 'šablon upis nije potvrđen (POST /onboarding/templates)').toBeTruthy();
      expect(verifiedGone, 'šablon nije nestao iz view-a').toBeTruthy();
    }
  }
});
