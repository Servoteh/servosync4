import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Zahtevi (AI PM modul) permission matrica — MODULE_SPEC_zahtevi.md §2 (F0).
 *   zahtevi.read  = pristup modulu → SVE aktivne SSO uloge (row-scope u servisu:
 *                   ne-admin vidi SAMO svoje). Kanon je VIEWER_READ_BASELINE, a
 *                   post-merge addPerms sloj garantuje i uloge bez baseline-a.
 *   zahtevi.write = kreiranje/submit/withdraw/prilozi/komentari SOPSTVENIH → SVE aktivne
 *                   uloge (svako sme da PODNESE zahtev), kroz post-merge addPerms.
 *   zahtevi.admin + zahtevi.decisions.write = SAMO admin (kroz ALL).
 *   zahtevi.decisions.read = admin + menadzment (presuda §13.2).
 * Row-scope (ne-admin vidi samo svoje) je servisni sloj — dokazuje ga zahtevi.service.spec,
 * ne ova rola-matrica.
 */
describe("Zahtevi permission matrix (MODULE_SPEC_zahtevi §2)", () => {
  // Sve aktivne 2.0 uloge (svaka u ROLE_PERMISSIONS mapi) — „svi prijavljeni".
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
  const DECISIONS_READ_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT];
  const ADMIN_ONLY = [ROLES.ADMIN];

  it.each(ACTIVE_ROLES)("%s ima zahtevi.read (pristup modulu)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.ZAHTEVI_READ)).toBe(true);
  });

  it.each(ACTIVE_ROLES)("%s ima zahtevi.write (sme da podnese zahtev)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.ZAHTEVI_WRITE)).toBe(true);
  });

  it("read/write pokrivaju i uloge BEZ VIEWER_READ_BASELINE (sef/tehnolog/menadzment) preko addPerms sloja", () => {
    for (const role of [ROLES.SEF, ROLES.TEHNOLOG, ROLES.MENADZMENT]) {
      expect(roleHasPermission(role, PERMISSIONS.ZAHTEVI_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.ZAHTEVI_WRITE)).toBe(true);
    }
  });

  it.each(DECISIONS_READ_ROLES)("%s ima zahtevi.decisions.read", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.ZAHTEVI_DECISIONS_READ)).toBe(
      true,
    );
  });

  it("menadzment IMA decisions.read ali NEMA admin ni decisions.write (upis/inbox su samo admin)", () => {
    expect(
      roleHasPermission(ROLES.MENADZMENT, PERMISSIONS.ZAHTEVI_DECISIONS_READ),
    ).toBe(true);
    expect(roleHasPermission(ROLES.MENADZMENT, PERMISSIONS.ZAHTEVI_ADMIN)).toBe(
      false,
    );
    expect(
      roleHasPermission(ROLES.MENADZMENT, PERMISSIONS.ZAHTEVI_DECISIONS_WRITE),
    ).toBe(false);
  });

  it("zahtevi.admin + decisions.write = SAMO admin (inbox svih + oba odobrenja + upis odluka)", () => {
    for (const perm of [
      PERMISSIONS.ZAHTEVI_ADMIN,
      PERMISSIONS.ZAHTEVI_DECISIONS_WRITE,
    ]) {
      expect(roleHasPermission(ROLES.ADMIN, perm)).toBe(true);
      for (const role of [
        ROLES.MENADZMENT,
        ROLES.SEF,
        ROLES.HR,
        ROLES.VIEWER,
        ROLES.PROIZVODNI_RADNIK,
      ])
        expect(roleHasPermission(role, perm)).toBe(false);
    }
  });

  /**
   * KOMPLETNOST nad ALL_ROLE_KEYS (test-hardening): svaka permisija se dodeljuje TAČNO
   * očekivanom skupu — nijedna uloga VAN skupa je nema. Deferred/prelazno role
   * (nabavka/kvalitet/prodaja/finansije/user) NISU u mapi → default-deny.
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

    it("zahtevi.read = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.ZAHTEVI_READ, ACTIVE_ROLES));
    it("zahtevi.write = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.ZAHTEVI_WRITE, ACTIVE_ROLES));
    it("zahtevi.decisions.read = TAČNO {admin,menadzment}", () =>
      expectedExactly(PERMISSIONS.ZAHTEVI_DECISIONS_READ, DECISIONS_READ_ROLES));
    it("zahtevi.admin = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.ZAHTEVI_ADMIN, ADMIN_ONLY));
    it("zahtevi.decisions.write = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.ZAHTEVI_DECISIONS_WRITE, ADMIN_ONLY));
  });

  it("nepoznata uloga = default deny (zahtevi)", () => {
    for (const perm of [
      PERMISSIONS.ZAHTEVI_READ,
      PERMISSIONS.ZAHTEVI_WRITE,
      PERMISSIONS.ZAHTEVI_ADMIN,
      PERMISSIONS.ZAHTEVI_DECISIONS_READ,
      PERMISSIONS.ZAHTEVI_DECISIONS_WRITE,
    ]) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });

  it("regres-štit: dodavanje zahtevi permisija NIJE oduzelo pb/profil/primopredaje/reversi dodele", () => {
    expect(roleHasPermission(ROLES.VIEWER, PERMISSIONS.PB_READ)).toBe(true);
    expect(roleHasPermission(ROLES.MONTER, PERMISSIONS.PROFILE_SELF)).toBe(true);
    expect(
      roleHasPermission(ROLES.PROIZVODNI_RADNIK, PERMISSIONS.PRIMOPREDAJE_READ),
    ).toBe(true);
    expect(roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.REVERSI_MANAGE)).toBe(
      true,
    );
  });
});
