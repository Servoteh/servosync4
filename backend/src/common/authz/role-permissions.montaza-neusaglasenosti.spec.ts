import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Neusaglašenosti na montaži — permission matrica (zahtev 004/26,
 * MODULE_SPEC_montaza_neusaglasenosti §2). Presuda: prijavljuju SVI sa pristupom
 * Montaži (Montaža je ungated → svaka aktivna 2.0 rola), istragu/status vode
 * menadžerske role.
 *   read  = ceo montaža krug = TAČNO iste role koje imaju montaza.read (sve aktivne).
 *   write = isti krug (prijava + fotke: svako sa pristupom Montaži).
 *   manage = MONTAZA_EDIT skup = {admin, leadpm, pm, menadzment, tim_lider}.
 * Deferred/prelazno role (nabavka/kvalitet/prodaja/finansije/user) NISU u mapi →
 * default-deny na sva tri ključa.
 */
describe("Neusaglašenosti na montaži — permission matrica (zahtev 004/26)", () => {
  // Sve aktivne 2.0 uloge (svaka u ROLE_PERMISSIONS mapi) — „svi sa pristupom Montaži".
  const ACTIVE_ROLES = [
    ROLES.ADMIN,
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.CNC_PROGRAMER,
    ROLES.KONTROLOR,
    ROLES.MAGACIONER,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.NABAVKA_VIEW,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.TIM_LIDER,
    ROLES.PROJEKTANT_VODJA,
    ROLES.INZENJER,
    ROLES.HR,
    ROLES.POSLOVNI_ADMIN,
    ROLES.CNC_OPERATER,
    ROLES.MONTER,
    ROLES.TEHNICAR_ODRZAVANJA,
    ROLES.VIEWER,
  ];
  const MANAGE_ROLES = [
    ROLES.ADMIN,
    ROLES.LEADPM,
    ROLES.PM,
    ROLES.MENADZMENT,
    ROLES.TIM_LIDER,
  ];

  it("read+write ide TAČNO onim rolama koje imaju montaza.read (isti krug)", () => {
    for (const role of ACTIVE_ROLES) {
      const hasMontaza = roleHasPermission(role, PERMISSIONS.MONTAZA_READ);
      expect(hasMontaza).toBe(true);
      expect(
        roleHasPermission(role, PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_READ),
      ).toBe(true);
      expect(
        roleHasPermission(role, PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE),
      ).toBe(true);
    }
  });

  it.each(MANAGE_ROLES)(
    "%s ima neusaglasenosti.manage (istraga + status)",
    (role) => {
      expect(
        roleHasPermission(role, PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE),
      ).toBe(true);
    },
  );

  it("operativne role prijavljuju (write) ali NE vode istragu (manage)", () => {
    for (const role of [
      ROLES.PROIZVODNI_RADNIK,
      ROLES.MONTER,
      ROLES.CNC_OPERATER,
      ROLES.MAGACIONER,
      ROLES.KONTROLOR,
      ROLES.TEHNOLOG,
    ]) {
      expect(
        roleHasPermission(role, PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE),
      ).toBe(true);
      expect(
        roleHasPermission(role, PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE),
      ).toBe(false);
    }
  });

  /**
   * KOMPLETNOST nad ALL_ROLE_KEYS (wrong-grant tripwire): svaki ključ se dodeljuje
   * TAČNO očekivanom skupu — nijedna uloga van skupa ga nema.
   */
  describe("kompletnost nad ALL_ROLE_KEYS", () => {
    const expectedExactly = (
      perm: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
      allowed: readonly string[],
    ) => {
      const set = new Set<string>(allowed);
      for (const role of ALL_ROLE_KEYS) {
        expect({ role, has: roleHasPermission(role, perm) }).toEqual({
          role,
          has: set.has(role),
        });
      }
    };

    it("neusaglasenosti.read = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_READ, ACTIVE_ROLES));
    it("neusaglasenosti.write = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE, ACTIVE_ROLES));
    it("neusaglasenosti.manage = TAČNO {admin, leadpm, pm, menadzment, tim_lider}", () =>
      expectedExactly(
        PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE,
        MANAGE_ROLES,
      ));
  });

  it("nepoznata uloga = default deny", () => {
    for (const perm of [
      PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_READ,
      PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE,
      PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE,
    ]) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });
});
