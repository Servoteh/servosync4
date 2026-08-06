import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { SastanciSourceService } from "./sastanci-source.service";
import { PbSourceService } from "./pb-source.service";

/**
 * Prekidači izvora `SASTANCI_IZVOR` i `PB_IZVOR` — pin za tri stvari koje moraju
 * da važe:
 *
 *  1. pod „3.0" nijedan neprepisan put NE SME tiho da ode u sy15, a nepoznata
 *     vrednost NE SME da se protumači kao „3.0";
 *  2. 🔴 **prekidači su NEZAVISNI**. Do 06.08.2026 je postojao jedan zajednički
 *     (`SASTANCI_PB_IZVOR`); čim je na produkciji stao na `3.0`, ceo projektni
 *     biro je počeo da vraća 503 i posao `pb-notify-dispatch` je padao na svaka
 *     2 minuta, iako se selio samo domen sastanaka. Sve četiri kombinacije su
 *     zato ovde nabrojane, sa naglaskom na `sastanci=3.0 + pb=sy15`;
 *  3. zastareli naziv `SASTANCI_PB_IZVOR` pomera SAMO sastanke — PB ga ne čita,
 *     pa stari naziv više ne može da obori modul koji se ne seli.
 */

const ENVS = ["SASTANCI_IZVOR", "PB_IZVOR", "SASTANCI_PB_IZVOR"] as const;
const ORIG = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));

/** Čist start: nijedan prekidač nije postavljen. */
function reset(): void {
  for (const k of ENVS) delete process.env[k];
}

function postavi(v: Partial<Record<(typeof ENVS)[number], string>>): void {
  reset();
  for (const [k, val] of Object.entries(v)) process.env[k] = val;
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

describe("SastanciSourceService (SASTANCI_IZVOR)", () => {
  it("bez promenljive: podrazumevano sy15", () => {
    const s = new SastanciSourceService();
    expect(s.izvor).toBe("sy15");
    expect(s.isThreeZero).toBe(false);
  });

  it("sy15: brana ne radi ništa", () => {
    postavi({ SASTANCI_IZVOR: "sy15" });
    expect(() =>
      new SastanciSourceService().assertPorted("bilo šta"),
    ).not.toThrow();
  });

  it("3.0: prepoznat", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: "3.0" });
    const s = new SastanciSourceService();
    expect(s.izvor).toBe("3.0");
    expect(s.isThreeZero).toBe(true);
  });

  it("3.0: brana baca 503 sa imenom putanje i imenom SVOG prekidača", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: "3.0" });
    const s = new SastanciSourceService();
    expect(() => s.assertPorted("sastanci: lista")).toThrow(
      ServiceUnavailableException,
    );
    try {
      s.assertPorted("sastanci: lista");
    } catch (e) {
      // Poruka mora da kaže I šta je zapelo I kako se vraća — inače je 503 nem.
      expect((e as Error).message).toContain("sastanci: lista");
      expect((e as Error).message).toContain("SASTANCI_IZVOR=sy15");
      // NIKAD ne sme da uputi na PB prekidač — to je bio koren incidenta.
      expect((e as Error).message).not.toContain("PB_IZVOR");
    }
  });

  it.each(["3,0", "30", "3.0.0", "sy16", "true", "", "  "])(
    "nepoznata vrednost %p pada na sy15 (nikad na 3.0)",
    (v) => {
      hvatajWarn();
      postavi({ SASTANCI_IZVOR: v });
      const s = new SastanciSourceService();
      expect(s.izvor).toBe("sy15");
      expect(s.isThreeZero).toBe(false);
      expect(() => s.assertPorted("x")).not.toThrow();
    },
  );

  it("razmaci oko vrednosti se tolerišu", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: " 3.0 " });
    expect(new SastanciSourceService().isThreeZero).toBe(true);
    postavi({ SASTANCI_IZVOR: " sy15 " });
    expect(new SastanciSourceService().izvor).toBe("sy15");
  });
});

describe("PbSourceService (PB_IZVOR)", () => {
  it("bez promenljive: podrazumevano sy15 (PB se seli tek u koraku 4b)", () => {
    const s = new PbSourceService();
    expect(s.izvor).toBe("sy15");
    expect(s.isThreeZero).toBe(false);
    expect(() =>
      s.assertPorted("projektni biro: dispatch kroz sy15"),
    ).not.toThrow();
  });

  it("3.0: brana baca 503 sa imenom SVOG prekidača", () => {
    hvatajWarn();
    postavi({ PB_IZVOR: "3.0" });
    const s = new PbSourceService();
    expect(s.isThreeZero).toBe(true);
    try {
      s.assertPorted("projektni biro: dispatch kroz sy15");
      throw new Error("brana nije pukla");
    } catch (e) {
      expect((e as Error).message).toContain("projektni biro: dispatch");
      expect((e as Error).message).toContain("PB_IZVOR=sy15");
      expect((e as Error).message).not.toContain("SASTANCI_IZVOR");
    }
  });

  it.each(["3,0", "30", "sy16", "", "  "])(
    "nepoznata vrednost %p pada na sy15 (nikad na 3.0)",
    (v) => {
      hvatajWarn();
      postavi({ PB_IZVOR: v });
      expect(new PbSourceService().isThreeZero).toBe(false);
    },
  );
});

