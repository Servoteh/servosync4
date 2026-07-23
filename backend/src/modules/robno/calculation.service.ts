import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Dec, ZERO, dec, round, safeDiv } from "./decimal.util";
import { VAT_RATE_BY_CODE } from "../gl/posting/vat-rates";
import { NIVELACIJA_HOOK } from "./nivelacija.hook";
import type {
  NivelacijaHook,
  NivelacijaInboundLine,
} from "./nivelacija.hook";
import { computeKepuEntries, writeKepuEntries } from "./kepu-book.util";

/**
 * Kalkulacija landed cost robnog ULAZA (doc 39 §A: `SracunajKalkulaciju`).
 *
 * `calculate(docId)` po stavci računa:
 *   • `purchasePriceNet` (A) = Fakturna − Rabat − Kasa (domaći ulaz),
 *   • raspodelu zavisnih troškova (B = ZTsop, C = ZTdob),
 *   • `KalkVP` = A + B + C + RuC + Akciza, `KalkMP` = Taksa + FiksniPorez + KalkVP*(1 + ΣStopa/100),
 *   • `RuC` (markupAmount) = KalkVP − A − B − C − Akciza (0 kad je Mag.VP = Nab, doc 39 §B).
 *
 * UVOZ (`isImport=true`, doc 39 §A `Module__UVOZ`): raspodela doc-level ZT po `DevNabCena`
 * (fxPurchasePrice) — ključ `DevNabCena/DevVredFak`, `CarKurs` za carinsku osnovicu, `ObrKurs`
 * za knjigovodstvenu nabavnu (razlika kurseva → ZTsop). Tako da `A + B + C = brutonabcena`.
 *
 * Sve u jednoj `$transaction`, `Prisma.Decimal`, zaokruživanje na 4 decimale tek pri upisu.
 * Status DRAFT → CALCULATED. Na kraju ULAZA poziva `NivelacijaHook` (uprosečavanje, doc 39 §F) —
 * hook je injektovan preko DI porta (BEZ tvrdog importa `NivelacijaService`); ako nije registrovan,
 * ostaje jasan `TODO` trag u logu i kalkulacija se ipak kompletira.
 */
@Injectable()
export class CalculationService {
  private readonly logger = new Logger(CalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(NIVELACIJA_HOOK)
    private readonly nivelacija?: NivelacijaHook,
  ) {}

  /**
   * Izračunaj landed cost svih stavki dokumenta i pređi u status CALCULATED.
   * Dozvoljava kalkulaciju samo iz DRAFT (CALCULATED/POSTED/LOCKED → 409).
   */
  async calculate(docId: number) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockDocument.findUnique({
        where: { id: docId },
        include: { items: { orderBy: { id: "asc" } } },
      });
      if (!doc)
        throw new NotFoundException(`Robni dokument ${docId} ne postoji.`);
      if (doc.status !== "DRAFT")
        throw new ConflictException(
          `Kalkulacija je moguća samo za dokument u statusu DRAFT (trenutno: ${doc.status}).`,
        );
      if (doc.items.length === 0)
        throw new UnprocessableEntityException(
          "Dokument nema stavke — nema šta da se kalkuliše.",
        );

      const isImport = doc.isImport === true;

      // ── UVOZ: doc-level ZT raspodela po vrednosti stavke (DevNabCena*kol) ──
      // Doc-level zavisni troškovi (carina + špedicija + ostalo) raspoređeni proporcionalno
      // vrednosti stavke (DevNabCena*kol) — odluka §Odluke T1. Imenilac = Σ(DevNabCena*kol).
      const docLevelDependent = doc.customs
        .add(doc.forwarding)
        .add(doc.otherDependentCosts);
      let fxBasisTotal = ZERO;
      if (isImport) {
        for (const it of doc.items) {
          fxBasisTotal = fxBasisTotal.add(it.fxPurchasePrice.mul(it.quantity));
        }
      }

      const nivLines: NivelacijaInboundLine[] = [];

      // Keš poreske stope po kodu (ΣStopa %) — jedan `tax_rates` lookup po kodu za ceo dokument.
      const taxRateCache = new Map<string, Dec>();

