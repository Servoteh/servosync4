import type { PublicUser } from '@/api/auth';

/**
 * Početna ruta posle prijave, zavisna od naloga (Nenad 17.07).
 *
 * Kontrolori ispred sebe treba da imaju SVOJU kontrolnu stranicu (/kvalitet:
 * škart/dorada/izveštaji + „Kontrola pogon"), ne generički /work-orders. Cilja:
 *  - deljeni kontrolni terminal `kontrola@servoteh.com`, i
 *  - lične naloge role „kontrolor".
 * Svi ostali (tehnolog, šef, admin, kiosk@, …) ostaju na /work-orders (rn.read
 * imaju sve uloge — nema 403). Menja SAMO gde kontrolor sleti, ništa drugo.
 */
const CONTROL_TERMINAL_EMAIL = 'kontrola@servoteh.com';
const CONTROLLER_ROLE = 'kontrolor';

export function landingRoute(user: Pick<PublicUser, 'email' | 'role'> | null): string {
  if (!user) return '/login';
  if (user.email === CONTROL_TERMINAL_EMAIL || user.role === CONTROLLER_ROLE)
    return '/kvalitet';
  return '/work-orders';
}
