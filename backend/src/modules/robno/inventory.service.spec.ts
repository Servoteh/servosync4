import { Prisma } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
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
