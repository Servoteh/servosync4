import {
  applyOverrides,
  resolvePermissionDecision,
  salaryEmailAllowed,
  type EffectivePermissionDb,
} from "./effective-permission";
import { PERMISSIONS as P } from "./permissions";
import { ROLES } from "./roles";
import { permissionsForRoles } from "./role-permissions";

const NENAD = "nenad.jarakovic@servoteh.com";
const NEVENA = "nevena.knezevic@servoteh.com";
const ZORAN = "zoran.jarakovic@servoteh.com"; // admin u 3.0, NE na salary allowlisti

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

/**
 * TVRDA BRAVA NA ZARADE (odluka vlasnika 21.07): `kadrovska.salary` sme ISKLJUČIVO
 * allowlisti (Nenad+Nevena), nezavisno od role/override. Presuđuje iznad admin role
 * i iznad grant override-a — čak i posle rola-sync-a koji nekog učini adminom.
 */
describe("tvrda salary-brava (kadrovska.salary samo allowlisti)", () => {
  const SALARY = P.KADROVSKA_SALARY;
  const origEnv = process.env.KADROVSKA_SALARY_ALLOWLIST;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.KADROVSKA_SALARY_ALLOWLIST;
    else process.env.KADROVSKA_SALARY_ALLOWLIST = origEnv;
  });

  it("salaryEmailAllowed: default (Nenad+Nevena) bez env-a", () => {
    delete process.env.KADROVSKA_SALARY_ALLOWLIST;
    expect(salaryEmailAllowed(NENAD)).toBe(true);
    expect(salaryEmailAllowed(NEVENA)).toBe(true);
    expect(salaryEmailAllowed(ZORAN)).toBe(false);
    expect(salaryEmailAllowed(undefined)).toBe(false);
    expect(salaryEmailAllowed("NENAD.JARAKOVIC@servoteh.com")).toBe(true); // case-insens
  });

  it("resolvePermissionDecision: admin rola NE otvara salary ne-allowlisti (deny)", async () => {
    const { m } = dbMock(null);
    const d = await resolvePermissionDecision(
      asDb(m),
      1,
      ROLES.ADMIN, // admin ima ALL uklj. salary
      SALARY,
      ZORAN,
    );
    expect(d).toBe("deny"); // brava presuđuje pre role
  });

  it("resolvePermissionDecision: admin + allowlist email → allow", async () => {
    const { m } = dbMock(null);
    const d = await resolvePermissionDecision(
      asDb(m),
      1,
      ROLES.ADMIN,
      SALARY,
      NENAD,
    );
    expect(d).toBe("allow");
  });

  it("resolvePermissionDecision: GRANT override NE otvara salary ne-allowlisti (brava > grant)", async () => {
    const { m } = dbMock({ allow: true });
    const d = await resolvePermissionDecision(
      asDb(m),
      2,
      ROLES.HR,
      SALARY,
      ZORAN,
    );
    expect(d).toBe("deny");
  });

  it("applyOverrides: admin-set BEZ salary za ne-allowlist email", () => {
    const adminPerms = permissionsForRoles([ROLES.ADMIN]);
    expect(adminPerms).toContain(SALARY); // admin rola daje salary…
    const out = applyOverrides(adminPerms, [], ZORAN);
    expect(out).not.toContain(SALARY); // …ali brava ga skida za Zorana
  });

  it("applyOverrides: admin + allowlist email → salary ostaje", () => {
    const adminPerms = permissionsForRoles([ROLES.ADMIN]);
    const out = applyOverrides(adminPerms, [], NEVENA);
    expect(out).toContain(SALARY);
  });

  it("env allowlist override-uje default", () => {
    process.env.KADROVSKA_SALARY_ALLOWLIST =
      "  X@Y.com , zoran.jarakovic@servoteh.com ";
    expect(salaryEmailAllowed(ZORAN)).toBe(true); // sad je na listi
    expect(salaryEmailAllowed(NENAD)).toBe(false); // više nije (env je zamenio default)
  });

  it("prazan env → pada na default (ne zaključava Nenada/Nevenu)", () => {
    process.env.KADROVSKA_SALARY_ALLOWLIST = "   ";
    expect(salaryEmailAllowed(NENAD)).toBe(true);
    expect(salaryEmailAllowed(ZORAN)).toBe(false);
  });
});
