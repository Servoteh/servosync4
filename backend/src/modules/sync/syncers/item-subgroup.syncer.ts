import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { CodeRegistrySyncer } from "./code-registry.syncer";

interface ItemSubgroupRow {
  code: string;
  description: string;
  parentGroup: string;
}

/**
 * Podgrupe artikala (QBigTehn `R_Podgrupa`) -> `item_subgroups` (Postgres).
 *
 * Source DDL: `Podgrupa nvarchar(10) NOT NULL` (PK), `Opis nvarchar(50) NOT NULL`,
 * `GrupaVeza nvarchar(10) NULL` (soft link to `R_Grupa.Grupa`).
 *
 * `GrupaVeza` is NOT declared as an FK in Postgres either, so an unknown parent
 * code is stored as-is rather than nulled — nothing can break, and the value is
 * still the source's own answer to "which group". Missing/empty becomes `'0'`,
 * the BigBit sentinel for "no parent".
 */
@Injectable()
export class ItemSubgroupSyncer extends CodeRegistrySyncer<ItemSubgroupRow> {
  readonly entity = "item_subgroups";
  protected readonly sourceTable = "R_Podgrupa";
  protected readonly sourceColumns = ["Podgrupa", "Opis", "GrupaVeza"] as const;
  protected readonly sourceKeyColumn = "Podgrupa";

  constructor(
    mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {
    super(mssql);
  }

  protected mapRow(r: Record<string, unknown>): ItemSubgroupRow {
    return {
      code: CodeRegistrySyncer.reqCode(r["Podgrupa"], "Podgrupa"),
      description: CodeRegistrySyncer.reqStr(r["Opis"]),
      parentGroup: CodeRegistrySyncer.codeOrZero(r["GrupaVeza"]),
    };
  }

  protected upsert(data: ItemSubgroupRow): Promise<unknown> {
    return this.prisma.itemSubgroup.upsert({
      where: { code: data.code },
      create: data,
      update: data,
    });
  }
}
