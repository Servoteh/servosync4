import { PrismaService } from "../../prisma/prisma.service";
import {
  BigbitMdbImportService,
  bbBool,
  bbDecimalText,
  mapGoodsDocumentRow,
  mapGoodsItemRow,
  mapRequisitionItemRow,
  splitGoodsQuantity,
  type BbItemIndex,
  type MdbStepResult,
} from "./bigbit-mdb-import.service";

/**
 * ROBNO OGLEDALO — lager (STANJE / REZERVISANO / SLOBODNO) i kartice artikla.
 *
 * Ovaj spec ne dokazuje da se 182.539 stavki prepiše — to se meri na bazi. On
 * pinuje ČETIRI odluke koje bi, da su pogrešne, dale ekran koji izgleda ispravno
 * a laže, i to su sve odluke izmerene nad živim BigBit fajlom (05.08.2026):
 *
 *  1. SMER SA ZAGLAVLJA, ZNAK IZ IZVORA. BigBit međumagacinski prenos knjiži kao
 *     DVA dokumenta, oba `Ulaz=True`, a odlazak iz magacina zapisuje NEGATIVNOM
 *     količinom (mereno: MMPM +5,005 u magacin 2, MMPR −5,005 iz magacina 1).
 *     `ABS()` bi robu umnožio prenosom, tiho.
 *  2. MAGACIN SA STAVKE. U Level 0 se magacin stavke i zaglavlja danas poklapaju
 *     u svih 18.865 stavki (pa bi pogrešan izbor prošao neprimećeno), ali u
 *     Level 250 se razlikuju u 523 stavke — a Level 250 daje kolonu REZERVISANO.
 *  3. `item_id` JE NAŠ `items.id`, preveden preko `external_item_id`. Mereno
 *     31.07.2026: `id = external_item_id` za 0 od 92.511 artikala.
 *  4. IDEMPOTENTNOST: ključ je BigBit-ov (`IDDok`/`IDStavke`), upsert je
 *     `ON CONFLICT (id) DO UPDATE ... WHERE red se STVARNO razlikuje`, brisanja
 *     nema. Drugi prolaz nad istim fajlom ne sme ništa da promeni.
 */

const DROP = 11;

// ───────────────────────────────────────────────────────────────────────────
// ČISTO PRESLIKAVANJE (bez baze)
// ───────────────────────────────────────────────────────────────────────────

/** Staging red robnog dokumenta: sve je tekst, nepopunjeno je `null`. */
const doc = (v: Record<string, string | null>): Record<string, unknown> => ({
  id: 1,
  id_dok: null,
  ulaz: null,
  broj_dokumenta: null,
  vrsta_dokumenta: null,
  sifra_komitenta: null,
  datum_dokumenta: null,
  datum_knjizenja: null,
  id_magacin_dok: null,
  level: null,
  id_predmet: null,
  zakljucano: null,
  rezervisi: null,
  godina: null,
  ...v,
});

/** Staging red robne stavke. */
const stavka = (v: Record<string, string | null>): Record<string, unknown> => ({
  id: 1,
  id_stavke: null,
  id_dok: null,
  sifra_artikla: null,
  kolicina: null,
  kg_kolicina: null,
  nabavna_cena_neto: null,
  stvarna_vp_cena: null,
  stvarna_mp_cena: null,
  rabat_proc: null,
  id_magacin: null,
  opis_stavke: null,
  ...v,
});

/** BigBit šifra 34811 -> naš artikal id=12640 (par iz produkcijskog merenja). */
const ITEMS: BbItemIndex = new Map([
  [34811, { id: 12640, catalogNumber: "R900407394" }],
  [777, { id: 5, catalogNumber: "KAT-777" }],
  // Duplu šifru drži više naših artikala — ne pogađa se koji je pravi.
  [999, null],
]);

