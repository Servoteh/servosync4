import { Prisma } from "@prisma/client";
import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { InventoryService } from "./inventory.service";
import type { CostingService } from "./costing.service";
import type { RobnoService } from "./robno.service";

/**
 * DETALJ POPISA MORA DA VRATI ID-EVE DOKUMENATA RAZLIKE — I TO SVAKI POD SVOJIM IMENOM.
 *
 * Zašto ovaj fajl postoji (07.08.2026): izmena od 07.08. je bila pokrivena SAMO tekstualnom
 * proverom nad izvorom (`frontend/src/lib/povratak-na-listu.spec.ts` traži nizove
 * `visakDocId`/`manjakDocId` u telu `get`). Takva provera prolazi i kad su `"VISAK"` i
 * `"MANJAK"` ZAMENJENI u `.find()` — a to nije sitnica: magacioner klikom na „Višak
 * (dokument #N)" otvara dokument MANJKA i gleda otpis kao da je višak. Zameniti dva
 * literala je najverovatnija greška u ovom kodu i jedina koju grep ne vidi.
 *
 * Meri se ponašanje `InventoryService.get()` nad lažnim Prisma slojem: ulaze redovi,
 * izlazi odgovor, i tvrdi se PO KOJOJ VREDNOSTI je koji id izabran.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

type RedDokumenta = { id: number; kind: string };

/** Zapamćeni argumenti `stock_documents.findMany` — provera brane po vrsti i popisu. */
type Zabelezeno = { where?: unknown; orderBy?: unknown };

function napraviPrisma(dokumenti: RedDokumenta[], zabelezeno: Zabelezeno) {
  return {
    inventoryCount: {
      findUnique: jest.fn().mockResolvedValue({
        id: 7,
        year: 2026,
        countNumber: "1/26",
        warehouseId: 1,
        status: "POSTED",
        items: [
          {
            id: 11,
            itemId: 90001,
            bookQuantity: D(10),
            countedQuantity: D(12),
            price: D(100),
          },
        ],
      }),
    },
    item: {
      findMany: jest.fn().mockResolvedValue([
        { id: 90001, name: "Ventil DN25", catalogNumber: "V-25", unit: "kom" },
      ]),
    },
    stockDocument: {
      findMany: jest.fn((args: Zabelezeno) => {
        zabelezeno.where = args.where;
        zabelezeno.orderBy = args.orderBy;
        return Promise.resolve(dokumenti);
      }),
    },
  };
}

function napraviServis(prisma: unknown) {
  return new InventoryService(
    prisma as unknown as PrismaService,
    {} as unknown as CostingService,
    {} as unknown as RobnoService,
  );
}