      for (const it of doc.items) {
        const quantity: Dec = it.quantity;

        let purchasePriceNet: Dec; // A
        let dependentCostOwn: Dec; // B
        let dependentCostSupplier: Dec; // C

        if (isImport) {
          // ── UVOZ (doc 39 §A: Module__UVOZ, ključ DevNabCena/DevVredFak) ──
          const devNabCena: Dec = it.fxPurchasePrice;
          const devVredFak: Dec | null = doc.fxInvoiceValue.isZero()
            ? null
            : doc.fxInvoiceValue;

          // carinska osnovica/JM = DevNabCena*CarKurs + (PovCarOsn/DevVredFak)*DevNabCena
          const povCarOsnTerm = devVredFak
            ? doc.customsRefundBase.div(devVredFak).mul(devNabCena)
            : ZERO;
          const carOsnJm = devNabCena
            .mul(doc.customsExchangeRate)
            .add(povCarOsnTerm);
          // carinajm = carosnjm * (CarStopa/100)
          const carinaJm = carOsnJm.mul(it.customsRate.div(100));

          // knjigovodstvena nabavna/JM (ObrKurs) — bez carine → A.
          const nabKnjJm = devNabCena.mul(doc.accountingExchangeRate);
          purchasePriceNet = nabKnjJm;

          // ZTdob (C) = doc-level zavisni trošak raspoređen po vrednosti stavke, po JM.
          let ztDobPerUnit = ZERO;
          if (!fxBasisTotal.isZero() && !docLevelDependent.isZero()) {
            const lineBasis = devNabCena.mul(quantity);
            const share = docLevelDependent.mul(safeDiv(lineBasis, fxBasisTotal));
            ztDobPerUnit = safeDiv(share, quantity);
          }
          // Carina/JM + pozitivna kursna razlika (CarKurs−ObrKurs)*DevNabCena → ZTsop (B).
          const kursnaRazlika = devNabCena
            .mul(doc.customsExchangeRate)
            .sub(nabKnjJm);
          dependentCostOwn = it.dependentCostOwn
            .add(carinaJm)
            .add(kursnaRazlika.isNegative() ? ZERO : kursnaRazlika);
          dependentCostSupplier = it.dependentCostSupplier.add(ztDobPerUnit);
          // Invarijanta doc 39 §A (brutonabcena): A + B + C = pun landed cost/JM.
        } else {
          // ── DOMAĆA kaskada (doc 39 §A: NabNeto = Fakturna − Rabat − Kasa) ──
          const fakturna: Dec = it.invoicePrice;
          const rabat = fakturna.mul(it.discountPercent.div(100));
          const posleRabata = fakturna.sub(rabat);
          const kasa = posleRabata.mul(it.cashDiscountPercent.div(100));
          purchasePriceNet = posleRabata.sub(kasa); // A

          dependentCostOwn = it.dependentCostOwn; // B (uneto po stavci)
          dependentCostSupplier = it.dependentCostSupplier; // C
        }

        const excise: Dec = it.excise; // Akciza
        const fee: Dec = it.fee; // Taksa
        const fixedTax: Dec = it.fixedTax; // FiksniPorez
        const ruc: Dec = it.markupAmount; // RuC (unesena marža; 0 kad Mag.VP=Nab)

        // KalkVP = A + B + C + RuC + Akciza (doc 39 §A)
        const kalkVP = purchasePriceNet
          .add(dependentCostOwn)
          .add(dependentCostSupplier)
          .add(ruc)
          .add(excise);

        // KalkMP = Taksa + FiksniPorez + KalkVP*(1 + ΣStopa/100) (doc 39 §A)
        let taxRatePct = taxRateCache.get(it.goodsTaxRateCode);
        if (taxRatePct === undefined) {
          taxRatePct = await this.taxRateOf(
            tx,
            it.goodsTaxRateCode,
            doc.documentDate,
          );
          taxRateCache.set(it.goodsTaxRateCode, taxRatePct);
        }
        const kalkMP = fee
          .add(fixedTax)
          .add(kalkVP.mul(dec(1).add(taxRatePct.div(100))));

        // markupAmount (RuC) po definiciji: KalkVP − A − B − C − Akciza (doc 39 §A).
        // Za ukalkulisanu robu (Mag.VP=Nab) operater ne unosi maržu → RuC = 0.
        const rucCalc = kalkVP
          .sub(purchasePriceNet)
          .sub(dependentCostOwn)
          .sub(dependentCostSupplier)
          .sub(excise);

        await tx.stockDocumentItem.update({
          where: { id: it.id },
          data: {
            purchasePriceNet: round(purchasePriceNet),
            dependentCostOwn: round(dependentCostOwn),
            dependentCostSupplier: round(dependentCostSupplier),
            calculatedWholesalePrice: round(kalkVP),
            calculatedRetailPrice: round(kalkMP),
            markupAmount: round(rucCalc),
          },
        });

        nivLines.push({
          itemId: it.itemId,
          warehouseId: it.warehouseId,
          quantity,
          purchasePriceNet: round(purchasePriceNet),
          dependentCostOwn: round(dependentCostOwn),
          dependentCostSupplier: round(dependentCostSupplier),
          calculatedWholesalePrice: round(kalkVP),
          calculatedRetailPrice: round(kalkMP),
        });
      }

