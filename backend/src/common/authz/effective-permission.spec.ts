import {
  resolvePermissionDecision,
  type EffectivePermissionDb,
} from "./effective-permission";
import { PERMISSIONS as P } from "./permissions";
import { ROLES } from "./roles";

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
