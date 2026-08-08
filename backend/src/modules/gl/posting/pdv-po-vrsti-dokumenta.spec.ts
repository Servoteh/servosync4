/**
 * PDV POSTOJI SAMO TAMO GDE POSTOJI — motor ga ne izmišlja (08.08.2026).
 * =============================================================================
 * IZMEREN KVAR: prekidač knjiženja je 07.08. upaljen za pet vrsta, ali je `VISAR`
 * (višak robe sa popisa) ISTOG DANA vraćen na nulu jer bi prvi popis sa viškom bio
 * ODBIJEN — motor mu je računao PRETPOREZ od tarife artikla (20 %), a šema 46 nema
 * red za PDV. Šema je pri tom VERNA BigBitu: višak nije poreski događaj, ništa nije
 * kupljeno. Brana `assertSchemeCoversVat` je radila ispravno i ostaje — greška je
 * bila u tome što je porez uopšte nastao.
 *
 * Ovde se zaključava OBOJE, bez baze (Prisma stubovana, obrazac `posting.service.spec.ts`):
 *   §1  `VISAR` sa stavkom po opštoj stopi PROLAZI i daje TAČNO `1320 duguje A /
 *       6740 potražuje A`, bez ijednog PDV reda (na zatečenom kodu je bio 422);
 *   §2  poreske vrste (`IFR`, `IFGP`) se NISU promenile — PDV se i dalje računa i knjiži;
 *   §3  stavka sa stopom na neporeskoj vrsti ostavlja TRAG u logu (ne odbija se, ne ćuti);
 *   §4  brana razilaženja: vrsta proglašena neporeskom + šema sa PDV redom = 422;
 *   §5  sam spisak vrsta — merenje pretočeno u tvrdnje (manjak NIJE višak).
 */
