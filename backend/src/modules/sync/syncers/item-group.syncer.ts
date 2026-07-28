import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { CodeRegistrySyncer } from "./code-registry.syncer";

interface ItemGroupRow {
  code: string;
  description: string;
}

/**
 * Grupe artikala (QBigTehn `R_Grupa`) -> `item_groups` (Postgres).
 *
 * Source DDL: `Grupa nvarchar(10) NOT NULL` (PK), `Opis nvarchar(50) NOT NULL`.
 * No watermark column -> full refresh by upsert on `code` (see base class).
 */
@Injectable()
export class ItemGroupSyncer extends CodeRegistrySyncer<ItemGroupRow> {
  readonly entity = "item_groups";
  protected readonly sourceTable = "R_Grupa";
  protected readonly sourceColumns = ["Grupa", "Opis"] as const;
  protected readonly sourceKeyColumn = "Grupa";

  constructor(
    mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {
    super(mssql);
  }

  protected mapRow(r: Record<string, unknown>): ItemGroupRow {
    return {
      code: CodeRegistrySyncer.reqCode(r["Grupa"], "Grupa"),
      description: CodeRegistrySyncer.reqStr(r["Opis"]),
    };
  }

  protected upsert(data: ItemGroupRow): Promise<unknown> {
    return this.prisma.itemGroup.upsert({
      where: { code: data.code },
      create: data,
      update: data,
    });
  }
}
