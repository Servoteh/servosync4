import "reflect-metadata";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
import { OdrzavanjeModule } from "../../modules/odrzavanje/odrzavanje.module";
import { OdrzavanjeLokacijeMostService } from "../../modules/odrzavanje/odrzavanje-lokacije-most.service";
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

  // 🔴 NALAZ C: most ka `loc_locations` je TREĆI potrošač `LOKACIJE_IZVOR`-a.
  // Bez ovog uvoza `@Optional()` prekidač u mostu ostaje `undefined` i brana je
  // MRTVA — tačno kvar koji je prvi krug našao kod Reversa i Lokacija.
  it("🔴 OdrzavanjeModule uvozi ReversiLokacijeIzvorModule (zbog mosta ka loc_locations)", () => {
    expect(uvozi(OdrzavanjeModule)).toContain(ReversiLokacijeIzvorModule);
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

  it("🔴 OdrzavanjeLokacijeMostService prima LokacijeSourceService (NALAZ C)", () => {
    expect(paramTypes(OdrzavanjeLokacijeMostService)).toContain(
      LokacijeSourceService,
    );
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
    locLocationMovement: {
      findMany: jest.fn(beleziPa<unknown[]>([])),
      count: jest.fn(beleziPa(0)),
    },
    // `authUserIdByEmail` / `resolveUserNames` idu sirovim upitom nad `auth.users`.
    $queryRaw: jest.fn(beleziPa<unknown[]>([])),
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

  // -------------------------------------------------------------------------
  // 🔴 NALAZ A (protivnička provera 08.08.2026): 503 se gutao u `catch`-u
  // -------------------------------------------------------------------------
  // `GET /locations/movements?mine=1` („Moja istorija" na mobilnoj) razrešava uid
  // kroz `authUserIdByEmail`, koji je ceo bio u `try { … } catch { return null }`.
  // Pod `3.0` je brana bacala 503 IZ `try`-ja, `catch` ga je progutao, a pozivalac
  // na `uid === null` vraćao praznu stranu — HTTP 200 sa LAŽNOM praznom listom
  // umesto glasnog „putanja nije preneta". Isti kvar koji ceo ovaj fajl zatvara.
  describe("🔴 mine=1 pod 3.0 — 503, a NE lažna prazna lista", () => {
    it("pod sy15 (PODRAZUMEVANO) put radi i STVARNO dodiruje sy15", async () => {
      const { svc, dodirnuto } = sy15Dubler();
      const service = new LocationsService(
        svc,
        LABEL,
        PRISMA,
        new LokacijeSourceService(),
      );
      const r = await service.listMovements({ mine: "1" }, "a@b.rs");
      expect(dodirnuto()).toBe(true);
      // Nerazrešiv nalog (dubler vraća prazan red) → prazna strana je ISPRAVNA.
      expect(r.data).toEqual([]);
    });

    it("🔴 pod 3.0 baca 503 i NE vraća praznu stranu", async () => {
      process.env.LOKACIJE_IZVOR = "3.0";
      const { svc, dodirnuto } = sy15Dubler();
      const service = new LocationsService(
        svc,
        LABEL,
        PRISMA,
        new LokacijeSourceService(),
      );
      await expect(
        service.listMovements({ mine: "1" }, "a@b.rs"),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(dodirnuto()).toBe(false);
    });

    it("🔴 i bez `mine` (obična istorija) pod 3.0 baca 503", async () => {
      process.env.LOKACIJE_IZVOR = "3.0";
      const { svc } = sy15Dubler();
      const service = new LocationsService(
        svc,
        LABEL,
        PRISMA,
        new LokacijeSourceService(),
      );
      await expect(service.listMovements({}, "a@b.rs")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
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
   * Deklaracija člana klase — konvencija oba fajla: uvučena TAČNO 2 razmaka
   * (`constructor(`, `private get db(`, `private async withSy15User<T>(`,
   * `async listDocuments(`, `private readonly x = …`). Komentari (`/**`, `*`, `//`)
   * i zatvarajuće zagrade (`}`, `)`) ne počinju identifikatorom pa ne prolaze.
   */
  const DEKLARACIJA_CLANA =
    /^ {2}(?:(?:private|protected|public|static|readonly|abstract|override|async|get|set)\s+)*[A-Za-z_$][\w$]*\s*[(<:=]/;

  /**
   * Svaki `this.sy15.<član>` MORA stajati u telu ISTOG člana klase koji je pre
   * njega pozvao `assertPorted(...)`. Sve ostalo zaobilazi branu i ovde pada.
   * (Redovi komentara se preskaču — oni ne izvršavaju ništa.)
   *
   * 🔴 ZAŠTO „isti član", a ne „prozor od N redova" (protivnička provera 08.08.2026,
   * NALAZ B): raniji detektor je gledao 6 redova IZNAD pogotka, pa je svaki
   * `this.sy15.*` u prvih 6 redova ispod BILO KOJE kapije nasleđivao tuđi
   * `assertPorted` i postajao nevidljiv. Izmereno: metoda ubačena odmah ispod
   * `runSy15Idempotent` prolazila je 19/19, a ista metoda drugde obarala test —
   * a to je upravo najprirodnije mesto gde bi neko dodao novu sy15 pomoćnu
   * metodu. Granica člana klase nema tu slepu mrlju (mutacija X3a ispod).
   */
  function prekrsaji(src: string): string[] {
    const linije = src.split("\n");
    const out: string[] = [];
    let pocetakClana = 0; // indeks reda sa deklaracijom tekućeg člana klase
    linije.forEach((linija, i) => {
      if (DEKLARACIJA_CLANA.test(linija)) pocetakClana = i;
      const trim = linija.trimStart();
      if (trim.startsWith("//") || trim.startsWith("*")) return;
      const m = /this\.sy15\.([A-Za-z_$][\w$]*)/.exec(linija);
      if (!m) return;
      const cuvan = linije
        .slice(pocetakClana, i)
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

  // -------------------------------------------------------------------------
  // 🔴 MUTACIJA X3a — slepi prozor ranijeg detektora (NALAZ B, 08.08.2026)
  // -------------------------------------------------------------------------

  /**
   * Raniji detektor: kapija se tražila u 6 redova IZNAD pogotka. Ovde je ostavljen
   * kao MERA — test ispod dokazuje da mutaciju X3a on propušta, a novi je hvata.
   * Ne koristi se ni za šta drugo; ako se ikad obriše, obriše se i njegov test.
   */
  function prekrsajiProzor6(src: string): string[] {
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

  /**
   * X3a: nova sy15 pomoćna metoda ubačena ODMAH ISPOD poslednje kapije — najprirodnije
   * mesto za „dodaj još jedan sy15 helper". Ubacuje se posle reda koji zatvara telo
   * kapije (`  }`), dakle kao pun, zaseban član klase.
   */
  function mutacijaX3a(src: string): string {
    const linije = src.split("\n");
    const kapije = linije
      .map((l, i) => (l.includes("this.assertPorted(") ? i : -1))
      .filter((i) => i >= 0);
    expect(kapije.length).toBeGreaterThan(0);
    // `trimEnd` — fajl na Windows-u ume da bude CRLF, pa red nosi zaostalo `\r`.
    let kraj = kapije[kapije.length - 1];
    while (kraj < linije.length && linije[kraj].trimEnd() !== "  }") kraj++;
    expect(kraj).toBeLessThan(linije.length); // kapija se STVARNO zatvara
    linije.splice(
      kraj + 1,
      0,
      "",
      "  private async novaSy15Pomoc(): Promise<unknown> {",
      "    return this.sy15.db;",
      "  }",
    );
    return linije.join("\n");
  }

  it("🔴 X3a nad reversi.service.ts: prozor od 6 redova je PROPUŠTA, novi detektor je HVATA", () => {
    const mutiran = mutacijaX3a(SRC.reversi);
    // Dokaz da je mutacija stvarno u slepoj mrlji starog detektora:
    expect(prekrsajiProzor6(mutiran)).toEqual([]);
    // …a novi detektor je vidi (granica člana klase, ne prozor od N redova).
    expect(prekrsaji(mutiran)).toHaveLength(1);
    expect(prekrsaji(mutiran)[0]).toMatch(/^this\.sy15\.db \(linija \d+\)$/);
  });

  it("🔴 X3a nad locations.service.ts: novi detektor je HVATA", () => {
    const mutiran = mutacijaX3a(SRC.lokacije);
    expect(prekrsaji(mutiran)).toHaveLength(1);
    expect(prekrsaji(mutiran)[0]).toMatch(/^this\.sy15\.db \(linija \d+\)$/);
  });

  /**
   * Kontrola same granice: da `DEKLARACIJA_CLANA` nikad ne pogodi, `pocetakClana` bi
   * ostao 0, ceo fajl bi bio „jedan član" i SVAKI `this.sy15.*` bi izgledao zaštićen
   * (jer kapija postoji negde iznad). Testovi X3a gore bi tada pali — ovo je izričita
   * provera iste pretpostavke: detektor ume da razdvoji članove pravog izvora.
   */
  it("granica člana klase se prepoznaje u oba pravog izvora", () => {
    const clanovi = (src: string) =>
      src.split("\n").filter((l) => DEKLARACIJA_CLANA.test(l)).length;
    expect(clanovi(SRC.reversi)).toBeGreaterThan(50);
    expect(clanovi(SRC.lokacije)).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// 6. 🔴 NALAZ D — detektor SAM pronalazi dodirne tačke (ne veruje spisku)
// ---------------------------------------------------------------------------
/**
 * ZAŠTO OVAJ ODELJAK POSTOJI (protivnička provera 08.08.2026, NALAZ D):
 * odeljak 5 gleda TAČNO DVA fajla, zakucana u `SRC`. Ta lista nije ničim
 * dokazana kao potpuna — i nije bila: `odrzavanje-lokacije-most.service.ts` piše
 * u `public.loc_locations` (tabela koju OVAJ korak seli) preko `this.sy15.db`,
 * bez ijedne `LOKACIJE_IZVOR` kapije, i odeljak 5 ga ne vidi jer nije u `SRC`.
 * Slepa mrlja spiska je veća od slepe mrlje prozora od 6 redova koju je zatvorio
 * drugi krug: prozor je propuštao 4 reda, spisak propušta CEO FAJL.
 *
 * Zato ovde detektor NE dobija spisak nego ga IZVODI:
 *   • tabele — iz samog skripta prenosa (`scripts/migrate-reversi-lokacije-sy15.ts`);
 *     doda li neko 22. tabelu u seobu, detektor se širi sam, bez izmene testa;
 *   • sy15 Prisma modeli nad tim tabelama — iz `prisma/sy15.prisma` (`@@map`);
 *   • fajlovi — obilaskom CELOG `backend/src`.
 * Dodirna tačka = fajl koji ima `this.sy15.` I pominje prenetu tabelu/model
 * (van komentara). Svaka mora biti upisana u `POZNATE_DODIRNE_TACKE` sa
 * obrazloženjem; nova, neupisana obara test.
 */
describe("🔴 NALAZ D — potpunost spiska dodirnih tačaka", () => {
  const BACKEND = join(__dirname, "..", "..", "..");
  const SRC_DIR = join(BACKEND, "src");

  /**
   * Tabele koje korak 3 STVARNO seli — čitaju se iz skripta prenosa, jedinog
   * izvora istine o obimu seobe. Namerno NIJE prepisana lista: prepis bi se
   * razišao sa skriptom, a razilaženje se ne bi videlo.
   */
  function preneteTabele(): string[] {
    const s = readFileSync(
      join(BACKEND, "scripts", "migrate-reversi-lokacije-sy15.ts"),
      "utf8",
    );
    return [...s.matchAll(/\btable:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
  }

  /**
   * Prisma akcesori sy15 klijenta nad tim tabelama (`revDocument`, `locLocation`…).
   * Izvode se iz `@@map` u `prisma/sy15.prisma`, a ne iz pravila za množinu —
   * `rev_tool_service_log` i `loc_bigtehn_ingest_state` nisu množina, pa bi svako
   * „skidanje s" promašilo. Regex je CRLF-svestan (`[\s\S]`, `^` uz `m`).
   */
  function preneteModele(tabele: readonly string[]): string[] {
    const s = readFileSync(join(BACKEND, "prisma", "sy15.prisma"), "utf8");
    const trazene = new Set(tabele);
    const out: string[] = [];
    for (const m of s.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const map = /@@map\("([a-z0-9_]+)"\)/.exec(m[2]);
      if (map && trazene.has(map[1]))
        out.push(m[1][0].toLowerCase() + m[1].slice(1));
    }
    return out;
  }

  /** Svi izvorni `.ts` fajlovi (bez testova i deklaracija), rel. na `src`, POSIX put. */
  function sviIzvori(): Map<string, string> {
    const out = new Map<string, string>();
    const obidji = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) obidji(p);
        else if (
          e.endsWith(".ts") &&
          !e.endsWith(".spec.ts") &&
          !e.endsWith(".d.ts")
        )
          out.set(
            relative(SRC_DIR, p).split(sep).join("/"),
            readFileSync(p, "utf8"),
          );
      }
    };
    obidji(SRC_DIR);
    return out;
  }

  /**
   * Fajl -> razlozi zbog kojih je dodirna tačka. Komentari se preskaču: inače bi
   * `odrzavanje.service.ts` („CMMS interna hijerarhija lokacija (≠ loc_locations)")
   * bio lažan pogodak, a lažni pogoci ubijaju detektor brže od promašaja —
   * spisak izuzetaka naraste i prestane da se čita.
   *
   * `split(/\r?\n/)` — fajlovi u ovom repou su CRLF (`core.autocrlf=true`);
   * `split("\n")` bi ostavio `\r` na kraju svakog reda i sve obrasce vezane za
   * kraj reda tiho oborio.
   */
  function klasifikuj(
    fajlovi: ReadonlyMap<string, string>,
    tabele: readonly string[],
    modeli: readonly string[],
  ): Map<string, string[]> {
    const reTab = new RegExp(`\\b(${tabele.join("|")})\\b`);
    const reMod = new RegExp(`\\.(${modeli.join("|")})\\b`);
    const nadjene = new Map<string, string[]>();
    for (const [rel, src] of fajlovi) {
      let sy15 = false;
      const razlozi: string[] = [];
      src.split(/\r?\n/).forEach((linija, i) => {
        const trim = linija.trimStart();
        if (
          trim.startsWith("//") ||
          trim.startsWith("*") ||
          trim.startsWith("/*")
        )
          return;
        if (linija.includes("this.sy15.")) sy15 = true;
        const t = reTab.exec(linija);
        if (t) razlozi.push(`${t[1]} (linija ${i + 1})`);
        const m = reMod.exec(linija);
        if (m) razlozi.push(`.${m[1]} (linija ${i + 1})`);
      });
      if (sy15 && razlozi.length > 0) nadjene.set(rel, razlozi);
    }
    return nadjene;
  }

  /**
   * 🔴 REGISTAR. Svaki fajl koji kroz `this.sy15.*` dodiruje prenetu tabelu mora
   * stajati ovde SA OBRAZLOŽENJEM. Novi fajl (ili nov `this.sy15.*` nad prenetom
   * tabelom u fajlu koji je ranije bio čist) obara test ispod — a to je jedina
   * stvar koja je 08.08.2026 falila da bi NALAZ C bio viđen u prvom krugu.
   */
  const POZNATE_DODIRNE_TACKE: Record<string, string> = {
    "modules/reversi/reversi.service.ts":
      "IZA BRANE: svaki pristup ide kroz `this.db` / `withSy15User` / " +
      "`runSy15Idempotent`, a svaki od njih zove `assertPorted` (odeljak 5).",
    "modules/locations/locations.service.ts":
      "IZA BRANE: `this.db` / `withSy15User` / `withSy15UserRls`, svaki sa " +
      "`assertPorted` (odeljak 5).",
    "modules/odrzavanje/odrzavanje-lokacije-most.service.ts":
      "NALAZ C (08.08.2026): most `maint_machines` -> `loc_locations`. NIJE iza " +
      "`assertPorted` jer je fail-soft i zove se POSLE commit-a (503 bi oborilo " +
      "zahtev kome je mašina već sačuvana). Umesto toga se pod `LOKACIJE_IZVOR=3.0` " +
      "GASI, glasno — v. `lokacijeNa30()` i test pozitivne kontrole ispod.",
    "modules/kadrovska/kadrovska.service.ts":
      "🔴 NALAZ E (08.08.2026, otkrio ovaj detektor): `offboardingOutstandingReversi` " +
      "čita `rev_documents`/`rev_document_lines`/`rev_tools` kroz `withUserRls`. " +
      "NIJE ožičeno jer je kadrovska ZAMRZNUTA do svoje seobe (runbook §1.4, §3 red 3). " +
      'Pod `REVERSI_IZVOR=3.0` bi panel „Zaduženja za vraćanje" pri odlasku radnika ' +
      "prikazao ZAMRZNUT sy15 snimak. Zato je u runbook-u §7 upisano kao P8 i kao " +
      "preduslov koraka 6 — preklop se ne izvodi dok se ovo ne reši.",
  };

  const TABELE = preneteTabele();
  const MODELI = preneteModele(TABELE);
  const NADJENE = klasifikuj(sviIzvori(), TABELE, MODELI);

  it("obim se čita iz skripta prenosa i sy15 šeme (a ne iz prepisane liste)", () => {
    expect(TABELE).toContain("loc_locations");
    expect(TABELE).toContain("rev_documents");
    expect(TABELE.length).toBeGreaterThanOrEqual(21);
    expect(MODELI).toContain("locLocation");
    expect(MODELI).toContain("revDocumentLine");
    expect(MODELI.length).toBeGreaterThanOrEqual(17);
  });

  it("🔴 spisak dodirnih tačaka je POTPUN — nijedna nije neupisana, nijedna zastarela", () => {
    const nadjene = [...NADJENE.keys()].sort();
    const upisane = Object.keys(POZNATE_DODIRNE_TACKE).sort();
    // Poruka nosi razloge, da onaj ko obori test odmah vidi ŠTA je dodirnuto.
    const opis = nadjene
      .map((f) => `${f}: ${(NADJENE.get(f) ?? []).slice(0, 3).join(", ")}`)
      .join("\n");
    expect({ nadjene, opis: opis.length > 0 }).toEqual({
      nadjene: upisane,
      opis: true,
    });
  });

  it("svaka upisana tačka ima stvarno obrazloženje", () => {
    for (const [f, zasto] of Object.entries(POZNATE_DODIRNE_TACKE)) {
      expect({ f, dovoljno: zasto.length > 60 }).toEqual({ f, dovoljno: true });
      expect(zasto).not.toMatch(/TODO|FIXME|videti kasnije/i);
    }
  });

  it("lažni pogodak iz komentara se NE broji (`odrzavanje.service.ts` pominje `loc_locations` samo u komentaru)", () => {
    expect(NADJENE.has("modules/odrzavanje/odrzavanje.service.ts")).toBe(false);
    // …a `loc-tp-feed.service.ts` ima `this.sy15.` ali NIJEDNU prenetu tabelu.
    expect(NADJENE.has("modules/locations/loc-tp-feed.service.ts")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Mutacije X4 — dokaz da detektor stvarno hvata nov otvor
  // -------------------------------------------------------------------------
  function mut(rel: string, src: string): Map<string, string[]> {
    return klasifikuj(new Map([[rel, src]]), TABELE, MODELI);
  }

  it("🔴 X4a: nov servis sa `this.sy15.db.locLocation` — HVATA se", () => {
    const nov =
      "class Nov {\n" +
      "  async x() {\n" +
      "    return this.sy15.db.locLocation.findMany();\n" +
      "  }\n" +
      "}\n";
    expect([...mut("modules/nov/nov.service.ts", nov).keys()]).toEqual([
      "modules/nov/nov.service.ts",
    ]);
  });

  it("🔴 X4b: sirov SQL nad prenetom tabelom u `withUser` povratnom pozivu — HVATA se", () => {
    const nov =
      "class Nov {\n" +
      "  async x(email: string) {\n" +
      "    return this.sy15.withUserRls(email, (tx) =>\n" +
      "      tx.$queryRaw(Prisma.sql`SELECT * FROM rev_documents`));\n" +
      "  }\n" +
      "}\n";
    expect([...mut("modules/nov/nov.service.ts", nov).keys()]).toHaveLength(1);
  });

  it("🔴 X4c: isti fajl u CRLF obliku — i dalje se HVATA (fajlovi u repou SU CRLF)", () => {
    const nov =
      "class Nov {\r\n" +
      "  async x() {\r\n" +
      "    return this.sy15.db.revDocumentLine.count();\r\n" +
      "  }\r\n" +
      "}\r\n";
    expect([...mut("modules/nov/nov.service.ts", nov).keys()]).toHaveLength(1);
  });

  it("X4d: sam pomen tabele bez `this.sy15.` (3.0 pristup kroz `this.prisma`) se NE broji", () => {
    const nov =
      "class Nov {\n" +
      "  async x() {\n" +
      "    return this.prisma.locLocation.findMany();\n" +
      "  }\n" +
      "}\n";
    expect([...mut("modules/nov/nov.service.ts", nov).keys()]).toHaveLength(0);
  });

  it("X4e: `this.sy15.` nad tabelom KOJA SE NE SELI se NE broji (npr. `maint_machines`)", () => {
    const nov =
      "class Nov {\n" +
      "  async x() {\n" +
      "    return this.sy15.db.$queryRaw(Prisma.sql`SELECT 1 FROM maint_machines`);\n" +
      "  }\n" +
      "}\n";
    expect([...mut("modules/nov/nov.service.ts", nov).keys()]).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Pozitivna kontrola za NALAZ C: kapija u mostu STVARNO postoji
  // -------------------------------------------------------------------------
  it("🔴 most ima `LOKACIJE_IZVOR` kapiju u `syncMachineToLoc` (a ne samo u `aktivan()`)", () => {
    const most = readFileSync(
      join(
        SRC_DIR,
        "modules",
        "odrzavanje",
        "odrzavanje-lokacije-most.service.ts",
      ),
      "utf8",
    );
    expect(most).toContain("private lokacijeNa30()");
    expect(most).toContain("LokacijeSourceService");
    // Kapija mora stajati PRE `try { return await this.sync(` — ne posle upisa.
    const iKapija = most.indexOf("if (this.lokacijeNa30()) {");
    const iUpis = most.indexOf("return await this.sync(");
    expect(iKapija).toBeGreaterThan(-1);
    expect(iUpis).toBeGreaterThan(iKapija);
  });
});
