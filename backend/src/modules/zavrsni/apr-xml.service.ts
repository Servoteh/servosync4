/**
 * APR XML SERVICE — APR eFI (FiForma) export završnog računa (Faza 7).
 * =========================================================================
 * Verbatim port BigBit VBA rutina `ZR_EksportXML_BS/BU/SI` (modul `ZR`) +
 * `XmlTag` helper (modul `ZRXML`) — _legacy/BigBit26/BigBit_APL_2010_ZR_code.txt
 * i BigBit_APL_2010_ZRXML_code.txt.
 *
 * Generiše XML u FiForma šemi koju APR eFI aplikacija učitava kao numerička /
 * tekstualna polja obrasca. Za svaku AOP liniju obračuna (FinancialStatementLine)
 * emituje `<a:NumerickoPolje>` po koloni:
 *
 *   <a:Naziv>aop-{aop}-{startColumn+n}</a:Naziv>          (n = 0..columnCount-1)
 *   <a:Vrednosti>Round(amount,0)</a:Vrednosti>            (ili i:nil="true" kad je 0)
 *
 * KOLONE PO OBRASCU (verbatim iz VBA — BrojKolona gating):
 *   BS (Bilans stanja)     — kolone 1/2/3  (Iznos_1/Iznos_2/Iznos_3)
 *   BU (Bilans uspeha)     — kolone 1/2    (Iznos_1/Iznos_2)
 *   SI (Statistički izv.)  — kolone 1/2/3
 *
 * i:nil="true" NA 0 (BigBit `XmlTag`): ako je Round(vrednost,0) == 0 ili null →
 * `<a:Vrednosti i:nil="true"/>`; inače `<a:Vrednosti>{Round(vrednost,0)}</a:Vrednosti>`.
 * Ovaj servis primenjuje `XmlTag` na SVE obrasce (task); BigBit ima istu logiku
 * doslovno samo na BS, a na BU/SI piše sirov `<a:Vrednosti>` — razlika je bezopasna
 * (nil vs. eksplicitna 0), a task traži konzistentno i:nil-na-0 ponašanje.
 *
 * TEKSTUALNA POLJA (verbatim iz VBA):
 *   BS/BU → <TekstualnaPoljaForme> sa <TekstualnoPolje> po liniji:
 *             <Naziv>aop-{aop}-{startColumn-1}</Naziv><Vrednosti></Vrednosti>
 *   SI    → prazno self-closed <TekstualnaPoljaForme/>
 *
 * NAMESPACE (verbatim):
 *   <FiForma xmlns="http://schemas.datacontract.org/2004/07/Domain.Model"
 *            xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
 *   <NumerickaPoljaForme xmlns:a="http://schemas.datacontract.org/2004/07/AppDef">
 *
 * ⚠️ StartnaKolona / BrojKolona (VBA `ZR_StavkeZaExport` iz `ZR_AOP_Modla`) NISU u
 * FinancialStatementLine modelu — ZR_AOP_Modla još nije seed-ovan (binaran u .MDB,
 * doc 37 §F; seed/balance-formulas.sql je rekonstrukcija bez tih kolona). Do tada:
 * columnCount = default po obrascu (BS=3, BU=2, SI=3), startColumn = default (3,
 * kao u VBA primeru `aop-9001-3`). TODO(zr-aop-modla): dodati `startColumn` i
 * `columnCount` na FinancialStatementLine (i BalanceFormulaDefinition) i puniti ih
 * iz ZR_AOP_Modla dump-a kad se seed-uje; tada čitati po liniji umesto default-a.
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2): iznosi su Prisma.Decimal; Round(x,0)
 * radi Decimal.toDecimalPlaces(0, ROUND_HALF_UP) — VBA `Round` je banker's rounding,
 * ali APR prima cele brojeve i HALF_UP je bezbedan/uobičajen izbor za valutu.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { STATEMENT_TYPE } from "./balance-sheet.service";

const D = Prisma.Decimal;

/** FiForma namespace-i (verbatim iz BigBit ZR_EksportXML_*). */
const NS_DOMAIN = "http://schemas.datacontract.org/2004/07/Domain.Model";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const NS_APPDEF = "http://schemas.datacontract.org/2004/07/AppDef";

