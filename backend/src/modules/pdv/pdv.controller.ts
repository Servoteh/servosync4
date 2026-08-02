import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { VatLedgerService } from "./vat-ledger.service";
import { PopdvService } from "./popdv.service";
import { KepuService } from "./kepu.service";
import { AdvanceVatService } from "./advance-vat.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type {
  CreateManualVatEntryDto,
  UpdateManualVatEntryDto,
} from "./dto/manual-vat-entry.dto";
import {
  normalizeListAdvancesQuery,
  type RecordIncomingAdvanceDto,
} from "./dto/advance-vat.dto";
import { Prisma } from "@prisma/client";
import type { VatSanityReport } from "./vat-sanity";
import type { VatLedgerRow } from "./vat-ledger.service";

/** Σ osnovice i PDV liste — isti broj koji ide u „UKUPNO" red PDF-a. */
function totalsOf(rows: VatLedgerRow[]): {
  totalBase: Prisma.Decimal;
  totalVat: Prisma.Decimal;
} {
  let totalBase = new Prisma.Decimal(0);
  let totalVat = new Prisma.Decimal(0);
  for (const r of rows) {
    totalBase = totalBase.add(r.vatBase);
    totalVat = totalVat.add(r.vatAmount);
  }
  return { totalBase, totalVat };
}

/** Sažetak provere za `meta` — bez sirovih grupa po stopama (front ih ne crta). */
function sanityMeta(s: VatSanityReport) {
  return {
    ok: s.ok,
    period: s.periodLabel,
    problems: s.problems,
    warnings: s.warnings,
    computedRefund: s.computedRefund,
    gkRefund: s.gkRefund,
    bigbitControl: s.bigbitControl,
    controlDiff: s.controlDiff,
    manualCount: s.manual.count,
  };
}

