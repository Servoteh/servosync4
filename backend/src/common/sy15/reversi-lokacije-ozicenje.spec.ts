import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ReversiLokacijeIzvorModule } from "./reversi-lokacije-izvor.module";
import { ReversiSourceService } from "./reversi-source.service";
import { LokacijeSourceService } from "./lokacije-source.service";
import type { Sy15Service } from "./sy15.service";
import { ReversiService } from "../../modules/reversi/reversi.service";
import { ReversiModule } from "../../modules/reversi/reversi.module";
import { LocationsService } from "../../modules/locations/locations.service";
import { LocationsModule } from "../../modules/locations/locations.module";
import type { LabelPrintService } from "../printing/label-print.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * 🔴 OŽIČENJE prekidača `REVERSI_IZVOR` / `LOKACIJE_IZVOR` — ne sama funkcija.
 *
 * ZAŠTO OVAJ FAJL POSTOJI (protivnička provera 08.08.2026, NALAZ 1 i 2):
 * `reversi-lokacije-izvor.spec.ts` pinuje ČISTU funkciju `assertSpojeniIzvori()` i
 * ponašanje `IzvorPrekidac`-a. Mutaciona proba je pokazala da to NIJE dovoljno:
 *
 *   • izbačen poziv `assertSpojeniIzvori(...)` iz `onModuleInit`   → 83/83 prolazi
 *   • izbačen `ReversiLokacijeIzvorModule` iz oba modula           → 336/336 prolazi
 *
 * Drugim rečima, prekidač je mogao da bude MRTAV, a testovi zeleni. Ovaj fajl
 * pinuje lanac od env-a do 503:
 *
 *   1. modul se STVARNO podiže i brana radi u `onModuleInit` (`Test…init()`),
 *   2. `ReversiModule` / `LocationsModule` STVARNO uvoze prekidače,
 *   3. `ReversiService` / `LocationsService` STVARNO primaju prekidač u konstruktor,
 *   4. pod `3.0` stvaran poziv rute vraća 503 (a pod `sy15` radi kao i do sada),
 *   5. nijedan pristup sy15 podacima ne zaobilazi branu (statička disciplina,
 *      obrazac iz `odrzavanje.set-role-discipline.spec.ts`).
 */

const ENVS = ["REVERSI_IZVOR", "LOKACIJE_IZVOR"] as const;
const ORIG = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of ENVS) delete process.env[k];
  jest
    .spyOn(Logger.prototype, "warn")
    .mockImplementation((): void => undefined);
});

