import { PrismaService } from "../../prisma/prisma.service";
import {
  ARTIKAL_SRC_TO_STAGE_FIELD,
  BigbitMdbImportService,
  type MdbStepResult,
} from "./bigbit-mdb-import.service";
import { SYNC_MAP } from "./sync-map.generated";

/**
 * KORAK 2, artikli: `bb_mdb_stage_artikli` -> `items`.
 *
 * Ovaj spec postoji zbog JEDNE greške koja je uhvaćena tek merenjem na
 * produkciji 31.07.2026, pošto je kod već bio napisan i „zelen":
 *
 *   `items.id` NIJE BigBit šifra. Prenos BigBit -> QBigTehn je artiklima
 *   dodeljivao svoju numeraciju, a BigBit-ovu čuvao u `BBSifra artikla` ->
 *   `items.external_item_id`. Mereno: `id = external_item_id` za **0 od 92.511**
 *   redova. Uvoz koji bi se ključao po `id`-u upisao bi BigBit artikal preko
 *   nepovezanog našeg artikla sa istim brojem — 58.143 pogrešno prepisana reda,
 *   i to tiho, jer bi svaki upis „uspeo".
 *
 * Zato se ovde pinuje PONAŠANJE KLJUČA, a ne sadržaj preslikavanja (67 kolona
 * dolazi iz `sync-map.generated.ts` i dokazano je na stvarnom .mdb-u).
 */

interface ItemsStep {
  importItems(dropId: number): Promise<MdbStepResult>;
}
const runItems = (
  service: BigbitMdbImportService,
  dropId = 9,
): Promise<MdbStepResult> =>
  (service as unknown as ItemsStep).importItems(dropId);

const DROP = 9;
const NATIVE_BASE = 900_000_000;

interface StageRow {
  id: number;
  dropId: number;
  [column: string]: unknown;
}

/** Staging red: sve je tekst, nepopunjene kolone su `null` (kao posle `\copy`). */
function stage(id: number, values: Record<string, string>): StageRow {
  const row: StageRow = { id, dropId: DROP };
  for (const field of Object.values(ARTIKAL_SRC_TO_STAGE_FIELD))
    row[field] = null;
  for (const [src, value] of Object.entries(values)) {
    const field = ARTIKAL_SRC_TO_STAGE_FIELD[src];
    if (!field) throw new Error(`test koristi nepoznatu BigBit kolonu: ${src}`);
    row[field] = value;
  }
  return row;
}

/** Najmanji ispravan BigBit artikal — šifra, katbroj, naziv i grupa. */
const artikal = (
  stageId: number,
  sifra: string,
  katbroj: string,
  naziv: string,
): StageRow =>
  stage(stageId, {
    "Sifra artikla": sifra,
    "Kataloski broj": katbroj,
    Naziv: naziv,
    Grupa: "1",
  });

interface Fixture {
  stage: StageRow[];
  /** Redovi koji su VEĆ u `items` (ranije uvezeni ili 4.0-native). */
  items: Record<string, unknown>[];
  /** `MAX(id)` ispod native opsega — polazna tačka za nove artikle. */
  maxBigbitId?: number;
}

function makePrisma(f: Fixture) {
  const items = f.items.map((i) => ({ ...i }));
  const update = jest.fn(
    (args: { where: { id: number }; data: Record<string, unknown> }) => {
      const at = items.findIndex((i) => i.id === args.where.id);
      if (at < 0) return Promise.reject(new Error("nema reda za update"));
      items[at] = { ...items[at], ...args.data };
      return Promise.resolve(items[at]);
    },
  );
  const create = jest.fn((args: { data: Record<string, unknown> }) => {
    if (items.some((i) => i.id === args.data.id))
      return Promise.reject(new Error("duplicate key value violates pk_items"));
    items.push({ ...args.data });
    return Promise.resolve(args.data);
  });

  const stageFindMany = jest.fn(
    (args: {
      where?: { id?: { gt?: number } };
      select?: Record<string, boolean>;
      take?: number;
    }) => {
      // `gt` se poštuje i u predučitavanju ključeva (`select`): i ono stranica
      // keyset-om, pa mock koji uvek vraća sve redove vrti večnu petlju.
      const gt = args.where?.id?.gt ?? 0;
      const page = f.stage
        .filter((r) => r.id > gt)
        .sort((a, b) => a.id - b.id)
        .slice(0, args.take ?? f.stage.length);
      return Promise.resolve(
        args.select
          ? page.map((r) => ({ id: r.id, sifraArtikla: r.sifraArtikla }))
          : page,
      );
    },
  );

  const itemFindMany = jest.fn(
    (args: { where: Record<string, { in?: unknown[] }> }) => {
      if (args.where.externalItemId?.in) {
        const exts = args.where.externalItemId.in as number[];
        return Promise.resolve(
          items.filter((i) => exts.includes(i.externalItemId as number)),
        );
      }
      const cats = (args.where.catalogNumber?.in ?? []) as string[];
      return Promise.resolve(
        items
          .filter((i) => cats.includes(i.catalogNumber as string))
          .map((i) => ({
            id: i.id,
            externalItemId: i.externalItemId,
            catalogNumber: i.catalogNumber,
          })),
      );
    },
  );

  const prisma = {
    bbMdbStageArtikal: {
      count: jest.fn(() => Promise.resolve(f.stage.length)),
      findMany: stageFindMany,
    },
    item: { findMany: itemFindMany, update, create },
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ next_id: (f.maxBigbitId ?? 0) + 1 }]),
    ),
  };

  return { prisma: prisma as unknown as PrismaService, items, update, create };
}

