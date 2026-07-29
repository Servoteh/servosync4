import { PrismaService } from "../../prisma/prisma.service";
import { MssqlClient } from "./mssql.client";
import { SyncService } from "./sync.service";
import { SYNC_MAP } from "./sync-map.generated";
import {
  isOwnedProductionTable,
  QBIGTEHN_CHAIN_ENTITIES,
} from "./table-ownership";
import type { CustomerSyncer } from "./syncers/customer.syncer";

/**
 * Cutover izvršen 2026-07-14 (runbook §17 korak 6): QBigTehn lanac je ugašen.
 * §5.3 privremeni chain-item synceri i handover-derivation syncer su OBRISANI,
 * a chain entiteti izbačeni iz sync-map.generated.ts. Ovaj test je ranije
 * proveravao redosled registracije tih (sada nepostojećih) syncera; posle
 * cutover-a proverava suprotno: ostaje samo trajni BigBit sync i NIJEDAN chain
 * entitet nije registrovan.
 */
describe("SyncService — posle cutover-a (trajni BigBit sync)", () => {
  function buildService(): SyncService {
    return new SyncService(
      {} as PrismaService,
      {} as MssqlClient,
      { entity: "customers" } as CustomerSyncer,
    );
  }

  it("registruje customers (bespoke BigBit syncer) tačno jednom", () => {
    const entities = buildService().availableEntities;
    expect(entities.filter((e) => e === "customers")).toHaveLength(1);
  });

  it("registruje trajne BigBit tabele iz sync mape (npr. projects, items)", () => {
    const entities = buildService().availableEntities;
    expect(entities).toContain("projects");
    expect(entities).toContain("items");
  });

  it("NE registruje nijedan QBigTehn chain entitet (ugašeni lanac)", () => {
    const entities = buildService().availableEntities;
    const leaked = entities.filter((e) => QBIGTEHN_CHAIN_ENTITIES.has(e));
    expect(leaked).toEqual([]);
  });

  // Robni tok (Faza 3): `goods_documents` (T_Robna dokumenta) + `goods_document_items`
  // (T_Robne stavke) su izbačeni iz sync-map.generated.ts jer postaju 2.0-owned
  // (prod kopija bila mrtva: 0 redova, 0 čitalaca). Njihov lagani BigBit keš —
  // `goods_documents_mirror` / `goods_document_items_mirror` (zaseban source) —
  // OSTAJE u syncu.
  it("NE registruje goods_documents ni goods_document_items (2.0-owned)", () => {
    const entities = buildService().availableEntities;
    expect(entities).not.toContain("goods_documents");
    expect(entities).not.toContain("goods_document_items");
  });

  it("i dalje registruje goods_documents_mirror (zaseban BigBit keš)", () => {
    const entities = buildService().availableEntities;
    expect(entities).toContain("goods_documents_mirror");
    expect(entities).toContain("goods_document_items_mirror");
  });

  // Presuda Nenada 26.07.2026: registar PDV tarifa je 4.0-owned (POST/PATCH
  // /api/v1/pdv/tax-rates). `R_Tarife` je izbačen iz mape — ne sme da postoji ni
  // kao ručno okidiv tok, jer bi full refresh obrisao 4.0 unose.
  it("NE registruje tax_rates (4.0-owned registar, mapiranje uklonjeno 26.07)", () => {
    const entities = buildService().availableEntities;
    expect(entities).not.toContain("tax_rates");
    expect(SYNC_MAP.some((m) => m.source === "R_Tarife")).toBe(false);
    expect(SYNC_MAP.some((m) => m.targetDb === "tax_rates")).toBe(false);
  });

  it("tax_rates je u OWNED_PRODUCTION_TABLES (zaštita ako se mapiranje vrati)", () => {
    expect(isOwnedProductionTable("tax_rates")).toBe(true);
  });
});

/**
 * Review 26.07.2026, nalaz [6]: in-process brava je bez TTL-a trajno zaključavala
 * SVAKI sledeći sync ako jedan prolaz visi (proces živ, promise nikad ne završi).
 */
describe("SyncService — TTL in-process brave", () => {
  function serviceWithSlowSync(finish: Promise<void>) {
    const prisma = {
      bbSyncLog: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 1, ...data })),
      },
      bbSyncState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const svc = new SyncService(prisma, {} as MssqlClient, {
      entity: "customers",
    } as CustomerSyncer);
    // Jedan „viseći" syncer koji drži bravu dok mu se ne kaže da završi.
    (svc as unknown as { syncers: Map<string, unknown> }).syncers.set(
      "customers",
      {
        entity: "customers",
        defaultStrategy: "incremental",
        sync: jest.fn().mockImplementation(async () => {
          await finish;
          return {
            entity: "customers",
            rowsFetched: 0,
            rowsUpserted: 0,
            rowsSkipped: 0,
            newCursor: null,
            errors: [],
          };
        }),
      },
    );
    return svc;
  }

  it("paralelan poziv dok brava traje → 409 sa trajanjem u poruci", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = serviceWithSlowSync(gate);

    const first = svc.run({ entities: ["customers"] });
    await expect(svc.run({ entities: ["customers"] })).rejects.toThrow(
      /already in progress/,
    );
    release();
    await first;
  });

  it("posle TTL-a se zaglavljena brava PREUZIMA (sync se ne zaključava zauvek)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = serviceWithSlowSync(gate);

    const stuck = svc.run({ entities: ["customers"] });
    // Pomeri početak brave 91 min unazad (TTL je 90 min).
    (svc as unknown as { runningSince: number }).runningSince =
      Date.now() - 91 * 60_000;

    const second = svc.run({ entities: ["customers"] });
    release();
    await expect(second).resolves.toBeDefined();
    await stuck;
    // Zaglavljeni prolaz NE sme da otključa tuđu bravu kad se konačno vrati.
    expect(
      (svc as unknown as { runningSince: number | null }).runningSince,
    ).toBeNull();
  });
});
