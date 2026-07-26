import { test, expect, type Page } from '@playwright/test';

// Podmeniji — treći nivo navigacije (PLAN_NAV_PODMENIJI, F1+F2). Smoke pokriva TAČNO ono
// što F1 dodaje povrh F0: dvosmernu sinhronizaciju „podmeni ↔ tab u strani ↔ URL".
//
//   1) klik na podstavku u sidebaru DOK SI VEĆ U MODULU menja tab (bez reload-a strane);
//   2) klik na tab U STRANI upisuje URL (`history.replaceState`) i highlight u sidebaru prati;
//   3) stari 1.0 alias deep-link (`/sastanci?tab=dashboard`) i dalje sleće na tačan tab;
//   4) isto važi i za Montažu, gde su pogledi DIREKTNE stavke domena (`?view=`).
//
// F2 dodaje tri slučaja povrh toga (round 2 + Finansije pregrupisanje):
//   5) Kadrovska koristi `?grupa=` (5 GRUPA, ne 13 tabova — presuda §6.4);
//   6) round-2 strana bez ikakvog deep-linka do sada (Kvalitet) sad ima `?tab=`;
//   7) preseljena finansijska stavka („Kursne razlike") je PODSTAVKA Saldakonta, a ne više
//      red prvog nivoa — meni je pao sa 12 na 9 stavki u domenu „Finansije".
//
// Zahteva sidebar u punom režimu (default) i viewport ≥1024px (config: 1440×900).

/** Sačekaj klijentski render/hidraciju (isti obrazac kao modules.smoke.spec.ts). */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
}

/** Link u punom sidebaru po tačnom nazivu (stavka modula ili podstavka podmenija). */
function navLink(page: Page, name: string) {
  return page.locator('aside').getByRole('link', { name, exact: true }).first();
}

/** Trenutno izabran tab u tab-traci strane (ui-kit `Tabs`: role=tab + aria-selected). */
function selectedTab(page: Page) {
  return page.locator('[role="tab"][aria-selected="true"]').first();
}

/**
 * Marker u `window` — preživljava React re-render, ali NE i pun reload dokumenta.
 * Time razlikujemo „promena taba bez remount-a" od skrivene pune navigacije.
 */
async function markNoReload(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__navPodmeniProbe = 'zivo';
  });
}
async function stillSameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>).__navPodmeniProbe === 'zivo',
  );
}

test('Održavanje — klik na podstavku menja tab bez reload-a strane', async ({ page }) => {
  await page.goto('/odrzavanje', { waitUntil: 'domcontentloaded' });
  await settle(page);

  // Modul u kome se nalaziš je auto-razgranat → podstavke su odmah vidljive (F0).
  await expect(navLink(page, 'Kvarovi')).toBeVisible();
  await markNoReload(page);

  await navLink(page, 'Kvarovi').click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('tab')).toBe('kvarovi');
  await expect(selectedTab(page)).toHaveText('Kvarovi');
  // Ključ F1: Next ne remount-uje stranu na promenu samog query-ja — `servosync:nav`
  // je ono što je natera da promeni tab. Ako je marker nestao, desio se pun reload.
  expect(await stillSameDocument(page)).toBe(true);

  // I aktivna podstavka nosi jedini `aria-current` (a11y pravilo iz F0).
  await expect(navLink(page, 'Kvarovi')).toHaveAttribute('aria-current', 'page');
});

test('Održavanje — klik na tab u strani upisuje URL i pomera highlight u sidebaru', async ({ page }) => {
  await page.goto('/odrzavanje?tab=kvarovi', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(selectedTab(page)).toHaveText('Kvarovi');

  await page.locator('[role="tab"]', { hasText: 'Mašine' }).first().click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('tab')).toBe('masine');
  await expect(navLink(page, 'Mašine')).toHaveAttribute('aria-current', 'page');
  // Prethodna podstavka više nije aktivna (jedan aria-current po ekranu).
  await expect(navLink(page, 'Kvarovi')).not.toHaveAttribute('aria-current', 'page');
});

