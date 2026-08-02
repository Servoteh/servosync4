import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Registar vrsta dokumenata kao KONFIGURACIJA EKRANA (PLAN_UNOS_DOKUMENATA §5.1/§5.7).
 *
 * BigBit nema 57 ekrana za 57 vrsta — ima JEDAN skelet koji red iz `document_types`
 * konfiguriše. Ekran odavde čita: profil (`screenKind`), proveru zaliha (`stockCheck`),
 * grupu numeracije, obavezna polja (`requires*`), varijante štampe i ciljeve prepisa.
 * Nova vrsta = nov red u tabeli, bez izmene frontenda.
 *
 * Read-only: ovaj modul NIŠTA ne upisuje. Uređivanje registra je posao Podešavanja.
 */

/** Profil ekrana — koje kolone stavke se uopšte prikazuju (§2.1). */
export type ScreenKind = "GOODS" | "SERVICE" | "ORDER";

// Provera zaliha (§2.7) NIJE definisana ovde nego u `common/document-types/stock-check`,
// zajedno sa robnim rutama. Razlog je zapisan u tom fajlu: registar i robne rute su
// nezavisno izabrali SUPROTNU podrazumevanu vrednost, pa je ekran korisniku govorio
// jedno a ruta radila drugo.
import {
  type StockCheck,
  DEFAULT_STOCK_CHECK,
  STOCK_CHECK_VALUES,
} from "../../common/document-types/stock-check";
export { type StockCheck, DEFAULT_STOCK_CHECK };

const SCREEN_KINDS: readonly ScreenKind[] = ["GOODS", "SERVICE", "ORDER"];

/**
 * Podrazumevani profil za vrstu koja JOŠ NIJE konfigurisana (`screen_kind IS NULL`).
 * GOODS namerno: robni ekran prikazuje NAJVIŠE kolona (artikal, magacin, zalihe), pa
 * neKonfigurisana vrsta ostaje upotrebljiva. SERVICE bi sakrio kolonu artikla i tiho
 * onemogućio unos robe.
 */
const DEFAULT_SCREEN_KIND: ScreenKind = "GOODS";

export interface ListDocumentTypesQuery {
  /** tačna šifra (jedna vrsta) */
  code?: string;
  /** grupa numeracije (INVOICE_OUT | OFFER | ADVANCE | …) */
  numberingGroup?: string;
  screenKind?: string;
  /** true = ulazna dokumenta, false = izlazna */
  isInbound?: boolean;
  /** samo vrste sa popunjenim `screen_kind` (konfigurisane za novi ekran) */
  configuredOnly?: boolean;
  /** pretraga po šifri ili opisu */
  q?: string;
}

/** Kolone koje ekran čita — eksplicitan izbor, da se legacy tabela ne izliva u API. */
const SELECT = {
  id: true,
  code: true,
  description: true,
  isInbound: true,
  isInternalDocument: true,
  isFiscal: true,
  isDepartmental: true,
  // ── numeracija ──
  numberingGroup: true,
  numberingMode: true,
  documentNumberPrefix: true,
  numberingStart: true,
  // ── ekran / zalihe ──
  screenKind: true,
  stockCheck: true,
  reservesStock: true,
  affectsStock: true,
  defaultWarehouseId: true,
  // ── cene / PDV ──
  writesPriceList: true,
  defaultPriceListCode: true,
  defaultVatExemptionCode: true,
  postInVatLedger: true,
  saleWithPpp: true,
  saleWithPpu: true,
  // ── obavezna polja ──
  requiresProject: true,
  requiresWorkOrder: true,
  requiresPoNumber: true,
  // ── štampa / prepis ──
  allowedPrintVariants: true,
  carryOverTargets: true,
} as const;

type DocumentTypeRow = Prisma.DocumentTypeGetPayload<{ select: typeof SELECT }>;

