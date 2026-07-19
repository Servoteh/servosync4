import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  NivelacijaHook,
  NivelacijaInboundLine,
} from "./nivelacija.hook";

/**
 * NIVELACIJA (uprosečavanje) — replika BigBit modela (doc 39 §F, MUST; odluka Nenad 18.07).
 * =========================================================================================
 * „Nivelacija mora da se radi kao u BigBitu — moraju se uprosečiti cene, jer ista roba ima
 *  različite cene i zavisne troškove uvoza."
 *
 * BigBit drži JEDNU valuacionu cenu po artiklu (`R_Artikli.VP/MP` → 2.0 `ItemValuation`). Kad nov
 * ulaz stigne po drugačijoj `KalkVP` a zatečeno stanje > 0, nivelaciona stavka revalorizuje zatečeno
 * stanje sa stare na novu (uprosečenu) cenu — `Module__Nivelacija.OdrediNeproknjizeneNivelacijeZaliha`,
 * prag `|Stara − Nova| ≥ 0.01`.
 *
 * Formula (doc 39 §F + PLAN_FAZA_3_IMPL §b/c) — ponderisana prosečna, ISTA kao §C costing prosek,
 * samo primenjena inkrementalno pri ulazu (dvočlana sredina: zatečeno stanje + novi ulaz):
 *
 *     novaVP = (stanjeKol * staraVP + ulazKol * ulaznaVP) / (stanjeKol + ulazKol)
 *
 * i analogno za NabNeto (A), ZTsop (B), ZTdob (C) i MP.
 *
 * Ponašanje po stanju (doc 39 §A propagacija + §F):
 *   • `stanjeKol = 0`  → nema šta da se uprosečava → `ItemValuation` se PROSTO prepiše ulaznim cenama;
 *                        NEMA `NIV` dokumenta.
 *   • `stanjeKol > 0` i `|ulaznaVP − staraVP| ≥ 0.01` → AUTO nivelacija: update `ItemValuation` na
 *                        uprosečene cene + kreiraj `NIV` `StockDocument` sa jednim `StockLevelingItem`
 *                        parom (old.. / new..), `quantityRevalued = stanjeKol`,
 *                        `valueAdjustment = stanjeKol * (novaVP − staraVP)`.
 *   • `stanjeKol > 0` i `|ulaznaVP − staraVP| < 0.01` → ispod praga → cena se ne menja, NEMA `NIV`.
 *
 * POZIVA SE UNUTAR `$transaction` iz kalkulacije ulaza (`CalculationService`) — svaki poziv prima `tx`.
 * GK knjiženje razlike (`valueAdjustment`) radi Faza-2 `PostingEngineService` nad kreiranim `NIV`
 * dokumentom (van ovog servisa — ovde se samo kreira dokument + par). Sve u `Prisma.Decimal`.
 *
 * Konvencije: BACKEND_RULES §2 (Decimal, nikad Float), §7 (poslovne greške tipizirane — ovde nema
 * poslovnih grešaka jer je poziv već validiran u kalkulaciji; guard-ovi bacaju samo na programsku grešku).
 */

const D = Prisma.Decimal;

/** Prag ispod kog se ista roba NE nivelira (BigBit `|Stara − Nova| ≥ 0.01`, doc 39 §F). */
export const LEVELING_THRESHOLD = new D("0.01");

/** Novac se drži na 4 decimale (`Decimal(19,4)`), količine na 6 (`Decimal(19,6)`) — kao schema. */
const PRICE_DP = 4;

/**
 * Ulazna stavka (podskup `StockDocumentItem` polja) relevantan za nivelaciju. Prima se već
 * IZRAČUNATA (posle domaće kaskade / uvoz ZT raspodele iz `CalculationService`): `calculated*`,
 * `purchasePriceNet`, `dependentCost*` su konačne per-JM cene ulaza (`ulazna*`), `quantity` je `ulazKol`.
 */
export interface InboundLevelingItem {
  itemId: number;
  warehouseId: number;
  /** Ulazna količina (uvek pozitivna) — `ulazKol`. */
  quantity: Prisma.Decimal | string | number;
  /** Ulazna KalkVP (`ulaznaVP`) — nosilac praga i uprosečavanja VP. */
  calculatedWholesalePrice: Prisma.Decimal | string | number;
  /** Ulazna KalkMP. */
  calculatedRetailPrice: Prisma.Decimal | string | number;
  /** Ulazna nabavna neto (A). */
  purchasePriceNet: Prisma.Decimal | string | number;
  /** Ulazni ZTsop (B). */
  dependentCostOwn: Prisma.Decimal | string | number;
  /** Ulazni ZTdob (C). */
  dependentCostSupplier: Prisma.Decimal | string | number;
}

