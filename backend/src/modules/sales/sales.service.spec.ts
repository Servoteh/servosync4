import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PricingService } from "./pricing.service";
import { SalesService } from "./sales.service";
import { vatPercentOf } from "./vat-totals";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * IZMENA PRODAJNOG DOKUMENTA — brane i računica.
 * =========================================================================
 * Pokriveno:
 *   B1  proknjižen/zaključan/storniran dokument → 409 sa uputstvom ŠTA da se uradi,
 *       + CAS: dokument proknjižen IZMEĐU čitanja i upisa → 409 (ništa se ne sačuva),
 *   B2  zaključan PDV period → 409,
 *   B3  zbirovi zaglavlja se preračunavaju iz stavki posle SVAKE izmene,
 *   B4  koeficijent je PONOVLJIV: `unitPrice = baseUnitPrice × koeficijent`,
 *       dva ista poziva daju isti rezultat, povratak na 1 vraća polazne cene,
 *   + IDOR (stavka tuđeg dokumenta), godina broja vs datum, i pravilo da
 *     izmena SAMO količine ne pregazi dogovorenu cenu novim cenovnikom.
 *
 * PricingService je PRAVI (ne mock) — test time dokazuje da servis ne nosi svoju
 * formulu za rabat/PDV, nego zove postojeći računar.
 */

const D = Prisma.Decimal;

const actor: AuthUser = {
  userId: 7,
  email: "komercijala@servoteh",
  role: "komercijalista",
  workerId: null,
};

interface ItemRow {
  id: number;
  invoiceId: number;
  lineNo: number;
  itemId: number | null;
  description: string | null;
  quantity: Prisma.Decimal;
  baseUnitPrice: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  cashDiscountPercent: Prisma.Decimal;
  vatRateCode: string;
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

type Row = Record<string, unknown>;

/** Stavka 2 kom × 1.000 (PDV 20%), bez rabata — koeficijent 1. */
function itemRow(over: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 100,
    invoiceId: 1,
    lineNo: 1,
    itemId: 42,
    description: "Artikal",
    quantity: new D(2),
    baseUnitPrice: new D(1000),
    unitPrice: new D(1000),
    discountPercent: new D(0),
    cashDiscountPercent: new D(0),
    vatRateCode: "3",
    vatBase: new D(2000),
    vatAmount: new D(400),
    lineTotal: new D(2400),
    ...over,
  };
}

/**
 * Mala in-memory baza: dovoljno verna da testovi mere STANJE posle izmene, a ne
 * samo da je neki mock pozvan. `$transaction` prosleđuje isti objekat kao `tx`.
 */
