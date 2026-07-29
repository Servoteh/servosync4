import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Matični podaci 4.0 — matrica `masters.read` (odluka Nenad 29.07.2026).
 *
 * Ključ otključava KOMERCIJALNI sloj kartona artikla/komitenta (cene, marže, rabati,
 * provizije, žiro računi, kreditni limit, GK konta). Kuriran je: krug su uloge koje
 * po poslu rade sa cenama i uslovima plaćanja — menadžment, šefovi, nabavka, vođe
 * projekata — plus `admin` kroz ALL. Ekrani /artikli i /komitenti OSTAJU na
 * `directory.read` (bazni sloj vidi svako), pa uskraćen `masters.read` NE zatvara
 * modul, samo suzi skup kolona (redakcija je u `modules/masters` servisima).
 */
describe("Matični podaci — matrica masters.read", () => {
  const ALLOWED_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.SEF,
    ROLES.NABAVKA_VIEW,
    ROLES.PM,
    ROLES.LEADPM,
  ];

  // Sve ostale katalogisane uloge (izvedeno iz ALL_ROLE_KEYS, ne ručna lista — da
  // budući nenamerni grant obori test; isti obrazac kao energetika matrica).
  const DENIED_ROLES = ALL_ROLE_KEYS.filter(
    (r) => !(ALLOWED_ROLES as string[]).includes(r),
  );

  it.each(ALLOWED_ROLES)("%s ima masters.read", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.MASTERS_READ)).toBe(true);
  });

  it.each(DENIED_ROLES)("%s NEMA masters.read", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.MASTERS_READ)).toBe(false);
  });

  /**
   * Ključna razlika prema `directory.read`: on je u VIEWER_READ_BASELINE (svaka SSO
   * uloga), `masters.read` NIJE. Bez ovoga bi ceo dvoslojni model bio bezvredan —
   * svako bi imao i komercijalni sloj.
   */
  it.each([ROLES.VIEWER, ROLES.MONTER, ROLES.TEHNOLOG, ROLES.HR])(
    "%s vidi modul (directory.read) ali NE i komercijalni sloj (masters.read)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.DIRECTORY_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.MASTERS_READ)).toBe(false);
    },
  );

  it("nepoznata uloga = default deny", () => {
    expect(roleHasPermission("nepostojeca", PERMISSIONS.MASTERS_READ)).toBe(
      false,
    );
  });
});