import { Logger, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../../prisma/prisma.service";
import {
  VRSTE_BEZ_PDV,
  razilazenjeVrsteISeme,
  slovaKojaSemaReferise,
  vatSlotsFor,
  vrstaNosiPdv,
} from "./pdv-po-vrsti-dokumenta";
import { PostingEngineService } from "./posting.service";

const D = Prisma.Decimal;

interface CreatedLine {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
  documentNumber: string | null;
}

type SchemeLine = {
  lineNo: number;
  accountCode: string;
  defDebit: string | null;
  defCredit: string | null;
  postsAnalytics: boolean;
  description: string | null;
};

const linija = (
  lineNo: number,
  accountCode: string,
  defDebit: string | null,
  defCredit: string | null,
): SchemeLine => ({
  lineNo,
  accountCode,
  defDebit,
  defCredit,
  postsAnalytics: true,
  description: null,
});

/**
 * Šema 46 sa produkcije (`accounting_scheme_lines`, izmereno 08.08.2026): TAČNO DVA reda,
 * `1320 DefDug=A` i `6740 DefPot=A`. Vrsta naloga je `VISAK` — ne `VISAR`; to su dva
 * imenika (`document_types.code` vs `accounting_schemes.order_type`) i za popis se stvarno
 * razlikuju.
 */
const SEMA_46_VISAK: SchemeLine[] = [
  linija(0, "1320", "A", null),
  linija(1, "6740", null, "A"),
];

/** Šema 33 (IFR) — poreska, sa produkcije: kupac `O+P+Q`, izlazni PDV `P` i `Q`. */
const SEMA_33_IFR: SchemeLine[] = [
  linija(1, "2040", "O+P+Q", null),
  linija(2, "4702", null, "P"),
  linija(3, "4710", null, "Q"),
  linija(4, "6040", null, "O"),
  linija(5, "1320", null, "A"),
  linija(6, "5010", "A", null),
];

/** Šema 36 (IFGP) — poreska, bez reda za sniženu stopu (to čuva `assertSchemeCoversVat`). */
const SEMA_36_IFGP: SchemeLine[] = [
  linija(1, "2040", "O+P", null),
  linija(2, "6141", null, "O"),
  linija(3, "4701", null, "P"),
  linija(4, "9600", null, "A"),
  linija(5, "9800", "A", null),
];

const DATUM = new Date("2026-08-08T10:00:00.000Z");

/** Stavka robnog dokumenta — samo kolone koje motor čita. */
function stavka(over: Record<string, unknown> = {}) {
  return {
    quantity: new D(1),
    purchasePriceNet: new D(6000),
    dependentCostOwn: new D(0),
    dependentCostSupplier: new D(0),
    calculatedWholesalePrice: new D(6000),
    actualWholesalePrice: new D(6000),
    fee: new D(0),
    goodsTaxRateCode: "3", // 20 % (VISA) — nosi ga 92.574 od 92.575 artikala
    ...over,
  };
}

function makeEngine(over: {
  documentTypeCode?: string;
  kind?: string;
  schemeId?: number;
  orderType?: string;
  isInbound?: boolean;
  schemeLines?: SchemeLine[];
  items?: Array<ReturnType<typeof stavka>>;
  customerId?: number | null;
}) {
  const documentTypeCode = over.documentTypeCode ?? "VISAR";
  const schemeId = over.schemeId ?? 46;
  const doc = {
    id: 77,
    companyId: 0,
    kind: over.kind ?? "VISAK",
    documentTypeCode,
    documentNumber: "P-1/2026",
    year: 2026,
    warehouseId: 1,
    supplierId: null,
    customerId: over.customerId === undefined ? null : over.customerId,
    documentDate: DATUM,
    postingDate: DATUM,
    isImport: false,
    workOrderId: null,
    projectId: null,
    status: "DRAFT",
  };

  const created: Array<{ lines: { create: CreatedLine[] } }> = [];
  const journalEntry = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve([])),
    delete: jest.fn(() => Promise.resolve({})),
    create: jest.fn((args: { data: { lines: { create: CreatedLine[] } } }) => {
      created.push(args.data);
      return Promise.resolve({ id: 501, lines: args.data.lines.create });
    }),
  };

  const tx = {
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    stockDocument: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(doc)),
      update: jest.fn(() => Promise.resolve(doc)),
    },
    stockDocumentItem: {
      findMany: jest.fn(() => Promise.resolve(over.items ?? [stavka()])),
    },
    documentType: {
      findFirstOrThrow: jest.fn(() =>
        Promise.resolve({
          code: documentTypeCode,
          postingTemplate: schemeId,
          isInbound: over.isInbound ?? true,
        }),
      ),
    },
    accountingScheme: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({
          id: schemeId,
          orderType: over.orderType ?? "VISAK",
          description: "Višak robe",
          lines: over.schemeLines ?? SEMA_46_VISAK,
        }),
      ),
    },
    invoice: { findFirst: jest.fn(() => Promise.resolve(null)) },
    customer: { findUnique: jest.fn(() => Promise.resolve(null)) },
    project: { findUnique: jest.fn(() => Promise.resolve(null)) },
    journalEntry,
  };

  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return { engine: new PostingEngineService(prisma), created };
}

/** Izlaznu (poresku) fakturu pravimo istim stubom — samo drugi smer i druga šema. */
const izlaznaFaktura = (over: Parameters<typeof makeEngine>[0] = {}) =>
  makeEngine({
    documentTypeCode: "IFR",
    kind: "IZ",
    schemeId: 33,
    orderType: "IFR",
    isInbound: false,
    schemeLines: SEMA_33_IFR,
    customerId: 11568,
    items: [stavka({ actualWholesalePrice: new D(10000) })],
    ...over,
  });

// ═════════════════════════════════════════════════════════════════════════════
// §1 — VIŠAK SA POPISA SE KNJIŽI, BEZ IJEDNOG PDV REDA
// ═════════════════════════════════════════════════════════════════════════════