/** Default StartnaKolona dok ZR_AOP_Modla nije seed-ovan (VBA primer: aop-9001-3). */
const DEFAULT_START_COLUMN = 3;

/**
 * Statički opis obrasca (Naziv + broj kolona) po statementType.
 * Naziv-evi su verbatim iz VBA (`<Naziv>Bilans stanja|Bilans uspeha|Statistički izveštaj</Naziv>`).
 * `emptyTextFields` = SI piše prazno self-closed <TekstualnaPoljaForme/> (VBA), BS/BU pun blok.
 */
interface FormSpec {
  naziv: string;
  columnCount: number;
  emptyTextFields: boolean;
}

const FORM_SPEC: Record<string, FormSpec> = {
  [STATEMENT_TYPE.BALANCE_SHEET]: {
    naziv: "Bilans stanja",
    columnCount: 3,
    emptyTextFields: false,
  },
  [STATEMENT_TYPE.INCOME_STATEMENT]: {
    naziv: "Bilans uspeha",
    columnCount: 2,
    emptyTextFields: false,
  },
  [STATEMENT_TYPE.POPDV_ANNUAL]: {
    naziv: "Statistički izveštaj",
    columnCount: 3,
    emptyTextFields: true,
  },
};

/** Obračun ne postoji ili nema poznat obrazac za APR export. */
export class AprXmlNotFoundException extends NotFoundException {
  readonly code = "ZR_STATEMENT_NOT_FOUND";
  constructor(statementId: number) {
    super(`FinancialStatement ${statementId} ne postoji.`);
    this.name = "AprXmlNotFoundException";
  }
}

/** Nepoznat/nepodržan tip obrasca za APR eFI export. */
export class AprXmlUnsupportedFormException extends NotFoundException {
  readonly code = "ZR_EXPORT_FORM_UNSUPPORTED";
  constructor(statementType: string) {
    super(
      `Tip obrasca "${statementType}" nema APR eFI FiForma definiciju (podržani: BS/BU/SI).`,
    );
    this.name = "AprXmlUnsupportedFormException";
  }
}