function makeService(f: Fixture) {
  const mock = makePrisma(f);
  return { ...mock, service: new BigbitMdbImportService(mock.prisma) };
}

describe("uvoz artikala iz .mdb — ključ je BigBit šifra, ne naš id", () => {
  it("mapiranje vodi BigBit šifru u `external_item_id`, a `id` je isId kolona koja se NE upisuje", () => {
    const m = SYNC_MAP.find((x) => x.targetDb === "items");
    expect(m).toBeDefined();
    const ext = m?.columns.find((c) => c.field === "externalItemId");
    const id = m?.columns.find((c) => c.isId);
    // Ako ovo ikad pukne, uvoz bi počeo da piše po `id`-u — vidi zaglavlje fajla.
    expect(ext?.src).toBe("BBSifra artikla");
    expect(id?.field).toBe("id");
    // Obe kolone čitaju ISTU staging kolonu (direktan kanal remap nema)…
    expect(ARTIKAL_SRC_TO_STAGE_FIELD["BBSifra artikla"]).toBe("sifraArtikla");
    expect(ARTIKAL_SRC_TO_STAGE_FIELD["Sifra artikla"]).toBe("sifraArtikla");
  });

  it("BigBit artikal 17048 ažurira NAŠ red koji ga nosi (id=2), a ne red id=17048", async () => {
    const { service, items, update, create } = makeService({
      items: [
        { id: 2, externalItemId: 17048, catalogNumber: "K-1", name: "staro ime" },
        { id: 17048, externalItemId: 55555, catalogNumber: "K-9", name: "TUĐI artikal" },
      ],
      stage: [artikal(1, "17048", "K-1", "Razvodni blok, 4-položajni, CD01")],
    });

    const res = await runItems(service);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: 2 });
    expect(create).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
    // Nepovezani artikal sa istim BROJEM ostaje netaknut — to je cela poenta.
    expect(items.find((i) => i.id === 17048)?.name).toBe("TUĐI artikal");
    expect(items.find((i) => i.id === 2)?.name).toBe(
      "Razvodni blok, 4-položajni, CD01",
    );
  });

  it("upis NIKAD ne dira `id` ni `external_item_id` postojećeg reda", async () => {
    const { service, update } = makeService({
      items: [{ id: 2, externalItemId: 17048, catalogNumber: "K-1", name: "x" }],
      stage: [artikal(1, "17048", "K-1", "novo ime")],
    });
    await runItems(service);
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("id");
    expect(data.externalItemId).toBe(17048);
  });

  it("nov artikal dobija PRVI SLOBODAN broj ispod native opsega (sekvenca stoji na 1)", async () => {
    const { service, create } = makeService({
      items: [{ id: 2, externalItemId: 17048, catalogNumber: "K-1", name: "x" }],
      stage: [artikal(1, "99001", "K-NOVO", "nov artikal")],
      maxBigbitId: 93_513,
    });

    const res = await runItems(service);

    expect(res.inserted).toBe(1);
    expect(create.mock.calls[0][0].data.id).toBe(93_514);
    expect(create.mock.calls[0][0].data.externalItemId).toBe(99_001);
  });

  it("dva nova artikla u istoj seriji dobijaju RAZLIČITE brojeve", async () => {
    const { service, create } = makeService({
      items: [],
      stage: [
        artikal(1, "99001", "K-A", "prvi"),
        artikal(2, "99002", "K-B", "drugi"),
      ],
      maxBigbitId: 100,
    });

    const res = await runItems(service);

    expect(res.inserted).toBe(2);
    const dodeljeni = create.mock.calls.map((c) => c[0].data.id);
    expect(new Set(dodeljeni).size).toBe(2);
    expect(dodeljeni).toEqual([101, 102]);
  });

  it("4.0-native artikal koji nosi tu šifru se NE prepisuje, i kaže se koji je", async () => {
    const { service, update, create } = makeService({
      items: [
        {
          id: NATIVE_BASE + 5,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "naš artikal",
        },
      ],
      stage: [artikal(1, "17048", "K-1", "BigBit verzija")],
    });

    const res = await runItems(service);

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.notes.join(" ")).toMatch(/900000005[\s\S]*4\.0 opsega/);
  });

  it("kad ista šifra pokazuje na DVA naša reda, ne pogađa se — red se imenuje", async () => {
    const { service, update } = makeService({
      items: [
        { id: 2, externalItemId: 17048, catalogNumber: "K-1", name: "a" },
        { id: 3, externalItemId: 17048, catalogNumber: "K-2", name: "b" },
      ],
      stage: [artikal(1, "17048", "K-1", "novo")],
    });

    const res = await runItems(service);

    expect(update).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.notes.join(" ")).toMatch(/pokazuje na 2 naša artikla[\s\S]*id=2\/3/);
  });

  it("neizmenjen red se NE upisuje — inače bi svaka noć javila 91.000 izmena", async () => {
    // Postojeći red mora da izgleda TAČNO kao ono što mapper napravi od staginga,
    // uključujući prazne stringove za kolone kojih u izvoru nema — inače bi se
    // „neizmenjen" test lažno završio kao izmena.
    const { service, update, create } = makeService({
      items: [
        {
          id: 2,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "isto ime",
          groupCode: "1",
          originCode: "",
          subgroupCode: "",
          goodsTaxRateCode: "",
          serviceTaxRateCode: "",
        },
      ],
      stage: [artikal(1, "17048", "K-1", "isto ime")],
    });

    const res = await runItems(service);

    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(res.unchanged).toBe(1);
  });

  it("BigBit-ov double `80.09999999999999` NIJE izmena naših `80.1000`", async () => {
    // Bez ovoga bi svaka noć prijavila ~91.000 „izmenjenih" artikala: BigBit cene
    // drži kao Double, a naša kolona je numeric(19,4) i pri upisu zaokruži — pa
    // bi se isti red prepisivao doveka, a prava izmena nestala u šumu.
    const { service, update } = makeService({
      items: [
        {
          id: 2,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "isto ime",
          groupCode: "1",
          originCode: "",
          subgroupCode: "",
          goodsTaxRateCode: "",
          serviceTaxRateCode: "",
          wholesalePrice: "80.1000",
        },
      ],
      stage: [
        stage(1, {
          "Sifra artikla": "17048",
          "Kataloski broj": "K-1",
          Naziv: "isto ime",
          Grupa: "1",
          "VP cena": "80.09999999999999",
        }),
      ],
    });

    const res = await runItems(service);

    expect(update).not.toHaveBeenCalled();
    expect(res.unchanged).toBe(1);
  });

  it("prava izmena cene se i dalje vidi (zaokruživanje ne sme da je pojede)", async () => {
    const { service, update } = makeService({
      items: [
        {
          id: 2,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "isto ime",
          groupCode: "1",
          originCode: "",
          subgroupCode: "",
          goodsTaxRateCode: "",
          serviceTaxRateCode: "",
          wholesalePrice: "80.1000",
        },
      ],
      stage: [
        stage(1, {
          "Sifra artikla": "17048",
          "Kataloski broj": "K-1",
          Naziv: "isto ime",
          Grupa: "1",
          "VP cena": "80.1001",
        }),
      ],
    });

    const res = await runItems(service);

    expect(res.updated).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("kataloški broj koji drži red nepoznat izvoru blokira dubl — i kaže ZAŠTO", async () => {
    const { service, create } = makeService({
      items: [
        // Ovaj red BigBit više ne šalje (obrisan tamo, kod nas namerno ostaje).
        { id: 50, externalItemId: 40404, catalogNumber: "K-SUDAR", name: "stari" },
      ],
      stage: [artikal(1, "17048", "K-SUDAR", "nov artikal sa istim katbrojem")],
      maxBigbitId: 100,
    });

    const res = await runItems(service);

    expect(create).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.notes.join(" ")).toMatch(/BigBit više ne šalje/);
  });

  it("POSTOJEĆI artikal se ažurira i kad neko drugi deli isti katbroj", async () => {
    // Nalaz probe 31.07.2026: brana je bila stroža od baze i preskakala 12
    // artikala koji kod nas VEĆ POSTOJE sa istim tim brojem, samo zato što ga
    // deli i naš artikal bez BigBit porekla — pa nikad ne bi primili izmenu.
    // Produkciona brana `guard_catalog_unique` takav upis dozvoljava.
    const { service, update, create } = makeService({
      items: [
        { id: 12640, externalItemId: 34811, catalogNumber: "R900407394", name: "staro" },
        { id: 89022, externalItemId: 0, catalogNumber: "R900407394", name: "naš, bez BigBit porekla" },
      ],
      stage: [artikal(1, "34811", "R900407394", "novo ime iz BigBita")],
    });

    const res = await runItems(service);

    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(0);
    expect(update.mock.calls[0][0].where).toEqual({ id: 12640 });
    expect(create).not.toHaveBeenCalled();
  });

  it("ali IZMENA katbroja na tuđi i dalje pada na paritet-branu", async () => {
    const { service, update } = makeService({
      items: [
        { id: 12640, externalItemId: 34811, catalogNumber: "STARI-BROJ", name: "x" },
        { id: 89022, externalItemId: 0, catalogNumber: "TUDJI-BROJ", name: "drži broj" },
      ],
      stage: [artikal(1, "34811", "TUDJI-BROJ", "hoće tuđi broj")],
    });

    const res = await runItems(service);

    expect(update).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(res.notes.join(" ")).toMatch(/TUDJI-BROJ/);
  });

  it("BigBit sme da ima svoje duplikate katbroja — oni se NE preskaču", async () => {
    const { service, create } = makeService({
      items: [],
      stage: [
        artikal(1, "17048", "K-DUPL", "prvi"),
        artikal(2, "17049", "K-DUPL", "drugi"),
      ],
      maxBigbitId: 100,
    });

    const res = await runItems(service);

    expect(res.inserted).toBe(2);
    expect(res.skipped).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("pad DB brane se hvata PO REDU i imenuje, umesto da obori ceo korak", async () => {
    const { service } = makeService({
      items: [{ id: 7, externalItemId: 17048, catalogNumber: "K-1", name: "x" }],
      stage: [
        artikal(1, "17048", "K-1", "novo ime"),
        artikal(2, "17049", "K-2", "drugi"),
      ],
      maxBigbitId: 100,
    });
    const prisma = (service as unknown as { prisma: { item: { update: jest.Mock } } })
      .prisma;
    prisma.item.update.mockRejectedValueOnce(
      new Error('CATALOG_NUMBER_DUPLICATE: kataloški broj "K-1" već postoji'),
    );

    const res = await runItems(service);

    expect(res.skipped).toBe(1);
    expect(res.inserted).toBe(1); // drugi red je ipak ušao
    expect(res.notes.join(" ")).toMatch(/17048[\s\S]*CATALOG_NUMBER_DUPLICATE/);
  });

  it("brojači se moraju zbrajati na broj stagovanih redova", async () => {
    const { service } = makeService({
      items: [{ id: 2, externalItemId: 17048, catalogNumber: "K-1", name: "x" }],
      stage: [
        artikal(1, "17048", "K-1", "izmenjen"),
        artikal(2, "17049", "K-2", "nov"),
        stage(3, { "Sifra artikla": "", "Kataloski broj": "K-3", Naziv: "bez šifre" }),
      ],
      maxBigbitId: 100,
    });

    const res = await runItems(service);

    expect(res.staged).toBe(3);
    expect(
      res.inserted + res.updated + res.unchanged + res.skipped + res.filtered,
    ).toBe(3);
    expect(res.notes.join(" ")).not.toMatch(/brojači se ne zbrajaju/);
  });
});

/**
 * MINIMALNU KOLIČINU PUNI BigBit — DO PRELASKA (01.04.2027).
 * =============================================================================
 * KOLONA JE 06.08.2026. BILA IZBAČENA IZ MAPE (commit `b2d11e8c`, „minimalne
 * količine unose magacioneri") PA ISTOG DANA VRAĆENA. Vlasnik je ispravio odluku:
 * „ovde nema UNOSA dok ne krenemo da radimo sa APP. Rekli smo da ćemo samo čitati
 * podatke iz BigBita."
 *
 * ZAŠTO OVAJ TEST POSTOJI I POSLE VRAĆANJA: opasnost je simetrična, a kvar je u OBA
 * smera nevidljiv — ništa ne pukne, podatak samo prestane da bude istinit.
 *   • kolona VAN mape, a unos odbijen (stanje koje je `b2d11e8c` napravio): kolonu ne
 *     puni NIKO i mesecima zastareva na 162 vrednosti;
 *   • kolona U mapi, a unos otvoren: uvoz u 03:45 pregazi svaki unos magacionera.
 * Zato ovde stoji šta uvoz STVARNO radi, a odnos prekidača i mape (oba smera) čuva
 * `masters/items.minimalna-kolicina-prekidac.spec.ts`.
 *
 * IZMERENO NA PRODUKCIJI 06.08.2026 (dokaz da je kanal živ, a ne teorijski):
 * poslednji drop (id 7) nosi 162 od 91.207 staging redova sa ne-nultom minimalnom,
 * a poređenje `bb_mdb_stage_artikli` ↔ `items` po `external_item_id` daje
 * **0 razlika na 92.623 uparena reda** — uvoz drži kolonu u savršenom koraku sa
 * BigBitom. Stanje `items` posle vraćanja (pre uvoza u 03:45): 162 ≠ 0, 92.460 nula,
 * 3 prazno, od 92.625 — ništa nije izgubljeno dok je kolona bila van mape.
 *
 * ⚠️ Ako se pravilo ikad promeni, menja se UZ ODLUKU VLASNIKA (i prevrtanjem
 * prekidača `VLASNIK_MINIMALNE_KOLICINE`) — ne tako što se test „popravi" da prođe.
 */
describe("minimalnu količinu puni BigBit — uvoz je UPISUJE", () => {
  it("mapiranje `items` IMA `minQuantity` (kolona vraćena 06.08.2026)", () => {
    // Da ovo padne, noćni uvoz bi prestao da puni kolonu, a unos iz aplikacije je
    // odbijen — pa je ne bi punio niko.
    const m = SYNC_MAP.find((x) => x.targetDb === "items");
    const kolona = (m?.columns ?? []).find((c) => c.field === "minQuantity");
    expect(kolona?.src).toBe("Minimalna kolicina");
  });

  it("staging prima BigBit vrednost — ista kolona koju mapa čita", () => {
    expect(ARTIKAL_SRC_TO_STAGE_FIELD["Minimalna kolicina"]).toBe(
      "minimalnaKolicina",
    );
  });

  it("uvoz UPISUJE `min_quantity` iz BigBita u postojeći red", async () => {
    const { service, items, update } = makeService({
      items: [
        {
          id: 2,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "staro ime",
          minQuantity: 12,
        },
      ],
      stage: [
        stage(1, {
          "Sifra artikla": "17048",
          "Kataloski broj": "K-1",
          Naziv: "novo ime",
          Grupa: "1",
          "Minimalna kolicina": "999",
        }),
      ],
    });

    const res = await runItems(service);

    expect(res.updated).toBe(1);
    expect(update.mock.calls[0][0].data.minQuantity).toBe(999);
    expect(items.find((i) => i.id === 2)?.minQuantity).toBe(999);
  });

  it("promena SAMO minimalne u BigBitu JESTE izmena — red se ažurira", async () => {
    // `sameProjectRow` poredi po kolonama iz mape. Ovo je test da je kolona stvarno
    // u poređenju: da nije, izmena praga u BigBitu ne bi stigla do nas sve dok se ne
    // promeni i neko drugo polje artikla.
    const { service, update, items } = makeService({
      items: [
        {
          id: 2,
          externalItemId: 17048,
          catalogNumber: "K-1",
          name: "isto ime",
          groupCode: "1",
          originCode: "",
          subgroupCode: "",
          goodsTaxRateCode: "",
          serviceTaxRateCode: "",
          minQuantity: 12,
        },
      ],
      stage: [
        stage(1, {
          "Sifra artikla": "17048",
          "Kataloski broj": "K-1",
          Naziv: "isto ime",
          Grupa: "1",
          "Minimalna kolicina": "999",
        }),
      ],
    });

    const res = await runItems(service);

    expect(res.updated).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(items.find((i) => i.id === 2)?.minQuantity).toBe(999);
  });

  it("nov BigBit artikal ulazi SA minimalnom, ne sa DB default-om", async () => {
    const { service, create } = makeService({
      items: [],
      stage: [
        stage(1, {
          "Sifra artikla": "99001",
          "Kataloski broj": "K-NOVO",
          Naziv: "nov artikal",
          Grupa: "1",
          "Minimalna kolicina": "5",
        }),
      ],
      maxBigbitId: 100,
    });

    const res = await runItems(service);

    expect(res.inserted).toBe(1);
    expect(create.mock.calls[0][0].data.minQuantity).toBe(5);
  });
});
