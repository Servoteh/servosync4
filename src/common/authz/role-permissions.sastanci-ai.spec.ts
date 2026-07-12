import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ALL_ROLE_KEYS, ROLES } from "./roles";

/**
 * Sastanci + AI permission matrica (MODULE_SPEC_sastanci_ai_30.md §2/§7 P6, presuda 12.07):
 * rola-sloj pariteta sa živim 1.0 gate-ovima —
 *   read        = canAccessSastanci  = admin/leadpm/pm/menadzment/hr/viewer
 *   edit        = has_edit_role       = admin/menadzment/hr/pm/leadpm/poslovni_admin
 *   manage      = current_user_is_management = admin/menadzment
 *   weekly_move = VIDLJIVOST (DB tabela sast_weekly_movers je istina) = admin/menadzment
 *   ai_model    = samo admin
 *   ai.chat     = SVE aktivne uloge (1.0 „/ai za sve")
 * Row-scope (učesnik/organizator-trio/pm_teme vidljivost/ai svoje-niti) dokazuje e2e/DB — ovde samo rola.
 */
describe("Sastanci + AI permission matrix (paritet 1.0 gate-ova)", () => {
  const READ_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.HR,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.VIEWER,
  ];
  const NOT_READ = [
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.CNC_PROGRAMER,
    ROLES.KONTROLOR,
    ROLES.MAGACIONER,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.NABAVKA_VIEW,
    ROLES.TIM_LIDER,
    ROLES.MONTER,
    ROLES.CNC_OPERATER,
    ROLES.POSLOVNI_ADMIN, // ima edit, ali NE read (nije u canAccessSastanci)
    // Presuda B6 (§7 P6): biro role NISU u canAccessSastanci — pin protiv regresije.
    ROLES.PROJEKTANT_VODJA,
    ROLES.INZENJER,
  ];
  const EDIT_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.HR,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.POSLOVNI_ADMIN,
  ];
  const MANAGE_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT];
  // sve uloge iz mape moraju imati ai.chat (1.0 /ai za sve)
  const AI_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.CNC_PROGRAMER,
    ROLES.KONTROLOR,
    ROLES.MAGACIONER,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.NABAVKA_VIEW,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.TIM_LIDER,
    ROLES.PROJEKTANT_VODJA,
    ROLES.INZENJER,
    ROLES.HR,
    ROLES.POSLOVNI_ADMIN,
    ROLES.CNC_OPERATER,
    ROLES.MONTER,
    ROLES.VIEWER,
  ];

  it.each(READ_ROLES)("%s ima sastanci.read (canAccessSastanci)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.SASTANCI_READ)).toBe(true);
  });
  it.each(NOT_READ)("%s NEMA sastanci.read", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.SASTANCI_READ)).toBe(false);
  });

  it.each(EDIT_ROLES)("%s ima sastanci.edit (has_edit_role)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.SASTANCI_EDIT)).toBe(true);
  });
  it("viewer ima read ali NE edit; poslovni_admin ima edit ali NE read (§2 asimetrija)", () => {
    expect(roleHasPermission(ROLES.VIEWER, PERMISSIONS.SASTANCI_READ)).toBe(
      true,
    );
    expect(roleHasPermission(ROLES.VIEWER, PERMISSIONS.SASTANCI_EDIT)).toBe(
      false,
    );
    expect(
      roleHasPermission(ROLES.POSLOVNI_ADMIN, PERMISSIONS.SASTANCI_EDIT),
    ).toBe(true);
    expect(
      roleHasPermission(ROLES.POSLOVNI_ADMIN, PERMISSIONS.SASTANCI_READ),
    ).toBe(false);
  });

  it.each(MANAGE_ROLES)("%s ima sastanci.manage + weekly_move", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.SASTANCI_MANAGE)).toBe(true);
    expect(roleHasPermission(role, PERMISSIONS.SASTANCI_WEEKLY_MOVE)).toBe(
      true,
    );
  });
  it("hr/pm/leadpm imaju edit ali NE manage", () => {
    for (const role of [ROLES.HR, ROLES.PM, ROLES.LEADPM]) {
      expect(roleHasPermission(role, PERMISSIONS.SASTANCI_EDIT)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.SASTANCI_MANAGE)).toBe(false);
    }
  });

  it("sastanci.ai_model ima SAMO admin", () => {
    expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.SASTANCI_AI_MODEL)).toBe(
      true,
    );
    for (const role of [ROLES.MENADZMENT, ROLES.HR, ROLES.PM, ROLES.VIEWER]) {
      expect(roleHasPermission(role, PERMISSIONS.SASTANCI_AI_MODEL)).toBe(
        false,
      );
    }
  });

  it.each(AI_ROLES)("%s ima ai.chat (1.0 /ai za sve)", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.AI_CHAT)).toBe(true);
  });

  /**
   * KOMPLETNOST nad ALL_ROLE_KEYS (test-hardening): svaka permisija se dodeljuje
   * TAČNO očekivanom skupu — nijedna uloga VAN skupa je nema. Bez ovoga, pogrešan
   * budući grant (npr. ai.chat → tehnicar_odrzavanja, ili weekly_move → hr) prolazi
   * neopaženo jer je manuelna lista bila samo pozitivna.
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

    it("sastanci.read = TAČNO canAccessSastanci skup", () =>
      expectedExactly(PERMISSIONS.SASTANCI_READ, READ_ROLES));
    it("sastanci.edit = TAČNO has_edit_role skup", () =>
      expectedExactly(PERMISSIONS.SASTANCI_EDIT, EDIT_ROLES));
    it("sastanci.manage = TAČNO {admin, menadzment}", () =>
      expectedExactly(PERMISSIONS.SASTANCI_MANAGE, MANAGE_ROLES));
    it("sastanci.weekly_move = TAČNO {admin, menadzment}", () =>
      expectedExactly(PERMISSIONS.SASTANCI_WEEKLY_MOVE, MANAGE_ROLES));
    it("sastanci.ai_model = TAČNO {admin}", () =>
      expectedExactly(PERMISSIONS.SASTANCI_AI_MODEL, [ROLES.ADMIN]));
    it("ai.chat = TAČNO AI_ROLES (tehnicar_odrzavanja/nabavka/… NEMAJU)", () =>
      expectedExactly(PERMISSIONS.AI_CHAT, AI_ROLES));
  });

  it("nepoznata uloga = default deny (sastanci.* i ai.chat)", () => {
    for (const perm of [
      PERMISSIONS.SASTANCI_READ,
      PERMISSIONS.SASTANCI_EDIT,
      PERMISSIONS.SASTANCI_MANAGE,
      PERMISSIONS.AI_CHAT,
    ]) {
      expect(roleHasPermission("nepostojeca", perm)).toBe(false);
    }
  });
});
