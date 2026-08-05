import { Prisma } from "@prisma/client";
import { UnprocessableEntityException } from "@nestjs/common";
import { computeAdvanceDeductions } from "./advance-deduction";
import { AdvanceInvoiceService } from "./advance-invoice.service";
import { FakturisanjeService } from "./fakturisanje.service";
import { InvoicePdfService } from "./print/invoice-pdf.service";
import { SefService } from "./sef/sef.service";
import { AdvanceVatService } from "../pdv/advance-vat.service";
import { BarcodeService } from "../documents/barcode.service";
import { PdfService } from "../documents/pdf.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * ODBIJENI AVANS — JEDAN SCENARIO KROZ SVE POTROŠAČE.
 * =============================================================================
 * Ovaj fajl NE testuje pravilo (to radi `computeAdvanceDeductions` u par tvrdnji na
 * kraju). On testuje da se pravilo NE RAZILAZI: isti račun, isti podaci, pa se pita
 * svaki potrošač posebno — ekran detalja, e-faktura, papir, primena avansa i lista
 * avansa — i svi moraju reći ISTIH 5.000.
 *
 * Zašto baš takav test: do 02.08.2026. je „koliko je avansa odbijeno" bilo prepisano
 * na PET mesta i tri od njih su se razišla. Kvar je bio vidljiv tek kad se uporede
 * papir i ekran za isti račun — nijedan test nad pojedinačnim servisom ga nije mogao
 * uhvatiti, jer je svaki servis bio dosledan SAM SEBI. Zato tvrdnje idu kroz PRAVE
 * ulazne tačke servisa, a ne kroz ponovni poziv zajedničke funkcije (to ne bi
 * dokazalo ništa — dokazalo bi samo da funkcija vraća isto što i ona sama).
 *
 * ── SCENARIJ (izmereno stanje sa produkcije) ─────────────────────────────────
 *
 *   Račun `7/26`            bruto 10.000
 *     ├─ `A-1/26` (id 55)   3.000 — ZATEČENA 1:1 veza: pdv modul, ruta `link-final`
 *     │                             (kolone `advance_invoice_id` + `advance_applied_amount`,
 *     │                             BEZ reda u spojnoj tabeli)
 *     └─ `A-2/26` (id 56)   2.000 — N:M primena (`invoice_advance_applications`)
 *
 *   Kolona `advance_applied_amount` = 5.000 (UNIJA oba), spojna tabela = 2.000.
 *
 * Za uplatu je 5.000. Po starom „ILI-ILI" pravilu (kolona se gleda samo kad primena
 * nema) ekran i e-faktura su videli 2.000 → za uplatu 8.000, i to sa referencom samo
 * na `A-2/26`. Po „kolona ima prednost" strana avansa bi `A-1/26` pripisala celih
 * 5.000, pa bi njegov ostatak nestao pre vremena.
 */

const D = Prisma.Decimal;

const actor: AuthUser = {
  userId: 7,
  email: "knjigovodja@servoteh",
  role: "racunovodja",
  workerId: null,
};

const INVOICE_ID = 1;
/** Drugi konačni račun — na njemu se troši OSTATAK avansa `A-1/26`. */
const OTHER_INVOICE_ID = 2;
const ADVANCE_LEGACY_ID = 55; // A-1/26 — vezan starim putem (kolone)
const ADVANCE_NM_ID = 56; // A-2/26 — vezan N:M primenom
const ADVANCE_THIRD_ID = 57; // A-3/26 — dodaje se u toku testa

/** Ono što SVI potrošači moraju da kažu za račun `7/26`. */
const ODBIJENO_UKUPNO = "5000.00";
const ZA_UPLATU = "5000.00";

// ─────────────────────────────────────────────────────────────── lažna baza

interface FakeInvoice {
  id: number;
  documentType: string;
  documentNumber: string;
  level: number;
  status: string;
  companyId: number;
  customerId: number;
  documentDate: Date;
  dueDate: Date | null;
  supplyDate: Date | null;
  paymentReference: string | null;
  poNumber: string | null;
  note: string | null;
  currency: string;
  isExport: boolean;
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  advanceInvoiceId: number | null;
  advanceAppliedAmount: Prisma.Decimal;
  advanceDirection: string | null;
  advancePaidAt: Date | null;
  advancePaidAmount: Prisma.Decimal;
  items: { vatRateCode: string; vatBase: Prisma.Decimal }[];
}