function makeDb(
  opts: { invoice?: Row; items?: ItemRow[]; vatLocked?: boolean } = {},
) {
  const invoice: Row = {
    id: 1,
    documentType: "PROF",
    documentNumber: "PROF0001/2026",
    status: "DRAFT",
    isLocked: false,
    level: 250,
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-07-10T00:00:00Z"),
    dueDate: null,
    currency: "RSD",
    exchangeRate: new D(1),
    accountingExchangeRate: new D(1),
    isExport: false,
    priceCoefficient: new D(1),
    netTotal: new D(0),
    vatTotal: new D(0),
    grossTotal: new D(0),
    note: null,
    lineProfile: null,
    ...opts.invoice,
  };
  const items: ItemRow[] = opts.items ? [...opts.items] : [];
  let nextItemId = 900;

  /** Simulira `updateMany` CAS: menja SAMO ako je dokument još nacrt. */
  const casUpdate = jest.fn((args: { where: Row; data: Row }) => {
    const w = args.where;
    const matchStatus = w.status === undefined || invoice.status === w.status;
    const matchLock =
      w.isLocked === undefined || invoice.isLocked === w.isLocked;
    if (!matchStatus || !matchLock) return Promise.resolve({ count: 0 });
    Object.assign(invoice, args.data);
    return Promise.resolve({ count: 1 });
  });

  const db = {
    invoice: {
      findUnique: jest.fn((args: { include?: Row }) =>
        Promise.resolve(
          args.include
            ? {
                ...invoice,
                items: [...items].sort((a, b) => a.lineNo - b.lineNo),
              }
            : { ...invoice },
        ),
      ),
      update: jest.fn((args: { data: Row }) => {
        Object.assign(invoice, args.data);
        return Promise.resolve({ ...invoice });
      }),
      updateMany: casUpdate,
    },
    invoiceItem: {
      findMany: jest.fn((args: { orderBy?: { lineNo?: string } }) => {
        const sorted = [...items].sort((a, b) => a.lineNo - b.lineNo);
        if (args.orderBy?.lineNo === "desc") sorted.reverse();
        return Promise.resolve(sorted.map((i) => ({ ...i })));
      }),
      findFirst: jest.fn(() => {
        const sorted = [...items].sort((a, b) => b.lineNo - a.lineNo);
        return Promise.resolve(sorted[0] ? { ...sorted[0] } : null);
      }),
      findUnique: jest.fn((args: { where: { id: number } }) => {
        const found = items.find((i) => i.id === args.where.id);
        return Promise.resolve(found ? { ...found } : null);
      }),
      create: jest.fn((args: { data: Row }) => {
        nextItemId += 1;
        const row = { id: nextItemId, ...args.data } as unknown as ItemRow;
        items.push(row);
        return Promise.resolve({ ...row });
      }),
      update: jest.fn((args: { where: { id: number }; data: Row }) => {
        const found = items.find((i) => i.id === args.where.id);
        if (found) Object.assign(found, args.data);
        return Promise.resolve({ ...(found as ItemRow) });
      }),
      delete: jest.fn((args: { where: { id: number } }) => {
        const idx = items.findIndex((i) => i.id === args.where.id);
        const [removed] = items.splice(idx, 1);
        return Promise.resolve(removed);
      }),
    },
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 5, customerDiscount: 0 }),
      ),
    },
    item: {
      findUnique: jest.fn(() =>
        Promise.resolve({
          id: 42,
          wholesalePrice: 1000,
          maxDiscountPercent: 100,
          goodsTaxRateCode: "3",
          groupCode: null,
        }),
      ),
    },
    priceListEntry: { findFirst: jest.fn(() => Promise.resolve(null)) },
    customerDiscount: { findMany: jest.fn(() => Promise.resolve([])) },
    // Brava PDV perioda: prazna lista = period otvoren.
    vatReturn: {
      findMany: jest.fn(() =>
        Promise.resolve(
          opts.vatLocked
            ? [{ id: 3, periodMonth: 7, periodQuarter: null }]
            : [],
        ),
      ),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(db),
  );

  return { db, invoice, items, casUpdate };
}

function service(db: unknown) {
  return new SalesService(db as never, new PricingService(db as never));
}

// ── B1: nacrt ili ništa ──────────────────────────────────────────────────────

describe("B1 — proknjižen/zaključan dokument se ne menja", () => {
  it("proknjižen račun → 409 koji kaže da ispravka ide protivdokumentom", async () => {
    const { db } = makeDb({
      invoice: {
        status: "POSTED",
        isLocked: true,
        documentNumber: "IFR0043/2026",
      },
    });
    await expect(
      service(db).updateHeader(1, { note: "ispravka" }, actor),
    ).rejects.toThrow(ConflictException);

    await service(db)
      .updateHeader(1, { note: "ispravka" }, actor)
      .catch((err: ConflictException) => {
        const msg = String(err.message);
        expect(msg).toContain("IFR0043/2026");
        expect(msg).toContain("proknjižen");
        expect(msg).toContain("protivdokument");
        expect(msg).toContain("storno");
      });
  });

  it("storniran dokument → 409 (ne oživljava se izmenom)", async () => {
    const { db } = makeDb({ invoice: { status: "CANCELLED", isLocked: true } });
    await expect(
      service(db).addItem(1, { itemId: 42, quantity: 1 }, actor),
    ).rejects.toThrow(/storniran/);
  });

  it("zaključan nacrt (isLocked bez knjiženja) → 409", async () => {
    const { db } = makeDb({ invoice: { isLocked: true } });
    await expect(service(db).removeItem(1, 100, actor)).rejects.toThrow(
      /zaključan/,
    );
  });

  it("CAS: knjiženje IZMEĐU čitanja i upisa → 409, stavka se NE dodaje", async () => {
    const { db, items, invoice } = makeDb({ items: [itemRow()] });
    // Simulacija trke: dokument se proknjiži tek pošto su brane pročitale nacrt.
    db.invoice.findUnique.mockImplementationOnce(() =>
      Promise.resolve({ ...invoice }),
    );
    db.item.findUnique.mockImplementationOnce(() => {
      invoice.status = "POSTED";
      invoice.isLocked = true;
      return Promise.resolve({
        id: 42,
        wholesalePrice: 1000,
        maxDiscountPercent: 100,
        goodsTaxRateCode: "3",
        groupCode: null,
      });
    });

    await expect(
      service(db).addItem(1, { itemId: 42, quantity: 1 }, actor),
    ).rejects.toThrow(ConflictException);
    expect(items).toHaveLength(1);
  });

  it("nepostojeći dokument → 404", async () => {
    const { db } = makeDb();
    db.invoice.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      service(db).updateHeader(999, { note: "x" }, actor),
    ).rejects.toThrow(NotFoundException);
  });
});