describe("§1 VISAR (višak robe) — PDV ne nastaje", () => {
  it("stavka po opštoj stopi PROLAZI i daje tačno 1320 duguje A / 6740 potražuje A", async () => {
    // Na zatečenom kodu je ovo bio 422: „…ima stavku oporezovanu opštom stopom (20 %), a
    // šema za kontiranje 46 NEMA red za tu stopu. Pretporez od 1200.00…". Pretporez ne
    // postoji — ništa nije kupljeno, zatečena je roba koja je već bila u imovini.
    const h = makeEngine({});

    const lines = await h.engine.postFromStockDocument(77);

    expect(lines).toHaveLength(2);
    const duguje = lines.find((l) => l.accountCode === "1320");
    const potrazuje = lines.find((l) => l.accountCode === "6740");
    expect(duguje?.debit.toFixed(2)).toBe("6000.00");
    expect(duguje?.credit.toFixed(2)).toBe("0.00");
    expect(potrazuje?.credit.toFixed(2)).toBe("6000.00");
    expect(potrazuje?.debit.toFixed(2)).toBe("0.00");

    // NIJEDAN PDV konto — ni ulazni (27xx) ni izlazni (47xx).
    for (const l of lines) {
      expect(l.accountCode).not.toMatch(/^(27|47)/);
    }
  });

  it("i sa VIŠE stavki po različitim stopama ostaju ista dva reda", async () => {
    // Popis ne bira artikle po tarifi — u istom viška ima i 20 % i 10 % i oslobođenih.
    const h = makeEngine({
      items: [
        stavka({ goodsTaxRateCode: "3" }), // 20 %
        stavka({ goodsTaxRateCode: "4", purchasePriceNet: new D(1000) }), // 10 %
        stavka({ goodsTaxRateCode: "1", purchasePriceNet: new D(500) }), // 0 %
      ],
    });

    const lines = await h.engine.postFromStockDocument(77);

    expect(lines.map((l) => l.accountCode).sort()).toEqual(["1320", "6740"]);
    expect(lines.find((l) => l.accountCode === "1320")?.debit.toFixed(2)).toBe(
      "7500.00",
    );
  });

  it("nepoznata šifra tarife I DALJE pada glasno (422) — to je kvar u podatku", async () => {
    // Namerno NIJE propušteno: provera ne pita „koliki je porez" nego „zna li sistem ovu
    // šifru". Isti kvar bi se inače sakrio do prve prodaje tog artikla.
    const h = makeEngine({ items: [stavka({ goodsTaxRateCode: "18" })] });

    await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2 — PORESKE VRSTE SU NETAKNUTE
// ═════════════════════════════════════════════════════════════════════════════

describe("§2 poreske vrste — ništa se nije promenilo", () => {
  it("IFR: izlazni PDV 20 % i dalje leže na 4702 (P), kupac nosi O+P", async () => {
    const h = izlaznaFaktura();

    const lines = await h.engine.postFromStockDocument(77);

    const pdv = lines.find((l) => l.accountCode === "4702");
    expect(pdv?.credit.toFixed(2)).toBe("2000.00"); // 10.000 × 20 %
    const kupac = lines.find((l) => l.accountCode === "2040");
    expect(kupac?.debit.toFixed(2)).toBe("12000.00"); // O + P
    const prihod = lines.find((l) => l.accountCode === "6040");
    expect(prihod?.credit.toFixed(2)).toBe("10000.00");
  });

  it("IFGP: PDV na 4701, i brana za sniženu stopu i dalje odbija (šema nema Q)", async () => {
    const h = izlaznaFaktura({
      documentTypeCode: "IFGP",
      schemeId: 36,
      orderType: "IFGP",
      schemeLines: SEMA_36_IFGP,
    });

    const lines = await h.engine.postFromStockDocument(77);
    expect(lines.find((l) => l.accountCode === "4701")?.credit.toFixed(2)).toBe(
      "2000.00",
    );

    // §4 stare brane: stavka na 10 % mora i dalje da padne — porez koji šema ne knjiži
    // nestao bi bez traga, a nalog bi pri tom balansirao.
    const nizastopa = izlaznaFaktura({
      documentTypeCode: "IFGP",
      schemeId: 36,
      orderType: "IFGP",
      schemeLines: SEMA_36_IFGP,
      items: [
        stavka({
          actualWholesalePrice: new D(10000),
          goodsTaxRateCode: "4",
        }),
      ],
    });
    await expect(nizastopa.engine.postFromStockDocument(77)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it("UFROB (ulaz robe): pretporez i dalje nastaje — potiskuje se SAMO neporeska vrsta", async () => {
    const h = makeEngine({
      documentTypeCode: "UFROB",
      kind: "UL",
      schemeId: 3,
      orderType: "UFROB",
      isInbound: true,
      schemeLines: [
        linija(1, "1320", "A+B+C", null),
        linija(2, "2700", "D", null),
        linija(3, "4350", null, "A+B+C+D+E"),
        linija(4, "2710", "E", null),
      ],
      customerId: 4711,
    });

    const lines = await h.engine.postFromStockDocument(77);

    expect(lines.find((l) => l.accountCode === "2700")?.debit.toFixed(2)).toBe(
      "1200.00", // 6.000 × 20 % — isti broj koji je na VISAR-u bio izmišljen
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3 — TRAG, NE ODBIJANJE
// ═════════════════════════════════════════════════════════════════════════════

describe("§3 stavka sa poreskom stopom na neporeskoj vrsti ostavlja trag", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("upozorenje nosi vrstu, šifru stope, osnovicu i iznos koji NIJE obračunat", async () => {
    const h = makeEngine({});

    await h.engine.postFromStockDocument(77);

    expect(warn).toHaveBeenCalledTimes(1);
    const poruka = String(warn.mock.calls[0][0]);
    expect(poruka).toContain("vrsta VISAR");
    expect(poruka).toContain("šifre 3");
    expect(poruka).toContain("6000.00"); // osnovica
    expect(poruka).toContain("1200.00"); // pretporez koji bi bio izmišljen
    expect(poruka).toContain("namerno");
    // Poruka mora da uputi na PRAVO mesto odluke, a ne na „ispravi tarifu artikla" —
    // tarifa artikla nema veze sa tim što je magacioner zatekao komad viška.
    expect(poruka).toContain("pdv-po-vrsti-dokumenta.ts");
  });

  it("nema stavke sa stopom → nema šuma u logu", async () => {
    const h = makeEngine({ items: [stavka({ goodsTaxRateCode: "1" })] }); // 0 %

    await h.engine.postFromStockDocument(77);

    expect(warn).not.toHaveBeenCalled();
  });

  it("poreska vrsta ne ostavlja trag (nema šta da se potisne)", async () => {
    const h = izlaznaFaktura();

    await h.engine.postFromStockDocument(77);

    expect(warn).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4 — BRANA RAZILAŽENJA (tiha rupa suprotnog smera)
// ═════════════════════════════════════════════════════════════════════════════

describe("§4 vrsta i šema se ne smeju raziću", () => {
  it("neporeska vrsta + šema sa PDV redom = 422, ne tiho nula-red", async () => {
    // Bez ove brane bi red `4700 = P` uvek bio nula (porez se ne računa) i
    // `finalizeLedgerLines` bi ga ćutke odbacio — knjigovođa bi mislio da porez leže.
    const h = makeEngine({
      schemeLines: [...SEMA_46_VISAK, linija(2, "2700", "D", null)],
    });

    await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
      /proglašena NEPORESKOM/,
    );
  });

  it("čista funkcija: bez razilaženja vraća null, sa razilaženjem opis šta da se uradi", () => {
    const bez = razilazenjeVrsteISeme({
      documentTypeCode: "VISAR",
      schemeId: 46,
      orderType: "VISAK",
      schemeLines: SEMA_46_VISAK,
      isInbound: true,
    });
    expect(bez).toBeNull();

    const sa = razilazenjeVrsteISeme({
      documentTypeCode: "VISAR",
      schemeId: 46,
      orderType: "VISAK",
      schemeLines: [...SEMA_46_VISAK, linija(2, "2700", "D", null)],
      isInbound: true,
    });
    expect(sa).toContain("D (opštom stopom (20 %))");
    expect(sa).toContain("VRSTE_BEZ_PDV");

    // Poreska vrsta sa PDV redom nije razilaženje — to je normalno stanje.
    expect(
      razilazenjeVrsteISeme({
        documentTypeCode: "IFR",
        schemeId: 33,
        orderType: "IFR",
        schemeLines: SEMA_33_IFR,
        isInbound: false,
      }),
    ).toBeNull();
  });

  it("razilaženje se meri po SMERU: izlazni slot na ulaznoj vrsti nije sudar", () => {
    // `aggregateDocAmounts` računa obe strane, pa bi provera bez smera odbijala pola sveta.
    expect(
      razilazenjeVrsteISeme({
        documentTypeCode: "PREUL",
        schemeId: 99,
        orderType: "PREUL",
        schemeLines: [linija(1, "4702", null, "P")], // izlazni slot
        isInbound: true, // ulazni dokument
      }),
    ).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §5 — SAM SPISAK: MERENJE PRETOČENO U TVRDNJE
// ═════════════════════════════════════════════════════════════════════════════

describe("§5 spisak vrsta bez PDV-a", () => {
  it.each(["VISAR", "VISAK", "VISAM", "PREUL", "PREIZ", "REV", "NIV"])(
    "„%s" + "” ne nosi PDV",
    (code) => {
      expect(vrstaNosiPdv(code)).toBe(false);
    },
  );

  it.each(["MANJR", "MANJM", "OTPIR", "OTPIM", "DONAC", "REPRE"])(
    "„%s" + "” NOSI PDV — šema mu ima red 4700 = P (izlazni 20 %)",
    (code) => {
      // Manjak preko normativa, otpis i donacija su rashodovanje/upotreba za vansistemske
      // svrhe — zakon na njih traži izlazni PDV. Manjak je ASIMETRIČAN višku; ko ih
      // izjednači „iz simetrije", izbrisaće porez koji država potražuje.
      expect(vrstaNosiPdv(code)).toBe(true);
      expect(VRSTE_BEZ_PDV.has(code)).toBe(false);
    },
  );

  it.each(["IFR", "IFGP", "IFUSL", "IZVRO", "IZVGP", "IZVUS", "UFROB", "AVR"])(
    "„%s" + "” nosi PDV (kod izvoza je stopa 0, ali porez POSTOJI kao pojam)",
    (code) => {
      expect(vrstaNosiPdv(code)).toBe(true);
    },
  );

  it("PON i PROF nisu na spisku, iako im je post_in_vat_ledger=false", () => {
    // Njihov PDV STVARNO postoji (štampa se na predračunu) — oni prosto nikad ne stižu do
    // glavne knjige. Upis ovde bio bi tačan ishod iz netačnog razloga.
    expect(vrstaNosiPdv("PON")).toBe(true);
    expect(vrstaNosiPdv("PROF")).toBe(true);
  });

  it("nepoznata/prazna šifra nosi PDV — default greši u BEZBEDNOM smeru", () => {
    // Nepoznata vrsta se ponaša kao i do sada: porez nastane, pa ga brana uhvati ako šema
    // nema gde da ga stavi. Suprotan default bi tiho gasio porez na svakoj zaboravljenoj šifri.
    expect(vrstaNosiPdv("NEPOZNATO")).toBe(true);
    expect(vrstaNosiPdv("")).toBe(true);
    expect(vrstaNosiPdv(null)).toBe(true);
    expect(vrstaNosiPdv(undefined)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §6 — SKENER SLOVA I SLOTOVI (jedan izvor za obe brane)
// ═════════════════════════════════════════════════════════════════════════════

describe("§6 skener slova šeme", () => {
  it("hvata slova iz oba izraza i ignoriše brojeve/operatore", () => {
    expect([...slovaKojaSemaReferise(SEMA_33_IFR)].sort()).toEqual([
      "A",
      "O",
      "P",
      "Q",
    ]);
    expect([...slovaKojaSemaReferise(SEMA_46_VISAK)]).toEqual(["A"]);
    expect(
      [...slovaKojaSemaReferise([linija(1, "1320", "-A+0", null)])].sort(),
    ).toEqual(["A"]);
  });

  it("slotovi po smeru: ulazni D/E/U, izlazni P/Q/W", () => {
    expect(vatSlotsFor(true).map((s) => s.letter)).toEqual(["D", "E", "U"]);
    expect(vatSlotsFor(false).map((s) => s.letter)).toEqual(["P", "Q", "W"]);
  });
});