describe("robno ogledalo — preslikavanje", () => {
  describe("smer prometa (Ulaz) i znak količine", () => {
    it("Ulaz=1 puni quantityIn, Ulaz=0 puni quantityOut", () => {
      expect(splitGoodsQuantity("7.5", true)).toEqual({
        quantityIn: "7.5",
        quantityOut: "0",
      });
      expect(splitGoodsQuantity("7.5", false)).toEqual({
        quantityIn: "0",
        quantityOut: "7.5",
      });
    });

    it("🔴 NEGATIVNA količina se PRENOSI SA ZNAKOM (međumagacinski prenos)", () => {
      // Doslovan snimak iz fajla: oba dokumenta su „ulaz", a odlazak iz
      // magacina 1 je zapisan minusom. ABS() bi 5,005 dodao OBA puta.
      const uMagacin2 = splitGoodsQuantity("5.005", true);
      const izMagacina1 = splitGoodsQuantity("-5.005", true);
      expect(uMagacin2.quantityIn).toBe("5.005");
      expect(izMagacina1.quantityIn).toBe("-5.005");
      // Zbir prenosa preko oba magacina mora biti NULA.
      expect(
        Number(uMagacin2.quantityIn) + Number(izMagacina1.quantityIn),
      ).toBe(0);
    });

    it("Access Boolean stiže kao TEKST — „0” je NETAČNO (Boolean('0') je u JS-u true)", () => {
      expect(bbBool("0")).toBe(false);
      expect(bbBool("1")).toBe(true);
      expect(bbBool("-1")).toBe(true);
      expect(bbBool("True")).toBe(true);
      expect(bbBool(null)).toBe(false);
    });

    it("količina ide u bazu kao TEKST — bez zaokruživanja kroz JS float", () => {
      // BigBit `Double` se izveze ovako; Postgres ga sam spusti na numeric(18,4).
      expect(bbDecimalText("5.0049999999999")).toBe("5.0049999999999");
      expect(bbDecimalText("1,5")).toBe("1.5");
      expect(bbDecimalText("")).toBeNull();
      expect(bbDecimalText("n/a")).toBeNull();
    });
  });

  describe("zaglavlje robnog dokumenta", () => {
    it("preslikava Ulaz/Level/Rezervisi/vrstu/magacin zaglavlja", () => {
      const m = mapGoodsDocumentRow(
        doc({
          id_dok: "4",
          ulaz: "1",
          vrsta_dokumenta: "UFROB",
          broj_dokumenta: "0452",
          datum_dokumenta: "2026-06-26",
          datum_knjizenja: "2026-06-30",
          level: "0",
          rezervisi: "0",
          zakljucano: "1",
          id_magacin_dok: "1",
          sifra_komitenta: "512",
          godina: "2026",
        }),
      );
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(m.value).toMatchObject({
        id: 4,
        documentType: "UFROB",
        documentNumber: "0452",
        documentDate: "2026-06-26",
        postingDate: "2026-06-30",
        isInflow: true,
        isReservation: false,
        isLocked: true,
        level: 0,
        warehouseId: 1,
        customerId: 512,
        year: 2026,
      });
    });

    it("REZERVACIJA se prepoznaje po ZASTAVICI, ne po vrsti dokumenta", () => {
      // Mereno: pored REZM (1.071) i REZR (487) rezervišu i OTP (9), PON (6) i
      // PROF (3). Ko bi filtrirao po vrsti, promašio bi 18 dokumenata.
      for (const vrsta of ["REZM", "REZR", "OTP", "PON", "PROF"]) {
        const m = mapGoodsDocumentRow(
          doc({
            id_dok: "9",
            vrsta_dokumenta: vrsta,
            datum_dokumenta: "2026-01-05",
            level: "250",
            rezervisi: "1",
            ulaz: "0",
          }),
        );
        expect(m.ok).toBe(true);
        if (m.ok) expect(m.value.isReservation).toBe(true);
      }
    });

    it("šifra komitenta/predmeta/magacina „0” znači NEMA, ne referencu na 0", () => {
      // Mereno: 242 dokumenta nose `Sifra komitenta = 0`.
      const m = mapGoodsDocumentRow(
        doc({
          id_dok: "5",
          datum_dokumenta: "2026-02-02",
          sifra_komitenta: "0",
          id_predmet: "0",
          id_magacin_dok: "0",
        }),
      );
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(m.value.customerId).toBeNull();
      expect(m.value.projectId).toBeNull();
      expect(m.value.warehouseId).toBeNull();
    });

    it("dokument bez upotrebljivog datuma se ODBACUJE (kolona je NOT NULL)", () => {
      const m = mapGoodsDocumentRow(doc({ id_dok: "6", datum_dokumenta: "" }));
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("FILTER");
      expect(m.reason).toContain("Datum dokumenta");
    });

    it("neupotrebljiv IDDok se odbacuje i IMENUJE (ne nestaje tiho)", () => {
      const m = mapGoodsDocumentRow(
        doc({ id_dok: "", datum_dokumenta: "2026-01-01" }),
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("FILTER");
      expect(m.reason).toContain("IDDok");
    });
  });

  describe("stavka robnog dokumenta", () => {
    const smer = new Map<number, boolean>([
      [100, true], // ulazni dokument
      [200, false], // izlazni dokument
    ]);

    it("🔴 MAGACIN SE UZIMA SA STAVKE, ne sa zaglavlja", () => {
      const m = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "200",
          sifra_artikla: "34811",
          kolicina: "3",
          id_magacin: "44", // stavka: Gotovi proizvodi
        }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      // Zaglavlje 200 u ovom testu uopšte ne nudi magacin — jedini izvor je stavka.
      expect(m.value.warehouseId).toBe(44);
    });

    it("smer uzima sa ZAGLAVLJA (stavka ga ne nosi)", () => {
      const ulaz = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "100",
          sifra_artikla: "34811",
          kolicina: "3",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      const izlaz = mapGoodsItemRow(
        stavka({
          id_stavke: "2",
          id_dok: "200",
          sifra_artikla: "34811",
          kolicina: "3",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      expect(ulaz.ok && ulaz.value.quantityIn).toBe("3");
      expect(ulaz.ok && ulaz.value.quantityOut).toBe("0");
      expect(izlaz.ok && izlaz.value.quantityIn).toBe("0");
      expect(izlaz.ok && izlaz.value.quantityOut).toBe("3");
      // Sirova količina ostaje uz podelu — REZERVISANO se po BigBit paritetu
      // računa nad njom, bez obzira na smer.
      expect(izlaz.ok && izlaz.value.quantity).toBe("3");
    });

    it("🔴 item_id je NAŠ items.id (preveden preko BigBit šifre), ne šifra", () => {
      const m = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "100",
          sifra_artikla: "34811",
          kolicina: "1",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(m.value.itemId).toBe(12640);
      expect(m.value.itemId).not.toBe(34811);
      // Kataloški broj se povlači usput — pogrešan spoj bi se odmah video.
      expect(m.value.catalogNumber).toBe("R900407394");
    });

    it("NEPOZNAT artikal se PRESKAČE i imenuje (ne obara uvoz)", () => {
      const m = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "100",
          sifra_artikla: "88888",
          kolicina: "1",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("SKIP");
      expect(m.reason).toContain("88888");
    });

    it("DUPLA BigBit šifra se ne pogađa — stavka se preskače", () => {
      const m = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "100",
          sifra_artikla: "999",
          kolicina: "1",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("SKIP");
      expect(m.reason).toContain("VIŠE naših artikala");
    });

    it("stavka čijeg dokumenta nema u fajlu se preskače (bez nagađanja smera)", () => {
      const m = mapGoodsItemRow(
        stavka({
          id_stavke: "1",
          id_dok: "404",
          sifra_artikla: "34811",
          kolicina: "1",
          id_magacin: "1",
        }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("SKIP");
      expect(m.reason).toContain("404");
    });

    it("„Sifra artikla” <= 0 je ODBAČEN red, ne preskočen (mereno: 1 takav)", () => {
      const m = mapGoodsItemRow(
        stavka({ id_stavke: "1", id_dok: "100", sifra_artikla: "0" }),
        smer,
        ITEMS,
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("FILTER");
    });
  });

  describe("stavka trebovanja (narudžbine)", () => {
    it("preslikava naručeno/isporučeno i prevodi šifru u naš artikal", () => {
      const m = mapRequisitionItemRow(
        {
          id_stavke: "3",
          id_treb: "70",
          sifra_artikla: "777",
          treb_kol: "10",
          isporucena_kolicina: "4",
          cena: "199.99",
          opis: "cev",
          ocekivani_datum_isporuke: "2026-09-01",
          datum_isporuke: null,
          isporuceno: "0",
          rabat_proc: "5",
        },
        new Set([70]),
        ITEMS,
      );
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(m.value).toMatchObject({
        id: 3,
        orderId: 70,
        itemId: 5,
        orderedQuantity: "10",
        receivedQuantity: "4",
        unitPrice: "199.99",
        expectedDeliveryDate: "2026-09-01",
        isDelivered: false,
      });
    });

    it("stavka bez svog trebovanja se preskače (FK bi oborio celu seriju)", () => {
      const m = mapRequisitionItemRow(
        { id_stavke: "3", id_treb: "70", sifra_artikla: "777" },
        new Set<number>(),
        ITEMS,
      );
      expect(m.ok).toBe(false);
      if (m.ok) return;
      expect(m.kind).toBe("SKIP");
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// KORACI UVOZA (mockovan Prisma)
// ───────────────────────────────────────────────────────────────────────────

interface Write {
  sql: string;
  params: unknown[];
}

/**
 * Stranica se u bazu šalje kao JEDAN `jsonb` parametar (a ne kao paralelni
 * nizovi) — vidi obrazloženje uz `GOODS_BATCH`: `unnest` je na dev bazi pao sa
 * „cannot cast type integer[] to date[]" čim je cela stranica imala prazan
 * datum. Testovi zato gledaju REDOVE, ne pozicije u nizovima.
 */
const payloadOf = (w: Write): Record<string, unknown>[] =>
  JSON.parse(String(w.params[0])) as Record<string, unknown>[];

interface Fixture {
  docs?: Record<string, unknown>[];
  items?: Record<string, unknown>[];
  /** `items` tabela: BigBit šifra -> naš artikal. */
  catalog?: { id: number; external_item_id: number; catalog_number: string }[];
  /** Migracija ogledala još nije prošla. */
  notMigrated?: boolean;
  /** Level 0 dokumenti po godinama koje ogledalo VEĆ drži. */
  years?: { year: number | null; c: number }[];
}

/** Sve kolone koje koraci traže — vraća ih `information_schema` upit. */
const COLUMNS = [
  "drop_id",
  "level",
  "is_inflow",
  "is_reservation",
  "document_number",
  "customer_id",
  "quantity",
  "quantity_in",
  "quantity_out",
  "warehouse_id",
  "order_number",
  "order_date",
  "supplier_id",
  "is_ordered",
  "order_id",
  "item_id",
  "ordered_quantity",
  "received_quantity",
];

function makePrisma(f: Fixture) {
  const docs = f.docs ?? [];
  const items = f.items ?? [];
  const catalog = f.catalog ?? [];
  const writes: Write[] = [];
  /** Dokumenti koji su STVARNO ušli u ogledalo — protiv njih se meri FK. */
  const inMirror = new Set<number>();

  const page = <T extends { id: number }>(rows: T[], after: number): T[] =>
    rows.filter((r) => r.id > after);

  const queryRaw = jest.fn(
    (
      strings: TemplateStringsArray,
      ...params: unknown[]
    ): Promise<unknown[]> => {
      const sql = strings.join(" ? ");

      // ── spremnost migracije ────────────────────────────────────────────
      if (sql.includes("information_schema.columns"))
        return Promise.resolve(
          f.notMigrated ? [] : COLUMNS.map((c) => ({ column_name: c })),
        );

      // ── brojači staging tabela ─────────────────────────────────────────
      if (sql.includes("FROM bb_mdb_stage_robna_dokumenta WHERE drop_id"))
        return Promise.resolve([{ c: BigInt(docs.length) }]);
      if (sql.includes("FROM bb_mdb_stage_robne_stavke WHERE drop_id"))
        return Promise.resolve([{ c: BigInt(items.length) }]);
      if (sql.includes("FROM bb_mdb_stage_trebovanja WHERE drop_id"))
        return Promise.resolve([{ c: BigInt(0) }]);
      if (sql.includes("FROM bb_mdb_stage_trebovanja_stavke WHERE drop_id"))
        return Promise.resolve([{ c: BigInt(0) }]);

      // ── godine u ogledalu (brana od smene poslovne godine) ─────────────
      if (sql.includes("GROUP BY year"))
        return Promise.resolve(
          (f.years ?? [{ year: 2026, c: docs.length }]).map((y) => ({
            year: y.year,
            c: BigInt(y.c),
          })),
        );

      // ── „izvor je poslao nulu, a ogledalo ima redove" ──────────────────
      if (/count\(\*\) AS c FROM \w+_mirror\s*$/.test(sql.trim()))
        return Promise.resolve([{ c: BigInt(0) }]);

      // ── mapa smera (IDDok -> Ulaz) ─────────────────────────────────────
      if (sql.includes("SELECT id, id_dok, ulaz FROM"))
        return Promise.resolve(
          page(docs as { id: number }[], Number(params[1])),
        );

      // ── šifarnik artikala (BigBit šifra -> items.id) ───────────────────
      if (sql.includes("FROM items"))
        return Promise.resolve(
          page(catalog as unknown as { id: number }[], Number(params[0])),
        );

      // ── stranice staging-a ─────────────────────────────────────────────
      if (sql.includes("FROM bb_mdb_stage_robna_dokumenta"))
        return Promise.resolve(
          page(docs as { id: number }[], Number(params[1])),
        );
      if (sql.includes("FROM bb_mdb_stage_robne_stavke"))
        return Promise.resolve(
          page(items as { id: number }[], Number(params[1])),
        );
      if (sql.includes("FROM bb_mdb_stage_trebovanja"))
        return Promise.resolve([]);

      // ── grupni upsert-i ────────────────────────────────────────────────
      if (sql.includes("INSERT INTO goods_documents_mirror")) {
        writes.push({ sql, params });
        const rows = payloadOf({ sql, params });
        for (const r of rows) inMirror.add(Number(r.id));
        return Promise.resolve([
          { inserted: BigInt(rows.length), updated: 0n },
        ]);
      }
      if (sql.includes("INSERT INTO goods_document_items_mirror")) {
        writes.push({ sql, params });
        const rows = payloadOf({ sql, params });
        // FK filter iz SQL-a (`JOIN goods_documents_mirror`) — stavka čije
        // zaglavlje nije ušlo se ne upisuje, ali ne obara ni ostale.
        const eligible = rows.filter((r) =>
          inMirror.has(Number(r.document_id)),
        ).length;
        return Promise.resolve([
          {
            inserted: BigInt(eligible),
            updated: 0n,
            lost: BigInt(rows.length - eligible),
          },
        ]);
      }

      return Promise.resolve([]);
    },
  );

  return {
    prisma: { $queryRaw: queryRaw } as unknown as PrismaService,
    writes,
    queryRaw,
  };
}

interface GoodsSteps {
  importGoodsDocuments(dropId: number): Promise<MdbStepResult>;
  importGoodsDocumentItems(dropId: number): Promise<MdbStepResult>;
}
const steps = (s: BigbitMdbImportService): GoodsSteps =>
  s as unknown as GoodsSteps;

/** Ulazni dokument 100 (magacin zaglavlja 1) + izlazni 200. */
const FIXTURE: Fixture = {
  docs: [
    {
      id: 1,
      id_dok: "100",
      ulaz: "1",
      vrsta_dokumenta: "UFROB",
      broj_dokumenta: "0452",
      datum_dokumenta: "2026-06-26",
      datum_knjizenja: "2026-06-26",
      level: "0",
      rezervisi: "0",
      zakljucano: "0",
      id_magacin_dok: "1",
      sifra_komitenta: "512",
      id_predmet: "0",
      godina: "2026",
    },
    {
      id: 2,
      id_dok: "200",
      ulaz: "0",
      vrsta_dokumenta: "REZM",
      broj_dokumenta: "0007",
      datum_dokumenta: "2026-06-27",
      datum_knjizenja: null,
      level: "250",
      rezervisi: "1",
      zakljucano: "0",
      id_magacin_dok: "1",
      sifra_komitenta: "0",
      id_predmet: "0",
      godina: "2026",
    },
  ],
  items: [
    {
      id: 1,
      id_stavke: "1000",
      id_dok: "100",
      sifra_artikla: "34811",
      kolicina: "5.005",
      id_magacin: "1",
      kg_kolicina: null,
      nabavna_cena_neto: "80.09999999999999",
      stvarna_vp_cena: null,
      stvarna_mp_cena: null,
      rabat_proc: null,
      opis_stavke: null,
    },
    {
      id: 2,
      id_stavke: "1001",
      id_dok: "200",
      sifra_artikla: "34811",
      kolicina: "2",
      // 🔴 magacin STAVKE se razlikuje od magacina zaglavlja (=1)
      id_magacin: "44",
      kg_kolicina: null,
      nabavna_cena_neto: null,
      stvarna_vp_cena: null,
      stvarna_mp_cena: null,
      rabat_proc: null,
      opis_stavke: null,
    },
  ],
  catalog: [
    { id: 12640, external_item_id: 34811, catalog_number: "R900407394" },
  ],
};

describe("robno ogledalo — koraci uvoza", () => {
  describe("idempotentnost", () => {
    it("ključ upsert-a je BIGBIT-ov IDDok, ne staging id", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);

      const upis = writes.find((w) =>
        w.sql.includes("INSERT INTO goods_documents_mirror"),
      );
      expect(upis).toBeDefined();
      // Staging redovi su id 1 i 2; ogledalo mora dobiti 100 i 200.
      expect(payloadOf(upis!).map((r) => r.id)).toEqual([100, 200]);
    });

    it("upsert je ON CONFLICT (id) DO UPDATE uz „samo ako se STVARNO razlikuje”", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      for (const w of writes) {
        expect(w.sql).toContain("ON CONFLICT (id) DO UPDATE");
        expect(w.sql).toContain("IS DISTINCT FROM");
      }
    });

    it("poređenje NE uključuje imported_drop_id ni updated_at (inače „sve izmenjeno” svake noći)", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      for (const w of writes) {
        const uslov = w.sql.slice(w.sql.indexOf("IS DISTINCT FROM"));
        expect(uslov).not.toContain("imported_drop_id");
        expect(uslov).not.toContain("updated_at");
      }
    });

    it("NIŠTA SE NE BRIŠE — nema DELETE ni TRUNCATE nad ogledalom", async () => {
      const { prisma, queryRaw } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      const sviUpiti = queryRaw.mock.calls
        .map((c) => c[0].join(" "))
        .join("\n");
      expect(sviUpiti).not.toMatch(/DELETE FROM|TRUNCATE/i);
    });

    it("ponovni uvoz ISTOG drop-a šalje ISTI upis (deterministički, bez duplikata)", async () => {
      const prvi = makePrisma(FIXTURE);
      await steps(new BigbitMdbImportService(prvi.prisma)).importGoodsDocuments(
        DROP,
      );
      const drugi = makePrisma(FIXTURE);
      await steps(
        new BigbitMdbImportService(drugi.prisma),
      ).importGoodsDocuments(DROP);
      expect(drugi.writes[0].params).toEqual(prvi.writes[0].params);
      // Isti ključevi + ON CONFLICT (id) = drugi prolaz ne može da napravi
      // drugi red; jedini upis je onaj koji se sudari sa postojećim.
      expect(drugi.writes).toHaveLength(1);
    });

    it("duplikat IDDok-a u istom drop-u se odbacuje (inače pada cela serija)", async () => {
      const { prisma, writes } = makePrisma({
        ...FIXTURE,
        docs: [
          FIXTURE.docs![0],
          { ...FIXTURE.docs![0], id: 3 }, // isti IDDok=100
        ],
      });
      const step = await steps(
        new BigbitMdbImportService(prisma),
      ).importGoodsDocuments(DROP);
      expect(payloadOf(writes[0]).map((r) => r.id)).toEqual([100]);
      expect(step.filtered).toBe(1);
      expect(step.notes.join(" ")).toContain("ponavlja");
    });
  });

  describe("lager: smer i magacin kroz ceo korak", () => {
    it("ulazni dokument daje quantity_in, izlazni quantity_out", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      const upis = writes.find((w) =>
        w.sql.includes("INSERT INTO goods_document_items_mirror"),
      );
      const redovi = payloadOf(upis!);
      // IDStavke iz BigBita, ne staging id.
      expect(redovi.map((r) => r.id)).toEqual([1000, 1001]);
      expect(redovi.map((r) => r.quantity_in)).toEqual(["5.005", "0"]);
      expect(redovi.map((r) => r.quantity_out)).toEqual(["0", "2"]);
    });

    it("🔴 magacin dolazi SA STAVKE (44), a ne sa zaglavlja (1)", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      const upis = writes.find((w) =>
        w.sql.includes("INSERT INTO goods_document_items_mirror"),
      );
      expect(payloadOf(upis!).map((r) => r.warehouse_id)).toEqual([1, 44]);
    });

    it("cena se prenosi doslovno — zaokruživanje radi Postgres, ne JS", async () => {
      const { prisma, writes } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      await steps(service).importGoodsDocumentItems(DROP);

      const upis = writes.find((w) =>
        w.sql.includes("INSERT INTO goods_document_items_mirror"),
      );
      expect(payloadOf(upis!).map((r) => r.purchase_price_net)).toEqual([
        "80.09999999999999",
        null,
      ]);
    });
  });

  describe("ništa tiho", () => {
    it("nepoznat artikal PRESKAČE red, ostatak uvoza prolazi", async () => {
      const { prisma, writes } = makePrisma({
        ...FIXTURE,
        items: [
          FIXTURE.items![0],
          {
            ...FIXTURE.items![1],
            id_stavke: "1002",
            sifra_artikla: "88888", // šifra koju 4.0 ne poznaje
          },
        ],
      });
      const service = new BigbitMdbImportService(prisma);
      await steps(service).importGoodsDocuments(DROP);
      const step = await steps(service).importGoodsDocumentItems(DROP);

      expect(step.skipped).toBe(1);
      expect(step.inserted).toBe(1); // ispravna stavka je ušla
      expect(step.notes.join(" ")).toContain("88888");
      const upis = writes.find((w) =>
        w.sql.includes("INSERT INTO goods_document_items_mirror"),
      );
      expect(payloadOf(upis!).map((r) => r.id)).toEqual([1000]);
    });

    it("stavka čije zaglavlje je ODBAČENO ne obara seriju (FK filter je u SQL-u)", async () => {
      const { prisma } = makePrisma({
        ...FIXTURE,
        // dokument 200 ostaje bez datuma -> zaglavlje se odbacuje...
        docs: [
          FIXTURE.docs![0],
          { ...FIXTURE.docs![1], datum_dokumenta: null },
        ],
      });
      const service = new BigbitMdbImportService(prisma);
      const zaglavlja = await steps(service).importGoodsDocuments(DROP);
      const stavke = await steps(service).importGoodsDocumentItems(DROP);

      expect(zaglavlja.filtered).toBe(1);
      // ...pa njegova stavka ne sme da uđe, ali ni da obori ostale.
      expect(stavke.inserted).toBe(1);
      expect(stavke.skipped).toBe(1);
      expect(stavke.notes.join(" ")).toContain("NIJE u ogledalu");
    });

    it("brojači se ZBRAJAJU: staged = inserted + updated + unchanged + skipped + filtered", async () => {
      const { prisma } = makePrisma(FIXTURE);
      const service = new BigbitMdbImportService(prisma);
      const zaglavlja = await steps(service).importGoodsDocuments(DROP);
      const stavke = await steps(service).importGoodsDocumentItems(DROP);

      for (const s of [zaglavlja, stavke])
        expect(
          s.inserted + s.updated + s.unchanged + s.skipped + s.filtered,
        ).toBe(s.staged);
    });

    it("SMENA POSLOVNE GODINE se imenuje — zbir preko godina duplira stanje", async () => {
      const { prisma } = makePrisma({
        ...FIXTURE,
        years: [
          { year: 2026, c: 1528 },
          { year: 2027, c: 40 },
        ],
      });
      const step = await steps(
        new BigbitMdbImportService(prisma),
      ).importGoodsDocuments(DROP);
      const poruka = step.notes.join(" ");
      expect(poruka).toContain("VIŠE godina");
      expect(poruka).toContain("duplira");
    });
  });

  describe("migracija ogledala još nije prošla", () => {
    it("korak se PRESKAČE sa imenovanim razlogom — ne obara noćni uvoz", async () => {
      const { prisma, writes } = makePrisma({
        ...FIXTURE,
        notMigrated: true,
      });
      const step = await steps(
        new BigbitMdbImportService(prisma),
      ).importGoodsDocuments(DROP);

      expect(step.staged).toBe(0);
      expect(step.notes.join(" ")).toContain("nije migrirano");
      expect(writes).toHaveLength(0);
    });
  });
});
