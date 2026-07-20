import { PrismaService } from "../../prisma/prisma.service";
import { MssqlClient } from "./mssql.client";
import { SyncService } from "./sync.service";
import { QBIGTEHN_CHAIN_ENTITIES } from "./table-ownership";
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
});
