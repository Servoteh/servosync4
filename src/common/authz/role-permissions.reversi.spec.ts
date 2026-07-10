import { PERMISSIONS } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ROLES } from "./roles";

/**
 * Reversi permission matrica (MODULE_SPEC_reversi.md §8) — rola-sloj pariteta sa
 * živom 1.0 politikom (snapshot 10.07, 0 drift vs sy15):
 *  - `rev_can_manage()` = admin, menadzment, pm, leadpm, magacioner → reversi.manage
 *  - SELECT za sve prijavljene → reversi.read za SVE aktivne uloge
 *  - team scope (get_team_issued_tools) → sef, tim_lider, menadzment, admin
 * Row-scope („moji"/„tim" redovi) dokazuje e2e matrica u R2 — ovde samo rola-sloj.
 */
describe("Reversi permission matrix (paritet rev_can_manage)", () => {
  const MANAGE_ROLES = [
    ROLES.ADMIN,
    ROLES.MENADZMENT,
    ROLES.PM,
    ROLES.LEADPM,
    ROLES.MAGACIONER,
  ];
  const READ_ONLY_ROLES = [
    ROLES.SEF,
    ROLES.TEHNOLOG,
    ROLES.CNC_PROGRAMER,
    ROLES.KONTROLOR,
    ROLES.PROIZVODNI_RADNIK,
    ROLES.NABAVKA_VIEW,
    ROLES.VIEWER,
  ];

  it.each(MANAGE_ROLES)(
    "%s ima reversi.manage (rev_can_manage paritet)",
    (role) => {
      expect(roleHasPermission(role, PERMISSIONS.REVERSI_MANAGE)).toBe(true);
      expect(roleHasPermission(role, PERMISSIONS.REVERSI_READ)).toBe(true);
    },
  );

  it.each(READ_ONLY_ROLES)("%s ima reversi.read ali NE manage", (role) => {
    expect(roleHasPermission(role, PERMISSIONS.REVERSI_READ)).toBe(true);
    expect(roleHasPermission(role, PERMISSIONS.REVERSI_MANAGE)).toBe(false);
  });

  it("team_read imaju sef/tim_lider/menadzment/admin, a NE magacioner/radnik/viewer", () => {
    for (const role of [
      ROLES.SEF,
      ROLES.TIM_LIDER,
      ROLES.MENADZMENT,
      ROLES.ADMIN,
    ]) {
      expect(roleHasPermission(role, PERMISSIONS.REVERSI_TEAM_READ)).toBe(true);
    }
    for (const role of [
      ROLES.MAGACIONER,
      ROLES.PROIZVODNI_RADNIK,
      ROLES.VIEWER,
    ]) {
      expect(roleHasPermission(role, PERMISSIONS.REVERSI_TEAM_READ)).toBe(
        false,
      );
    }
  });

  it("nepoznata uloga = default deny", () => {
    expect(roleHasPermission("nepostojeca", PERMISSIONS.REVERSI_READ)).toBe(
      false,
    );
  });
});
