import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TransferService } from "./transfer.service";
import { RobnoService } from "./robno.service";
import type { CreateStockDocumentDto } from "./dto/create-stock-document.dto";

/* Lažni Prisma klijent mora da vraća Promise (servis ga `await`-uje), ali unutra nema
   nijedan pravi `await` — pravilo `require-await` ovde ne meri ništa korisno. */
/* eslint-disable @typescript-eslint/require-await */

/**
 * PRENOS IZMEĐU MAGACINA — testovi koji zaključavaju bag iz §3.2
 * (izvorni magacin se razduži, odredišni ne dobije ništa).
 *
 * Testovi ne mockuju rezultat prenosa nego SIMULIRAJU knjigu kretanja onako kako je
 * čita produkcija: stanje magacina = Σ(±količina) po `stock_document_items.warehouse_id`,
 * sa znakom iz `DocumentType.isInbound`. Zato „zbir po oba magacina je očuvan" ovde znači
 * isto što i na lager listi — da je servis napisao samo jednu stranu (stari bag), zbir bi
 * pao i test bi pukao.
 *
 * Guard dovoljnog stanja NIJE mockovan: koristi se PRAVI `RobnoService.assertStockAvailable`
 * nad simuliranim stanjem.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const DATE = "2026-07-27T10:00:00.000Z";

interface Movement {
  itemId: number;
  warehouseId: number;
  quantity: Prisma.Decimal;
  isInbound: boolean;
  nab: Prisma.Decimal;
  vp: Prisma.Decimal;
}

interface FakeDoc {
  id: number;
  companyId: number;
  kind: string;
  documentTypeCode: string;
  documentNumber: string;
  warehouseId: number;
  targetWarehouseId: number | null;
  transferPairDocId: number | null;
  reversalOfDocId: number | null;
  status: string;
  projectId: number | null;
  workOrderId: number | null;
  documentDate: Date;
  note: string | null;
  items: Array<{
    id: number;
    itemId: number;
    warehouseId: number;
    lineNo: number;
    quantity: Prisma.Decimal;
    purchasePriceNet: Prisma.Decimal;
    calculatedWholesalePrice: Prisma.Decimal;
    actualWholesalePrice: Prisma.Decimal;
    calculatedRetailPrice: Prisma.Decimal;
    actualRetailPrice: Prisma.Decimal;
  }>;
}

const INBOUND_TYPES = new Set(["PREUL", "UFROB", "VISAR"]);

/** Knjiga kretanja + lažni Prisma klijent nad njom. */
function makeHarness() {
  const movements: Movement[] = [];
  const docs = new Map<number, FakeDoc>();
  const kepu: Array<{
    documentId: number;
    warehouseId: number;
    charge: string;
    discharge: string;
  }> = [];
  let docSeq = 100;
  let itemSeq = 1000;

  const stateOf = (itemId: number, warehouseId: number) =>
    movements
      .filter((m) => m.itemId === itemId && m.warehouseId === warehouseId)
      .reduce(
        (acc, m) => (m.isInbound ? acc.add(m.quantity) : acc.sub(m.quantity)),
        D(0),
      );

  const valueOf = (itemId: number, warehouseId: number) =>
    movements
      .filter((m) => m.itemId === itemId && m.warehouseId === warehouseId)
      .reduce(
        (acc, m) =>
          m.isInbound
            ? acc.add(m.quantity.mul(m.nab))
            : acc.sub(m.quantity.mul(m.nab)),
        D(0),
      );

  /** Početno stanje (ulaz robe) — kao primka na magacinu. */
  const seed = (
    itemId: number,
    warehouseId: number,
    qty: number,
    nab = 100,
    vp = 120,
  ) => {
    movements.push({
      itemId,
      warehouseId,
      quantity: D(qty),
      isInbound: true,
      nab: D(nab),
      vp: D(vp),
    });
  };

  const materialize = (data: Record<string, unknown>): FakeDoc => {
    const id = ++docSeq;
    const created = (data.items as { create: Array<Record<string, unknown>> })
      .create;
    const doc: FakeDoc = {
      id,
      companyId: data.companyId as number,
      kind: data.kind as string,
      documentTypeCode: data.documentTypeCode as string,
      documentNumber: data.documentNumber as string,
      warehouseId: data.warehouseId as number,
      targetWarehouseId: (data.targetWarehouseId as number | null) ?? null,
      transferPairDocId: (data.transferPairDocId as number | null) ?? null,
      reversalOfDocId: (data.reversalOfDocId as number | null) ?? null,
      status: data.status as string,
      projectId: (data.projectId as number | null) ?? null,
      workOrderId: (data.workOrderId as number | null) ?? null,
      documentDate: data.documentDate as Date,
      note: (data.note as string | null) ?? null,
      items: created.map((it) => ({
        id: ++itemSeq,
        itemId: it.itemId as number,
        warehouseId: it.warehouseId as number,
        lineNo: it.lineNo as number,
        quantity: it.quantity as Prisma.Decimal,
        purchasePriceNet: it.purchasePriceNet as Prisma.Decimal,
        calculatedWholesalePrice: it.calculatedWholesalePrice as Prisma.Decimal,
        actualWholesalePrice:
          (it.actualWholesalePrice as Prisma.Decimal) ?? D(0),
        // Maloprodajne cene prenos ne dira — KEPU pada na VP fallback (v. kepu-book.util).
        calculatedRetailPrice: D(0),
        actualRetailPrice: D(0),
      })),
    };
    docs.set(id, doc);
    // Upis u knjigu kretanja — ISTA pravila kao produkcijski agregat.
    const isInbound = INBOUND_TYPES.has(doc.documentTypeCode);
    for (const it of doc.items)
      movements.push({
        itemId: it.itemId,
        warehouseId: it.warehouseId,
        quantity: it.quantity,
        isInbound,
        nab: it.purchasePriceNet,
        vp: it.calculatedWholesalePrice,
      });
    return doc;
  };

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn(async () => {
      // averageCosts — ponderisani prosek iz simulirane knjige za sve (artikal) na magacinu.
      const byItem = new Map<
        number,
        {
          item_id: number;
          weight: Prisma.Decimal;
          weighted_nab: Prisma.Decimal;
          weighted_vp: Prisma.Decimal;
        }
      >();
      for (const m of movements) {
        if (m.warehouseId !== lastValuationWarehouse) continue;
        const sign = m.isInbound ? 1 : -1;
        const cur = byItem.get(m.itemId) ?? {
          item_id: m.itemId,
          weight: D(0),
          weighted_nab: D(0),
          weighted_vp: D(0),
        };
        cur.weight = cur.weight.add(m.quantity.mul(sign));
        cur.weighted_nab = cur.weighted_nab.add(
          m.quantity.mul(sign).mul(m.nab),
        );
        cur.weighted_vp = cur.weighted_vp.add(m.quantity.mul(sign).mul(m.vp));
        byItem.set(m.itemId, cur);
      }
      return [...byItem.values()];
    }),
    stockReservation: { groupBy: jest.fn().mockResolvedValue([]) },
    stockDocument: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        materialize(data),
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          const doc = docs.get(where.id);
          if (!doc) throw new Error(`nema dokumenta ${where.id}`);
          Object.assign(doc, data);
          return doc;
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: number } }) =>
          docs.get(where.id) ?? null,
      ),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { reversalOfDocId?: { in: number[] } };
        }) => {
          const ids = where?.reversalOfDocId?.in ?? [];
          return (
            [...docs.values()].find(
              (d) =>
                d.reversalOfDocId != null && ids.includes(d.reversalOfDocId),
            ) ?? null
          );
        },
      ),
    },
    kepuBookEntry: {
      deleteMany: jest.fn(
        async ({ where }: { where: { documentId: number } }) => {
          for (let i = kepu.length - 1; i >= 0; i--)
            if (kepu[i].documentId === where.documentId) kepu.splice(i, 1);
          return { count: 0 };
        },
      ),
      createMany: jest.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          for (const e of data)
            kepu.push({
              documentId: e.documentId as number,
              warehouseId: e.warehouseId as number,
              charge: String(e.charge),
              discharge: String(e.discharge),
            });
          return { count: data.length };
        },
      ),
    },
    item: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, name: "Artikal A", catalogNumber: "A-001" },
        { id: 2, name: "Artikal B", catalogNumber: "B-002" },
      ]),
    },
  };

  /** Magacin za koji lažni `$queryRaw` računa prosek (postavlja ga `createTransfer` tok). */
  let lastValuationWarehouse = 0;
  const setValuationWarehouse = (id: number) => {
    lastValuationWarehouse = id;
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
    warehouse: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: number[] } } }) =>
          where.id.in
            .filter((id) => id === 1 || id === 2)
            .map((id) => ({ id })),
      ),
    },
    item: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: number[] } } }) =>
          where.id.in
            .filter((id) => id === 1 || id === 2)
            .map((id) => ({ id })),
      ),
    },
    documentType: {
      findMany: jest.fn().mockResolvedValue([
        { code: "PREIZ", isInbound: false, affectsStock: true },
        { code: "PREUL", isInbound: true, affectsStock: true },
      ]),
    },
    stockDocument: tx.stockDocument,
  };

  // Pravi RobnoService (guard nije mockovan) — costing čita simuliranu knjigu.
  const robno = new RobnoService(
    {} as never,
    {} as never,
    {
      stateAsOf: jest.fn(async (itemId: number, warehouseId: number) =>
        stateOf(itemId, warehouseId),
      ),
    } as never,
  );

  let seq = 0;
  const numbering = {
    next: jest.fn(
      async (_tx: unknown, _c: number, code: string, year: number) => ({
        documentNumber: `${String(++seq).padStart(4, "0")}/${year}`,
        year,
        code,
      }),
    ),
  };

  const service = new TransferService(prisma as never, numbering, robno);

  return {
    service,
    robno,
    stateOf,
    valueOf,
    seed,
    docs,
    kepu,
    movements,
    setValuationWarehouse,
  };
}