describe("InventoryService.get — dokumenti razlike po vrsti", () => {
  it("🔴 VISAK ide u visakDocId, MANJAK u manjakDocId (zamena literala je pogrešan dokument na ekranu)", async () => {
    const zabelezeno: Zabelezeno = {};
    // NAMERNO su id-evi takvi da zamena literala NE MOŽE da prođe slučajno:
    // manjak ima veći id i stoji prvi (`orderBy: id desc`), pa bi „uzmi prvi" bez
    // provere vrste vratio manjak i na jednom i na drugom mestu.
    const servis = napraviServis(
      napraviPrisma(
        [
          { id: 502, kind: "MANJAK" },
          { id: 501, kind: "VISAK" },
        ],
        zabelezeno,
      ),
    );

    const { data } = await servis.get(7);

    expect(data.visakDocId).toBe(501);
    expect(data.manjakDocId).toBe(502);
  });

  it("popis sa samo jednom vrstom razlike ne izmišlja drugu", async () => {
    const zabelezeno: Zabelezeno = {};
    const servis = napraviServis(
      napraviPrisma([{ id: 900, kind: "VISAK" }], zabelezeno),
    );

    const { data } = await servis.get(7);

    expect(data.visakDocId).toBe(900);
    expect(data.manjakDocId).toBeNull();
  });

  it("popis bez ijednog dokumenta razlike vraća null za obe vrste", async () => {
    const zabelezeno: Zabelezeno = {};
    const servis = napraviServis(napraviPrisma([], zabelezeno));

    const { data } = await servis.get(7);

    expect(data.visakDocId).toBeNull();
    expect(data.manjakDocId).toBeNull();
  });

  it("kad ista vrsta ima više dokumenata, važi POSLEDNJI (najveći id)", async () => {
    // Duplikat nastaje ručnim `POST /robno/documents` sa `inventoryCountId` u telu —
    // `finalize` ga zbog CAS-a na statusu ne može napraviti.
    const zabelezeno: Zabelezeno = {};
    const servis = napraviServis(
      napraviPrisma(
        [
          { id: 812, kind: "VISAK" },
          { id: 811, kind: "MANJAK" },
          { id: 810, kind: "VISAK" },
        ],
        zabelezeno,
      ),
    );

    const { data } = await servis.get(7);

    expect(data.visakDocId).toBe(812);
    expect(data.manjakDocId).toBe(811);
  });

  it("dokumenti se traže PO OVOM popisu i SAMO među vrstama razlike, najnoviji prvo", async () => {
    // Bez `inventoryCountId` u `where` bi detalj popisa pokupio tuđe dokumente; bez
    // filtera po vrsti bi „Višak" mogao da otvori redovnu otpremnicu vezanu za popis.
    // `orderBy: id desc` je uslov da tvrdnja „važi poslednji" uopšte ima smisla.
    const zabelezeno: Zabelezeno = {};
    const servis = napraviServis(napraviPrisma([], zabelezeno));

    await servis.get(7);

    expect(zabelezeno.where).toEqual({
      inventoryCountId: 7,
      kind: { in: ["VISAK", "MANJAK"] },
    });
    expect(zabelezeno.orderBy).toEqual({ id: "desc" });
  });

  it("stavke i dalje nose naziv/šifru/JM artikla (komisija broji imenovanu robu)", async () => {
    const zabelezeno: Zabelezeno = {};
    const servis = napraviServis(napraviPrisma([], zabelezeno));

    const { data } = await servis.get(7);

    expect(data.items[0]).toMatchObject({
      itemId: 90001,
      itemName: "Ventil DN25",
      itemCode: "V-25",
      unit: "kom",
    });
  });

  it("nepostojeći popis je 404, ne prazan odgovor", async () => {
    const prisma = napraviPrisma([], {});
    prisma.inventoryCount.findUnique.mockResolvedValue(null);

    await expect(napraviServis(prisma).get(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

/**
 * ZAKLJUČIVANJE POPISA — MANJAK GA ZAUSTAVLJA, DOKUMENT MANJKA SE NE PRAVI.
 *
 * Odgovor knjigovođe 07.08.2026, doslovno: „kada se utvrdi da je popisano manje nego što knjige
 * kažu onda to ne radimo kroz dokument manjak. Takav dokument ne treba da postoji". Do te izmene
 * je `finalize` sam pravio dokument vrste `MANJR`, čija šema 50 nosi i izlazni PDV (`4700`) i
 * rashod `5741` — poreski tretman koji popisna komisija ne sme da odabere klikom na „Zaključi".
 *
 * Meri se ponašanje `finalize` nad lažnim Prisma/Robno slojem: šta se kreira, šta ne, i u kom
 * statusu popis ostaje.
 */
describe("InventoryService.finalize — manjak zaustavlja, višak prolazi", () => {
  /** Popis sa zadatim (knjigovodstveno, popisano) parovima po artiklu. */
  function napraviOkruzenje(
    stavke: Array<{ itemId: number; knjizno: number; popisano: number }>,
  ) {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const createStockDocument = jest
      .fn()
      .mockResolvedValue({ data: { id: 555 } });

    const prisma = {
      inventoryCount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          countNumber: "0001/2026",
          warehouseId: 1,
          countDate: new Date("2026-08-07T00:00:00.000Z"),
          status: "COUNTING",
          items: stavke.map((s, i) => ({
            id: i + 1,
            itemId: s.itemId,
            bookQuantity: D(s.knjizno),
            countedQuantity: D(s.popisano),
            price: D(100),
          })),
        }),
        updateMany,
      },
      item: {
        findMany: jest.fn().mockResolvedValue([
          { id: 90001, name: "Ventil DN25", catalogNumber: "V-25" },
          { id: 90002, name: "Prirubnica DN50", catalogNumber: "P-50" },
        ]),
      },
      stockDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const servis = new InventoryService(
      prisma as unknown as PrismaService,
      {} as unknown as CostingService,
      { createStockDocument } as unknown as RobnoService,
    );
    return { servis, prisma, createStockDocument, updateMany };
  }

  it("🔴 popis sa manjkom se ODBIJA — ne pravi se nijedan dokument i popis ostaje otvoren", async () => {
    // Zatečeno ponašanje (pre 07.08.2026): tiho se kreirao MANJR dokument i popis je prelazio
    // u POSTED — knjige bi se „ispravile" knjiženjem koje knjigovođa nije odobrio.
    const o = napraviOkruzenje([
      { itemId: 90001, knjizno: 10, popisano: 7 }, // manjak 3
    ]);

    await expect(o.servis.finalize(7)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    expect(o.createStockDocument).not.toHaveBeenCalled(); // ni MANJAK ni VISAK
    expect(o.updateMany).not.toHaveBeenCalled(); // popis OSTAJE u COUNTING
    expect(o.prisma.stockDocument.deleteMany).not.toHaveBeenCalled(); // bez ijednog traga
  });

  it("poruka imenuje artikle, količinu manjka i citira odluku knjigovođe", async () => {
    const o = napraviOkruzenje([
      { itemId: 90001, knjizno: 10, popisano: 7 },
      { itemId: 90002, knjizno: 5, popisano: 4 },
    ]);

    const greska = await o.servis.finalize(7).catch((e: Error) => e);
    const poruka = (greska as Error).message;

    expect(poruka).toMatch(/Popis 0001\/2026 ne može da se zaključi/);
    expect(poruka).toMatch(/2 artikala ima manje nego što knjige kažu/);
    expect(poruka).toMatch(/V-25 Ventil DN25 \(manjak 3\.000\)/);
    expect(poruka).toMatch(/P-50 Prirubnica DN50 \(manjak 1\.000\)/);
    expect(poruka).toMatch(/takav dokument ne treba da postoji/);
    expect(poruka).toMatch(/07\.08\.2026/);
    expect(poruka).toMatch(/COUNTING/); // gde popis ostaje
  });

  it("popis SAMO sa viškom prolazi — VISAK dokument se pravi kao i do sada", async () => {
    // Kontrolna grupa: višak koriste i potvrđen je (nalog VISAK 260119 u knjizi 2026,
    // 1320/6740 = 190.168,91). Brana ga ne sme dirati.
    const o = napraviOkruzenje([{ itemId: 90001, knjizno: 10, popisano: 12 }]);

    const { data } = await o.servis.finalize(7);

    expect(o.createStockDocument).toHaveBeenCalledTimes(1);
    const [kind, telo] = o.createStockDocument.mock.calls[0] as [
      string,
      { documentTypeCode: string; items: Array<{ quantity: string }> },
    ];
    expect(kind).toBe("VISAK");
    expect(telo.documentTypeCode).toBe("VISAR");
    expect(telo.items[0].quantity).toBe("2.000000");
    expect(data).toMatchObject({ status: "POSTED", visakDocId: 555 });
    // `manjakDocId` ostaje u ugovoru zbog FE-a, ali novi popis ga više ne može dobiti.
    expect(data.manjakDocId).toBeNull();
  });

  it("popis sa VIŠKOM I MANJKOM se odbija u celini — višak se ne knjiži „usput”", async () => {
    // Brana stoji PRE kreiranja: da je posle, popis bi ostavio DRAFT VISAK dokument kao smeće.
    const o = napraviOkruzenje([
      { itemId: 90001, knjizno: 10, popisano: 12 }, // višak 2
      { itemId: 90002, knjizno: 5, popisano: 1 }, // manjak 4
    ]);

    await expect(o.servis.finalize(7)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(o.createStockDocument).not.toHaveBeenCalled();
  });

  it("popis bez ijedne razlike prolazi bez ijednog dokumenta", async () => {
    const o = napraviOkruzenje([{ itemId: 90001, knjizno: 10, popisano: 10 }]);

    const { data } = await o.servis.finalize(7);

    expect(o.createStockDocument).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      status: "POSTED",
      visakDocId: null,
      manjakDocId: null,
    });
  });
});