// ── B2: zaključan PDV period ─────────────────────────────────────────────────

describe("B2 — zaključan PDV period", () => {
  it("izmena zaglavlja u zaključanom periodu → 409", async () => {
    const { db } = makeDb({ vatLocked: true });
    await expect(
      service(db).updateHeader(1, { note: "x" }, actor),
    ).rejects.toThrow(/PDV period/);
  });

  it("brana gleda NOVI datum kad se datum menja", async () => {
    const { db } = makeDb();
    // Zaključan je samo jul; dokument je u julu, novi datum je 12.07. → i dalje jul.
    db.vatReturn.findMany.mockResolvedValue([
      { id: 3, periodMonth: 7, periodQuarter: null },
    ] as never);
    await expect(
      service(db).updateHeader(1, { documentDate: "2026-07-12" }, actor),
    ).rejects.toThrow(/PDV period 2026-07/);
  });

  it("dodavanje stavke u zaključanom periodu → 409", async () => {
    const { db, items } = makeDb({ vatLocked: true });
    await expect(
      service(db).addItem(1, { itemId: 42, quantity: 1 }, actor),
    ).rejects.toThrow(ConflictException);
    expect(items).toHaveLength(0);
  });
});

// ── B3: zbirovi ──────────────────────────────────────────────────────────────

