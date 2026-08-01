import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { DocumentEditService, demandByKey } from "./document-edit.service";
import { RobnoService } from "./robno.service";

/* Lažni Prisma klijent vraća Promise-e, ali unutra nema pravih `await`-ova. */
/* eslint-disable @typescript-eslint/require-await */

/**
 * IZMENA ROBNOG DOKUMENTA — zaglavlje + dodavanje/izmena stavke.
 *
 * Testovi ne mockuju rezultat provere zaliha: koristi se PRAVI
 * `RobnoService.assertStockAvailable` nad simuliranim stanjem (`stateAsOf` po ključu
 * `itemId:warehouseId`), pa „prošlo je" u testu znači isto što i na produkciji.
 *
 * Ono što se ovde zaključava (da se ne vrati tiho):
 *   • proknjižen/kalkulisan/zaključan dokument se NE menja (409, srpska poruka sa izlazom),
 *   • prenos između magacina se ODBIJA umesto da se jednostrano „popravi",
 *   • provera zaliha visi o MAGACINU reda, ne o vrsti dokumenta,
 *   • SMANJENJE količine na dokumentu koji je u minusu MORA da prođe (to je ispravka koja
 *     minus i gasi) — a povećanje ne sme,
 *   • sopstvene stavke se ne oduzimaju dvaput (`excludeDocId`),
 *   • kalkulacija se NE pokreće sama (zaključala bi dokument već na prvoj stavci).
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const DOC_DATE = new Date("2026-07-20T00:00:00.000Z");

interface FakeLine {
  id: number;
  itemId: number;
  warehouseId: number;
  lineNo: number;
  quantity: Prisma.Decimal;
  deletedAt: Date | null;
}

interface HarnessOptions {
  kind?: string;
  documentTypeCode?: string;
  status?: string;
  journalEntryId?: number | null;
  warehouseId?: number;
  transferPairDocId?: number | null;
  reversalOfDocId?: number | null;
  inventoryCountId?: number | null;
  lines?: FakeLine[];
  /** Stanje po `itemId:warehouseId` (uključuje i stavke ovog dokumenta — kao `stateAsOf`). */
  state?: Record<string, Prisma.Decimal>;
  /** `document_types.stock_check` za vrstu dokumenta (null = nekonfigurisano). */
  stockCheck?: string | null;
  /** Otvorene rezervacije po (artikal, magacin). */
  reservations?: Array<{
    itemId: number;
    warehouseId: number;
    quantity: Prisma.Decimal;
  }>;
  /** Magacini koji postoje (default 1 i 2). */
  warehouses?: number[];
  /** Artikli koji postoje (default 1, 2, 3). */
  items?: number[];
}

function line(
  id: number,
  itemId: number,
  warehouseId: number,
  quantity: number | string,
  lineNo = id,
  deletedAt: Date | null = null,
): FakeLine {
  return { id, itemId, warehouseId, lineNo, quantity: D(quantity), deletedAt };
}