interface FakeApplication {
  id: number;
  invoiceId: number;
  advanceInvoiceId: number;
  appliedAmount: Prisma.Decimal;
  status: string;
}

function invoice(over: Partial<FakeInvoice> & { id: number }): FakeInvoice {
  return {
    documentType: "IFR",
    documentNumber: `${over.id}/26`,
    level: 0,
    status: "POSTED",
    companyId: 1,
    customerId: 5,
    documentDate: new Date("2026-07-05T00:00:00Z"),
    dueDate: null,
    supplyDate: new Date("2026-07-05T00:00:00Z"),
    paymentReference: null,
    poNumber: null,
    note: null,
    currency: "RSD",
    isExport: false,
    netTotal: new D(10000),
    vatTotal: new D(0),
    grossTotal: new D(10000),
    advanceInvoiceId: null,
    advanceAppliedAmount: new D(0),
    advanceDirection: null,
    advancePaidAt: null,
    advancePaidAmount: new D(0),
    items: [{ vatRateCode: "3", vatBase: new D(10000) }],
    ...over,
  };
}

function advance(
  id: number,
  documentNumber: string,
  paid: string,
): FakeInvoice {
  return invoice({
    id,
    documentNumber,
    documentType: "AVR",
    status: "PAID",
    advanceDirection: "out",
    advancePaidAt: new Date("2026-07-03T00:00:00Z"),
    advancePaidAmount: new D(paid),
    netTotal: new D(paid),
    vatTotal: new D(0),
    grossTotal: new D(paid),
    // 0% PDV: iznosi u tvrdnjama ostaju okrugli, a pravilo o odbitku sa PDV-om nema veze.
    items: [{ vatRateCode: "0", vatBase: new D(paid) }],
  });
}

/** Zatečeno stanje iz scenarija — sveže za svaki test. */
function makeDb() {
  return {
    invoices: [
      invoice({
        id: INVOICE_ID,
        documentNumber: "7/26",
        // Kolone nose UNIJU oba odbitka; spojna tabela zna samo za `A-2/26`.
        advanceInvoiceId: ADVANCE_LEGACY_ID,
        advanceAppliedAmount: new D(5000),
      }),
      invoice({ id: OTHER_INVOICE_ID, documentNumber: "8/26" }),
      advance(ADVANCE_LEGACY_ID, "A-1/26", "5000"),
      advance(ADVANCE_NM_ID, "A-2/26", "2000"),
      advance(ADVANCE_THIRD_ID, "A-3/26", "1000"),
    ],
    applications: [
      {
        id: 800,
        invoiceId: INVOICE_ID,
        advanceInvoiceId: ADVANCE_NM_ID,
        appliedAmount: new D(2000),
        status: "ACTIVE",
      },
    ] as FakeApplication[],
  };
}

type Db = ReturnType<typeof makeDb>;

/** `{ in: [...] }` ili gola vrednost — Prisma dozvoljava oba oblika. */
function matches(filter: unknown, value: number | null): boolean {
  if (filter == null) return true;
  if (typeof filter === "object" && "in" in filter) {
    const list = (filter as { in: number[] }).in;
    return value != null && list.includes(value);
  }
  return filter === value;
}

/**
 * Lažni Prisma klijent nad `db` — jedan za SVE potrošače, da nijedan ne može da vidi
 * podatke koje drugi ne vidi. Prati oblike `where`-a koje servisi stvarno šalju.
 */
