import { ServiceUnavailableException } from "@nestjs/common";
import { SastanciPbSourceService } from "./sastanci-pb-source.service";

/**
 * Prekidač `SASTANCI_PB_IZVOR` — pin za jedinu stvar koja mora da važi:
 * pod „3.0" nijedan neprepisan put NE SME tiho da ode u sy15, a nepoznata
 * vrednost NE SME da se protumači kao „3.0".
 */
describe("SastanciPbSourceService", () => {
  const orig = process.env.SASTANCI_PB_IZVOR;

  const make = (v: string | undefined): SastanciPbSourceService => {
    if (v === undefined) delete process.env.SASTANCI_PB_IZVOR;
    else process.env.SASTANCI_PB_IZVOR = v;
    return new SastanciPbSourceService();
  };

  afterEach(() => {
    if (orig === undefined) delete process.env.SASTANCI_PB_IZVOR;
    else process.env.SASTANCI_PB_IZVOR = orig;
  });

  it("bez promenljive: podrazumevano sy15", () => {
    const s = make(undefined);
    expect(s.izvor).toBe("sy15");
    expect(s.isThreeZero).toBe(false);
  });

  it("sy15: brana ne radi ništa", () => {
    const s = make("sy15");
    expect(() => s.assertPorted("bilo šta")).not.toThrow();
  });

  it("3.0: prepoznat", () => {
    const s = make("3.0");
    expect(s.izvor).toBe("3.0");
    expect(s.isThreeZero).toBe(true);
  });

  it("3.0: brana baca 503 sa imenom putanje", () => {
    const s = make("3.0");
    expect(() => s.assertPorted("sastanci: lista")).toThrow(
      ServiceUnavailableException,
    );
    try {
      s.assertPorted("sastanci: lista");
    } catch (e) {
      // Poruka mora da kaže I šta je zapelo I kako se vraća — inače je 503 nem.
      expect((e as Error).message).toContain("sastanci: lista");
      expect((e as Error).message).toContain("SASTANCI_PB_IZVOR=sy15");
    }
  });

  it.each(["3,0", "30", "3.0.0", "sy16", "true", "", "  "])(
    "nepoznata vrednost %p pada na sy15 (nikad na 3.0)",
    (v) => {
      const s = make(v);
      expect(s.izvor).toBe("sy15");
      expect(s.isThreeZero).toBe(false);
      expect(() => s.assertPorted("x")).not.toThrow();
    },
  );

  it("razmaci oko vrednosti se tolerišu", () => {
    expect(make(" 3.0 ").isThreeZero).toBe(true);
    expect(make(" sy15 ").izvor).toBe("sy15");
  });
});
