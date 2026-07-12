import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Energetika / SCADA permission matrica (MODULE_SPEC_scada_30.md §2) — rola-sloj
 * pariteta sa živom 1.0 politikom (9 politika, snapshot 12.07 — 0 drift):
 *   `scada_is_admin_or_management()` = SAMO globalna admin ILI menadzment →
 *   `energetika.read` + `energetika.control`. NIKO drugi (SCADA nije za sve →
 *   BEZ viewer read-baseline; ni sef/tehnolog/magacioner/pm…).
 * Dva ključa, ista dodela (1.0 `canControlScada() ≡ canAccessEnergetikaScada()`).
 */
describe("Energetika permission matrix (paritet scada_is_admin_or_management)", () => {
  const ALLOWED_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT];

  // SVE ostale katalogisane uloge (izvedeno iz ALL_ROLE_KEYS, ne ručna lista —
  // review nalaz 12.07: hardkodovana lista je izostavljala 5 rezervisanih rola,
  // pa budući pogrešan grant npr. tehnicar_odrzavanja ne bi oborio nijedan test).
  const DENIED_ROLES = ALL_ROLE_KEYS.filter(
    (r) => !(ALLOWED_ROLES as string[]).includes(r),
  );

  it.each(ALLOWED_ROLES)(
    "%s ima energetika.read i energetika.control",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.ENERGETIKA_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.ENERGETIKA_CONTROL)).toBe(
        true,
      );
    },
  );

  it.each(DENIED_ROLES)(
    "%s NEMA ni energetika.read ni energetika.control",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.ENERGETIKA_READ)).toBe(false);
      expect(roleHasPermission(role, PERMISSIONS.ENERGETIKA_CONTROL)).toBe(
        false,
      );
    },
  );

  // Naglašeno (zahtev spec §2): uloge koje INAČE dobijaju read-baseline za druge
  // 2.0 module NE smeju da procure u SCADA (viewer/pm/hr/monter poimence).
  it.each([ROLES.VIEWER, ROLES.PM, ROLES.HR, ROLES.MONTER])(
    "%s (read-baseline za druge module) NEMA energetika.read",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.ENERGETIKA_READ)).toBe(false);
    },
  );

  it("nepoznata uloga = default deny", () => {
    expect(roleHasPermission("nepostojeca", PERMISSIONS.ENERGETIKA_READ)).toBe(
      false,
    );
  });
});
