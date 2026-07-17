import type { PublicUser } from '@/api/auth';

/**
 * Početna ruta posle prijave, HIBRID po ulozi (Nenad 17.07, PLAN_MAIN_PAGE §5.1).
 *
 * 1) Kontrolori ispred sebe treba da imaju SVOJU kontrolnu stranicu (/kvalitet:
 *    škart/dorada/izveštaji + „Kontrola pogon"), ne generički /work-orders. Cilja:
 *     - deljeni kontrolni terminal `kontrola@servoteh.com`, i
 *     - lične naloge role „kontrolor".
 *    Ovo važi UVEK (i u hub-u i van njega) — kontrolni terminal ne sme da sleti na hub.
 * 2) „Hub uloge" (kancelarija/tehnologija — v. HUB_ROLES) sleću na hub `/pocetna`,
 *    odakle biraju modul. Ostali (kiosk@, pogon, …) i dalje idu direktno na /work-orders
 *    (rn.read imaju sve uloge — nema 403).
 * 3) `opts.embedded` = ServoSync 2.0 radi kao iframe modul „Tehnologija" unutar 1.0
 *    shell-a, koji VEĆ ima svoj HUB. Tada hub-uloge PRESKAČU /pocetna (dupli hub) i
 *    padaju na svoju ne-hub metu (kontrolor→/kvalitet gore, ostali→/work-orders).
 *
 * Regresija: za NE-hub uloge ruta je IDENTIČNA kao pre (kontrolor→/kvalitet, ostali→
 * /work-orders); menja se samo gde hub-uloge sleću kad NISU u iframe-u.
 */
const CONTROL_TERMINAL_EMAIL = 'kontrola@servoteh.com';
const CONTROLLER_ROLE = 'kontrolor';

/**
 * Uloge koje sleću na hub `/pocetna` (kancelarija + tehnologija). Ostale (pogon/kiosk/
 * kontrolor) zadržavaju direktnu modul-metu. Set = O(1) provera članstva.
 */
const HUB_ROLES: ReadonlySet<string> = new Set([
  'admin',
  'menadzment',
  'leadpm',
  'pm',
  'poslovni_admin',
  'hr',
  'projektant_vodja',
  'tehnolog',
]);

export function landingRoute(
  user: Pick<PublicUser, 'email' | 'role'> | null,
  opts?: { embedded?: boolean },
): string {
  if (!user) return '/login';
  // Kontrolni terminal / kontrolor UVEK na /kvalitet — pre hub-provere, da deljeni
  // terminal ne sleti na hub čak i ako mu je nalog u hub-ulozi.
  if (user.email === CONTROL_TERMINAL_EMAIL || user.role === CONTROLLER_ROLE)
    return '/kvalitet';
  // Hub-uloge → /pocetna, osim u iframe-u (1.0 već ima HUB) gde padaju na modul-metu.
  if (!opts?.embedded && HUB_ROLES.has(user.role)) return '/pocetna';
  return '/work-orders';
}
