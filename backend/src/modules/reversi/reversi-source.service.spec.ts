import { ServiceUnavailableException } from "@nestjs/common";
import { ReversiSourceService } from "./reversi-source.service";

/**
 * Prekidač izvora reversa (`REVERSI_IZVOR`).
 *
 * Suština koja se ovde meri: prekidač mora da GREŠI NA STRANU sy15. Svaka vrednost
 * koja nije tačno "3.0" ostavlja sistem na staroj bazi — jer je pogrešno protumačen
 * prekidač (npr. "3,0", "true", prazan string) opasniji od nikakvog prekidača:
 * upisi bi otišli u jednu bazu, čitanja u drugu, i to se ne bi videlo odmah.
 */
describe("ReversiSourceService", () => {
  const original = process.env.REVERSI_IZVOR;

  afterEach(() => {
    if (original === undefined) delete process.env.REVERSI_IZVOR;
    else process.env.REVERSI_IZVOR = original;
  });

  function make(value?: string): ReversiSourceService {
    if (value === undefined) delete process.env.REVERSI_IZVOR;
    else process.env.REVERSI_IZVOR = value;
    return new ReversiSourceService();
  }

  it("bez promenljive koristi sy15 (bezbedan default)", () => {
    const s = make(undefined);
    expect(s.izvor).toBe("sy15");
    expect(s.isThreeZero).toBe(false);
  });

  it('"sy15" ostaje sy15', () => {
    expect(make("sy15").izvor).toBe("sy15");
  });

  it('"3.0" prebacuje izvor', () => {
    const s = make("3.0");
    expect(s.izvor).toBe("3.0");
    expect(s.isThreeZero).toBe(true);
  });

  it("prazan string pada na sy15, ne na 3.0", () => {
    expect(make("").izvor).toBe("sy15");
  });

  it.each(["3,0", "3", "true", "30", "SY15", "prod", "yes"])(
    'neprepoznata vrednost "%s" pada na sy15',
    (v) => {
      expect(make(v).izvor).toBe("sy15");
    },
  );

  it("okolni razmaci se tolerišu", () => {
    expect(make("  3.0  ").izvor).toBe("3.0");
    expect(make("  sy15 ").izvor).toBe("sy15");
  });

  describe("assertPorted", () => {
    it("pod sy15 propušta sve (ponašanje pre seobe je netaknuto)", () => {
      const s = make("sy15");
      expect(() => s.assertPorted("bilo sta")).not.toThrow();
    });

    it("pod 3.0 baca 503 sa imenom putanje u poruci", () => {
      const s = make("3.0");
      expect(() => s.assertPorted("reports/machines")).toThrow(
        ServiceUnavailableException,
      );
      try {
        s.assertPorted("reports/machines");
        fail("očekivan izuzetak");
      } catch (e) {
        expect((e as Error).message).toContain("reports/machines");
        // Poruka mora da kaže KAKO se vraća — runbook u glavi operatera, ne u dokumentu.
        expect((e as Error).message).toContain("REVERSI_IZVOR=sy15");
      }
    });
  });
});
