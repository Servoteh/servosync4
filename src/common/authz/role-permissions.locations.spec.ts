import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ROLES } from "./roles";

/**
 * Lokacije permission matrica (MODULE_SPEC_lokacije_30.md §2) — rola-sloj pariteta
 * sa živom 1.0 politikom (4 authz nivoa + labels, snapshot 12.07):
 *  - read = „svi prijavljeni" (select true) → SVE aktivne uloge
 *  - move = loc_can_create_movement() → SVE aktivne uloge na guard-sloju (row-odluku
 *           „manage ILI aktivan zaposleni" donosi DB fn kroz GUC — širina OSTAJE u bazi)
 *  - manage = loc_can_manage_locations() → admin, menadzment, pm, leadpm
 *  - admin  = loc_is_admin() → SAMO admin
 *  - labels = 1.0 canPrintLocLabels() → manage role + magacioner + cnc_operater
 */
describe("Lokacije permission matrix (paritet loc_* politike)", () => {
  // Sve uloge koje kroz SSO ulaze u 2.0 → read + move (kao reversi.read pokrivenost).
  const READ_MOVE_ROLES = [
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
  const MANAGE_ROLES = [ROLES.ADMIN, ROLES.MENADZMENT, ROLES.PM, ROLES.LEADPM];
  const NOT_MANAGE = [
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.MAGACIONER,
    ROLES.KONTROLOR,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.CNC_OPERATER,
    ROLES.NABAVKA_VIEW,
    ROLES.TIM_LIDER,
    ROLES.VIEWER,
  ];
  const LABELS_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.MAGACIONER,
    ROLES.CNC_OPERATER,
  ];
  const NOT_LABELS = [
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.CNC_PROGRAMER,
    ROLES.KONTROLOR,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.NABAVKA_VIEW,
    ROLES.VIEWER,
    ROLES.TIM_LIDER,
    ROLES.HR,
  ];

  it.each(READ_MOVE_ROLES)("%s ima lokacije.read + lokacije.move", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_READ)).toBe(true);
    expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_MOVE)).toBe(true);
  });

  it.each(MANAGE_ROLES)(
    "%s ima lokacije.manage (loc_can_manage_locations paritet)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_MANAGE)).toBe(true);
    },
  );

  it.each(NOT_MANAGE)("%s NEMA lokacije.manage", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_MANAGE)).toBe(false);
  });

  it("lokacije.admin ima SAMO admin (loc_is_admin) — ni menadzment/pm/leadpm", () => {
    expect(roleHasPermission(ROLES.ADMIN, PERMISSIONS.LOKACIJE_ADMIN)).toBe(
      true,
    );
    for (const role of [
      ROLES.MENADZMENT,
      ROLES.PM,
      ROLES.LEADPM,
      ROLES.MAGACIONER,
    ]) {
      expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_ADMIN)).toBe(false);
    }
  });

  it.each(LABELS_ROLES)(
    "%s ima lokacije.labels (canPrintLocLabels paritet)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_LABELS)).toBe(true);
    },
  );

  it.each(NOT_LABELS)("%s NEMA lokacije.labels", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.LOKACIJE_LABELS)).toBe(false);
  });

  it("magacioner: labels + move, ali NE manage/admin (spec §2)", () => {
    expect(
      roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.LOKACIJE_LABELS),
    ).toBe(true);
    expect(roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.LOKACIJE_MOVE)).toBe(
      true,
    );
    expect(
      roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.LOKACIJE_MANAGE),
    ).toBe(false);
    expect(
      roleHasPermission(ROLES.MAGACIONER, PERMISSIONS.LOKACIJE_ADMIN),
    ).toBe(false);
  });

  it("nepoznata uloga = default deny", () => {
    expect(roleHasPermission("nepostojeca", PERMISSIONS.LOKACIJE_READ)).toBe(
      false,
    );
    expect(roleHasPermission("nepostojeca", PERMISSIONS.LOKACIJE_MOVE)).toBe(
      false,
    );
  });
});