/**
 * Stara valuaciona cena artikla (`ItemValuation` = BigBit `R_Artikli.VP/MP`) pre ovog ulaza.
 * `staraVP = valuationWholesalePrice`.
 */
export interface OldValuation {
  valuationPurchaseNet: Prisma.Decimal | string | number; // A
  valuationDependentOwn: Prisma.Decimal | string | number; // B
  valuationDependentSupplier: Prisma.Decimal | string | number; // C
  valuationWholesalePrice: Prisma.Decimal | string | number; // VP (staraVP)
  valuationRetailPrice: Prisma.Decimal | string | number; // MP
}

/** Uprosečene (nove) valuacione cene — rezultat ponderisane sredine. */
interface AveragedValuation {
  purchaseNet: Prisma.Decimal;
  dependentOwn: Prisma.Decimal;
  dependentSupplier: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal;
  retailPrice: Prisma.Decimal;
}

/** Ishod jednog poziva `applyLeveling` (za pozivaoca / logging / test). */
export interface LevelingResult {
  itemId: number;
  warehouseId: number;
  /** `'INIT'` = stanje 0, cene prepisane; `'LEVELED'` = kreiran NIV; `'SKIPPED'` = ispod praga. */
  outcome: "INIT" | "LEVELED" | "SKIPPED";
  /** Nova valuaciona VP (posle prepisa/uprosečavanja) — za dijagnostiku. */
  newWholesalePrice: Prisma.Decimal;
  /** Kreiran NIV `StockDocument.id` (samo kad outcome='LEVELED'). */
  levelingDocumentId?: number;
  /** `stanjeKol * (novaVP − staraVP)` (samo kad outcome='LEVELED'). */
  valueAdjustment?: Prisma.Decimal;
}

/**
 * DI token za costing izvor (`CostingService.stateAsOf`). Vezuje se u `RobnoModule` na stvarni
 * `CostingService` (sibling servis modula). Definisano kao token + interfejs da `nivelacija.service`
 * ne zavisi hard-import-om od još-neizgrađenog `costing.service` fajla (tsc-clean nezavisno od redosleda
 * gradnje) — a da `applyLevelingForInboundItem` i dalje „koristi CostingService.stateAsOf" kad je vezan.
 */
export const COSTING_SERVICE = Symbol("COSTING_SERVICE");

/** Ugovor koji `NivelacijaService` očekuje od costing sloja (podskup `CostingService`). */
export interface StateProvider {
  /** As-of stanje `Σ(±Kol)` po (artikal, magacin) do `asOf` (KODJ izuzet) — doc 39 §C. */
  stateAsOf(
    itemId: number,
    warehouseId: number,
    asOf: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal>;
}

/**
 * DI token za NIV numeraciju (`NNNN/god`). Opciono; ako nije vezan, servis pravi fallback broj iz
 * MAX-a nad `stock_documents` za dati (kod, godina). Vezivanjem u `RobnoModule` se koristi zajednički
 * numbering (obrazac `handovers/draft-numbering.service.ts`).
 */
export const NIV_NUMBERING = Symbol("NIV_NUMBERING");

/** Ugovor numeracije NIV dokumenta. */
export interface NivNumberingProvider {
  nextNivNumber(
    tx: Prisma.TransactionClient,
    documentTypeCode: string,
    year: number,
  ): Promise<string>;
}

@Injectable()
export class NivelacijaService implements NivelacijaHook {
  private readonly logger = new Logger(NivelacijaService.name);

  constructor(
    @Optional() @Inject(COSTING_SERVICE) private readonly costing?: StateProvider,
    @Optional() @Inject(NIV_NUMBERING) private readonly numbering?: NivNumberingProvider,
  ) {}