function makeHarness(opts: HarnessOptions = {}) {
  const lines: FakeLine[] = opts.lines ?? [line(10, 1, 1, 5)];
  const doc = {
    id: 77,
    kind: opts.kind ?? "UL",
    documentTypeCode: opts.documentTypeCode ?? "UFROB",
    documentNumber: "0042/2026",
    status: opts.status ?? "DRAFT",
    journalEntryId: opts.journalEntryId ?? null,
    warehouseId: opts.warehouseId ?? 1,
    documentDate: DOC_DATE,
    transferPairDocId: opts.transferPairDocId ?? null,
    reversalOfDocId: opts.reversalOfDocId ?? null,
    inventoryCountId: opts.inventoryCountId ?? null,
  };
  const state = opts.state ?? {};
  const existingWarehouses = new Set(opts.warehouses ?? [1, 2]);
  const existingItems = new Set(opts.items ?? [1, 2, 3]);

  let nextItemId = 1000;
  const created: Array<Record<string, unknown>> = [];
  const updatedLines: Array<{ id: number; data: Record<string, unknown> }> = [];
  const movedLines: Array<Record<string, unknown>> = [];
  const headerUpdates: Array<Record<string, unknown>> = [];

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    stockDocument: {
      findUnique: jest.fn(async () => ({
        ...doc,
        items: lines
          .filter((l) => l.deletedAt == null)
          .map(({ id, itemId, warehouseId, lineNo, quantity }) => ({
            id,
            itemId,
            warehouseId,
            lineNo,
            quantity,
          })),
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        headerUpdates.push(args.data);
        return { ...doc, ...args.data, items: [] };
      }),
    },
    stockDocumentItem: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: ++nextItemId, ...args.data };
      }),
      update: jest.fn(
        async (args: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          updatedLines.push({ id: args.where.id, data: args.data });
          return { id: args.where.id, ...args.data };
        },
      ),
      updateMany: jest.fn(async (args: Record<string, unknown>) => {
        movedLines.push(args);
        return { count: 1 };
      }),
      findFirst: jest.fn(async (args: { where: { id: number } }) => {
        const found = lines.find((l) => l.id === args.where.id);
        return found ? { id: found.id } : null;
      }),
    },
    warehouse: {
      findUnique: jest.fn(async (args: { where: { id: number } }) =>
        existingWarehouses.has(args.where.id) ? { id: args.where.id } : null,
      ),
    },
    item: {
      findUnique: jest.fn(async (args: { where: { id: number } }) =>
        existingItems.has(args.where.id) ? { id: args.where.id } : null,
      ),
      findMany: jest.fn(async () => [
        { id: 1, name: "Artikal A", catalogNumber: "A-001" },
        { id: 2, name: "Artikal B", catalogNumber: "B-002" },
        { id: 3, name: "Artikal C", catalogNumber: "C-003" },
      ]),
    },
    customer: {
      findUnique: jest.fn(async (args: { where: { id: number } }) =>
        args.where.id === 999 ? null : { id: args.where.id },
      ),
    },
    documentType: {
      findFirst: jest.fn(async () => ({
        stockCheck: opts.stockCheck === undefined ? null : opts.stockCheck,
      })),
    },
    stockReservation: {
      groupBy: jest.fn(async () =>
        (opts.reservations ?? []).map((r) => ({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
          _sum: { quantity: r.quantity },
        })),
      ),
    },
  };

  const prisma = {
    $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
  };

  const costing = {
    stateAsOf: jest.fn(
      async (itemId: number, warehouseId: number): Promise<Prisma.Decimal> =>
        state[`${itemId}:${warehouseId}`] ?? D(0),
    ),
  };
  const robno = new RobnoService(
    prisma as never,
    {} as never,
    costing as never,
  );
  const calculation = {
    calculate: jest.fn(async () => ({ id: doc.id, status: "CALCULATED" })),
  };
  const service = new DocumentEditService(
    prisma as never,
    robno,
    calculation as never,
  );

  return {
    service,
    tx,
    costing,
    calculation,
    created,
    updatedLines,
    movedLines,
    headerUpdates,
  };
}

// ───────────────────────────────────────────────────── BRANA 1: proknjižen dokument