/**
 * PDV / POPDV kontroler (Faza 6). Izvedena PDV evidencija iz glavne knjige.
 *
 *   GET  /api/v1/pdv/kif?year=&month=            — KIF (izlazne fakture) za period
 *   GET  /api/v1/pdv/kuf?year=&month=            — KUF (ulazne fakture) za period
 *   POST /api/v1/pdv/kif-kuf/build                — napuni KIF/KUF iz GK za period
 *   POST /api/v1/pdv/popdv/compute                — POPDV obračun (VatReturn + linije)
 *   GET  /api/v1/pdv/returns?year=                — sačuvani PDV obračuni
 *   GET  /api/v1/pdv/kepu?year=&month=&warehouseId= — KEPU rekapitulacija
 *
 * Permisije: read = PDV_READ; obračun/punjenje = PDV_COMPUTE.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDV_READ)
@Controller({ path: "pdv", version: "1" })
export class PdvController {
  constructor(
    private readonly vatLedger: VatLedgerService,
    private readonly popdv: PopdvService,
    private readonly kepu: KepuService,
    private readonly advanceVat: AdvanceVatService,
  ) {}

  /**
   * KIF/KUF lista. `meta` NOSI I ZBIR I NALAZ PROVERE (review: zaštita je do
   * sada stajala samo na PDF-u i mejlu, pa je ekran i „Izvezi CSV" tiho iznosio
   * period koji se ne sme štampati; a lista uopšte nije imala zbir — baš onaj
   * kvar zbog kojeg je modul i pisan, „625 stavki a UKUPNO 0,00", na ekranu se
   * ne bi ni video). Lista se NE blokira — 409 na čitanju bi zaključao ekran;
   * front prikazuje baner iz `meta.sanity` i njime označava izvoz.
   */
  @Get("kif")
  async listKif(@Query("year") year: string, @Query("month") month: string) {
    const data = await this.vatLedger.listKif(Number(year), Number(month));
    const sanity = await this.vatLedger.checkPeriod(Number(year), Number(month));
    return { data, meta: { count: data.length, ...totalsOf(data), sanity: sanityMeta(sanity) } };
  }

  @Get("kuf")
  async listKuf(@Query("year") year: string, @Query("month") month: string) {
    const data = await this.vatLedger.listKuf(Number(year), Number(month));
    const sanity = await this.vatLedger.checkPeriod(Number(year), Number(month));
    return { data, meta: { count: data.length, ...totalsOf(data), sanity: sanityMeta(sanity) } };
  }

  /** Nalaz provere ispravnosti perioda (bez punjenja i bez štampe). */
  @Get("sanity")
  async periodSanity(
    @Query("year") year: string,
    @Query("month") month: string,
  ) {
    const sanity = await this.vatLedger.checkPeriod(Number(year), Number(month));
    return { data: sanityMeta(sanity) };
  }

  @Post("kif-kuf/build")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async buildKifKuf(
    @Body() body: { year: number; month: number; force?: boolean },
  ) {
    const data = await this.vatLedger.buildKifKuf(
      Number(body.year),
      Number(body.month),
      // `force` upisuje i period koji je pao na proveri ispravnosti (za
      // dijagnostiku); bez njega se punjenje poništava (rollback) uz 409.
      { force: body.force === true },
    );
    return { data };
  }

  // ── ručne KIF/KUF stavke (D4) — source = manual (sourceJournalEntryId null) ──

  @Post("kif-kuf/entries")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async createManualEntry(@Body() body: CreateManualVatEntryDto) {
    const data = await this.vatLedger.createManualEntry(body);
    return { data };
  }

  @Patch("kif-kuf/entries/:id")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async updateManualEntry(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateManualVatEntryDto,
  ) {
    const data = await this.vatLedger.updateManualEntry(id, body);
    return { data };
  }

  @Delete("kif-kuf/entries/:id")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async deleteManualEntry(@Param("id", ParseIntPipe) id: number) {
    const data = await this.vatLedger.deleteManualEntry(id);
    return { data };
  }

  @Post("popdv/compute")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async computePopdv(
    @Body()
    body: { year: number; month?: number; quarter?: number; force?: boolean },
  ) {
    const data = await this.popdv.compute({
      year: Number(body.year),
      month: body.month != null ? Number(body.month) : undefined,
      quarter: body.quarter != null ? Number(body.quarter) : undefined,
      // `force` sačuva i obračun koji je pao na proveri ispravnosti (za
      // dijagnostiku) — problemi ostaju u `sanity` i `note`; NIJE za predaju.
      force: body.force === true,
    });
    return { data };
  }

  @Get("returns")
  async listReturns(@Query("year") year?: string) {
    const data = await this.popdv.listReturns(
      year != null ? Number(year) : undefined,
    );
    return { data, meta: { count: data.length } };
  }

  /**
   * Zaključaj (proknjiži) PDV obračun: CALCULATED → POSTED (D3). Posle ovoga je
   * period zaključan (build/compute/ručne izmene tog perioda se odbijaju).
   */
  @Post("returns/:id/post")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async postReturn(@Param("id", ParseIntPipe) id: number) {
    const data = await this.popdv.postReturn(id);
    return { data };
  }

  /** KEPU knjiga per-red (D5 FE tab): rbr/strana po godini + kumulativni saldo. */
  @Get("kepu")
  async kepuBook(
    @Query("year") year: string,
    @Query("month") month?: string,
    @Query("warehouseId") warehouseId?: string,
  ) {
    const data = await this.kepu.book(
      Number(year),
      month != null ? Number(month) : undefined,
      warehouseId != null ? Number(warehouseId) : undefined,
    );
    return { data, meta: { count: data.length } };
  }

  /** KEPU rekapitulacija po magacinu (slaganje robno↔finansijski). */
  @Get("kepu/recap")
  async kepuRecap(
    @Query("year") year: string,
    @Query("month") month?: string,
    @Query("warehouseId") warehouseId?: string,
  ) {
    const data = await this.kepu.recap(
      Number(year),
      month != null ? Number(month) : undefined,
      warehouseId != null ? Number(warehouseId) : undefined,
    );
    return { data, meta: { count: data.length } };
  }

  // ── Avansni računi (Batch C) ────────────────────────────────────────────────
  // Ulazni avans: pretporez se priznaje tek PLAĆANJEM, pa je knjiženje u KUF
  // vezano za `paidAt`, ne za datum dokumenta.

  /** Lista avansa (oba smera) — `direction=in|out`, `unpaidOnly=true`. */
  @Get("advances")
  async listAdvances(
    @Query()
    query: {
      direction?: string;
      partnerId?: string;
      unpaidOnly?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    return this.advanceVat.listAdvances(normalizeListAdvancesQuery(query));
  }

  /** Evidentiraj ulazni avansni račun dobavljača (bez KUF stavke dok nije plaćen). */
  @Post("advances/incoming")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async recordIncomingAdvance(
    @Body() dto: RecordIncomingAdvanceDto,
    @Req() req: { user: AuthUser },
  ) {
    const data = await this.advanceVat.recordIncomingAdvance(dto, req.user);
    return { data };
  }

  /** Označi plaćanje ulaznog avansa → upis pretporeza u KUF po periodu plaćanja. */
  @Post("advances/incoming/:id/mark-paid")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async markIncomingAdvancePaid(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { paidAt: string; amount: string | number },
    @Req() req: { user: AuthUser },
  ) {
    // Iznos se prosleđuje NETAKNUT (string ostaje string) — `Number()` ovde bi
    // provukao novac kroz JS Float, protiv BACKEND_RULES §3 (review Batch C, R8).
    const data = await this.advanceVat.markIncomingAdvancePaid(
      { id, paidAt: body?.paidAt, amount: body?.amount },
      req.user,
    );
    return { data };
  }

  /** Veži ulazni avans na konačni ulazni račun (storno pretporeza avansa). */
  @Post("advances/incoming/:id/link-final")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async linkIncomingAdvanceToFinal(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { finalInvoiceId: number },
  ) {
    const data = await this.advanceVat.linkIncomingAdvanceToFinal({
      advanceId: id,
      finalInvoiceId: body.finalInvoiceId,
    });
    return { data };
  }
}