  /**
   * `NivelacijaHook` port (vezuje se pod `NIVELACIJA_HOOK` tokenom; `CalculationService` ga zove na
   * kraju kalkulacije ULAZA, u istoj `$transaction`). Za svaku ulaznu stavku: učita staru
   * `ItemValuation` (default nule ako je nema), izračuna `stanjeKol` preko `CostingService.stateAsOf`,
   * pa delegira na `applyLeveling` (uprosečavanje + NIV). `inboundDocId` → `linkedInboundDocId` na NIV.
   */
  async applyForInbound(
    tx: Prisma.TransactionClient,
    inboundDocId: number,
    documentDate: Date,
    lines: NivelacijaInboundLine[],
  ): Promise<void> {
    if (!this.costing) {
      throw new Error(
        "NivelacijaService.applyForInbound: COSTING_SERVICE nije vezan (potreban stateAsOf).",
      );
    }
    for (const line of lines) {
      const valuation = await tx.itemValuation.findUnique({
        where: { itemId: line.itemId },
      });
      const staraValuacija: OldValuation = valuation ?? {
        valuationPurchaseNet: 0,
        valuationDependentOwn: 0,
        valuationDependentSupplier: 0,
        valuationWholesalePrice: 0,
        valuationRetailPrice: 0,
      };
      const stanjeKol = await this.costing.stateAsOf(
        line.itemId,
        line.warehouseId,
        documentDate,
        tx,
      );
      await this.applyLeveling(tx, line, stanjeKol, staraValuacija, {
        documentDate,
        linkedInboundDocId: inboundDocId,
      });
    }
  }

