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
  rbr: number; // redni broj reda u periodu (1-baziran; „rbr po godini", task D5be)
  strana: number; // strana knjige = (N\45)+1 (BigBit; N = 0-baziran indeks reda)
  warehouseId: number;
  totalCharge: Prisma.Decimal; // Σ zaduženje (MagUlaz)
  totalDischarge: Prisma.Decimal; // Σ razduženje (MagStvarniIzlaz)
  balance: Prisma.Decimal; // Σ zaduženje − Σ razduženje
  entryCount: number;
}

/** Broj KEPU redova po strani knjige (BigBit: strana = (N\45)+1). */
const KEPU_ROWS_PER_PAGE = 45;

interface KepuRecapRawRow {
  warehouse_id: number;
  total_charge: Prisma.Decimal | null;
  total_discharge: Prisma.Decimal | null;
  entry_count: bigint;
}

/** Red KEPU knjige (per-red prikaz za FE tab — ugovor api/pdv.ts KepuRow). */
export interface KepuBookRow {
  id: number;
  rbr: number; // redni broj u knjizi — numeracija PO GODINI (nezavisna od mesečnog filtera)
  strana: number; // strana knjige = (rbr-1 \ 45) + 1 (BigBit)
  entryDate: Date;
  documentNumber: string | null; // broj izvornog robnog dokumenta
  description: string | null;
  charge: Prisma.Decimal; // zaduženje (MagUlaz)
  discharge: Prisma.Decimal; // razduženje (MagStvarniIzlaz)
  balance: Prisma.Decimal; // kumulativni saldo od početka godine (running Σ charge−discharge)
}

interface KepuBookRawRow {
  id: number;
  rbr: bigint;
  entry_date: Date;
  document_number: string | null;
  description: string | null;
  charge: Prisma.Decimal;
  discharge: Prisma.Decimal;
  running_balance: Prisma.Decimal | null;
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

    return rows.map((r, idx) => {
      const totalCharge = new D(r.total_charge ?? ZERO);
      const totalDischarge = new D(r.total_discharge ?? ZERO);
      const rbr = idx + 1; // redni broj reda u periodu (1-baziran)
      return {
        rbr,
        // BigBit strana = (N\45)+1, N = 0-baziran indeks → floor(idx/45)+1.
        strana: Math.floor(idx / KEPU_ROWS_PER_PAGE) + 1,
        warehouseId: r.warehouse_id,
        totalCharge,
        totalDischarge,
        balance: totalCharge.sub(totalDischarge),
        entryCount: Number(r.entry_count),
      };
    });
  }

  /**
   * KEPU knjiga per-red (D5, FE tab). rbr i kumulativni saldo se računaju NAD
   * CELOM GODINOM (window preko svih redova godine, redosled entry_date pa id) —
   * numeracija po godini ostaje stabilna i kad se prikazuje jedan mesec.
   * `documentNumber` iz izvornog StockDocument-a (meki ref documentId).
   * Kumulativni saldo je globalan (svi magacini zajedno) — knjiga se vodi na
   * nivou obveznika; per-magacin pregled daje `recap`.
   */
  async book(
    year: number,
    month?: number,
    warehouseId?: number,
  ): Promise<KepuBookRow[]> {
    const yearFrom = new Date(Date.UTC(year, 0, 1));
    const yearTo = new Date(Date.UTC(year + 1, 0, 1));
    const from = new Date(Date.UTC(year, month != null ? month - 1 : 0, 1));
    const to =
      month != null
        ? new Date(Date.UTC(year, month, 1))
        : new Date(Date.UTC(year + 1, 0, 1));

    const warehouseFilter =
      warehouseId != null
        ? Prisma.sql`AND kbe.warehouse_id = ${warehouseId}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<KepuBookRawRow[]>(
      Prisma.sql`
        SELECT * FROM (
          SELECT
            kbe.id,
            ROW_NUMBER() OVER (ORDER BY kbe.entry_date, kbe.id) AS rbr,
            kbe.entry_date,
            sd.document_number,
            kbe.description,
            kbe.charge,
            kbe.discharge,
            SUM(kbe.charge - kbe.discharge)
              OVER (ORDER BY kbe.entry_date, kbe.id) AS running_balance
          FROM kepu_book_entries kbe
          LEFT JOIN stock_documents sd ON sd.id = kbe.document_id
          WHERE kbe.entry_date >= ${yearFrom}
            AND kbe.entry_date < ${yearTo}
            ${warehouseFilter}
        ) t
        WHERE t.entry_date >= ${from}
          AND t.entry_date < ${to}
        ORDER BY t.rbr
      `,
    );

    return rows.map((r) => {
      const rbr = Number(r.rbr);
      return {
        id: r.id,
        rbr,
        strana: Math.floor((rbr - 1) / KEPU_ROWS_PER_PAGE) + 1,
        entryDate: r.entry_date,
        documentNumber: r.document_number,
        description: r.description,
        charge: new D(r.charge),
        discharge: new D(r.discharge),
        balance: new D(r.running_balance ?? ZERO),
      };
    });
  }
}