test('Sastanci — stari 1.0 alias deep-link i dalje sleće na tačan tab', async ({ page }) => {
  // `dashboard` je 1.0 id iz sastanci/index.js; mora da nastavi da radi (linkovi u mejlovima).
  await page.goto('/sastanci?tab=dashboard', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(selectedTab(page)).toHaveText('Pregled');

  // Podmeni menja tab i ovde — „Akcioni plan" je jedinstven naziv u sidebaru.
  await markNoReload(page);
  await navLink(page, 'Akcioni plan').click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('tab')).toBe('akcioni');
  expect(await stillSameDocument(page)).toBe(true);
});

test('Montaža — pogledi su direktne stavke domena i menjaju prikaz iz sidebara', async ({ page }) => {
  await page.goto('/montaza?view=plan', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(navLink(page, 'Plan')).toHaveAttribute('aria-current', 'page');

  await markNoReload(page);
  await navLink(page, 'Izveštaji montera').click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('view')).toBe('izvestaji');
  expect(await stillSameDocument(page)).toBe(true);
});

// ─────────────────────────────── F2 (round 2 + Finansije) ───────────────────────────────

test('Kvalitet — round 2: strana bez deep-linka sad ima `?tab=` u oba smera', async ({ page }) => {
  // Do F2 je tab bio interni `useState` — nije bilo ni bookmarka ni Ctrl+K skoka na tab.
  await page.goto('/kvalitet?tab=dokumenti', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(selectedTab(page)).toHaveText('Dokumenti');
  await expect(navLink(page, 'Dokumenti')).toHaveAttribute('aria-current', 'page');

  // Podmeni menja tab i kad smo VEĆ u modulu (ključ F1 mašinerije, sad i ovde).
  await markNoReload(page);
  await navLink(page, 'Kontrola pogon').click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('tab')).toBe('pogon');
  await expect(selectedTab(page)).toHaveText('Kontrola pogon');
  expect(await stillSameDocument(page)).toBe(true);
});

test('Kadrovska — podmeni su GRUPE i voze se kroz `?grupa=`', async ({ page }) => {
  // Presuda §6.4: meni nosi 5 grupa (Role Center logika), ne svih 13 tabova.
  await page.goto('/kadrovska?grupa=sati', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await expect(navLink(page, 'Radni sati')).toHaveAttribute('aria-current', 'page');

  await markNoReload(page);
  await navLink(page, 'Zaposleni').click();
  await page.waitForTimeout(600);

  expect(new URL(page.url()).searchParams.get('grupa')).toBe('zaposleni');
  await expect(navLink(page, 'Zaposleni')).toHaveAttribute('aria-current', 'page');
  expect(await stillSameDocument(page)).toBe(true);

  // Povratak na hub („⊞ Grupe") briše parametar iz URL-a (`omitDefault`) — /kadrovska
  // bez `?grupa=` je landing sa karticama, kao i pre F2 (paritet 1.0).
  await page.getByRole('button', { name: '⊞ Grupe' }).click();
  await page.waitForTimeout(600);
  expect(new URL(page.url()).searchParams.get('grupa')).toBeNull();
});

test('Finansije — „Kursne razlike" su preseljene pod Saldakonte (12 → 9 u prvom redu)', async ({ page }) => {
  await page.goto('/saldakonti', { waitUntil: 'domcontentloaded' });
  await settle(page);

  // Aktivni modul je auto-razgranat (F0), pa je preseljena stavka odmah pri ruci —
  // amortizer navike iz presude §6.3 („stavke se sele, ne nestaju").
  await expect(navLink(page, 'Kursne razlike')).toBeVisible();
  // Isto važi i za „Karticu komitenta" — ruta koja do F2 NIJE bila nigde u meniju.
  await expect(navLink(page, 'Kartica komitenta')).toBeVisible();

  await navLink(page, 'Kursne razlike').click();
  await page.waitForURL('**/saldakonti/kursne-razlike', { timeout: 15_000 });
  await settle(page);

  // Podstavka nosi jedini `aria-current`, roditelj „Saldakonti" samo stil (a11y iz F0).
  await expect(navLink(page, 'Kursne razlike')).toHaveAttribute('aria-current', 'page');
  await expect(navLink(page, 'Saldakonti')).not.toHaveAttribute('aria-current', 'page');
});