@Injectable()
export class AprXmlService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generiši APR eFI FiForma XML za sačuvani obračun (FinancialStatement).
   * @returns { xml, fileName, contentType } — kontroler prosleđuje kao download.
   */
  async exportFiForma(statementId: number): Promise<{
    xml: string;
    fileName: string;
    contentType: string;
  }> {
    const statement = await this.prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: { lines: { orderBy: { ordinal: "asc" } } },
    });

    if (!statement) {
      throw new AprXmlNotFoundException(statementId);
    }

    const spec = FORM_SPEC[statement.statementType];
    if (!spec) {
      throw new AprXmlUnsupportedFormException(statement.statementType);
    }

    const lines = statement.lines.map((l) => ({
      aop: l.aop,
      amount: l.amount instanceof D ? l.amount : new D(l.amount),
      // TODO(zr-aop-modla): kada model dobije startColumn, čitaj `l.startColumn ?? DEFAULT_START_COLUMN`.
      startColumn: DEFAULT_START_COLUMN,
    }));

    const xml = this.buildFiForma(spec, lines);

    // BS_2025.xml / BU_2025.xml / SI_2025.xml
    const shortCode = FORM_SHORT_CODE[statement.statementType] ?? "ZR";
    const fileName = `${shortCode}_${statement.periodYear}.xml`;

    return { xml, fileName, contentType: "text/xml; charset=utf-8" };
  }

  // ── interno: sastavljanje XML-a ─────────────────────────────────────────────

  /**
   * FiForma dokument: zaglavlje + NumerickaPoljaForme (jedno NumerickoPolje po
   * (linija × kolona)) + TekstualnaPoljaForme (BS/BU pun, SI prazan).
   * Struktura i redosled tačno po VBA `ZR_EksportXML_*`.
   */
  private buildFiForma(
    spec: FormSpec,
    lines: Array<{ aop: string; amount: Prisma.Decimal; startColumn: number }>,
  ): string {
    const parts: string[] = [];

    parts.push(
      `<FiForma xmlns="${NS_DOMAIN}" xmlns:i="${NS_XSI}">` +
        `<Naziv>${escapeXml(spec.naziv)}</Naziv>` +
        `<NumerickaPoljaForme xmlns:a="${NS_APPDEF}">`,
    );

    // Numerička polja: za svaku liniju emituj `columnCount` NumerickoPolje-a.
    // VBA emituje 1 iznos po koloni (Iznos_1/2/3); ovde je (rekonstruisano) jedan
    // `amount` po liniji → kolone iznad prve dobijaju istu vrednost. TODO kad model
    // dobije po-kolonu iznose, indeksiraj njih.
    for (const line of lines) {
      for (let n = 0; n < spec.columnCount; n++) {
        const naziv = `aop-${line.aop}-${line.startColumn + n}`;
        parts.push(
          `<a:NumerickoPolje>` +
            `<a:Naziv>${escapeXml(naziv)}</a:Naziv>` +
            xmlTag("a:Vrednosti", line.amount) +
            `</a:NumerickoPolje>`,
        );
      }
    }

    parts.push(`</NumerickaPoljaForme>`);

    // Tekstualna polja: BS/BU pun blok (prazna vrednost po liniji), SI self-closed.
    if (spec.emptyTextFields) {
      parts.push(`<TekstualnaPoljaForme/>`);
    } else {
      parts.push(`<TekstualnaPoljaForme>`);
      for (const line of lines) {
        const naziv = `aop-${line.aop}-${line.startColumn - 1}`;
        parts.push(
          `<TekstualnoPolje>` +
            `<Naziv>${escapeXml(naziv)}</Naziv>` +
            `<Vrednosti></Vrednosti>` +
            `</TekstualnoPolje>`,
        );
      }
      parts.push(`</TekstualnaPoljaForme>`);
    }

    parts.push(`</FiForma>`);

    return `<?xml version="1.0" encoding="utf-8"?>\n` + parts.join("\n");
  }
}

/** Kratke oznake obrasca za ime fajla. */
const FORM_SHORT_CODE: Record<string, string> = {
  [STATEMENT_TYPE.BALANCE_SHEET]: "BS",
  [STATEMENT_TYPE.INCOME_STATEMENT]: "BU",
  [STATEMENT_TYPE.POPDV_ANNUAL]: "SI",
};

/**
 * Port BigBit `XmlTag(tag, Vrednost)` (modul ZRXML):
 *   null ILI Round(Nz(Vrednost,0),0) == 0  →  <tag i:nil="true"/>
 *   inače                                  →  <tag>{Round(Vrednost,0)}</tag>
 * VBA piše `i:nil = "true"` (sa razmacima); ovde standardni `i:nil="true"`
 * (ekvivalentno po XML-u; APR parser čita atribut, ne bajt-po-bajt).
 */
function xmlTag(tag: string, value: Prisma.Decimal | null | undefined): string {
  const rounded =
    value == null ? new D(0) : value.toDecimalPlaces(0, D.ROUND_HALF_UP);
  if (rounded.isZero()) {
    return `<${tag} i:nil="true"/>`;
  }
  return `<${tag}>${rounded.toFixed(0)}</${tag}>`;
}

/** Minimalni XML escape za tekstualni sadržaj/atribute (AOP oznake su ASCII, ali branimo se). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