  /**
   * Nivelacija za jednu ulaznu stavku — CENTRALNA metoda (doc 39 §F). Poziva se UNUTAR `$transaction`
   * iz kalkulacije. `stanjeKol` je as-of stanje PRE ulaza (dobija se iz `CostingService.stateAsOf`).
   *
   * @param tx              Prisma transakcioni klijent (isti `$transaction` kao kalkulacija).
   * @param inboundItem     Već izračunata ulazna stavka (`ulazKol`, `ulaznaVP`, A/B/C, MP).
   * @param stanjeKol       Zatečeno stanje pre ulaza (`CostingService.stateAsOf`), Decimal.
   * @param staraValuacija  Trenutna `ItemValuation` artikla (staraVP/A/B/C/MP).
   * @param opts            Kontekst NIV dokumenta (magacin/datum/kreator/link na izvorni UL).
   */
  async applyLeveling(
    tx: Prisma.TransactionClient,
    inboundItem: InboundLevelingItem,
    stanjeKol: Prisma.Decimal | string | number,
    staraValuacija: OldValuation,
    opts: LevelingContext = {},
  ): Promise<LevelingResult> {
    const itemId = inboundItem.itemId;
    const warehouseId = inboundItem.warehouseId;

    const stateQty = new D(stanjeKol);
    const inQty = new D(inboundItem.quantity);

    const inVP = new D(inboundItem.calculatedWholesalePrice);
    const oldVP = new D(staraValuacija.valuationWholesalePrice);

    // ── Slučaj 1: stanjeKol = 0 → nema uprosečavanja → prepiši ulaznim cenama (doc 39 §A). NEMA NIV. ──
    // (stateQty ≤ 0: negativno stanje se tretira kao „nema baze za uprosečavanje" → prepis; sprečava
    //  deljenje sa ≤0 imeniocem u ponderisanoj sredini.)
    if (stateQty.lessThanOrEqualTo(0)) {
      const initValuation: AveragedValuation = {
        purchaseNet: new D(inboundItem.purchasePriceNet).toDecimalPlaces(PRICE_DP),
        dependentOwn: new D(inboundItem.dependentCostOwn).toDecimalPlaces(PRICE_DP),
        dependentSupplier: new D(inboundItem.dependentCostSupplier).toDecimalPlaces(PRICE_DP),
        wholesalePrice: inVP.toDecimalPlaces(PRICE_DP),
        retailPrice: new D(inboundItem.calculatedRetailPrice).toDecimalPlaces(PRICE_DP),
      };
      await this.writeValuation(tx, itemId, initValuation);
      return {
        itemId,
        warehouseId,
        outcome: "INIT",
        newWholesalePrice: initValuation.wholesalePrice,
      };
    }

    // ── Prag: |ulaznaVP − staraVP| < 0.01 → ispod praga → ne diramo cenu, NEMA NIV (doc 39 §F). ──
    if (inVP.minus(oldVP).abs().lessThan(LEVELING_THRESHOLD)) {
      return {
        itemId,
        warehouseId,
        outcome: "SKIPPED",
        newWholesalePrice: oldVP.toDecimalPlaces(PRICE_DP),
      };
    }

    // ── Slučaj 2: stanjeKol > 0 i iznad praga → AUTO nivelacija (uprosečavanje). ──
    // novaX = (stanjeKol * staraX + ulazKol * ulaznaX) / (stanjeKol + ulazKol)   (doc 39 §F)
    const totalQty = stateQty.plus(inQty);
    const averaged: AveragedValuation = {
      purchaseNet: this.weightedAvg(
        stateQty,
        staraValuacija.valuationPurchaseNet,
        inQty,
        inboundItem.purchasePriceNet,
        totalQty,
      ),
      dependentOwn: this.weightedAvg(
        stateQty,
        staraValuacija.valuationDependentOwn,
        inQty,
        inboundItem.dependentCostOwn,
        totalQty,
      ),
      dependentSupplier: this.weightedAvg(
        stateQty,
        staraValuacija.valuationDependentSupplier,
        inQty,
        inboundItem.dependentCostSupplier,
        totalQty,
      ),
      wholesalePrice: this.weightedAvg(
        stateQty,
        staraValuacija.valuationWholesalePrice,
        inQty,
        inboundItem.calculatedWholesalePrice,
        totalQty,
      ),
      retailPrice: this.weightedAvg(
        stateQty,
        staraValuacija.valuationRetailPrice,
        inQty,
        inboundItem.calculatedRetailPrice,
        totalQty,
      ),
    };

    const newVP = averaged.wholesalePrice;
    // valueAdjustment = stanjeKol * (novaVP − staraVP) — revalorizacija ZATEČENOG stanja (doc 39 §F).
    const valueAdjustment = stateQty
      .times(newVP.minus(oldVP.toDecimalPlaces(PRICE_DP)))
      .toDecimalPlaces(PRICE_DP);

    // a. update ItemValuation na uprosečene (nova*) cene — nova jedinstvena valuaciona cena artikla.
    await this.writeValuation(tx, itemId, averaged);

    // b. kreiraj NIV StockDocument (header nema kol. kretanje) + jedan StockLevelingItem par.
    const documentTypeCode = opts.documentTypeCode ?? "NIV";
    const documentDate = opts.documentDate ?? new Date();
    const postingDate = opts.postingDate ?? documentDate;
    const year = opts.year ?? documentDate.getFullYear();
    const documentNumber = await this.nextNivNumber(tx, documentTypeCode, year);

    const nivDoc = await tx.stockDocument.create({
      data: {
        companyId: opts.companyId ?? 0,
        kind: "NIV",
        documentTypeCode,
        documentNumber,
        year,
        warehouseId,
        documentDate,
        postingDate,
        status: "CALCULATED",
        isCalculated: true,
        // NIV → izvorni UL (traceback na dokument koji je pokrenuo uprosečavanje).
        linkedInboundDocId: opts.linkedInboundDocId ?? null,
        createdByUserId: opts.createdByUserId ?? null,
        stockLevelingItems: {
          create: [
            {
              itemId,
              warehouseId,
              quantityRevalued: stateQty.toDecimalPlaces(6),
              // Par stara → nova (osnov za valueAdjustment i istoriju revalorizacije).
              oldPurchaseNet: new D(staraValuacija.valuationPurchaseNet).toDecimalPlaces(PRICE_DP),
              newPurchaseNet: averaged.purchaseNet,
              oldDependentOwn: new D(staraValuacija.valuationDependentOwn).toDecimalPlaces(PRICE_DP),
              newDependentOwn: averaged.dependentOwn,
              oldDependentSupplier: new D(
                staraValuacija.valuationDependentSupplier,
              ).toDecimalPlaces(PRICE_DP),
              newDependentSupplier: averaged.dependentSupplier,
              oldWholesalePrice: oldVP.toDecimalPlaces(PRICE_DP),
              newWholesalePrice: newVP,
              oldRetailPrice: new D(staraValuacija.valuationRetailPrice).toDecimalPlaces(PRICE_DP),
              newRetailPrice: averaged.retailPrice,
              valueAdjustment,
              isPosted: false,
            },
          ],
        },
      },
      select: { id: true },
    });

    this.logger.debug(
      `NIV ${documentNumber} (doc ${nivDoc.id}): item=${itemId} wh=${warehouseId} ` +
        `staraVP=${oldVP.toFixed(4)} novaVP=${newVP.toFixed(4)} ` +
        `stanjeKol=${stateQty.toString()} valueAdjustment=${valueAdjustment.toFixed(4)}`,
    );

    return {
      itemId,
      warehouseId,
      outcome: "LEVELED",
      newWholesalePrice: newVP,
      levelingDocumentId: nivDoc.id,
      valueAdjustment,
    };
  }

