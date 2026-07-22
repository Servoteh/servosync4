import { test, expect } from '@playwright/test';
import { captureWrites, recordProbe, testTag, type ProbeResult } from '../../utils/netzero';

/**
 * Zahtevi (AI PM modul) — net-zero probe tok podnošenja → admin odluka (F2 AC).
 *
 * Najčistiji net-zero bez drugog naloga: kroz formu napravi DRAFT → Podnesi
 * (SUBMITTED) → zatim ga terminiraj tako da NE ostane u obradi:
 *   • ako je nalog admin: action-bar „Arhiviraj" (SUBMITTED→ARCHIVED, POST /decision),
 *   • inače: owner „Povuci" (SUBMITTED→ARCHIVED, POST /withdraw).
 * Oba puta zahtev završi u ARCHIVED — nema hard-delete-a posle submit-a (doktrina
 * §10.3: original je svetinja), pa je „nestanak iz obrade" (ARCHIVED) najbliži
 * net-zero-u. Rezidualni ARCHIVED zapis je označen tagom radi lakšeg uvida.
 *
 * NAPOMENA: probe traži ŽIVU aplikaciju + nalog sa `zahtevi.write` (svi ga imaju).
 * Pokreće se u `netzero` projektu (playwright.config `.probe.spec.ts`, zависан od
 * `setup`). NIJE pokretan u F2 — pisan po obrascu reversi/kadrovska probe-ova i
 * verifikovan samo statički (tsc/lint u frontendu). Za pokretanje:
 *   cd e2e && npx playwright test tests/netzero/zahtevi.probe.spec.ts
 */
test('Zahtevi: draft→submit→arhiviraj/povuci (net-zero)', async ({ page }) => {
  const writes = captureWrites(page);
  const tag = testTag('E2E'); // E2E-TEST-xxxxxx — naslov zahteva
  const notes: string[] = [];
  let submitted = false;
  let terminated = false;
  let residue: string | null = null;
  let skipped = false;

  try {
    // 1) Otvori formu novog zahteva.
    await page.goto('/zahtevi/novi', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(600);

    const titleInput = page.getByPlaceholder('Kratko: šta ne radi ili šta treba dodati');
    if ((await titleInput.count()) === 0) {
      skipped = true;
      notes.push('forma novog zahteva nije dostupna (nema zahtevi.write?) — probe preskočen');
      throw new Error('SKIP');
    }

    // 2) Popuni obavezna polja i Podnesi (DRAFT→SUBMITTED + trijaža fire-and-forget).
    await titleInput.fill(tag);
    await page
      .getByPlaceholder('Detaljno opišite problem ili ideju…')
      .fill('Automatski net-zero E2E zahtev. Biće arhiviran odmah po podnošenju.');
    await page.getByRole('button', { name: 'Podnesi' }).click();

    // Uspeh submit-a = odlazak na detalj (/zahtevi/detalj?id=<id>) + POST /submit (ili create submit:true).
    await page.waitForURL(/\/zahtevi\/detalj\?id=\d+$/, { timeout: 20_000 });
    await page.waitForTimeout(800);
    submitted = writes.some((w) => /POST .*\/zahtevi(\/\d+\/submit|\?|$|\/)/.test(w));
    notes.push(`detalj: ${new URL(page.url()).pathname}`);

    // 3) Terminiraj u ARCHIVED — admin „Arhiviraj" ili owner „Povuci".
    const archiveBtn = page.getByRole('button', { name: 'Arhiviraj' });
    const withdrawBtn = page.getByRole('button', { name: 'Povuci' });

    if ((await archiveBtn.count()) > 0) {
      await archiveBtn.first().click();
      // dijalog presude — napomena opciona za archive → Potvrdi.
      const dlg = page.getByRole('dialog');
      await expect(dlg).toBeVisible({ timeout: 8_000 });
      await dlg.getByRole('button', { name: 'Potvrdi' }).click();
      await expect(dlg).toBeHidden({ timeout: 10_000 });
      terminated = writes.some((w) => /POST .*\/zahtevi\/\d+\/decision/.test(w));
      notes.push('terminirano: admin Arhiviraj (decision)');
    } else if ((await withdrawBtn.count()) > 0) {
      await withdrawBtn.first().click();
      const dlg = page.getByRole('dialog');
      await expect(dlg).toBeVisible({ timeout: 8_000 });
      await dlg.getByRole('button', { name: 'Povuci' }).click();
      await expect(dlg).toBeHidden({ timeout: 10_000 });
      terminated = writes.some((w) => /POST .*\/zahtevi\/\d+\/withdraw/.test(w));
      notes.push('terminirano: owner Povuci (withdraw)');
    } else {
      notes.push('nema Arhiviraj ni Povuci dugmeta — zahtev ostaje SUBMITTED');
    }

    await page.waitForTimeout(600);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'SKIP') notes.push('greška: ' + msg.slice(0, 160));
  } finally {
    if (submitted && !terminated) {
      residue = `zahtev "${tag}" je PODNET ali nije arhiviran/povučen — ostao u obradi, proveri i arhiviraj ručno.`;
    }
    const status: ProbeResult['status'] = skipped
      ? 'SKIP'
      : residue
        ? 'RESIDUE'
        : submitted && terminated
          ? 'PASS'
          : 'FAIL';
    recordProbe({
      module: 'Zahtevi',
      probe: 'draft→submit→arhiviraj/povuci',
      kind: 'create-delete',
      status,
      writeVerified: submitted,
      reverted: terminated,
      verifiedGone: terminated, // ARCHIVED = van obrade (hard-delete ne postoji posle submit-a)
      residue,
      writes: writes.filter((w) => /\/zahtevi/.test(w)),
      notes,
    });
    if (!skipped) {
      expect(residue, residue ?? undefined).toBeNull();
      expect(submitted, 'zahtev nije podnet (POST .../zahtevi[/submit])').toBeTruthy();
      expect(terminated, 'zahtev nije arhiviran/povučen posle podnošenja').toBeTruthy();
    }
  }
});