afterEach(() => {
  for (const k of ENVS) {
    const o = ORIG[k];
    if (o === undefined) delete process.env[k];
    else process.env[k] = o;
  }
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Brana STVARNO radi pri podizanju modula (a ne samo kao pozvana funkcija)
// ---------------------------------------------------------------------------
describe("ReversiLokacijeIzvorModule — brana u onModuleInit", () => {
  async function podigni(): Promise<{ close: () => Promise<void> }> {
    const moduleRef = await Test.createTestingModule({
      imports: [ReversiLokacijeIzvorModule],
    }).compile();
    return moduleRef.init();
  }

  it("obe vrednosti iste (sy15, podrazumevano): modul se podiže", async () => {
    const app = await podigni();
    await app.close();
  });

  it("obe vrednosti iste (3.0): modul se podiže", async () => {
    process.env.REVERSI_IZVOR = "3.0";
    process.env.LOKACIJE_IZVOR = "3.0";
    const app = await podigni();
    await app.close();
  });

  it("🔴 reversi=3.0 + lokacije=sy15: PODIZANJE PADA", async () => {
    process.env.REVERSI_IZVOR = "3.0";
    await expect(podigni()).rejects.toThrow(/transakciono spojena/);
  });

  it("🔴 lokacije=3.0 + reversi=sy15: PODIZANJE PADA i u tom smeru", async () => {
    process.env.LOKACIJE_IZVOR = "3.0";
    await expect(podigni()).rejects.toThrow(/transakciono spojena/);
  });
});

// ---------------------------------------------------------------------------
// 2. Domenski moduli STVARNO uvoze prekidače
// ---------------------------------------------------------------------------
describe("ReversiModule / LocationsModule — uvoz prekidača", () => {
  function uvozi(mod: object): unknown[] {
    return (Reflect.getMetadata("imports", mod) as unknown[]) ?? [];
  }

  it("ReversiModule uvozi ReversiLokacijeIzvorModule", () => {
    expect(uvozi(ReversiModule)).toContain(ReversiLokacijeIzvorModule);
  });

  it("LocationsModule uvozi ReversiLokacijeIzvorModule", () => {
    expect(uvozi(LocationsModule)).toContain(ReversiLokacijeIzvorModule);
  });
});

// ---------------------------------------------------------------------------
// 3. Servisi STVARNO primaju prekidač u konstruktor (inače je @Optional tih)
// ---------------------------------------------------------------------------
describe("Injekcija prekidača u domenske servise", () => {
  function paramTypes(cls: object): unknown[] {
    return (Reflect.getMetadata("design:paramtypes", cls) as unknown[]) ?? [];
  }

  it("ReversiService prima ReversiSourceService", () => {
    expect(paramTypes(ReversiService)).toContain(ReversiSourceService);
  });

  it("LocationsService prima LokacijeSourceService", () => {
    expect(paramTypes(LocationsService)).toContain(LokacijeSourceService);
  });
});

// ---------------------------------------------------------------------------
// 4. Ponašanje: pod `3.0` stvarna ruta vraća 503, pod `sy15` radi kao i do sada
// ---------------------------------------------------------------------------

/** Minimalni sy15 dubler — pamti da li je iko uopšte dodirnuo bazu. */
function sy15Dubler(): { svc: Sy15Service; dodirnuto: () => boolean } {
  let dodirnuto = false;
  /** Svaki dubler-poziv se prijavljuje — tako test dokazuje i da baza NIJE dirana. */
  function beleziPa<T>(vrednost: T): () => Promise<T> {
    return () => {
      dodirnuto = true;
      return Promise.resolve(vrednost);
    };
  }
  const db = {
    revDocument: {
      findMany: jest.fn(beleziPa<unknown[]>([])),
      count: jest.fn(beleziPa(0)),
    },
    revDocumentLine: { groupBy: jest.fn(beleziPa<unknown[]>([])) },
    locLocation: {
      findMany: jest.fn(beleziPa<unknown[]>([])),
      count: jest.fn(beleziPa(0)),
    },
  };
  const svc = {
    get db() {
      return db;
    },
    withUser: jest.fn(beleziPa(null)),
    withUserRls: jest.fn(beleziPa(null)),
    runIdempotent: jest.fn(beleziPa({ idempotent: false, result: null })),
  };
  return {
    svc: svc as unknown as Sy15Service,
    dodirnuto: () => dodirnuto,
  };
}

const LABEL = {} as LabelPrintService;
const PRISMA = {
  workOrder: { findMany: jest.fn() },
} as unknown as PrismaService;

/** Privatni parnjaci sy15 poziva — jedini put do baze (v. disciplinu ispod). */
interface Kapije {
  withSy15User: (email: string, fn: unknown) => Promise<unknown>;
  withSy15UserRls: (email: string, fn: unknown) => Promise<unknown>;
  runSy15Idempotent: (
    email: string,
    id: string,
    action: string,
    fn: unknown,
  ) => Promise<unknown>;
}

function kapije(svc: object): Kapije {
  return svc as unknown as Kapije;
}

describe("ReversiService — brana REVERSI_IZVOR", () => {
  it("pod sy15 (PODRAZUMEVANO) ruta radi i STVARNO dodiruje sy15", async () => {
    const { svc, dodirnuto } = sy15Dubler();
    const service = new ReversiService(
      svc,
      LABEL,
      undefined,
      undefined,
      new ReversiSourceService(),
    );
    await service.listDocuments({});
    expect(dodirnuto()).toBe(true);
  });

  it("🔴 pod 3.0 ruta vraća 503 i NE dodiruje sy15", async () => {
    process.env.REVERSI_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const service = new ReversiService(
      svc,
      LABEL,
      undefined,
      undefined,
      new ReversiSourceService(),
    );
    await expect(service.listDocuments({})).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(dodirnuto()).toBe(false);
  });

  it("🔴 pod 3.0 i `withUser` i `runIdempotent` put padaju sa 503", async () => {
    process.env.REVERSI_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const k = kapije(
      new ReversiService(
        svc,
        LABEL,
        undefined,
        undefined,
        new ReversiSourceService(),
      ),
    );
    await expect(
      k.withSy15User("a@b.rs", () => Promise.resolve(null)),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      k.runSy15Idempotent("a@b.rs", "uuid", "revIssue", () =>
        Promise.resolve(null),
      ),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(dodirnuto()).toBe(false);
  });

  it("bez prekidača (nedostaje provajder) ponašanje je kao sy15 — nikad kao 3.0", async () => {
    process.env.REVERSI_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const service = new ReversiService(svc, LABEL);
    await service.listDocuments({});
    expect(dodirnuto()).toBe(true);
  });
});

describe("LocationsService — brana LOKACIJE_IZVOR", () => {
  it("pod sy15 (PODRAZUMEVANO) ruta radi i STVARNO dodiruje sy15", async () => {
    const { svc, dodirnuto } = sy15Dubler();
    const service = new LocationsService(
      svc,
      LABEL,
      PRISMA,
      new LokacijeSourceService(),
    );
    await service.listLocations({});
    expect(dodirnuto()).toBe(true);
  });

  it("🔴 pod 3.0 ruta vraća 503 i NE dodiruje sy15", async () => {
    process.env.LOKACIJE_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const service = new LocationsService(
      svc,
      LABEL,
      PRISMA,
      new LokacijeSourceService(),
    );
    await expect(service.listLocations({})).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(dodirnuto()).toBe(false);
  });

  it("🔴 pod 3.0 i `withUser` i `withUserRls` put padaju sa 503", async () => {
    process.env.LOKACIJE_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const k = kapije(
      new LocationsService(svc, LABEL, PRISMA, new LokacijeSourceService()),
    );
    await expect(
      k.withSy15User("a@b.rs", () => Promise.resolve(null)),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(
      k.withSy15UserRls("a@b.rs", () => Promise.resolve(null)),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(dodirnuto()).toBe(false);
  });

  it("bez prekidača (nedostaje provajder) ponašanje je kao sy15 — nikad kao 3.0", async () => {
    process.env.LOKACIJE_IZVOR = "3.0";
    const { svc, dodirnuto } = sy15Dubler();
    const service = new LocationsService(svc, LABEL, PRISMA);
    await service.listLocations({});
    expect(dodirnuto()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Disciplina: nijedan pristup sy15 podacima ne zaobilazi branu
// ---------------------------------------------------------------------------
describe("Disciplina brane — nijedan direktan `this.sy15.*` u domenskim servisima", () => {
  const SRC = {
    reversi: readFileSync(
      join(__dirname, "..", "..", "modules", "reversi", "reversi.service.ts"),
      "utf8",
    ),
    lokacije: readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "modules",
        "locations",
        "locations.service.ts",
      ),
      "utf8",
    ),
  };

  /**
   * Svaki `this.sy15.<član>` u kodu MORA biti u telu kapije, tj. u prozoru odmah
   * ispod `assertPorted(...)`. Sve ostalo zaobilazi branu i ovde pada.
   * (Redovi komentara se preskaču — oni ne izvršavaju ništa.)
   */
  function prekrsaji(src: string): string[] {
    const linije = src.split("\n");
    const out: string[] = [];
    linije.forEach((linija, i) => {
      const trim = linija.trimStart();
      if (trim.startsWith("//") || trim.startsWith("*")) return;
      const m = /this\.sy15\.([A-Za-z_$][\w$]*)/.exec(linija);
      if (!m) return;
      const cuvan = linije
        .slice(Math.max(0, i - 6), i)
        .some((p) => p.includes("assertPorted("));
      if (!cuvan) out.push(`this.sy15.${m[1]} (linija ${i + 1})`);
    });
    return out;
  }

  it("reversi.service.ts ide isključivo kroz `this.db` / `withSy15User` / `runSy15Idempotent`", () => {
    expect(prekrsaji(SRC.reversi)).toEqual([]);
    // Pozitivna kontrola: brana i sve tri kapije STVARNO postoje u izvoru.
    expect(SRC.reversi).toContain("this.revIzvor?.assertPorted(");
    expect(SRC.reversi).toContain("return this.sy15.db;");
    expect(SRC.reversi).toContain("return this.sy15.withUser(email, fn);");
    expect(SRC.reversi).toContain("return this.sy15.runIdempotent(");
  });

  it("locations.service.ts ide isključivo kroz `this.db` / `withSy15User` / `withSy15UserRls`", () => {
    expect(prekrsaji(SRC.lokacije)).toEqual([]);
    expect(SRC.lokacije).toContain("this.locIzvor?.assertPorted(");
    expect(SRC.lokacije).toContain("return this.sy15.db;");
    expect(SRC.lokacije).toContain("return this.sy15.withUser(email, fn);");
    expect(SRC.lokacije).toContain("this.sy15.withUserRls(email, fn)");
  });

  it("negativna kontrola: detektor STVARNO pada na nezaštićen pristup", () => {
    const lose = "async x() {\n  return this.sy15.db.revTool.findMany();\n}";
    expect(prekrsaji(lose)).toEqual(["this.sy15.db (linija 2)"]);
  });
});
