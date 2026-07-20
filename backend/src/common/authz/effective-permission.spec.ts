import {
  applyOverrides,
  resolvePermissionDecision,
  type EffectivePermissionDb,
} from "./effective-permission";
import { PERMISSIONS as P } from "./permissions";
import { ROLES } from "./roles";
import { permissionsForRoles } from "./role-permissions";

/** Mock db — samo userPermissionOverride.findUnique koji helper dira. */
function dbMock(override: { allow: boolean } | null = null) {
  const findUnique = jest.fn().mockResolvedValue(override);
  return { m: { userPermissionOverride: { findUnique } }, findUnique };
}

const asDb = (m: { userPermissionOverride: { findUnique: jest.Mock } }) =>
  m as unknown as EffectivePermissionDb;

// menadzment IMA primopredaje.approve; inzenjer NEMA (ima samo write).
const APPROVE = P.PRIMOPREDAJE_APPROVE;

describe("resolvePermissionDecision (deny > grant > rola)", () => {
  it("rola daje + nema override → allow", async () => {
    const { m } = dbMock(null);
    const d = await resolvePermissionDecision(
      asDb(m),
      1,
      ROLES.MENADZMENT,
      APPROVE,
    );
    expect(d).toBe("allow");
  });

  it("rola daje ali DENY override → deny (deny beat rola)", async () => {
    const { m } = dbMock({ allow: false });
    const d = await resolvePermissionDecision(
      asDb(m),
      1,
      ROLES.MENADZMENT,
      APPROVE,
    );
    expect(d).toBe("deny");
  });

  it("rola NE daje + GRANT override → allow (grant tačno tom useru)", async () => {
    const { m, findUnique } = dbMock({ allow: true });
    const d = await resolvePermissionDecision(
      asDb(m),
      2206,
      ROLES.INZENJER,
      APPROVE,
    );
    expect(d).toBe("allow");
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId_key: { userId: 2206, key: APPROVE } },
      select: { allow: true },
    });
  });

  it("rola NE daje + nema override → deny", async () => {
    const { m } = dbMock(null);
    const d = await resolvePermissionDecision(
      asDb(m),
      2206,
      ROLES.INZENJER,
      APPROVE,
    );
    expect(d).toBe("deny");
  });

  it("rola NE daje + DENY override → deny (idempotentno)", async () => {
    const { m } = dbMock({ allow: false });
    const d = await resolvePermissionDecision(
      asDb(m),
      2206,
      ROLES.INZENJER,
      APPROVE,
    );
    expect(d).toBe("deny");
  });

  it("nepoznata rola + GRANT override → allow (override je jedini izvor)", async () => {
    const { m } = dbMock({ allow: true });
    const d = await resolvePermissionDecision(asDb(m), 9, "user", APPROVE);
    expect(d).toBe("allow");
  });
});

/**
 * Bulk merge za /auth/me/permissions — MORA da se slaže sa resolvePermissionDecision
 * (deny > grant > rola) da FE `can()` i backend 403 nikad ne divergiraju. Kanonski
 * slučaj: `kadrovska.grid_edit` ne ide nijednoj roli (allowlist ključ, spec §2.5) —
 * HR sa override grantom ga MORA videti (incident: zaključan mesečni grid 20.07.2026).
 */
describe("applyOverrides (bulk /me/permissions merge)", () => {
  const GRID_EDIT = P.KADROVSKA_GRID_EDIT;

  it("bez override-a → rola-set netaknut", () => {
    const rolePerms = permissionsForRoles([ROLES.HR]);
    expect(applyOverrides(rolePerms, [])).toEqual([...rolePerms]);
  });

  it("GRANT dodaje ključ koji rola nema (hr + grid_edit override → vidi grid_edit)", () => {
    const rolePerms = permissionsForRoles([ROLES.HR]);
    expect(rolePerms).not.toContain(GRID_EDIT); // pretpostavka: allowlist ključ nije u roli
    const out = applyOverrides(rolePerms, [{ key: GRID_EDIT, allow: true }]);
    expect(out).toContain(GRID_EDIT);
  });

  it("DENY skida ključ koji rola daje (deny beat rola)", () => {
    const rolePerms = permissionsForRoles([ROLES.HR]);
    expect(rolePerms).toContain(P.KADROVSKA_EDIT);
    const out = applyOverrides(rolePerms, [
      { key: P.KADROVSKA_EDIT, allow: false },
    ]);
    expect(out).not.toContain(P.KADROVSKA_EDIT);
  });

  it("mešano: grant + deny u istom pozivu, ostatak seta netaknut", () => {
    const rolePerms = permissionsForRoles([ROLES.HR]);
    const out = applyOverrides(rolePerms, [
      { key: GRID_EDIT, allow: true },
      { key: P.KADROVSKA_EDIT, allow: false },
    ]);
    expect(out).toContain(GRID_EDIT);
    expect(out).not.toContain(P.KADROVSKA_EDIT);
    expect(out).toContain(P.KADROVSKA_READ); // netaknut rola-grant
  });
});