describe("B3 — zbirovi se preračunavaju posle svake izmene stavke", () => {
  it("dodavanje stavke puni net/vat/gross iz stavki", async () => {
    const { db, invoice } = makeDb();
    const result = await service(db).addItem(
      1,
      { itemId: 42, quantity: 2 },
      actor,
    );

    expect(new D(invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe(
      "2000.00",
    );
    expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("400.00");
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      "2400.00",
    );
    expect(result.items).toHaveLength(1);
  });

  it("brisanje stavke skida njen iznos i prenumeriše preostale", async () => {
    const { db, items, invoice } = makeDb({
      items: [
        itemRow({ id: 100, lineNo: 1 }),
        itemRow({
          id: 101,
          lineNo: 2,
          quantity: new D(1),
          vatBase: new D(1000),
          vatAmount: new D(200),
          lineTotal: new D(1200),
        }),
      ],
    });

    await service(db).removeItem(1, 100, actor);

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(101);
    expect(items[0].lineNo).toBe(1); // prenumerisano, bez rupe
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      "1200.00",
    );
  });

  it("brisanje POSLEDNJE stavke ostavlja nule (dokument ostaje, prazan)", async () => {
    const { db, items, invoice } = makeDb({ items: [itemRow()] });
    await service(db).removeItem(1, 100, actor);
    expect(items).toHaveLength(0);
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe("0.00");
  });

  it("stavka tuđeg dokumenta → 404 (IDOR brana)", async () => {
    const { db } = makeDb({ items: [itemRow({ invoiceId: 77 })] });
    await expect(service(db).removeItem(1, 100, actor)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ── B4: koeficijent (§8/O1) ──────────────────────────────────────────────────

describe("B4 — koeficijent cene je izveden i PONOVLJIV", () => {
  it("primena koeficijenta množi baznu cenu, ne dira baseUnitPrice", async () => {
    const { db, items } = makeDb({ items: [itemRow()] });

    await service(db).updateHeader(1, { priceCoefficient: "1.1" }, actor);

    expect(items[0].baseUnitPrice.toString()).toBe("1000");
    expect(items[0].unitPrice.toString()).toBe("1100");
    expect(items[0].vatBase.toFixed(2)).toBe("2200.00");
    expect(items[0].vatAmount.toFixed(2)).toBe("440.00");
    expect(items[0].lineTotal.toFixed(2)).toBe("2640.00");
  });

  it("DVA POZIVA sa istim koeficijentom daju isti rezultat (idempotencija)", async () => {
    const { db, items } = makeDb({ items: [itemRow()] });
    const svc = service(db);

    await svc.updateHeader(1, { priceCoefficient: "1.1" }, actor);
    const first = {
      base: items[0].baseUnitPrice.toString(),
      unit: items[0].unitPrice.toString(),
      gross: items[0].lineTotal.toString(),
    };

    await svc.updateHeader(1, { priceCoefficient: "1.1" }, actor);

    expect(items[0].baseUnitPrice.toString()).toBe(first.base);
    expect(items[0].unitPrice.toString()).toBe(first.unit);
    expect(items[0].lineTotal.toString()).toBe(first.gross);
  });

  it("povratak na 1 vraća polazne cene (BigBit to nije umeo)", async () => {
    const { db, items } = makeDb({ items: [itemRow()] });
    const svc = service(db);

    await svc.updateHeader(1, { priceCoefficient: "1.35" }, actor);
    expect(items[0].unitPrice.toString()).toBe("1350");

    await svc.updateHeader(1, { priceCoefficient: 1 }, actor);
    expect(items[0].unitPrice.toString()).toBe("1000");
    expect(items[0].lineTotal.toFixed(2)).toBe("2400.00");
  });

  it("koeficijent iz stringa ide u Decimal bez prolaska kroz float", async () => {
    const { db, items, invoice } = makeDb({ items: [itemRow()] });
    await service(db).updateHeader(1, { priceCoefficient: "1.0345" }, actor);

    // 1000 × 1.0345 = 1034.5 TAČNO (float bi umeo da da 1034.4999999999998).
    expect(items[0].unitPrice.toString()).toBe("1034.5");
    expect(new D(invoice.priceCoefficient as Prisma.Decimal).toString()).toBe(
      "1.0345",
    );
  });

  it("koeficijent se upisuje i u zaglavlje, sa tragom ko ga je primenio", async () => {
    const { db, invoice } = makeDb({ items: [itemRow()] });
    await service(db).updateHeader(1, { priceCoefficient: "2" }, actor);
    expect(new D(invoice.priceCoefficient as Prisma.Decimal).toString()).toBe(
      "2",
    );
    expect(invoice.priceCoefficientAppliedBy).toBe(7);
    expect(invoice.priceCoefficientAppliedAt).toBeInstanceOf(Date);
  });

  it("koeficijent 0 → 400 (utišao bi ceo dokument)", async () => {
    const { db } = makeDb({ items: [itemRow()] });
    await expect(
      service(db).updateHeader(1, { priceCoefficient: 0 }, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it("NOVA stavka na dokumentu sa koeficijentom odmah dobija izvedenu cenu", async () => {
    const { db, items } = makeDb({
      invoice: { priceCoefficient: new D("1.2") },
    });
    await service(db).addItem(1, { itemId: 42, quantity: 1 }, actor);
    expect(items[0].baseUnitPrice.toString()).toBe("1000");
    expect(items[0].unitPrice.toString()).toBe("1200");
  });
});

// ── Izmena stavke ────────────────────────────────────────────────────────────

describe("Izmena stavke", () => {
  it("promena SAMO količine ne dira dogovorenu cenu", async () => {
    const { db, items, invoice } = makeDb({
      // Cena je nekad dogovorena na 900 (rabat 10%); cenovnik danas kaže 1000.
      items: [
        itemRow({
          baseUnitPrice: new D(900),
          unitPrice: new D(900),
          discountPercent: new D(10),
          vatBase: new D(1800),
          vatAmount: new D(360),
          lineTotal: new D(2160),
        }),
      ],
    });

    await service(db).updateItem(1, 100, { quantity: 3 }, actor);

    expect(items[0].baseUnitPrice.toString()).toBe("900");
    expect(items[0].unitPrice.toString()).toBe("900");
    expect(items[0].vatBase.toFixed(2)).toBe("2700.00");
    expect(items[0].vatAmount.toFixed(2)).toBe("540.00");
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      "3240.00",
    );
  });

  it("promena rabata preračunava cenu kroz PricingService", async () => {
    const { db, items } = makeDb({ items: [itemRow()] });
    await service(db).updateItem(1, 100, { discountPercent: 10 }, actor);
    // 1000 − 10% = 900; 2 kom → 1.800 + 360 PDV.
    expect(items[0].baseUnitPrice.toString()).toBe("900");
    expect(items[0].discountPercent.toString()).toBe("10");
    expect(items[0].lineTotal.toFixed(2)).toBe("2160.00");
  });

  it("prekucana cena je BAZNA cena (koeficijent se množi na nju)", async () => {
    const { db, items } = makeDb({
      invoice: { priceCoefficient: new D("1.5") },
      items: [itemRow()],
    });
    await service(db).updateItem(1, 100, { unitPrice: "800" }, actor);
    expect(items[0].baseUnitPrice.toString()).toBe("800");
    expect(items[0].unitPrice.toString()).toBe("1200");
  });

  it("rabat na slobodnoj (uslužnoj) stavci bez cene → 422, cena se NE briše", async () => {
    const { db, items } = makeDb({
      items: [itemRow({ itemId: null, description: "Usluga montaže" })],
    });
    await expect(
      service(db).updateItem(1, 100, { discountPercent: 5 }, actor),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(items[0].unitPrice.toString()).toBe("1000");
  });

  it("nepoznata PDV šifra → 400 (ne pada tiho na 0%)", async () => {
    const { db } = makeDb({ items: [itemRow()] });
    await expect(
      service(db).updateItem(1, 100, { vatRateCode: "9" }, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it("količina 0 → 400", async () => {
    const { db } = makeDb({ items: [itemRow()] });
    await expect(
      service(db).updateItem(1, 100, { quantity: 0 }, actor),
    ).rejects.toThrow(BadRequestException);
  });
});

// ── Zaglavlje: ostala polja ──────────────────────────────────────────────────

describe("Izmena zaglavlja", () => {
  it("menja datum, valutu, kurs, rok plaćanja i napomenu", async () => {
    const { db, invoice } = makeDb();
    await service(db).updateHeader(
      1,
      {
        documentDate: "2026-07-15",
        dueDate: "2026-08-14",
        currency: "eur",
        exchangeRate: "117.2345",
        note: "  Po ugovoru 12/26  ",
      },
      actor,
    );

    expect((invoice.documentDate as Date).toISOString()).toContain(
      "2026-07-15",
    );
    expect(invoice.currency).toBe("EUR");
    expect(new D(invoice.exchangeRate as Prisma.Decimal).toString()).toBe(
      "117.2345",
    );
    expect(invoice.note).toBe("Po ugovoru 12/26");
    expect(invoice.updatedByUserId).toBe(7);
  });

  it("`null` briše polje, izostanak polja ga ne dira", async () => {
    const { db, invoice } = makeDb({
      invoice: { note: "stara", poNumber: "NAR-1" },
    });
    await service(db).updateHeader(1, { note: null }, actor);
    expect(invoice.note).toBeNull();
    expect(invoice.poNumber).toBe("NAR-1");
  });

  it("nepostojeći kupac → 404", async () => {
    const { db } = makeDb();
    db.customer.findUnique.mockResolvedValueOnce(null as never);
    await expect(
      service(db).updateHeader(1, { customerId: 999 }, actor),
    ).rejects.toThrow(NotFoundException);
  });

  it("prazno telo → 400", async () => {
    const { db } = makeDb();
    await expect(service(db).updateHeader(1, {}, actor)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("profil stavki prima samo GOODS/SERVICE", async () => {
    const { db, invoice } = makeDb();
    await service(db).updateHeader(1, { lineProfile: "service" }, actor);
    expect(invoice.lineProfile).toBe("SERVICE");
    await expect(
      service(db).updateHeader(1, { lineProfile: "ROBA" }, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it("datum se ne sme prebaciti u drugu godinu (broj pripada godišnjem nizu)", async () => {
    const { db, invoice } = makeDb();
    await expect(
      service(db).updateHeader(1, { documentDate: "2027-01-05" }, actor),
    ).rejects.toThrow(/2026/);
    expect((invoice.documentDate as Date).toISOString()).toContain(
      "2026-07-10",
    );
  });

  it("nacrt iz prepisa (bez definitivnog broja) sme da promeni godinu", async () => {
    const { db, invoice } = makeDb({
      invoice: { documentNumber: "DRAFT-1", documentType: "IFR", level: 0 },
    });
    await service(db).updateHeader(1, { documentDate: "2027-01-05" }, actor);
    expect((invoice.documentDate as Date).toISOString()).toContain(
      "2027-01-05",
    );
  });
});

// ── Izvoz ────────────────────────────────────────────────────────────────────

describe("Izvoz — PDV se ne obračunava", () => {
  it("stavka na izvoznom dokumentu dobija šifru 0 i PDV 0", async () => {
    const { db, items, invoice } = makeDb({
      invoice: { isExport: true, documentType: "IZVRO", currency: "EUR" },
    });
    await service(db).addItem(1, { itemId: 42, quantity: 2 }, actor);
    expect(items[0].vatRateCode).toBe("0");
    expect(items[0].vatAmount.toFixed(2)).toBe("0.00");
    expect(items[0].lineTotal.toFixed(2)).toBe("2000.00");
    expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("0.00");
  });
});

// ── B3′: PDV DOKUMENTA SE RAČUNA PO STOPI, NE SABIRANJEM STAVKI ──────────────

/**
 * 🔴 VISOK NALAZ (peti krug, 02.08.2026): `vatTotal` je bio ZBIR ZAOKRUŽENIH PDV-a PO
 * STAVCI, pa jednačina koju papir ŠTAMPA — `osnovica × stopa = PDV` — više nije važila.
 *
 * IZMERENO: 5 stavki × 1 kom × 100,01 din uz 20 % → osnovica 500,05, `Σ vatAmount` =
 * 5 × round2(20,002) = 100,00, a `500,05 × 20 % = 100,01`. Papir je štampao
 * `PDV po stopi 20 % · 500,05 · 100,00`, SEF bi poslao `TaxSubtotal` koji obara EN 16931
 * BR-CO-17, a KIF (koji osnovicu IZVODI iz PDV-a) bi nosio 500,00 umesto 500,05.
 *
 * Monte Carlo nad 20.000 dokumenata: na 5 stavki se razilazi 43,7 % dokumenata, na 20
 * stavki 69,4 % i do 0,05 din; na stopi 10 % do 0,06 din.
 */
describe("B3′ — PDV zaglavlja se računa iz osnovice po stopi", () => {
  /** Stavka bez rabata: `qty × cena` je već zaokruženo, kao što ga i `PricingService` piše. */
  const stavka = (
    id: number,
    vatBase: string,
    vatRateCode = "3",
  ): ReturnType<typeof itemRow> =>
    itemRow({
      id,
      lineNo: id - 99,
      quantity: new D(1),
      baseUnitPrice: new D(vatBase),
      unitPrice: new D(vatBase),
      vatRateCode,
      vatBase: new D(vatBase),
      vatAmount: new D(vatBase).mul(vatRateCode === "4" ? "0.10" : "0.20")
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      lineTotal: new D(0),
    });

  it("5 × 100,01 din uz 20 % → PDV 100,01 (ne 100,00 iz zbira stavki)", async () => {
    const { db, invoice } = makeDb({
      items: [100, 101, 102, 103, 104].map((id) => stavka(id, "100.01")),
    });

    // Bilo koja izmena okida `recalcTotals` — merimo zaglavlje, ne put do njega.
    await service(db).updateHeader(1, { note: "preračun" }, actor);

    expect(new D(invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe("500.05");
    expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("100.01");
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      "600.06",
    );
  });

  // ŠIFRE STOPA (ispravka 02.08.2026): snižena stopa 10 % je „4" (NIZA), poljoprivredna
  // 8 % je „5" (POLJO), a šifre „2" u `R_Tarife` NEMA. Ranije je ovde stajalo „2" za
  // 10 % i „4" za 8 % — v. `gl/posting/vat-rates.ts`. Iznosi u testovima se NE menjaju,
  // menja se samo šifra kojom se stopa imenuje.
  it("dve stope na istom računu: svaka grupa nosi svoj `round2(osnovica × stopa)`", async () => {
    const { db, invoice } = makeDb({
      items: [
        stavka(100, "100.01", "3"),
        stavka(101, "100.01", "3"),
        stavka(102, "100.05", "4"),
        stavka(103, "100.05", "4"),
      ],
    });

    await service(db).updateHeader(1, { note: "preračun" }, actor);

    // 20 %: 200,02 × 0,20 = 40,004 → 40,00.  10 %: 200,10 × 0,10 = 20,01.
    expect(new D(invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe("400.12");
    expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("60.01");
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      "460.13",
    );
  });

  /**
   * NALAZ S2 (zatvara se trajno): delimično izmenjen nacrt ume da pomeša zaokružene i
   * NEZAOKRUŽENE stavke (kolona je `Decimal(19,4)`), pa dokument ne sabira. Na produkciji
   * danas nema nijedne fakture ni stavke (izmereno 0/0), pa migracija ne treba — ali
   * uvoz, ručna ispravka u bazi ili budući BigBit uvoz mogu da donesu takav red.
   * Zbir se zato brani NA SABIRANJU: svaka osnovica se zaokruži pre nego što uđe u zbir.
   */
  it("mešan dokument (zaokružena + nezaokružena stavka) sabira ZAOKRUŽENE iznose", async () => {
    const { db, invoice } = makeDb({
      items: [
        // „Uvezen" red: 1,5 × 21,3300 = 31,9950 upisano nezaokruženo.
        stavka(100, "31.995"),
        // Red koji je pisao `PricingService` — već na paru.
        stavka(101, "32.00"),
      ],
    });

    await service(db).updateHeader(1, { note: "preračun" }, actor);

    // Papir obe stavke štampa kao `32.00`; osnovica mora biti BAŠ 64,00, ne 63,995.
    expect(new D(invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe("64.00");
    expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("12.80");
    expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe("76.80");
  });

  /**
   * INVARIJANTA NAD NASUMIČNIM DOKUMENTIMA — 1–20 stavki, sve stope.
   * Seme je fiksno (deterministički generator), da pad testa uvek bude ponovljiv.
   */
  it("nasumični dokumenti (1–20 stavki, sve stope) drže jednačinu papira", async () => {
    // „3" i „6" su OBE 20 % — dokument tako uvek meša i par šifri koji se spaja u JEDNU
    // PDV grupu (v. objašnjenje uz `byRate` ispod). Stope se ne prepisuju ovde: lokalni
    // spisak stopa je i bio razlog što je ovaj test zastario.
    const CODES = ["3", "6", "1", "4", "5", "0"] as const;
    // xorshift32 — bez zavisnosti, ponovljiv, dovoljno raspršen za paru.
    let seed = 20260802;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) / 2147483648;
    };

    for (let doc = 0; doc < 200; doc += 1) {
      const count = 1 + Math.floor(rnd() * 20);
      const items = Array.from({ length: count }, (_, i) => {
        const code = CODES[Math.floor(rnd() * CODES.length)];
        const amount = (rnd() * 1000 + 0.01).toFixed(2);
        return stavka(100 + i, amount, code);
      });
      const { db, invoice } = makeDb({ items });

      await service(db).updateHeader(1, { note: `doc-${doc}` }, actor);

      // Osnovica = zbir osnovica stavki (jedini zbir stavki koji postoji).
      const net = items.reduce((s, it) => s.add(it.vatBase), new D(0));
      // PDV = Σ round2(osnovica_STOPE × stopa) — jednačina koju papir štampa.
      //
      // ⚠️ GRUPIŠE SE PO STOPI, NE PO ŠIFRI (ispravka 02.08.2026, nalaz R3): dve šifre
      // umeju da nose istu stopu („3" i „6" su obe 20 %), a porez je obaveza po PROMETU I
      // STOPI. Grupisanje po šifri je davalo dva puta `round2` nad polovinama iste
      // osnovice — izmereno: 100,03 + 100,03 → 20,01 + 20,01 = 40,02 umesto 40,01. Stopa
      // se čita iz `vatPercentOf` (mapa iz koje je porez i obračunat), pa ovaj test ne
      // može da zastari kad se šifarnik ispravi — a upravo je zastareo lokalni spisak
      // stopa i bio razlog što ovaj test pada.
      const byRate = new Map<string, Prisma.Decimal>();
      for (const it of items) {
        const percent = vatPercentOf(it.vatRateCode).toFixed(2);
        byRate.set(
          percent,
          (byRate.get(percent) ?? new D(0)).add(it.vatBase),
        );
      }
      let vat = new D(0);
      for (const [percent, base] of byRate)
        vat = vat.add(
          base
            .mul(percent)
            .div(100)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        );

      expect(new D(invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe(
        net.toFixed(2),
      );
      expect(new D(invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe(
        vat.toFixed(2),
      );
      expect(new D(invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
        net.add(vat).toFixed(2),
      );
    }
  });
});