function fakePrisma(db: Db) {
  const byId = (id: number | null) =>
    db.invoices.find((i) => i.id === id) ?? null;
  /** Primena u obliku u kom je vraća baza sa uključenim relacijama. */
  const enrich = (a: FakeApplication) => ({
    ...a,
    appliedNet: a.appliedAmount,
    appliedVat: new D(0),
    closingEntryId: null,
    createdAt: new Date("2026-07-06T00:00:00Z"),
    advance: {
      documentNumber: byId(a.advanceInvoiceId)?.documentNumber ?? null,
      advancePaidAt: byId(a.advanceInvoiceId)?.advancePaidAt ?? null,
    },
    invoice: { documentNumber: byId(a.invoiceId)?.documentNumber ?? null },
  });

  return {
    invoice: {
      count: jest.fn(() => Promise.resolve(db.invoices.length)),
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(byId(args.where.id)),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(
        (args: { where?: Record<string, unknown> } | undefined) => {
          const where = args?.where ?? {};
          const rows = db.invoices.filter((i) => {
            if (where.documentType && where.documentType !== i.documentType)
              return false;
            if (
              where.advanceDirection &&
              where.advanceDirection !== i.advanceDirection
            )
              return false;
            if (
              "advanceInvoiceId" in where &&
              !matches(where.advanceInvoiceId, i.advanceInvoiceId)
            )
              return false;
            const status = where.status as { not?: string } | undefined;
            if (status?.not && i.status === status.not) return false;
            return true;
          });
          // Kao u bazi: `select` traži i aktivne primene TOG računa (v. loadAdvanceLinkedInvoices).
          return Promise.resolve(
            rows.map((i) => ({
              ...i,
              advanceApplications: db.applications.filter(
                (a) => a.invoiceId === i.id && a.status === "ACTIVE",
              ),
            })),
          );
        },
      ),
      update: jest.fn((args: { where: { id: number }; data: FakeInvoice }) => {
        const row = byId(args.where.id);
        if (row) Object.assign(row, args.data);
        return Promise.resolve(row);
      }),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      create: jest.fn(() => Promise.resolve({ id: 999 })),
    },
    invoiceAdvanceApplication: {
      findMany: jest.fn((args: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        return Promise.resolve(
          db.applications
            .filter((a) => {
              if (where.status && where.status !== a.status) return false;
              if (
                "invoiceId" in where &&
                !matches(where.invoiceId, a.invoiceId)
              )
                return false;
              if (
                "advanceInvoiceId" in where &&
                !matches(where.advanceInvoiceId, a.advanceInvoiceId)
              )
                return false;
              return true;
            })
            .map(enrich),
        );
      }),
      create: jest.fn((args: { data: FakeApplication }) => {
        const row = { ...args.data, id: 900 + db.applications.length };
        db.applications.push(row);
        return Promise.resolve({ id: row.id });
      }),
      update: jest.fn(() => Promise.resolve({ id: 900 })),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 5,
          name: "KUPAC DOO",
          taxId: "100200300",
          registrationNumber: "12345678",
          address: "Ulica 1",
          city: "Kragujevac",
          publicSectorId: null,
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([{ id: 5, name: "KUPAC DOO" }])),
    },
    company: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 1,
          companyName: "SERVOTEH DOO",
          taxId: "111222333",
          registrationNumber: "87654321",
          address: "Zastavska bb",
          city: "Kragujevac",
          bankAccount: "160-1234-56",
          iban: null,
          swift: null,
        }),
      ),
    },
    item: { findMany: jest.fn(() => Promise.resolve([])) },
    // Registar vrsta dokumenata — `SefService.enqueue` od 03.08.2026. proverava sme li
    // vrsta uopšte na SEF (`document_types.post_in_vat_ledger`). Ovde je scenario
    // izlazna faktura (`IFR`), koja po seed-u registra nosi TRUE.
    documentType: {
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve({
          code: args.where.code,
          description: "Izlazna faktura — roba (izdatnica)",
          isInbound: false,
          postInVatLedger: true,
        }),
      ),
    },
    sefOutbox: {
      // `enqueue` od 04.08.2026. prvo pita ima li ŽIV outbox red za tu fakturu
      // (parnjak parcijalnog unique-a `uq_sef_outbox_live` — jedan živ red po fakturi).
      // `null` = nema živog reda; ovaj spec meri iznos avansa, ne branu duplog reda.
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({ id: 5000 })),
    },
    sefStatusLog: { create: jest.fn(() => Promise.resolve({ id: 1 })) },
    // Brava PDV perioda: prazna lista = nijedan obračun nije proknjižen.
    vatReturn: { findMany: jest.fn(() => Promise.resolve([])) },
    $executeRaw: jest.fn(() => Promise.resolve(0)),
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)(prismaRef.current),
    ),
  };
}