describe("DocumentEditService — proknjižen/zaključan dokument se ne menja (brana 1)", () => {
  const cases: Array<[string, HarnessOptions, string]> = [
    [
      "proknjižen (journalEntryId)",
      { status: "CALCULATED", journalEntryId: 5001 },
      "proknjižen",
    ],
    ["status POSTED", { status: "POSTED" }, "proknjižen"],
    ["status LOCKED", { status: "LOCKED" }, "zaključan"],
    ["status CALCULATED", { status: "CALCULATED" }, "kalkulisan"],
  ];

  it.each(cases)(
    "addItem odbija %s sa 409 i uputstvom",
    async (_name, options, needle) => {
      const { service } = makeHarness(options);
      expect.assertions(3);
      try {
        await service.addItem(77, { itemId: 1, quantity: 1 }, 3);
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictException);
        const msg = (e as ConflictException).message;
        expect(msg).toContain(needle);
        // Poruka mora da kaže i ŠTA korisnik može da uradi (§2.7 „nikad 'Nevalidna vrednost'").
        expect(msg).toMatch(/storniranjem|Poništi kalkulaciju/);
      }
    },
  );

  it("updateItem odbija proknjižen dokument", async () => {
    const { service } = makeHarness({ status: "POSTED" });
    await expect(
      service.updateItem(77, 10, { quantity: 2 }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("updateHeader odbija TVRDO polje (datum) na proknjiženom dokumentu", async () => {
    const { service } = makeHarness({
      status: "CALCULATED",
      journalEntryId: 5001,
    });
    await expect(
      service.updateHeader(77, { documentDate: "2026-07-25" }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("updateHeader DOZVOLJAVA meko polje (napomena) na proknjiženom dokumentu", async () => {
    const { service, headerUpdates } = makeHarness({
      status: "CALCULATED",
      journalEntryId: 5001,
    });
    const res = await service.updateHeader(77, { note: "  stigla roba " }, 3);
    expect(res.meta.changed).toEqual(["note"]);
    expect(headerUpdates[0]?.note).toBe("stigla roba");
  });

  it("zaključan dokument je zatvoren i za meka polja", async () => {
    const { service } = makeHarness({ status: "LOCKED" });
    await expect(
      service.updateHeader(77, { note: "bilo šta" }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ───────────────────────────────────────────── Dokumenti koje izmena NE SME da dodirne

describe("DocumentEditService — dokumenti koje izmena odbija umesto da ih 'popravi'", () => {
  it("prenos između magacina (vrsta PREIZ) → 422 sa uputstvom na radnju prenosa", async () => {
    const { service } = makeHarness({ kind: "IZ", documentTypeCode: "PREIZ" });
    expect.assertions(2);
    try {
      await service.addItem(77, { itemId: 1, quantity: 1 }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).message).toContain(
        "prenosa između magacina",
      );
    }
  });

  it("dokument koji ima par prenosa (transferPairDocId) → 422", async () => {
    const { service } = makeHarness({ transferPairDocId: 78 });
    await expect(
      service.updateHeader(77, { note: "x" }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("kind PRENOS → 422", async () => {
    const { service } = makeHarness({ kind: "PRENOS" });
    await expect(
      service.addItem(77, { itemId: 1, quantity: 1 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("storno dokument → 409 (mora ostati ogledalna slika)", async () => {
    const { service } = makeHarness({ reversalOfDocId: 70 });
    await expect(
      service.addItem(77, { itemId: 1, quantity: 1 }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("dokument iz popisa (inventoryCountId) → 409, ispravka ide kroz popis", async () => {
    const { service } = makeHarness({
      kind: "MANJAK",
      inventoryCountId: 12,
    });
    expect.assertions(2);
    try {
      await service.updateItem(77, 10, { quantity: 1 }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).message).toContain("popis");
    }
  });

  it("nepostojeći dokument → 404", async () => {
    const { service, tx } = makeHarness();
    tx.stockDocument.findUnique.mockResolvedValueOnce(
      null as unknown as ReturnType<typeof tx.stockDocument.findUnique>,
    );
    await expect(
      service.addItem(77, { itemId: 1, quantity: 1 }, 3),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ───────────────────────────────────────────────────────────── Dodavanje stavke (ULAZ)

describe("DocumentEditService.addItem — ulaz robe (primka)", () => {
  it("dodaje stavku sa sledećim slobodnim lineNo i Decimal iznosima", async () => {
    const { service, created } = makeHarness({
      lines: [line(10, 1, 1, 5, 1), line(11, 2, 1, 3, 2)],
    });
    const res = await service.addItem(
      77,
      { itemId: 3, quantity: "12.5", invoicePrice: "1234.5678" },
      9,
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ itemId: 3, warehouseId: 1, lineNo: 3 });
    expect((created[0]?.quantity as Prisma.Decimal).toString()).toBe("12.5");
    // Novac je Decimal, nikad Float (BACKEND_RULES §2).
    expect(created[0]?.invoicePrice).toBeInstanceOf(Prisma.Decimal);
    expect((created[0]?.invoicePrice as Prisma.Decimal).toString()).toBe(
      "1234.5678",
    );
    expect(res.meta.calculation.stale).toBe(true);
  });

  it("ULAZ ne dira proveru zaliha (nema šta da nedostaje)", async () => {
    const { service, costing } = makeHarness({ kind: "UL", state: {} });
    await service.addItem(77, { itemId: 1, quantity: 99999 }, 3);
    expect(costing.stateAsOf).not.toHaveBeenCalled();
  });

  it("količina 0 → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.addItem(77, { itemId: 1, quantity: 0 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("negativna količina → 422 (smer se izvodi iz vrste dokumenta)", async () => {
    const { service } = makeHarness();
    expect.assertions(2);
    try {
      await service.addItem(77, { itemId: 1, quantity: "-3" }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).message).toContain(
        "pozitivan broj",
      );
    }
  });

  it("nepostojeći artikal → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.addItem(77, { itemId: 4242, quantity: 1 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("nepostojeći magacin stavke → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.addItem(77, { itemId: 1, quantity: 1, warehouseId: 99 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

// ─────────────────────────────────────────────── BRANA 2: kalkulacija (postojeći motor)

describe("DocumentEditService — kalkulacija se poziva, ne prepisuje (brana 2)", () => {
  it("podrazumevano NE pokreće kalkulaciju (inače bi dokument ostao sa jednom stavkom)", async () => {
    const { service, calculation } = makeHarness();
    const res = await service.addItem(77, { itemId: 1, quantity: 1 }, 3);
    expect(calculation.calculate).not.toHaveBeenCalled();
    expect(res.meta.calculation.stale).toBe(true);
    expect(res.meta.calculation.hint).toContain("Kalkuliši");
  });

  it("`recalculate: true` poziva POSTOJEĆI CalculationService.calculate(docId)", async () => {
    const { service, calculation } = makeHarness();
    const res = await service.addItem(
      77,
      { itemId: 1, quantity: 1, recalculate: true },
      3,
    );
    expect(calculation.calculate).toHaveBeenCalledTimes(1);
    expect(calculation.calculate).toHaveBeenCalledWith(77);
    expect(res.meta.calculation.stale).toBe(false);
    expect(res.meta.document).toMatchObject({ status: "CALCULATED" });
  });

  it("kalkulacija ide POSLE transakcije (ne ugnežđeno, dok se drže advisory lock-ovi)", async () => {
    const { service, calculation, tx } = makeHarness();
    let calculatedWhileCreating = false;
    tx.stockDocumentItem.create.mockImplementation(async (args) => {
      calculatedWhileCreating = calculation.calculate.mock.calls.length > 0;
      return { id: 1001, ...args.data };
    });
    await service.updateItem(77, 10, { quantity: 2, recalculate: true }, 3);
    expect(calculatedWhileCreating).toBe(false);
    expect(calculation.calculate).toHaveBeenCalledTimes(1);
  });

  it("servis ne piše IZVEDENE kalkulativne kolone", async () => {
    const { service, created } = makeHarness();
    await service.addItem(
      77,
      { itemId: 1, quantity: 1, invoicePrice: "100", markupAmount: "10" },
      3,
    );
    const data = created[0] ?? {};
    expect(data).not.toHaveProperty("purchasePriceNet");
    expect(data).not.toHaveProperty("calculatedWholesalePrice");
    expect(data).not.toHaveProperty("calculatedRetailPrice");
  });
});

// ────────────────────────────────────── BRANA 3: provera zaliha visi o MAGACINU

describe("DocumentEditService — provera zaliha (brana 3)", () => {
  const izlaz: HarnessOptions = {
    kind: "IZ",
    documentTypeCode: "IFR",
    lines: [line(10, 1, 1, 5)],
  };

  it("IZLAZ: nova stavka preko raspoloživog → 422 STOCK_INSUFFICIENT", async () => {
    const { service } = makeHarness({ ...izlaz, state: { "2:1": D(4) } });
    expect.assertions(3);
    try {
      await service.addItem(77, { itemId: 2, quantity: 10 }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const res = (e as UnprocessableEntityException).getResponse() as {
        code: string;
        shortages: Array<{ itemId: number; warehouseId: number }>;
      };
      expect(res.code).toBe("STOCK_INSUFFICIENT");
      expect(res.shortages[0]).toMatchObject({ itemId: 2, warehouseId: 1 });
    }
  });

  it("sopstvene stavke se ne oduzimaju dvaput — provera ide sa excludeDocId", async () => {
    const { service, costing } = makeHarness({
      ...izlaz,
      state: { "2:1": D(50) },
    });
    await service.addItem(77, { itemId: 2, quantity: 10 }, 3);
    expect(costing.stateAsOf).toHaveBeenCalledWith(
      2,
      1,
      DOC_DATE,
      expect.objectContaining({ excludeDocId: 77 }),
    );
  });

  it("SMANJENJE količine prolazi i kad je dokument već u minusu (ispravka koja minus gasi)", async () => {
    const { service, updatedLines } = makeHarness({
      ...izlaz,
      lines: [line(10, 1, 1, 100)],
      state: { "1:1": D(0) }, // stanje bez ovog dokumenta = 0 → 100 je nepokriveno
    });
    await expect(
      service.updateItem(77, 10, { quantity: 10 }, 3),
    ).resolves.toBeDefined();
    expect(updatedLines[0]?.id).toBe(10);
  });

  it("POVEĆANJE količine na istom dokumentu se blokira", async () => {
    const { service } = makeHarness({
      ...izlaz,
      lines: [line(10, 1, 1, 10)],
      state: { "1:1": D(12) },
    });
    await expect(
      service.updateItem(77, 10, { quantity: 20 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("mod se čita PO MAGACINU reda — `stock_check = OFF` ne blokira", async () => {
    const { service, tx } = makeHarness({
      ...izlaz,
      state: { "2:1": D(0) },
      stockCheck: "OFF",
    });
    await expect(
      service.addItem(77, { itemId: 2, quantity: 10 }, 3),
    ).resolves.toBeDefined();
    // Magacin JE konsultovan (uslov je konjunkcija magacin × vrsta, §2.7).
    expect(tx.warehouse.findUnique).toHaveBeenCalled();
  });

  it("`stock_check = WARN` propušta, ali vraća meko upozorenje", async () => {
    const { service } = makeHarness({
      ...izlaz,
      state: { "2:1": D(1) },
      stockCheck: "WARN",
    });
    const res = await service.addItem(77, { itemId: 2, quantity: 10 }, 3);
    expect(res.meta.warnings).toHaveLength(1);
    expect(res.meta.warnings[0]).toContain("Nedovoljno stanje");
  });

  it("nekonfigurisana vrsta (stock_check NULL) i dalje BLOKIRA — bez tihog popuštanja", async () => {
    const { service } = makeHarness({
      ...izlaz,
      state: { "2:1": D(1) },
      stockCheck: null,
    });
    await expect(
      service.addItem(77, { itemId: 2, quantity: 10 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("IZ oduzima otvorene rezervacije, MANJAK ih ne oduzima (nalaz R3)", async () => {
    const rez = [{ itemId: 2, warehouseId: 1, quantity: D(8) }];
    const izlazSaRez = makeHarness({
      ...izlaz,
      state: { "2:1": D(10) },
      reservations: rez,
    });
    await expect(
      izlazSaRez.service.addItem(77, { itemId: 2, quantity: 5 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException); // 10 − 8 = 2 < 5

    const manjak = makeHarness({
      kind: "MANJAK",
      documentTypeCode: "MANJR",
      lines: [line(10, 1, 1, 1)],
      state: { "2:1": D(10) },
      reservations: rez,
    });
    await expect(
      manjak.service.addItem(77, { itemId: 2, quantity: 5 }, 3),
    ).resolves.toBeDefined();
    expect(manjak.tx.stockReservation.groupBy).not.toHaveBeenCalled();
  });

  it("uzima advisory lock po (artikal, magacin) pre provere", async () => {
    const { service, tx } = makeHarness({ ...izlaz, state: { "2:1": D(50) } });
    await service.addItem(77, { itemId: 2, quantity: 10 }, 3);
    expect(tx.$executeRaw).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────── Izmena stavke

describe("DocumentEditService.updateItem", () => {
  it("menja samo prosleđena polja i vraća listu izmena", async () => {
    const { service, updatedLines } = makeHarness({
      lines: [line(10, 1, 1, 5)],
    });
    const res = await service.updateItem(
      77,
      10,
      { quantity: "7", discountPercent: "5" },
      3,
    );
    expect(res.meta.changed).toEqual(
      expect.arrayContaining(["quantity", "discountPercent"]),
    );
    expect(updatedLines[0]?.data).not.toHaveProperty("itemId");
    expect((updatedLines[0]?.data.quantity as Prisma.Decimal).toString()).toBe(
      "7",
    );
  });

  it("prazno telo → 422 (ne tiho ne-dešavanje)", async () => {
    const { service } = makeHarness();
    await expect(service.updateItem(77, 10, {}, 3)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("količina 0 → 422 sa uputstvom da se red obriše", async () => {
    const { service } = makeHarness();
    expect.assertions(2);
    try {
      await service.updateItem(77, 10, { quantity: 0 }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).message).toContain("obriši");
    }
  });

  it("meko obrisana stavka → 409 sa uputstvom „poništi brisanje”", async () => {
    const { service } = makeHarness({
      lines: [line(10, 1, 1, 5, 1, new Date())],
    });
    expect.assertions(2);
    try {
      await service.updateItem(77, 10, { quantity: 2 }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).message).toContain("Poništi");
    }
  });

  it("stavka iz drugog dokumenta / nepostojeća → 404", async () => {
    const { service } = makeHarness({ lines: [line(10, 1, 1, 5)] });
    await expect(
      service.updateItem(77, 999, { quantity: 2 }, 3),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("premeštanje reda u drugi magacin proverava zalihu NOVOG magacina", async () => {
    const { service, costing } = makeHarness({
      kind: "IZ",
      documentTypeCode: "IFR",
      lines: [line(10, 1, 1, 5)],
      state: { "1:1": D(100), "1:2": D(1) },
    });
    await expect(
      service.updateItem(77, 10, { warehouseId: 2 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(costing.stateAsOf).toHaveBeenCalledWith(
      1,
      2,
      DOC_DATE,
      expect.objectContaining({ excludeDocId: 77 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────── Izmena zaglavlja

describe("DocumentEditService.updateHeader", () => {
  it("menja datum, dobavljača i napomenu", async () => {
    const { service, headerUpdates } = makeHarness();
    const res = await service.updateHeader(
      77,
      {
        documentDate: "2026-07-25",
        supplierId: 42,
        note: "  otpremnica 123  ",
      },
      3,
    );
    expect(res.meta.changed).toEqual(["documentDate", "supplierId", "note"]);
    expect(headerUpdates[0]?.supplierId).toBe(42);
    expect(headerUpdates[0]?.note).toBe("otpremnica 123");
    expect(headerUpdates[0]?.updatedByUserId).toBe(3);
  });

  it("`supplierId: null` briše dobavljača", async () => {
    const { service, headerUpdates } = makeHarness();
    await service.updateHeader(77, { supplierId: null }, 3);
    expect(headerUpdates[0]?.supplierId).toBeNull();
  });

  it("nepostojeći dobavljač → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.updateHeader(77, { supplierId: 999 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("prazan datum → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.updateHeader(77, { documentDate: "" }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("prazno telo → 422", async () => {
    const { service } = makeHarness();
    await expect(service.updateHeader(77, {}, 3)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("promena magacina POVLAČI stavke koje su pratile zaglavlje", async () => {
    const { service, movedLines, headerUpdates } = makeHarness({
      warehouseId: 1,
      lines: [line(10, 1, 1, 5), line(11, 2, 2, 3)],
    });
    const res = await service.updateHeader(77, { warehouseId: 2 }, 3);

    expect(headerUpdates[0]?.warehouseId).toBe(2);
    expect(res.meta.movedLines).toBe(1); // samo red koji je bio u magacinu zaglavlja
    expect(movedLines[0]).toMatchObject({
      where: { documentId: 77, warehouseId: 1, deletedAt: null },
      data: { warehouseId: 2 },
    });
  });

  it("promena magacina na IZLAZU proverava zalihu novog magacina", async () => {
    const { service } = makeHarness({
      kind: "IZ",
      documentTypeCode: "IFR",
      warehouseId: 1,
      lines: [line(10, 1, 1, 5)],
      state: { "1:1": D(100), "1:2": D(2) },
    });
    await expect(
      service.updateHeader(77, { warehouseId: 2 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("nepostojeći magacin → 422", async () => {
    const { service } = makeHarness();
    await expect(
      service.updateHeader(77, { warehouseId: 77 }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("promena DATUMA na izlazu proverava SVE redove na novoj as-of osnovi", async () => {
    const { service, costing } = makeHarness({
      kind: "IZ",
      documentTypeCode: "IFR",
      lines: [line(10, 1, 1, 5)],
      state: { "1:1": D(1) },
    });
    await expect(
      service.updateHeader(77, { documentDate: "2026-01-05" }, 3),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(costing.stateAsOf).toHaveBeenCalledWith(
      1,
      1,
      new Date("2026-01-05"),
      expect.objectContaining({ excludeDocId: 77 }),
    );
  });

  it("`deliveryNoteNumber` → 422 sa objašnjenjem (kolone nema), ne tihi gubitak", async () => {
    const { service, headerUpdates } = makeHarness();
    expect.assertions(3);
    try {
      await service.updateHeader(77, { deliveryNoteNumber: "OTP-55" }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).message).toContain(
        "Broj otpremnice",
      );
      expect(headerUpdates).toHaveLength(0);
    }
  });

  it("`paymentTerms` → 422 sa objašnjenjem (kolone nema)", async () => {
    const { service } = makeHarness();
    expect.assertions(2);
    try {
      await service.updateHeader(77, { paymentTerms: "30 dana" }, 3);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect((e as UnprocessableEntityException).message).toContain(
        "Uslovi plaćanja",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────── Pomoćno

describe("demandByKey", () => {
  it("sabira više redova istog artikla u istom magacinu", () => {
    const map = demandByKey([
      line(1, 7, 3, 6),
      line(2, 7, 3, 4),
      line(3, 7, 4, 2),
    ]);
    expect(map.get("7:3")?.qty.toString()).toBe("10");
    expect(map.get("7:4")?.qty.toString()).toBe("2");
  });
});