      const updated = await tx.stockDocument.update({
        where: { id: docId },
        data: { status: "CALCULATED", isCalculated: true },
        include: { items: { orderBy: { id: "asc" } } },
      });

      // ── AUTO nivelacija (uprosečavanje) SAMO za ULAZ (doc 39 §F) ──
      // UL je jedini kind koji zadužuje magacin novom cenom → jedini koji uprosečava valuaciju.
      if (doc.kind === "UL") {
        if (this.nivelacija) {
          await this.nivelacija.applyForInbound(
            tx,
            docId,
            doc.documentDate,
            nivLines,
          );
        } else {
          // TODO(nivelacija): NivelacijaService još nije registrovan pod NIVELACIJA_HOOK.
          // Kad se doda (provider { provide: NIVELACIJA_HOOK, useExisting: NivelacijaService }),
          // ovaj ulaz će uprosečiti ItemValuation i kreirati NIV dokument razlike (doc 39 §F).
          this.logger.warn(
            `TODO(nivelacija): ulaz ${docId} kalkulisan, ali NivelacijaHook nije registrovan — ` +
              `ItemValuation NIJE uprosečen. Registruj NivelacijaService pod NIVELACIJA_HOOK.`,
          );
        }

        // ── KEPU zaduženje (maloprodajna knjiga) — SAMO za ULAZ (doc 39 §E, task D5be) ──
        // MagUlaz = Σ Kol × KalkMP (maloprodajna/prodajna vrednost — v. kepu-book.util za izbor MP vs VP).
        // Smer se čita iz DocumentType.kepuDefault* (default po tipu), fallback na kind (UL → zaduženje).
        // Idempotentno po documentId (delete+insert) — ponovni calculate ne duplira KEPU red.
        const kepuDocType = await tx.documentType.findFirst({
          where: { code: doc.documentTypeCode },
          select: { kepuDefaultCharge: true, kepuDefaultDischarge: true },
        });
        const kepuEntries = computeKepuEntries(
          updated,
          updated.items,
          [],
          kepuDocType,
        );
        await writeKepuEntries(tx, docId, kepuEntries);
      }

      return updated;
    });
  }

  /**
   * Zbir poreskih stopa (%) za `KalkMP` (`ΣStopa/100`, doc 39 §A) po `goodsTaxRateCode` i datumu
   * dokumenta (C8). Prioritet:
   *   1) `tax_rates` (model `TaxRate`) — red gde je kod jednak i datum u opsegu `validFrom..validTo`
   *      (null = otvoreno). `ΣStopa` = baseRate+railwayRate+cityRate+warRate+specialRate (procenti);
   *      najnoviji `validFrom` pobeđuje kad ima više redova.
   *   2) Fallback (nema reda) — deljena mapa `VAT_RATE_BY_CODE` (razlomak 0.20/0.10/0.08) × 100
   *      → procenat (20/10/8). Jedan izvor stope sa GL kontiranjem (posting.service, C8).
   * Vraća PROCENAT (npr. 20 za PDV 20%), jer `KalkMP` formula deli sa 100.
   */
  private async taxRateOf(
    tx: Prisma.TransactionClient,
    goodsTaxRateCode: string,
    asOf: Date,
  ): Promise<Dec> {
    const row = await tx.taxRate.findFirst({
      where: {
        code: goodsTaxRateCode,
        OR: [{ validFrom: null }, { validFrom: { lte: asOf } }],
        AND: [{ OR: [{ validTo: null }, { validTo: { gte: asOf } }] }],
      },
      orderBy: [{ validFrom: "desc" }],
    });
    if (row) {
      // ΣStopa (%) — zbir svih poreskih komponenti tarife (legacy R_Tarife, doc 39 §A / 43 §4).
      return dec(row.baseRate ?? 0)
        .add(row.railwayRate ?? 0)
        .add(row.cityRate ?? 0)
        .add(row.warRate ?? 0)
        .add(row.specialRate ?? 0);
    }
    // Fallback: deljena mapa (razlomak) → procenat. Nepoznat kod → 0 (bez PDV u KalkMP).
    const fraction = VAT_RATE_BY_CODE[goodsTaxRateCode] ?? ZERO;
    return dec(fraction).mul(100);
  }
}
