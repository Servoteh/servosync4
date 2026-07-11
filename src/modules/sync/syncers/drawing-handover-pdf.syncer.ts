import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  ChainItemDelegate,
  LegacyChainItemSyncer,
} from "./legacy-chain-item.syncer";

type Refs = Record<string, never>;

/**
 * TEMPORARY (P4 §5.3): PrimopredajaPDFCrteza (QBigTehn) ->
 * drawing_handover_pdfs.
 *
 * EXPECTED EMPTY: the legacy parent `PrimopredajaCrteza` is empty even on the
 * live MSSQL (the real handover lives as tRN attributes — see
 * handover-derivation.syncer.ts), so this child table is almost certainly
 * empty too. The spec (§5.3) mandates a COUNT check at import time: the run
 * note always reports the source row count.
 *
 * DELIBERATELY NEVER WRITES A ROW: legacy `IDPrimopredaje` values CANNOT be
 * mapped onto 2.0 `drawing_handovers` ids — derived rows carry native
 * autoincrement ids keyed by `legacy_rn_id`, not by the legacy group id, so
 * any direct id match would attach the PDF to an arbitrary handover. If the
 * source turns out non-empty, every row is skipped with an explicit error and
 * the run note demands a mapping decision BEFORE cutover. Deleted at cutover
 * with the sync-map split (§7.2).
 */
@Injectable()
export class DrawingHandoverPdfSyncer extends LegacyChainItemSyncer<Refs> {
  readonly entity = "drawing_handover_pdfs";

  constructor(mssql: MssqlClient, prisma: PrismaService) {
    super(mssql, prisma);
  }

  protected selectSql(): string {
    return `SELECT [ID], [IDPrimopredaje], [LinkFajla], [NazivFajla]
            FROM [dbo].[PrimopredajaPDFCrteza]`;
  }

  protected delegate(): ChainItemDelegate {
    return this.prisma.drawingHandoverPdf as unknown as ChainItemDelegate;
  }

  protected resolveRefs(): Promise<Refs> {
    return Promise.resolve({});
  }

  protected rowLabel(row: Record<string, unknown>): string {
    return `ID=${String(row["ID"])}`;
  }

  protected note(rowsFetched: number): string {
    return rowsFetched === 0
      ? "PrimopredajaPDFCrteza je prazna na izvoru (očekivano — prazan legacy parent PrimopredajaCrteza)."
      : `PAŽNJA: PrimopredajaPDFCrteza NIJE prazna (${rowsFetched} redova) — legacy IDPrimopredaje se ne može mapirati na derivirane drawing_handovers id-jeve; svi redovi su preskočeni, potrebna odluka pre cutover-a (spec §5.3).`;
  }

  protected mapRow(): { id: number; data: Record<string, unknown> } {
    // The full column mapping WOULD be: ID -> id, IDPrimopredaje ->
    // handover_id, LinkFajla -> file_link, NazivFajla -> file_name — but the
    // handover reference is unmappable (see class doc), so every row skips.
    throw new Error(
      "legacy IDPrimopredaje cannot be mapped onto derived drawing_handovers ids — mapping decision required before cutover (spec §5.3)",
    );
  }
}