/*
 * 🔴 SVE ČETIRI KOMBINACIJE. Treća je scenario koji je 06.08.2026 pao na produkciji.
 */
describe("nezavisnost prekidača — 4 kombinacije (incident 06.08.2026)", () => {
  const par = () => ({
    sastanci: new SastanciSourceService(),
    pb: new PbSourceService(),
  });

  it("sy15 / sy15 (podrazumevano): oba na sy15, nijedna brana ne puca", () => {
    const { sastanci, pb } = par();
    expect(sastanci.izvor).toBe("sy15");
    expect(pb.izvor).toBe("sy15");
    expect(() => sastanci.assertPorted("x")).not.toThrow();
    expect(() => pb.assertPorted("x")).not.toThrow();
  });

  it("sy15 / 3.0: PB pada sa 503, sastanci NETAKNUTI", () => {
    hvatajWarn();
    postavi({ PB_IZVOR: "3.0" });
    const { sastanci, pb } = par();
    expect(sastanci.isThreeZero).toBe(false);
    expect(() => sastanci.assertPorted("x")).not.toThrow();
    expect(pb.isThreeZero).toBe(true);
    expect(() => pb.assertPorted("x")).toThrow(ServiceUnavailableException);
  });

  it("🔴 3.0 / sy15 (scenario koji je pao): sastanci u 3.0, PB radi normalno", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: "3.0" });
    const { sastanci, pb } = par();
    expect(sastanci.isThreeZero).toBe(true);
    expect(() => sastanci.assertPorted("x")).toThrow(
      ServiceUnavailableException,
    );
    // Cela poenta razdvajanja: PB ne sme ni da primeti preklop sastanaka.
    expect(pb.izvor).toBe("sy15");
    expect(pb.isThreeZero).toBe(false);
    expect(() =>
      pb.assertPorted("projektni biro: dispatch kroz sy15"),
    ).not.toThrow();
  });

  it("3.0 / 3.0: oba u 3.0, obe brane pucaju", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: "3.0", PB_IZVOR: "3.0" });
    const { sastanci, pb } = par();
    expect(sastanci.isThreeZero).toBe(true);
    expect(pb.isThreeZero).toBe(true);
    expect(() => sastanci.assertPorted("x")).toThrow(
      ServiceUnavailableException,
    );
    expect(() => pb.assertPorted("x")).toThrow(ServiceUnavailableException);
  });
});

describe("zastareli SASTANCI_PB_IZVOR — rezerva SAMO za sastanke", () => {
  it("3.0: pomera sastanke, PB ostaje na sy15 (incident se NE ponavlja)", () => {
    hvatajWarn();
    postavi({ SASTANCI_PB_IZVOR: "3.0" });
    expect(new SastanciSourceService().isThreeZero).toBe(true);
    expect(new PbSourceService().isThreeZero).toBe(false);
  });

  it("sy15: oba ostaju na sy15", () => {
    hvatajWarn();
    postavi({ SASTANCI_PB_IZVOR: "sy15" });
    expect(new SastanciSourceService().izvor).toBe("sy15");
    expect(new PbSourceService().izvor).toBe("sy15");
  });

  it("nov naziv NADJAČAVA stari (alias se čita samo kad SASTANCI_IZVOR nije zadat)", () => {
    hvatajWarn();
    postavi({ SASTANCI_IZVOR: "sy15", SASTANCI_PB_IZVOR: "3.0" });
    expect(new SastanciSourceService().izvor).toBe("sy15");
  });

  it("upotreba zastarelog naziva se GLASNO prijavljuje (oba servisa)", () => {
    const warn = hvatajWarn();
    postavi({ SASTANCI_PB_IZVOR: "3.0" });
    new SastanciSourceService();
    new PbSourceService();
    const poruke = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join(" || ");
    expect(poruke).toContain("ZASTAREO naziv");
    expect(poruke).toContain("SASTANCI_IZVOR");
    // PB mora da kaže ZAŠTO ga ignoriše — inače izgleda kao da prekidač ne radi.
    expect(poruke).toContain("NAMERNO ne čita");
  });

  it("poruka povratka nosi env koji je STVARNO dao vrednost (alias, ne novo ime)", () => {
    hvatajWarn();
    postavi({ SASTANCI_PB_IZVOR: "3.0" });
    try {
      new SastanciSourceService().assertPorted("sastanci: lista");
      throw new Error("brana nije pukla");
    } catch (e) {
      expect((e as Error).message).toContain("SASTANCI_PB_IZVOR=sy15");
    }
  });
});
