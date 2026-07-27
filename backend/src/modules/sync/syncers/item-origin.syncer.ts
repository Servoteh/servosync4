import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { CodeRegistrySyncer } from "./code-registry.syncer";

interface ItemOriginRow {
  code: string;
  description: string;
  subgroupCode: string;
  discountPercent: Prisma.Decimal;
}

/**
 * Poreklo artikala (QBigTehn `R_Poreklo`) -> `item_origins` (Postgres).
 *
 * Source DDL: `Poreklo nvarchar(5) NOT NULL` (PK), `Opis nvarchar(50) NOT NULL`,
 * `PodgrupaVeza nvarchar(10) NULL` (soft link to `R_Podgrupa.Podgrupa`),
 * `PopustProc money NULL` (discount %, 4 decimals).
 *
 * `PopustProc` is money and therefore arrives as a JS number; it is wrapped in
 * `Prisma.Decimal` so the value reaches `numeric(19,4)` unrounded. NULL becomes
 * `0`, matching the CSV path in `tools/bigbit-bridge/sql/item_origins.sql`.
 */
@Injectable()
export class ItemOriginSyncer extends CodeRegistrySyncer<ItemOriginRow> {
  readonly entity = "item_origins";
  protected readonly sourceTable = "R_Poreklo";
  protected readonly sourceColumns = [
    "Poreklo",
    "Opis",
    "PodgrupaVeza",
    "PopustProc",
  ] as const;
  protected readonly sourceKeyColumn = "Poreklo";

  constructor(
    mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {
    super(mssql);
  }

  protected mapRow(r: Record<string, unknown>): ItemOriginRow {
    const discount = r["PopustProc"];
    return {
      code: CodeRegistrySyncer.reqCode(r["Poreklo"], "Poreklo"),
      description: CodeRegistrySyncer.reqStr(r["Opis"]),
      subgroupCode: CodeRegistrySyncer.codeOrZero(r["PodgrupaVeza"]),
      discountPercent: new Prisma.Decimal(
        discount === null || discount === undefined
          ? 0
          : (discount as number | string),
      ),
    };
  }

  protected upsert(data: ItemOriginRow): Promise<unknown> {
    return this.prisma.itemOrigin.upsert({
      where: { code: data.code },
      create: data,
      update: data,
    });
  }
}