  /**
   * Pogodna varijanta: resolvuje `stanjeKol` preko `CostingService.stateAsOf` pa delegira na
   * `applyLeveling`. „Koristi CostingService.stateAsOf" (doc 39 §C/§F). Zahteva da je `COSTING_SERVICE`
   * vezan u modulu; inače baca (programska greška vezivanja, ne poslovna).
   */
  async applyLevelingForInboundItem(
    tx: Prisma.TransactionClient,
    inboundItem: InboundLevelingItem,
    staraValuacija: OldValuation,
    opts: LevelingContext = {},
  ): Promise<LevelingResult> {
    if (!this.costing) {
      throw new Error(
        "NivelacijaService: COSTING_SERVICE nije vezan — prosledi stanjeKol preko applyLeveling().",
      );
    }
    const asOf = opts.documentDate ?? new Date();
    const stanjeKol = await this.costing.stateAsOf(
      inboundItem.itemId,
      inboundItem.warehouseId,
      asOf,
      tx,
    );
    return this.applyLeveling(tx, inboundItem, stanjeKol, staraValuacija, opts);
  }

  /**
   * Ponderisana dvočlana sredina: (qA*ceA + qB*ceB) / total. Total > 0 je garantovan pozivaocem
   * (stateQty > 0, inQty ≥ 0). Zaokruživanje na 4 decimale TEK na rezultatu (doc 39: 4 dec pri upisu).
   */
  private weightedAvg(
    qA: Prisma.Decimal,
    priceA: Prisma.Decimal | string | number,
    qB: Prisma.Decimal,
    priceB: Prisma.Decimal | string | number,
    total: Prisma.Decimal,
  ): Prisma.Decimal {
    const numerator = qA.times(new D(priceA)).plus(qB.times(new D(priceB)));
    return numerator.dividedBy(total).toDecimalPlaces(PRICE_DP);
  }

  /** Upiši/prepiši `ItemValuation` (upsert — 1:1 po itemId). */
  private async writeValuation(
    tx: Prisma.TransactionClient,
    itemId: number,
    v: AveragedValuation,
  ): Promise<void> {
    await tx.itemValuation.upsert({
      where: { itemId },
      create: {
        itemId,
        valuationPurchaseNet: v.purchaseNet,
        valuationDependentOwn: v.dependentOwn,
        valuationDependentSupplier: v.dependentSupplier,
        valuationWholesalePrice: v.wholesalePrice,
        valuationRetailPrice: v.retailPrice,
      },
      update: {
        valuationPurchaseNet: v.purchaseNet,
        valuationDependentOwn: v.dependentOwn,
        valuationDependentSupplier: v.dependentSupplier,
        valuationWholesalePrice: v.wholesalePrice,
        valuationRetailPrice: v.retailPrice,
      },
    });
  }

  /**
   * NIV broj `NNNN/god`. Ako je `NIV_NUMBERING` vezan → koristi zajednički numbering; inače fallback:
   * numerički MAX nad `stock_documents` za (kod, godina), pod advisory lock-om (obrazac
   * `nabavka/purchase-numbering.service.ts` — MAX u JS, ne string sort → '999' < '1000' bez tihih duplikata).
   */
  private async nextNivNumber(
    tx: Prisma.TransactionClient,
    documentTypeCode: string,
    year: number,
  ): Promise<string> {
    if (this.numbering) {
      return this.numbering.nextNivNumber(tx, documentTypeCode, year);
    }
    const suffix = `/${year}`;
    const lockKey = `robno:niv:${documentTypeCode}:${year}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const rows = await tx.stockDocument.findMany({
      where: { documentTypeCode, year, documentNumber: { endsWith: suffix } },
      select: { documentNumber: true },
    });
    let maxSeq = 0;
    for (const r of rows) {
      const raw = r.documentNumber.slice(0, -suffix.length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isNaN(n) && n > maxSeq) maxSeq = n;
    }
    return `${String(maxSeq + 1).padStart(4, "0")}${suffix}`;
  }
}

/** Kontekst NIV dokumenta (sve opciono — razumni default-i za poziv iz kalkulacije). */
export interface LevelingContext {
  companyId?: number;
  /** `DocumentType.code` za NIV vrstu (default `'NIV'`). */
  documentTypeCode?: string;
  documentDate?: Date;
  postingDate?: Date;
  year?: number;
  /** Izvorni `UL` `StockDocument.id` (traceback: NIV → ulaz koji ga je pokrenuo). */
  linkedInboundDocId?: number;
  createdByUserId?: number;
}
