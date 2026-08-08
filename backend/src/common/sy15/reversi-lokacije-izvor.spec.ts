import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { ReversiSourceService } from "./reversi-source.service";
import { LokacijeSourceService } from "./lokacije-source.service";
import {
  assertSpojeniIzvori,
  RAZDVOJI_REVERSE_I_LOKACIJE,
} from "./spojeni-izvori";

/**
 * Prekidači `REVERSI_IZVOR` i `LOKACIJE_IZVOR` — pin za četiri stvari:
 *
 *  1. pod „3.0" nijedan neprepisan put NE SME tiho da ode u sy15, a nepoznata
 *     vrednost NE SME da se protumači kao „3.0";
 *  2. 🔴 vrednosti MORAJU biti iste. Ova dva domena su transakciono spojena
 *     (izmereno 07.08.2026: izdavanje alata u istom commit-u piše
 *     `rev_document_lines` i `loc_location_movements`), pa razdvojen preklop ne
 *     obara modul — on TIHO razilazi dve baze, što je gora klasa kvara;
 *  3. sprega se ne sme „popraviti" tako što jedan prekidač gazi drugi — svaki
 *     domen i dalje čita SVOJE ime env-a i u poruci navodi SEBE (pouka 06.08.2026,
 *     `SASTANCI_PB_IZVOR`);
 *  4. razdvajanje je moguće SAMO uz izričitu, imenovanu promenljivu.
 */

const ENVS = [
  "REVERSI_IZVOR",
  "LOKACIJE_IZVOR",
  RAZDVOJI_REVERSE_I_LOKACIJE,
  "SASTANCI_PB_IZVOR",
] as const;
const ORIG = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));

function reset(): void {
  for (const k of ENVS) delete process.env[k];
}

beforeEach(reset);
afterEach(() => {
  for (const k of ENVS) {
    const o = ORIG[k];
    if (o === undefined) delete process.env[k];
    else process.env[k] = o;
  }
  jest.restoreAllMocks();
});

/** Upozorenja iz konstruktora — hvatamo ih da ne zagade izlaz testa. */
function hvatajWarn(): jest.SpyInstance {
  return jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation((): void => undefined);
}

describe("ReversiSourceService (REVERSI_IZVOR)", () => {
  it("bez promenljive: podrazumevano sy15", () => {
    expect(new ReversiSourceService().izvor).toBe("sy15");
  });

  it("REVERSI_IZVOR=3.0 prebacuje izvor", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    const s = new ReversiSourceService();
    expect(s.izvor).toBe("3.0");
    expect(s.isThreeZero).toBe(true);
  });

  it("nepoznata vrednost pada na sy15, NIKAD na 3.0", () => {
    const warn = hvatajWarn();
    process.env.REVERSI_IZVOR = "3,0";
    expect(new ReversiSourceService().izvor).toBe("sy15");
    expect(warn).toHaveBeenCalled();
  });

  it("assertPorted pod sy15 ne radi ništa, pod 3.0 baca 503 sa imenom putanje", () => {
    hvatajWarn();
    expect(() =>
      new ReversiSourceService().assertPorted("issueReversal"),
    ).not.toThrow();

    process.env.REVERSI_IZVOR = "3.0";
    const s = new ReversiSourceService();
    expect(() => s.assertPorted("issueReversal")).toThrow(
      ServiceUnavailableException,
    );
    try {
      s.assertPorted("issueReversal");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("issueReversal");
      expect(msg).toContain("REVERSI_IZVOR=sy15");
      // Domen se imenuje SOBOM — pouka 06.08.2026.
      expect(msg).toContain("Reversi");
    }
  });

  it("zastareli SASTANCI_PB_IZVOR ga NE pomera", () => {
    process.env.SASTANCI_PB_IZVOR = "3.0";
    expect(new ReversiSourceService().izvor).toBe("sy15");
  });
});

describe("LokacijeSourceService (LOKACIJE_IZVOR)", () => {
  it("bez promenljive: podrazumevano sy15", () => {
    expect(new LokacijeSourceService().izvor).toBe("sy15");
  });

  it("LOKACIJE_IZVOR=3.0 prebacuje izvor", () => {
    hvatajWarn();
    process.env.LOKACIJE_IZVOR = "3.0";
    expect(new LokacijeSourceService().isThreeZero).toBe(true);
  });

  it("REVERSI_IZVOR ga NE pomera — svaki domen čita svoje ime", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    expect(new LokacijeSourceService().izvor).toBe("sy15");
  });

  it("503 poruka imenuje LOKACIJE, ne reverse", () => {
    hvatajWarn();
    process.env.LOKACIJE_IZVOR = "3.0";
    const s = new LokacijeSourceService();
    try {
      s.assertPorted("createMovement");
      throw new Error("trebalo je da baci");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Lokacije delova");
      expect(msg).toContain("LOKACIJE_IZVOR=sy15");
    }
  });
});

describe("🔴 sprega REVERSI <-> LOKACIJE (assertSpojeniIzvori)", () => {
  function par(): [ReversiSourceService, LokacijeSourceService] {
    return [new ReversiSourceService(), new LokacijeSourceService()];
  }

  it("obe na sy15: prolazi", () => {
    const [r, l] = par();
    expect(() => assertSpojeniIzvori(r, l)).not.toThrow();
  });

  it("obe na 3.0: prolazi", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    process.env.LOKACIJE_IZVOR = "3.0";
    const [r, l] = par();
    expect(() => assertSpojeniIzvori(r, l)).not.toThrow();
  });

  it("🔴 reversi=3.0 + lokacije=sy15: PUCA (presečena transakcija)", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    const [r, l] = par();
    expect(() => assertSpojeniIzvori(r, l)).toThrow(/transakciono spojena/);
  });

  it("🔴 lokacije=3.0 + reversi=sy15: PUCA i u tom smeru", () => {
    hvatajWarn();
    process.env.LOKACIJE_IZVOR = "3.0";
    const [r, l] = par();
    expect(() => assertSpojeniIzvori(r, l)).toThrow(/transakciono spojena/);
  });

  it("poruka o neslaganju nosi OBE vrednosti i uputstvo za povratak", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    const [r, l] = par();
    try {
      assertSpojeniIzvori(r, l);
      throw new Error("trebalo je da baci");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('REVERSI_IZVOR="3.0"');
      expect(msg).toContain('LOKACIJE_IZVOR="sy15"');
      expect(msg).toContain(RAZDVOJI_REVERSE_I_LOKACIJE);
    }
  });

  it("razdvajanje prolazi SAMO uz izričitu promenljivu, i to uz upozorenje", () => {
    const warn = hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    process.env[RAZDVOJI_REVERSE_I_LOKACIJE] = "true";
    const [r, l] = par();
    expect(() => assertSpojeniIzvori(r, l)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(RAZDVOJI_REVERSE_I_LOKACIJE),
    );
  });

  it("bilo šta osim tačno 'true' NE otključava razdvajanje", () => {
    hvatajWarn();
    process.env.REVERSI_IZVOR = "3.0";
    for (const v of ["1", "da", "yes", "TRUE ", ""]) {
      process.env[RAZDVOJI_REVERSE_I_LOKACIJE] = v;
      const [r, l] = par();
      if (v.trim().toLowerCase() === "true") continue;
      expect(() => assertSpojeniIzvori(r, l)).toThrow();
    }
  });
});