describe("TransferService — prenos između magacina je DVOSTRAN", () => {
  it("razduži izvorni I zaduži odredišni magacin; zbir po oba magacina je očuvan", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10); // 10 kom u magacinu 1
    h.setValuationWarehouse(1);

    expect(h.stateOf(1, 1).toString()).toBe("10");
    expect(h.stateOf(1, 2).toString()).toBe("0");
    const ukupnoPre = h.stateOf(1, 1).add(h.stateOf(1, 2));

    const res = await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      7,
    );

    expect(h.stateOf(1, 1).toString()).toBe("6");
    expect(h.stateOf(1, 2).toString()).toBe("4");
    expect(h.stateOf(1, 1).add(h.stateOf(1, 2)).toString()).toBe(
      ukupnoPre.toString(),
    );

    // Par postoji, povezan je u OBA smera i nosi ispravne magacine.
    expect(res.data.outbound.documentTypeCode).toBe("PREIZ");
    expect(res.data.inbound.documentTypeCode).toBe("PREUL");
    expect(res.data.outbound.warehouseId).toBe(1);
    expect(res.data.inbound.warehouseId).toBe(2);
    expect(res.data.outbound.transferPairDocId).toBe(res.data.inbound.id);
    expect(res.data.inbound.transferPairDocId).toBe(res.data.outbound.id);
    // Stavka ODREDIŠNOG dokumenta mora nositi ODREDIŠNI magacin — to je tačka na kojoj
    // je stari kod padao (stavka je nosila izvorni magacin).
    expect(res.data.inbound.items[0].warehouseId).toBe(2);
  });

  it("čuva i VREDNOST zaliha — odredište dobija tačno ono što izvor izgubi", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10, 100, 120);
    h.setValuationWarehouse(1);
    const vrednostPre = h.valueOf(1, 1).add(h.valueOf(1, 2));

    await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      null,
    );

    expect(h.valueOf(1, 1).toString()).toBe("600");
    expect(h.valueOf(1, 2).toString()).toBe("400");
    expect(h.valueOf(1, 1).add(h.valueOf(1, 2)).toString()).toBe(
      vrednostPre.toString(),
    );
  });

  it("KEPU: par upisuje PO JEDAN red po strani (razduženje izvora + zaduženje odredišta)", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10, 100, 120);
    h.setValuationWarehouse(1);

    await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      null,
    );

    // Dva reda ukupno, ne četiri: izvor razdužen, odredište zaduženo.
    expect(h.kepu).toHaveLength(2);
    const izvor = h.kepu.find((e) => e.warehouseId === 1);
    const odrediste = h.kepu.find((e) => e.warehouseId === 2);
    expect(izvor?.charge).toBe("0");
    expect(Number(izvor?.discharge)).toBeGreaterThan(0);
    expect(Number(odrediste?.charge)).toBeGreaterThan(0);
    expect(odrediste?.discharge).toBe("0");
  });
});

