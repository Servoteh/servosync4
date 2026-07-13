import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Održavanje (CMMS) permission matrica (MODULE_SPEC_odrzavanje_30.md §2/§3, presuda F8) —
 * rola-sloj (GRUBA kapija; VIDLJIVOST). Row-odluka (operator machine-scope,
 * chief-bez-globalne-role, magacioner krug, WO dodeljeni/prijavilac…) presuđuje 102 RLS
 * politike kroz `withUserRls` — dokazuje e2e/živi smoke, ne ovaj rola-sloj.
 *   read/report = OPŠTE pravo (F8): SVE aktivne uloge (hub kartica + prijava kvara).
 *   write       = maint chief/admin ERP-aproks. {admin, sef, magacioner, menadzment, tehnicar_odrzavanja}.
 *   admin_ui    = {admin, menadzment, magacioner} (prikaz admin UI-ja; nije bezb. granica).
 */
describe("Održavanje permission matrix (paritet F8 + §2.4)", () => {
  // SVE aktivne uloge = svaka rola sa permisijskim blokom (isključi deferred/prelazno).
  const INACTIVE: readonly string[] = [
    ROLES.NABAVKA,
    ROLES.KVALITET,
    ROLES.PRODAJA,
    ROLES.FINANSIJE,
    ROLES.USER,
  ];
  const READ_ROLES = ALL_ROLE_KEYS.filter((r) => !INACTIVE.includes(r));
  const WRITE_ROLES = [
    ROLES.ADMIN,
    ROLES.SEF,
    ROLES.MAGACIONER,
    ROLES.MENADZMENT,
    ROLES.TEHNICAR_ODRZAVANJA,
  ];
  const ADMIN_UI_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT, ROLES.MAGACIONER];

  it.each(READ_ROLES)("%s ima odrzavanje.read + report (F8)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_READ)).toBe(true);
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_REPORT)).toBe(true);
  });

  it.each(INACTIVE)("%s NEMA odrzavanje.* (neaktivna/deferred)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_READ)).toBe(false);
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_REPORT)).toBe(false);
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_WRITE)).toBe(false);
    expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_ADMIN_UI)).toBe(
      false,
    );
  });

  it.each(WRITE_ROLES)(
    "%s ima odrzavanje.write (maint chief/admin sloj)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_WRITE)).toBe(true);
    },
  );

  it("tehnicar_odrzavanja ima read/report/write ali NE admin_ui", () => {
    expect(
      roleHasPermission(ROLES.TEHNICAR_ODRZAVANJA, PERMISSIONS.ODRZAVANJE_READ),
    ).toBe(true);
    expect(
      roleHasPermission(
        ROLES.TEHNICAR_ODRZAVANJA,
        PERMISSIONS.ODRZAVANJE_WRITE,
      ),
    ).toBe(true);
    expect(
      roleHasPermission(
        ROLES.TEHNICAR_ODRZAVANJA,
        PERMISSIONS.ODRZAVANJE_ADMIN_UI,
      ),
    ).toBe(false);
  });

  it("read je opšte pravo ali write NIJE: viewer/monter/proizvodni_radnik imaju read, NE write", () => {
    for (const role of [ROLES.VIEWER, ROLES.MONTER, ROLES.PROIZVODNI_RADNIK]) {
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_WRITE)).toBe(false);
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_ADMIN_UI)).toBe(
        false,
      );
    }
  });

  /**
   * KOMPLETNOST nad ALL_ROLE_KEYS (test-hardening): svaka odrzavanje.* permisija se
   * dodeljuje TAČNO očekivanom skupu — nijedna uloga van skupa je nema (pogrešan budući
   * grant obara test). Isti obrazac kao sastanci/ai spec.
   */
  describe("kompletnost nad ALL_ROLE_KEYS (wrong-grant tripwire)", () => {
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

    it("odrzavanje.read = TAČNO sve aktivne uloge (F8)", () =>
      expectedExactly(PERMISSIONS.ODRZAVANJE_READ, READ_ROLES));
    it("odrzavanje.report = TAČNO sve aktivne uloge (F8)", () =>
      expectedExactly(PERMISSIONS.ODRZAVANJE_REPORT, READ_ROLES));
    it("odrzavanje.write = TAČNO {admin, sef, magacioner, menadzment, tehnicar_odrzavanja}", () =>
      expectedExactly(PERMISSIONS.ODRZAVANJE_WRITE, WRITE_ROLES));
    it("odrzavanje.admin_ui = TAČNO {admin, menadzment, magacioner}", () =>
      expectedExactly(PERMISSIONS.ODRZAVANJE_ADMIN_UI, ADMIN_UI_ROLES));
  });

  it("nepoznata uloga = default deny (odrzavanje.*)", () => {
    for (const perm of [
      PERMISSIONS.ODRZAVANJE_READ,
      PERMISSIONS.ODRZAVANJE_REPORT,
      PERMISSIONS.ODRZAVANJE_WRITE,
      PERMISSIONS.ODRZAVANJE_ADMIN_UI,
    ]) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });
});
