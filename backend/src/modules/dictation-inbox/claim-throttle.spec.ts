import {
  CLAIM_THROTTLE_POLICY,
  __resetClaimThrottle,
  recordClaimAttempt,
} from "./claim-throttle";

describe("claim-throttle", () => {
  beforeEach(() => __resetClaimThrottle());

  it("prvih MAX_CLAIMS poziva prolazi (0 = dozvoljeno)", () => {
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      expect(recordClaimAttempt(42, 1_000)).toBe(0);
    }
  });

  it("preko granice vraća broj sekundi čekanja (> 0)", () => {
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      recordClaimAttempt(42, 1_000);
    }
    const wait = recordClaimAttempt(42, 1_000);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(CLAIM_THROTTLE_POLICY.WINDOW_MS / 1000);
  });

  it("nov prozor resetuje brojač", () => {
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      recordClaimAttempt(42, 1_000);
    }
    expect(recordClaimAttempt(42, 1_000)).toBeGreaterThan(0);
    // Posle isteka prozora brojanje kreće ispočetka.
    expect(
      recordClaimAttempt(42, 1_000 + CLAIM_THROTTLE_POLICY.WINDOW_MS + 1),
    ).toBe(0);
  });

  it("brojač je PO NALOGU — jedan agent ne blokira drugog", () => {
    for (let i = 0; i < CLAIM_THROTTLE_POLICY.MAX_CLAIMS; i++) {
      recordClaimAttempt(42, 1_000);
    }
    expect(recordClaimAttempt(42, 1_000)).toBeGreaterThan(0);
    expect(recordClaimAttempt(43, 1_000)).toBe(0);
  });
});
