/**
 * KEPU SERVICE — rekapitulacija KEPU knjige (Faza 6 §C).
 * =========================================================================
 * KEPU (Knjiga evidencije prometa i usluga) je zakonski obavezna veleprodajna
 * knjiga (doc 18 §3.4 — vraćena u 4.0 scope). Model `KepuBookEntry` (Faza 3)
 * postoji: red = zaduženje (`charge`, MagUlaz) / razduženje (`discharge`,
 * MagStvarniIzlaz) po magacinu, sa `entryDate` i vezom na izvorni StockDocument.
 *
 * Ovaj servis daje REKAPITULACIJU (ne punjenje — punjenje radi robno pri
 * kreiranju robnih dokumenata): po magacinu i periodu sumira zaduženje/razduženje
 * i računa saldo (Σ zaduženje − Σ razduženje). Puna KEPU tabela (redosled,
 * kumulativni saldo po redu, štampani izlaz) je robno-modul odgovornost; ovde je
 * PDV-ciklusni pregled (slaganje robno↔finansijski, doc mesečni ciklus korak 4).
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Rekapitulacija KEPU po magacinu za period. */
export interface KepuRecapRow {
  warehouseId: number;
  totalCharge: Prisma.Decimal; // Σ zaduženje (MagUlaz)
  totalDischarge: Prisma.Decimal; // Σ razduženje (MagStvarniIzlaz)
  balance: Prisma.Decimal; // Σ zaduženje − Σ razduženje
  entryCount: number;
}

interface KepuRecapRawRow {
  warehouse_id: number;
  total_charge: Prisma.Decimal | null;
  total_discharge: Prisma.Decimal | null;
  entry_count: bigint;
}

@Injectable()
export class KepuService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rekapitulacija KEPU po magacinu za period [od, do). Ako `warehouseId` nije
   * zadat, vraća sve magacine. Period se filtrira po `entry_date`.
   *
   * @param year   godina perioda
   * @param month  mesec (1..12); ako je null → cela godina
   * @param warehouseId  filter magacina (opciono)
   */
  async recap(
    year: number,
    month?: number,
    warehouseId?: number,
  ): Promise<KepuRecapRow[]> {
    const from = new Date(Date.UTC(year, month != null ? month - 1 : 0, 1));
    const to =
      month != null
        ? new Date(Date.UTC(year, month, 1))
        : new Date(Date.UTC(year + 1, 0, 1));

    const warehouseFilter =
      warehouseId != null
        ? Prisma.sql`AND kbe.warehouse_id = ${warehouseId}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<KepuRecapRawRow[]>(
      Prisma.sql`
        SELECT
          kbe.warehouse_id AS warehouse_id,
          COALESCE(SUM(kbe.charge), 0) AS total_charge,
          COALESCE(SUM(kbe.discharge), 0) AS total_discharge,
          COUNT(*) AS entry_count
        FROM kepu_book_entries kbe
        WHERE kbe.entry_date >= ${from}
          AND kbe.entry_date < ${to}
          ${warehouseFilter}
        GROUP BY kbe.warehouse_id
        ORDER BY kbe.warehouse_id
      `,
    );

    return rows.map((r) => {
      const totalCharge = new D(r.total_charge ?? ZERO);
      const totalDischarge = new D(r.total_discharge ?? ZERO);
      return {
        warehouseId: r.warehouse_id,
        totalCharge,
        totalDischarge,
        balance: totalCharge.sub(totalDischarge),
        entryCount: Number(r.entry_count),
      };
    });
  }
}