describe("TransferService — guard negativnog stanja", () => {
  it("odbija prenos veći od stanja izvornog magacina (422 STOCK_INSUFFICIENT)", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10);
    h.setValuationWarehouse(1);

    await expect(
      h.service.createTransfer(
        {
          sourceWarehouseId: 1,
          targetWarehouseId: 2,
          documentDate: DATE,
          items: [{ itemId: 1, quantity: 20 }],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // Ništa se nije pomerilo ni u jednom magacinu.
    expect(h.stateOf(1, 1).toString()).toBe("10");
    expect(h.stateOf(1, 2).toString()).toBe("0");
  });

  it("sabira dve stavke istog artikla pre provere (6+6 ne prolazi nad stanjem 10)", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10);
    h.setValuationWarehouse(1);

    await expect(
      h.service.createTransfer(
        {
          sourceWarehouseId: 1,
          targetWarehouseId: 2,
          documentDate: DATE,
          items: [
            { itemId: 1, quantity: 6 },
            { itemId: 1, quantity: 6 },
          ],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.stateOf(1, 1).toString()).toBe("10");
  });

  it("odbija isti izvorni i odredišni magacin", async () => {
    const h = makeHarness();
    await expect(
      h.service.createTransfer(
        {
          sourceWarehouseId: 1,
          targetWarehouseId: 1,
          items: [{ itemId: 1, quantity: 1 }],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("odbija količinu 0 i negativnu količinu (obrnut smer se ne tumači tiho)", async () => {
    const h = makeHarness();
    for (const q of [0, -3]) {
      await expect(
        h.service.createTransfer(
          {
            sourceWarehouseId: 1,
            targetWarehouseId: 2,
            items: [{ itemId: 1, quantity: q }],
          },
          null,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Cene se nisu proveravale uopšte: negativna
   * cena je prolazila, odredište je dobijalo NEGATIVNU vrednost zaliha uz pozitivnu
   * količinu, izvoru je skakao prosek — i taj otrovan prosek dalje hrani svaki
   * naredni prenos i kalkulaciju iz tog magacina.
   */
  it("REGRESIJA: odbija negativnu cenu (otrovala bi prosek izvornog magacina)", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10, 500, 600);
    for (const field of ["purchasePriceNet", "wholesalePrice"] as const) {
      await expect(
        h.service.createTransfer(
          {
            sourceWarehouseId: 1,
            targetWarehouseId: 2,
            items: [{ itemId: 1, quantity: 2, [field]: "-9999" }],
          },
          null,
        ),
      ).rejects.toThrow(/ne sme biti negativna/);
    }
    // Stanje se nije pomerilo ni za jednu jedinicu.
    expect(h.stateOf(1, 1).toString()).toBe("10");
    expect(h.stateOf(1, 2).toString()).toBe("0");
  });
});

describe("TransferService — storno", () => {
  it("vraća OBA magacina na stanje pre prenosa", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10);
    h.setValuationWarehouse(1);

    const t = await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      null,
    );
    expect(h.stateOf(1, 1).toString()).toBe("6");
    expect(h.stateOf(1, 2).toString()).toBe("4");

    const s = await h.service.reverse(
      t.data.outbound.id,
      { reason: "greška magacionera" },
      null,
    );

    expect(h.stateOf(1, 1).toString()).toBe("10");
    expect(h.stateOf(1, 2).toString()).toBe("0");
    // Storno je ogledalo: izlaz iz odredišta, ulaz u izvor.
    expect(s.data.outbound.warehouseId).toBe(2);
    expect(s.data.inbound.warehouseId).toBe(1);
    // Storno-veza pokazuje na strane originala (svaka na svoju).
    expect(s.data.outbound.reversalOfDocId).toBe(t.data.inbound.id);
    expect(s.data.inbound.reversalOfDocId).toBe(t.data.outbound.id);
  });

  it("odbija DVOSTRUKI storno (409) — inače bi izvor bio duplo zadužen", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10);
    h.setValuationWarehouse(1);

    const t = await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      null,
    );
    await h.service.reverse(t.data.outbound.id, {}, null);

    await expect(
      h.service.reverse(t.data.inbound.id, {}, null),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.stateOf(1, 1).toString()).toBe("10");
    expect(h.stateOf(1, 2).toString()).toBe("0");
  });

  it("odbija storno kad je roba u međuvremenu potrošena iz odredišnog magacina (422)", async () => {
    const h = makeHarness();
    h.seed(1, 1, 10);
    h.setValuationWarehouse(1);

    const t = await h.service.createTransfer(
      {
        sourceWarehouseId: 1,
        targetWarehouseId: 2,
        documentDate: DATE,
        items: [{ itemId: 1, quantity: 4 }],
      },
      null,
    );
    // Izdato iz odredišnog magacina (npr. izdatnica) — ostalo 1 kom.
    h.movements.push({
      itemId: 1,
      warehouseId: 2,
      quantity: D(3),
      isInbound: false,
      nab: D(100),
      vp: D(120),
    });
    expect(h.stateOf(1, 2).toString()).toBe("1");

    await expect(
      h.service.reverse(t.data.outbound.id, {}, null),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(h.stateOf(1, 2).toString()).toBe("1");
  });
});

describe("RobnoService.createStockDocument — jednostrani PRENOS je zatvoren", () => {
  it("odbija kind=PRENOS na opštoj ruti i upućuje na radnju prenosa", async () => {
    const robno = new RobnoService({} as never, {} as never, {} as never);
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "PREIZ",
      warehouseId: 1,
      targetWarehouseId: 2,
      items: [{ itemId: 1, quantity: 5 }],
    };
    expect.assertions(2);
    try {
      await robno.createStockDocument("PRENOS", dto);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      // Poruka je na jeziku posla — ne pominje rutu ni interni kod (nalaz NIZAK).
      expect(String((e as Error).message)).toContain(
        "Prenos u drugi magacin",
      );
    }
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Guard je gledao SAMO `kind`, a
   * `documentTypeCode` je slobodan tekst — pa je isti jednostrani prenos i dalje
   * bio moguć preko `kind=UL, documentTypeCode=PREUL` (roba nastane ni iz čega:
   * UL ne prolazi kroz guard dovoljnog stanja) i `kind=IZ, documentTypeCode=PREIZ`
   * (izvor razdužen, odredište nezaduženo). Dokazano na dev bazi.
   */
  it.each([
    ["UL" as const, "PREUL"],
    ["IZ" as const, "PREIZ"],
  ])(
    "REGRESIJA: odbija kind=%s sa rezervisanom vrstom %s (prenos kroz druga vrata)",
    async (kind, code) => {
      const prisma = {
        documentType: {
          findFirst: jest.fn().mockResolvedValue({
            id: 1,
            code,
            isInbound: code === "PREUL",
          }),
        },
      };
      const robno = new RobnoService(
        prisma as never,
        {} as never,
        {} as never,
      );
      await expect(
        robno.createStockDocument(kind, {
          documentTypeCode: code,
          warehouseId: 1,
          items: [{ itemId: 1, quantity: 1000 }],
        } as CreateStockDocumentDto),
      ).rejects.toThrow(/pripada prenosu između magacina/);
    },
  );

  /**
   * Smer mora da odgovara vrsti: `is_inbound` je jedini izvor znaka u svim
   * obračunima stanja, pa ulazni dokument sa izlaznom vrstom tiho pomera zalihu
   * u pogrešnom smeru i zaobilazi guard dovoljnog stanja.
   */
  it("odbija ULAZNI dokument sa IZLAZNOM vrstom (znak zalihe bi bio pogrešan)", async () => {
    const prisma = {
      documentType: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 9, code: "IFR", isInbound: false }),
      },
    };
    const robno = new RobnoService(prisma as never, {} as never, {} as never);
    await expect(
      robno.createStockDocument("UL", {
        documentTypeCode: "IFR",
        warehouseId: 1,
        items: [{ itemId: 1, quantity: 5 }],
      } as CreateStockDocumentDto),
    ).rejects.toThrow(/je IZLAZNA, a dokument je ulazni/);
  });
});