@Injectable()
export class DocumentTypesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ceo registar (57 redova — bez paginacije), uz opcione filtere. */
  async list(query: ListDocumentTypesQuery = {}) {
    const where: Prisma.DocumentTypeWhereInput = {};
    if (query.code) where.code = query.code.trim().toUpperCase();
    if (query.numberingGroup)
      where.numberingGroup = query.numberingGroup.trim().toUpperCase();
    if (query.screenKind) {
      where.screenKind = query.screenKind.trim().toUpperCase();
    } else if (query.configuredOnly) {
      // `configuredOnly` NE sme da pregazi uži filter po profilu (`screenKind` ga već
      // podrazumeva) — inače bi kombinacija oba filtera tiho vratila ceo registar.
      where.screenKind = { not: null };
    }
    if (query.isInbound !== undefined) where.isInbound = query.isInbound;
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { code: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const rows = await this.prisma.documentType.findMany({
      where,
      select: SELECT,
      orderBy: { code: "asc" },
    });

    const data = rows.map((r) => this.toScreenConfig(r));
    return {
      data,
      meta: {
        count: data.length,
        /** koliko ih je stvarno konfigurisano za novi ekran (ostale voze na podrazumevanom). */
        configured: data.filter((d) => d.isConfigured).length,
      },
    };
  }

  /** Jedna vrsta po šifri — ekran je zove pri otvaranju dokumenta. */
  async byCode(code: string) {
    const normalized = (code ?? "").trim().toUpperCase();
    if (!normalized) {
      throw new NotFoundException("Šifra vrste dokumenta je obavezna.");
    }
    const row = await this.prisma.documentType.findUnique({
      where: { code: normalized },
      select: SELECT,
    });
    if (!row) {
      throw new NotFoundException(
        `Vrsta dokumenta „${normalized}" ne postoji u registru.`,
      );
    }
    return { data: this.toScreenConfig(row) };
  }

  /**
   * Mapiranje reda u konfiguraciju ekrana.
   *
   * Vraća se I sirova vrednost I `effective*` — ekran uzima `effective*` i ne izmišlja
   * sopstveni default, a Podešavanja vide sirovo stanje (šta je zaista upisano).
   * Nepoznata vrednost u koloni (loš ručni UPDATE) se NE prosleđuje ekranu: pada na
   * podrazumevanu i prijavljuje se kroz `warnings`.
   */
  private toScreenConfig(r: DocumentTypeRow) {
    const warnings: string[] = [];

    const screenKind = this.normalizeEnum(
      r.screenKind,
      SCREEN_KINDS,
      "screen_kind",
      r.code,
      warnings,
    );
    const stockCheck = this.normalizeEnum(
      r.stockCheck,
      STOCK_CHECK_VALUES,
      "stock_check",
      r.code,
      warnings,
    );

    return {
      id: r.id,
      code: r.code,
      description: r.description,
      isInbound: r.isInbound,
      isInternalDocument: r.isInternalDocument ?? false,
      isFiscal: r.isFiscal ?? false,
      isDepartmental: r.isDepartmental ?? false,

      /** true kad je vrsta zaista konfigurisana za novi ekran (ima `screen_kind`). */
      isConfigured: screenKind !== null,

      // ── profil ekrana ──
      screenKind,
      effectiveScreenKind: screenKind ?? DEFAULT_SCREEN_KIND,

      // ── numeracija ──
      numberingGroup: r.numberingGroup,
      numberingMode: r.numberingMode,
      documentNumberPrefix: r.documentNumberPrefix,
      numberingStart: r.numberingStart ?? 0,

      // ── zalihe ──
      stockCheck,
      effectiveStockCheck: stockCheck ?? DEFAULT_STOCK_CHECK,
      reservesStock: r.reservesStock,
      affectsStock: r.affectsStock ?? false,
      defaultWarehouseId: r.defaultWarehouseId ?? null,

      // ── cene / PDV ──
      writesPriceList: r.writesPriceList,
      defaultPriceListCode: r.defaultPriceListCode,
      defaultVatExemptionCode: r.defaultVatExemptionCode,
      postInVatLedger: r.postInVatLedger ?? false,
      /** „Prodaja sa PPP/PPU" = DA LI SE OBRAČUNAVA porez na robu/usluge (§4.4c), NE bruto/neto. */
      chargesGoodsVat: r.saleWithPpp ?? false,
      chargesServiceVat: r.saleWithPpu ?? false,

      // ── obavezna polja na zaglavlju ──
      requiresProject: r.requiresProject,
      requiresWorkOrder: r.requiresWorkOrder,
      requiresPoNumber: r.requiresPoNumber,

      // ── štampa / prepis (uvek niz, nikad null) ──
      allowedPrintVariants: r.allowedPrintVariants ?? [],
      carryOverTargets: r.carryOverTargets ?? [],

      warnings,
    };
  }

  private normalizeEnum<T extends string>(
    raw: string | null,
    allowed: readonly T[],
    column: string,
    code: string,
    warnings: string[],
  ): T | null {
    if (raw === null || raw === undefined || raw === "") return null;
    const value = raw.trim().toUpperCase() as T;
    if (allowed.includes(value)) return value;
    warnings.push(
      `Vrsta ${code}: nepoznata vrednost „${raw}" u koloni ${column} — primenjena je podrazumevana.`,
    );
    return null;
  }
}
