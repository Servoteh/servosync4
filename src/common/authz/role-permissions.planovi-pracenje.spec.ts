import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * TALAS C permission matrica (MODULE_SPEC_planovi_pracenje_30.md §2/§7, presuda 13.07) —
 * rola-sloj pariteta sa ŽIVIM 1.0 gate-ovima (`src/state/auth.js`), NE labavim spec tekstom:
 *   montaza.read / izvestaji : Montaža modul UNGATED (router.assertModuleAllowed nema montaza
 *     granu; hub kartica bez gate-a) → SVAKA aktivna 2.0 rola.
 *   plan_proizvodnje.read / pracenje.read : canAccessPlanProizvodnje (router gate za modul
 *     „proizvodnja") = {admin,leadpm,pm,menadzment,hr,viewer,cnc_operater,tim_lider,proizvodni_radnik}.
 *   montaza.edit : canEditPlanMontaze = canEdit()∪tim_lider = {admin,leadpm,pm,menadzment,tim_lider}.
 *     PRESUDA C1: tim_lider dobija PRAVI edit (1.0 bag-by-omission); C2: hr/poslovni_admin
 *     NISU u UI dodeli (has_edit_role širina ostaje u DB kroz GUC).
 *   plan_proizvodnje.edit / pracenje.edit : {admin,pm,menadzment}.
 *   plan_proizvodnje.force / pracenje.manage : {admin,menadzment}.
 *   koop_admin / prioritet / ai_admin : {admin}.
 * Row-scope (has_edit_role project-scope, autor-scope izveštaja) dokazuje e2e/DB, ne ovaj sloj.
 */
describe("Talas C permission matrix (paritet živih 1.0 gate-ova)", () => {
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
    // AKTIVIRAN Talasom F (re-integracija 14.07): tehnicar_odrzavanja je sada u
    // ROLE_PERMISSIONS mapi → C-sloj (talasCGrants) mu daje montaza.read/izvestaji
    // (Montaža ungated). NE dobija ai.chat/VIEWER_READ_BASELINE (F ga drži maint-only).
    ROLES.TEHNICAR_ODRZAVANJA,
    ROLES.VIEWER,
  ];
  const PP_READ_ROLES = [
    ROLES.ADMIN,
    ROLES.LEADPM,
    ROLES.PM,
    ROLES.MENADZMENT,
    ROLES.HR,
    ROLES.VIEWER,
    ROLES.CNC_OPERATER,
    ROLES.TIM_LIDER,
    ROLES.PROIZVODNI_RADNIK,
  ];
  const MONTAZA_EDIT_ROLES = [
    ROLES.ADMIN,
    ROLES.LEADPM,
    ROLES.PM,
    ROLES.MENADZMENT,
    ROLES.TIM_LIDER,
  ];
  const PP_EDIT_ROLES = [ROLES.ADMIN, ROLES.PM, ROLES.MENADZMENT];
  const MGMT2 = [ROLES.ADMIN, ROLES.MENADZMENT];
  const ADMIN_ONLY = [ROLES.ADMIN];

  it.each(ACTIVE_ROLES)("%s ima montaza.read (Montaža ungated)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.MONTAZA_READ)).toBe(true);
    expect(roleHasPermission(role, PERMISSIONS.MONTAZA_IZVESTAJI)).toBe(true);
  });

  it.each(PP_READ_ROLES)(
    "%s ima plan_proizvodnje.read + pracenje.read (canAccessPlanProizvodnje)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_READ)).toBe(
        true,
      );
      expect(roleHasPermission(role, PERMISSIONS.PRACENJE_READ)).toBe(true);
    },
  );

  it("montaža ungated ali proizvodnja gated: sef/tehnolog/magacioner imaju montaza.read a NE plan_proizvodnje.read", () => {
    for (const role of [ROLES.SEF, ROLES.TEHNOLOG, ROLES.MAGACIONER]) {
      expect(roleHasPermission(role, PERMISSIONS.MONTAZA_READ)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_READ)).toBe(
        false,
      );
      expect(roleHasPermission(role, PERMISSIONS.PRACENJE_READ)).toBe(false);
    }
  });

  // PRESUDA C1 + C2 (task item #5): tim_lider IMA edit; hr/poslovni_admin NEMAJU.
  it.each(MONTAZA_EDIT_ROLES)("%s ima montaza.edit", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.MONTAZA_EDIT)).toBe(true);
  });
  it("C1: tim_lider IMA montaza.edit (1.0 bag-by-omission ispravljen)", () => {
    expect(roleHasPermission(ROLES.TIM_LIDER, PERMISSIONS.MONTAZA_EDIT)).toBe(
      true,
    );
  });
  it("C2: hr i poslovni_admin NEMAJU montaza.edit (has_edit_role širina ostaje u DB, ne u guardu)", () => {
    expect(roleHasPermission(ROLES.HR, PERMISSIONS.MONTAZA_EDIT)).toBe(false);
    expect(
      roleHasPermission(ROLES.POSLOVNI_ADMIN, PERMISSIONS.MONTAZA_EDIT),
    ).toBe(false);
  });

  it.each(PP_EDIT_ROLES)(
    "%s ima plan_proizvodnje.edit + pracenje.edit",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_EDIT)).toBe(
        true,
      );
      expect(roleHasPermission(role, PERMISSIONS.PRACENJE_EDIT)).toBe(true);
    },
  );
  it("leadpm ima montaza.edit ali NE plan_proizvodnje.edit (auth.js: canEdit vs canEditPlanProizvodnje)", () => {
    expect(roleHasPermission(ROLES.LEADPM, PERMISSIONS.MONTAZA_EDIT)).toBe(true);
    expect(
      roleHasPermission(ROLES.LEADPM, PERMISSIONS.PLAN_PROIZVODNJE_EDIT),
    ).toBe(false);
  });

  it.each(MGMT2)("%s ima force + manage", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_FORCE)).toBe(
      true,
    );
    expect(roleHasPermission(role, PERMISSIONS.PRACENJE_MANAGE)).toBe(true);
  });
  it("pm ima edit ali NE force/manage (can_edit ⊃ can_force/can_manage samo za mgmt)", () => {
    expect(roleHasPermission(ROLES.PM, PERMISSIONS.PLAN_PROIZVODNJE_EDIT)).toBe(
      true,
    );
    expect(roleHasPermission(ROLES.PM, PERMISSIONS.PLAN_PROIZVODNJE_FORCE)).toBe(
      false,
    );
    expect(roleHasPermission(ROLES.PM, PERMISSIONS.PRACENJE_MANAGE)).toBe(false);
  });

  it("koop_admin / prioritet / ai_admin = SAMO admin", () => {
    for (const perm of [
      PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN,
      PERMISSIONS.PRACENJE_PRIORITET,
      PERMISSIONS.MONTAZA_AI_ADMIN,
    ]) {
      expect(roleHasPermission(ROLES.ADMIN, perm)).toBe(true);
      for (const role of [ROLES.MENADZMENT, ROLES.PM, ROLES.HR, ROLES.VIEWER])
        expect(roleHasPermission(role, perm)).toBe(false);
    }
  });

  /**
   * KOMPLETNOST nad ALL_ROLE_KEYS (test-hardening): svaka permisija se dodeljuje TAČNO
   * očekivanom skupu — nijedna uloga VAN skupa je nema. Deferred/prelazno role
   * (tehnicar_odrzavanja/nabavka/kvalitet/prodaja/finansije/user) NISU u mapi → default-deny.
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

    it("montaza.read = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.MONTAZA_READ, ACTIVE_ROLES));
    it("montaza.izvestaji = TAČNO sve aktivne uloge", () =>
      expectedExactly(PERMISSIONS.MONTAZA_IZVESTAJI, ACTIVE_ROLES));
    it("plan_proizvodnje.read = TAČNO canAccessPlanProizvodnje", () =>
      expectedExactly(PERMISSIONS.PLAN_PROIZVODNJE_READ, PP_READ_ROLES));
    it("pracenje.read = TAČNO canAccessPlanProizvodnje", () =>
      expectedExactly(PERMISSIONS.PRACENJE_READ, PP_READ_ROLES));
    it("montaza.edit = TAČNO {admin,leadpm,pm,menadzment,tim_lider}", () =>
      expectedExactly(PERMISSIONS.MONTAZA_EDIT, MONTAZA_EDIT_ROLES));
    it("plan_proizvodnje.edit = TAČNO {admin,pm,menadzment}", () =>
      expectedExactly(PERMISSIONS.PLAN_PROIZVODNJE_EDIT, PP_EDIT_ROLES));
    it("pracenje.edit = TAČNO {admin,pm,menadzment}", () =>
      expectedExactly(PERMISSIONS.PRACENJE_EDIT, PP_EDIT_ROLES));
    it("plan_proizvodnje.force = TAČNO {admin,menadzment}", () =>
      expectedExactly(PERMISSIONS.PLAN_PROIZVODNJE_FORCE, MGMT2));
    it("pracenje.manage = TAČNO {admin,menadzment}", () =>
      expectedExactly(PERMISSIONS.PRACENJE_MANAGE, MGMT2));
    it("plan_proizvodnje.koop_admin = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN, ADMIN_ONLY));
    it("pracenje.prioritet = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.PRACENJE_PRIORITET, ADMIN_ONLY));
    it("montaza.ai_admin = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.MONTAZA_AI_ADMIN, ADMIN_ONLY));
  });

  it("nepoznata uloga = default deny (talas C)", () => {
    for (const perm of [
      PERMISSIONS.MONTAZA_READ,
      PERMISSIONS.MONTAZA_EDIT,
      PERMISSIONS.PLAN_PROIZVODNJE_READ,
      PERMISSIONS.PRACENJE_MANAGE,
    ]) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });

  it("regres-štit: dodavanje talas-C permisija NIJE oduzelo reversi/sastanci/ai dodele", () => {
    expect(roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.REVERSI_MANAGE)).toBe(
      true,
    );
    expect(roleHasPermission(ROLES.MENADZMENT, PERMISSIONS.SASTANCI_READ)).toBe(
      true,
    );
    expect(roleHasPermission(ROLES.MONTER, PERMISSIONS.AI_CHAT)).toBe(true);
  });
});
