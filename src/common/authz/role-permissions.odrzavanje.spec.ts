import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Održavanje (CMMS) permission matrica (MODULE_SPEC_odrzavanje_30.md §2/§3, presuda F8) —
 * rola-sloj (GRUBA kapija; VIDLJIVOST). Row-odluka (operator machine-scope,
 * chief-bez-globalne-role, magacioner krug, WO dodeljeni/prijavilac…) presuđuje 102 RLS
 * politike kroz `withUserRls` — dokazuje e2e/živi smoke, ne ovaj rola-sloj.
 *   read/report/write = OPŠTE pravo (F8 + HIGH#1): SVE aktivne uloge. Write je COARSE-
 *     SUPERSET (guard NE sme biti uži od žive RLS write-vlasti; `maint_profile_role()`
 *     auth.uid()-baziran chief NIJE u JWT-u — vidi role-permissions.ts komentar).
 *     Neovlašćen write odbija DB RLS (42501→403), ne guard.
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
  // HIGH#1: write = coarse-superset = SVE aktivne uloge (= READ_ROLES). RLS presuđuje red.
  const WRITE_ROLES = READ_ROLES;
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
    "%s ima odrzavanje.write (coarse-superset; RLS presuđuje red)",
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

  it("HIGH#1: read-only ERP role (viewer/monter/proizvodni_radnik) IMAJU write (coarse), NE admin_ui — chief-profil kroz njih ne sme 403 pre RLS", () => {
    for (const role of [ROLES.VIEWER, ROLES.MONTER, ROLES.PROIZVODNI_RADNIK]) {
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.ODRZAVANJE_WRITE)).toBe(true);
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
    it("odrzavanje.write = TAČNO sve aktivne uloge (HIGH#1 coarse-superset)", () =>
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
