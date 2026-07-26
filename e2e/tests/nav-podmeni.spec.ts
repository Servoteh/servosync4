import { test, expect, type Page } from '@playwright/test';

// Podmeniji — treći nivo navigacije (PLAN_NAV_PODMENIJI, F1). Smoke pokriva TAČNO ono
// što F1 dodaje povrh F0: dvosmernu sinhronizaciju „podmeni ↔ tab u strani ↔ URL".
//
//   1) klik na podstavku u sidebaru DOK SI VEĆ U MODULU menja tab (bez reload-a strane);
//   2) klik na tab U STRANI upisuje URL (`history.replaceState`) i highlight u sidebaru prati;
//   3) stari 1.0 alias deep-link (`/sastanci?tab=dashboard`) i dalje sleće na tačan tab;
//   4) isto važi i za Montažu, gde su pogledi DIREKTNE stavke domena (`?view=`).
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