/** `$transaction` prosleđuje SAM SEBE kao `tx` — otud indirekcija. */
const prismaRef: { current: unknown } = { current: null };

function makePrisma(db: Db) {
  const p = fakePrisma(db);
  prismaRef.current = p;
  return p;
}

// ─────────────────────────────────────────────────── potrošači, jedan po jedan

describe("odbijeni avans — svi potrošači daju ISTI iznos", () => {
  let db: Db;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    db = makeDb();
    prisma = makePrisma(db);
  });

  /** Referentna vrednost: samo pravilo, bez ijednog servisa. */
  it("PRAVILO: 5.000 (2.000 primena + 3.000 zatečena veza), dva reda", () => {
    const out = computeAdvanceDeductions({
      invoice: db.invoices[0],
      applications: [
        { advanceInvoiceId: ADVANCE_NM_ID, appliedAmount: new D(2000) },
      ],
      legacyAdvanceDocumentNumber: "A-1/26",
    });

    expect(out.total.toFixed(2)).toBe(ODBIJENO_UKUPNO);
    expect(out.lines.map((l) => l.amount.toFixed(2))).toEqual([
      "3000.00",
      "2000.00",
    ]);
    // Zatečena veza je hronološki prva (`advance_invoice_id` se upisuje pri PRVOM vezivanju).
    expect(out.lines[0].advanceDocumentNumber).toBe("A-1/26");
    expect(out.lines[0].fromLegacyLink).toBe(true);
  });

  /**
   * EKRAN DETALJA RAČUNA. Do ispravke je ovde stajalo „ILI-ILI" — zbir primena, a na
   * kolonu se padalo tek kad primena nema — pa je ekran tvrdio da je odbijeno 2.000 i
   * da se duguje 8.000, dok je papir za isti račun štampao 5.000.
   */
  it("getInvoice: odbijeno 5.000, za uplatu 5.000, oba avansa u spisku", async () => {
    const service = new FakturisanjeService(
      prisma as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never, // exchangeRates — `getInvoice` ne knjiži, pa kurs ne traži
    );

    const res = await service.getInvoice(INVOICE_ID);

    expect(res.advanceAppliedAmount.toFixed(2)).toBe(ODBIJENO_UKUPNO);
    expect(res.payableAmount.toFixed(2)).toBe(ZA_UPLATU);
    // Spisak mora da SABIRA u prikazan iznos — inače ekran protivreči sam sebi.
    expect(res.advanceDeductions.map((d) => d.advanceDocumentNumber)).toEqual([
      "A-1/26",
      "A-2/26",
    ]);
    expect(
      res.advanceDeductions
        .reduce((s, d) => s.add(d.amount), new D(0))
        .toFixed(2),
    ).toBe(ODBIJENO_UKUPNO);
  });

  /**
   * E-FAKTURA (SEF). `cbc:PrepaidAmount` određuje `PayableAmount` koji kupac vidi, a
   * `cac:BillingReference` mora da navede SVAKI odbijen avans. Po starom pravilu je
   * e-faktura nosila 2.000 i referencu samo na `A-2/26` — veći dug nego stvarni, na
   * poreskom dokumentu koji jedan avans prećutkuje.
   */
  it("SEF enqueue: PrepaidAmount 5.000 i referenca na OBA avansa", async () => {
    /** Presretnut UBL ulaz — tvrdnje idu nad njim, ne nad gotovim XML-om. */
    interface UblInput {
      invoice: {
        prepaidAmount: Prisma.Decimal | null;
        prepaymentReferences: string[];
      };
    }
    const ubl = {
      build: jest.fn((input: UblInput) =>
        input.invoice.prepaymentReferences.length > 0
          ? "<Invoice><cac:BillingReference/></Invoice>"
          : "<Invoice/>",
      ),
    };
    const invoicePdf = {
      buildInvoicePdf: jest.fn(() =>
        Promise.resolve({ buffer: Buffer.from("pdf"), fileName: "r.pdf" }),
      ),
    };
    const service = new SefService(
      prisma as never,
      null as never,
      ubl as never,
      invoicePdf as never,
    );

    await service.enqueue(INVOICE_ID, actor.userId);

    const arg = ubl.build.mock.calls[0][0];
    expect(arg.invoice.prepaidAmount?.toFixed(2)).toBe(ODBIJENO_UKUPNO);
    expect(arg.invoice.prepaymentReferences).toEqual(["A-1/26", "A-2/26"]);
  });

  /**
   * PAPIR. Tvrdnja ide nad `loadAdvanceDeductions` — to je tačka na kojoj štampa čita
   * pravilo; sve dalje (PrintCtx → `advanceTotal` → „Za uplatu") pokriva
   * `print/invoice-pdf.service.spec.ts` nad istim scenarijem.
   */
  it("štampa: dva reda umanjenja, zbir 5.000", async () => {
    const service = new InvoicePdfService(
      prisma as never,
      new PdfService(),
      new BarcodeService(),
    );
    const load = (
      service as unknown as {
        loadAdvanceDeductions(
          inv: unknown,
        ): Promise<{ documentNumber: string | null; amount: Prisma.Decimal }[]>;
      }
    ).loadAdvanceDeductions.bind(service);

    const deductions = await load(db.invoices[0]);

    expect(deductions.map((d) => d.documentNumber)).toEqual([
      "A-1/26",
      "A-2/26",
    ]);
    expect(
      deductions.reduce((s, d) => s.add(d.amount), new D(0)).toFixed(2),
    ).toBe(ODBIJENO_UKUPNO);
  });

  /**
   * PRIMENA AVANSA, strana RAČUNA. Sledeći avans na istom računu mora da vidi da je
   * već odbijeno 5.000. Staro pravilo je sabiralo primene PLUS CELU kolonu (2.000 +
   * 5.000 = 7.000), pa bi ovde upisalo 8.000 i oborilo invariantu „kolona = ukupno
   * odbijeno" na kojoj papir i ekran izvode iznos zatečenog reda.
   */
  it("applyAdvance: treći avans vidi 5.000 već odbijeno → ukupno 6.000", async () => {
    const posting = {
      postManualEntry: jest.fn(() =>
        Promise.resolve({ journalEntryId: 77, number: "IF-77" }),
      ),
    };
    const service = new AdvanceInvoiceService(
      prisma as never,
      null as never,
      posting as never,
    );

    const res = await service.applyAdvance(
      {
        invoiceId: INVOICE_ID,
        advanceInvoiceId: ADVANCE_THIRD_ID,
        amount: "1000",
      },
      actor,
    );

    expect(res.advanceAppliedAmount.toFixed(2)).toBe("6000.00");
    expect(res.payableAmount.toFixed(2)).toBe("4000.00");
  });

  /**
   * PRIMENA AVANSA, strana AVANSA. `A-1/26` je naplaćen 5.000 i potrošen 3.000 na
   * računu `7/26` — ostatak je 2.000.
   *
   * Staro pravilo je avansu pripisivalo CELU kolonu računa `7/26` (5.000), iako je
   * 2.000 od toga tuđi odbitak (`A-2/26`) — pa je `A-1/26` ispadao potrošen do kraja i
   * njegov ostatak se nije mogao odbiti NIGDE.
   */
  it("applyAdvance: ostatak zatečenog avansa je 2.000 — ni 0 ni 5.000", async () => {
    const posting = {
      postManualEntry: jest.fn(() =>
        Promise.resolve({ journalEntryId: 78, number: "IF-78" }),
      ),
    };
    const service = new AdvanceInvoiceService(
      prisma as never,
      null as never,
      posting as never,
    );

    // Preko ostatka → 422 (dokaz da ostatak NIJE 5.000).
    await expect(
      service.applyAdvance(
        {
          invoiceId: OTHER_INVOICE_ID,
          advanceInvoiceId: ADVANCE_LEGACY_ID,
          amount: "2500",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // Tačno ostatak → prolazi (dokaz da ostatak NIJE 0).
    const res = await service.applyAdvance(
      {
        invoiceId: OTHER_INVOICE_ID,
        advanceInvoiceId: ADVANCE_LEGACY_ID,
        amount: "2000",
      },
      actor,
    );
    expect(res.appliedAmount.toFixed(2)).toBe("2000.00");
    expect(res.advanceRemainingAmount.toFixed(2)).toBe("0.00");
  });

  /**
   * LISTA AVANSA (pdv modul). Ekran po `remainingAmount > 0` nudi „Veži na konačni
   * račun" — mora da pokaže isti ostatak koji server dozvoljava, inače dugme laže u
   * jednu ili drugu stranu.
   */
  it("listAdvances: A-1/26 iskorišćen 3.000, ostatak 2.000", async () => {
    const service = new AdvanceVatService(prisma as never, null as never);

    const rows = (await service.listAdvances({})).data;
    const a1 = rows.find((r) => r.id === ADVANCE_LEGACY_ID)!;
    const a2 = rows.find((r) => r.id === ADVANCE_NM_ID)!;

    expect(a1.appliedAmount.toFixed(2)).toBe("3000.00");
    expect(a1.remainingAmount.toFixed(2)).toBe("2000.00");
    expect(a1.applications.map((x) => x.documentNumber)).toEqual(["7/26"]);
    // Drugi avans na ISTOM računu ne sme da pokupi tuđi deo kolone.
    expect(a2.appliedAmount.toFixed(2)).toBe("2000.00");
    expect(a2.remainingAmount.toFixed(2)).toBe("0.00");
  });
});

// ─────────────────────────────────────────────────────── ivice samog pravila

describe("computeAdvanceDeductions — ivice", () => {
  const columns = (advanceInvoiceId: number | null, applied: string) => ({
    advanceInvoiceId,
    advanceAppliedAmount: new D(applied),
  });

  it("zatečena veza koja IMA svoj red u spojnoj tabeli se ne broji dvaput", () => {
    const out = computeAdvanceDeductions({
      invoice: columns(55, "3000"),
      applications: [{ advanceInvoiceId: 55, appliedAmount: new D(3000) }],
    });
    expect(out.total.toFixed(2)).toBe("3000.00");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].fromLegacyLink).toBe(false);
  });

  it("zaostala kolona (manja od Σ primena) ne pravi red od 0 niti oduzima minus", () => {
    // Kolona ume da zaostane posle ručne ispravke u bazi ili storna primene. Negativna
    // razlika kao red umanjenja kupcu bi POVEĆALA dug.
    const out = computeAdvanceDeductions({
      invoice: columns(55, "2000"),
      applications: [{ advanceInvoiceId: 56, appliedAmount: new D(2000) }],
    });
    expect(out.total.toFixed(2)).toBe("2000.00");
    expect(out.lines).toHaveLength(1);
  });

  it("bez ijedne primene pada na zatečenu vezu iz kolone", () => {
    const out = computeAdvanceDeductions({
      invoice: columns(55, "3000"),
      applications: [],
      legacyAdvanceDocumentNumber: "A-1/26",
    });
    expect(out.total.toFixed(2)).toBe("3000.00");
    expect(out.lines[0].advanceDocumentNumber).toBe("A-1/26");
  });

  it("račun bez avansa daje nulu i prazan spisak", () => {
    const out = computeAdvanceDeductions({
      invoice: columns(null, "0"),
      applications: [],
    });
    expect(out.total.toFixed(2)).toBe("0.00");
    expect(out.lines).toEqual([]);
  });

  it("`total` je UVEK zbir `lines` — spisak i iznos ne smeju da se raziđu", () => {
    const out = computeAdvanceDeductions({
      invoice: columns(55, "5000"),
      applications: [
        { advanceInvoiceId: 56, appliedAmount: new D(2000) },
        { advanceInvoiceId: 57, appliedAmount: new D(1000) },
      ],
    });
    expect(
      out.lines.reduce((s, l) => s.add(l.amount), new D(0)).toFixed(2),
    ).toBe(out.total.toFixed(2));
    expect(out.total.toFixed(2)).toBe("5000.00");
  });
});
