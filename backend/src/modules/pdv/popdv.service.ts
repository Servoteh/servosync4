/**
 * POPDV SERVICE — obračun PDV prijave za period (Faza 6 §B).
 * =========================================================================
 * POPDV obrazac je DEKLARATIVAN (doc 18 §3.3): tabela `popdv_definitions`
 * (seed = 287 reda iz BB_POPDV_T.mdb) nosi za svaki AOP polje ILI direktnu
 * vrednost ILI formulu (`KxDef`) koja se evaluira nad drugim AOP-ovima /
 * PDV kontima. Engine: učitaj definiciju → evaluiraj formule → agregacija.
 *
 * FORMULA EVAL — DVE VRSTE (seed BB_T_26):
 *   1) AGREGACIJA drugih AOP: `1.5K1 = [1.1K1]+[1.2K1]+[1.3K1]+[1.4K1]`.
 *      Reference `[AOP]` se rekurzivno razrešavaju do vrednosti, pa se izraz
 *      evaluira Faza-1 safe parserom (`evaluateExpression` + Decimal adapter).
 *   2) SELF-REFERENCE — `formula = "[isti aop]"` (npr. aop="8а.2DAK1",
 *      formula="[8а.2DAK1]"). To NIJE ciklus — marker je da se AOP puni iz
 *      KONTO→AOP mapiranja (`popdv_account_map`, seed POPDV_SemeKontaZaKnjizenje):
 *      Σ salda konta mapiranih na taj AOP. AOP = popdvMark + "K" + columnIndex;
 *      za svaki (account, columnDef) uzmi saldo konta iz ledger_entries za period
 *      (D=Σdebit, P=Σcredit, "D/0.2"=Σdebit/0.2 = osnovica pri 20%), saberi.
 *      AOP koji nema mapiranje = 0 (nije još uknjižen konto).
 *   Reference se porede uz latin↔ćirilica normalizaciju (8a↔8а, 8e↔8е).
 *
 * OSNOVNI OBRAČUN (uvek radi, i kad je definicija tabela prazna):
 *   outputVat = Σ izlazni PDV konta (VatAccountMap direction='output': 4700/4702/4710…)
 *   inputVat  = Σ ulazni PDV konta  (VatAccountMap direction='input':  2700/2710…)
 *   vatLiability = outputVat − inputVat  (obaveza za uplatu / povraćaj)
 *   → kreira VatReturn zaglavlje. Ostaje kao fallback i kad self-ref punjenje
 *     nije potpuno pokriveno mapiranjem.
 *
 * Idempotentno po periodu: postojeći VatReturn za (godina, mesec/kvartal) se
 * ažurira (linije se rekreiraju), ne duplira (uq_vat_returns_period).
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { evaluateExpression } from "../gl/posting/expression-parser";
import { prismaDecimalArith } from "../gl/posting/prisma-decimal-arith";
import { InvalidVatPeriodException } from "./vat-ledger.service";
import {
  assertVatPeriodNotLocked,
  VAT_RETURN_CALCULATED,
  VAT_RETURN_POSTED,
} from "./vat-period-lock";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Saldo konta za period: Σdebit (D) i Σcredit (P) proknjiženih stavki. */
interface AccountBalance {
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/** Red iz popdv_account_map — kako se puni jedna AOP kolona iz salda konta. */
interface AccountMapRow {
  account: string;
  popdvMark: string;
  columnDef: string;
  columnIndex: number;
}

/**
 * Normalizuje AOP oznaku za poređenje: trim + latin↔ćirilica homoglifi na
 * jedan oblik (agent našao nesklad 8a↔8а, 8e↔8е između seed-a i formula). Mapira
 * ćirilične homoglife (а е о с р) na latinicu — poređenje AOP referenci postaje
 * otporno na izvorno mešanje pisama; ostali znakovi (cifre, K, tačka) ostaju.
 */
function normalizeAop(aop: string): string {
  const CYR_TO_LAT: Record<string, string> = {
    а: "a", // U+0430 → a
    е: "e", // U+0435 → e
    о: "o", // U+043E → o
    с: "c", // U+0441 → c
    р: "p", // U+0440 → p
    А: "A",
    Е: "E",
    О: "O",
    С: "C",
    Р: "P",
  };
  let out = "";
  for (const ch of aop.trim()) out += CYR_TO_LAT[ch] ?? ch;
  return out;
}

/**
 * Legacy VBA poziv u POPDV formuli: identifikator (slovo/_ pa slova/cifre/_)
 * neposredno pred "(". Npr. `POPDV_VredZaPDVOznaku5_3(…)`, `iif(…)`. Safe
 * aritmetički parser ovo ne podržava → tretiramo AOP kao neuvezan (0).
 */
const LEGACY_CALL_RE = /[\p{L}_][\p{L}\p{N}_]*\s*\(/u;

/**
 * Self-reference marker: formula je tačno "[isti aop]" (uz normalizaciju pisma).
 * To znači „ovaj AOP se puni iz konto→AOP mape", NE ciklus i NE agregacija.
 */
function isSelfRef(formula: string, aop: string): boolean {
  const f = formula.trim();
  if (!f.startsWith("[") || !f.endsWith("]")) return false;
  const inner = f.slice(1, -1);
  return normalizeAop(inner) === normalizeAop(aop);
}

/** Ulaz obračuna: mesec (1..12) ILI kvartal (1..4), tačno jedan. */
export interface ComputePopdvInput {
  year: number;
  month?: number; // mesečni obveznik
  quarter?: number; // kvartalni obveznik
}

/** Rezultat obračuna (zaglavlje + linije). */
export interface PopdvResult {
  vatReturnId: number;
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  outputVat: Prisma.Decimal;
  inputVat: Prisma.Decimal;
  vatLiability: Prisma.Decimal;
  lineCount: number;
  seededDefinition: boolean; // true = pun POPDV (linije iz popdv_definitions)
  note: string;
}

interface VatSumRow {
  direction: string;
  vat_amount: Prisma.Decimal | null;
}

@Injectable()
export class PopdvService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obračun PDV za period. Vraća zaglavlje (output/input/obaveza) + linije po
   * AOP-u (ako je `popdv_definitions` seed-ovana). Osnovni obračun radi uvek.
   */
  async compute(input: ComputePopdvInput): Promise<PopdvResult> {
    const { year } = input;
    const { month, quarter } = this.resolvePeriod(input);

    // Meseci koji čine period (mesec = [m]; kvartal = 3 meseca).
    const months = this.periodMonths(month, quarter);

    // D3: prekomputiranje zaključanog (POSTED) perioda nije dozvoljeno.
    await assertVatPeriodNotLocked(this.prisma, year, months);

    // 1) Osnovni obračun — Σ PDV konta iz GK po smeru za period.
    const gk = await this.sumVatAccounts(year, months);

    // 1b) RUČNE KIF/KUF stavke (D4, sourceJournalEntryId=null) — review 1D nalaz.
    //     Ručne stavke NEMAJU nalog u GK, pa ih sumVatAccounts NE vidi, a PP-PDV
    //     štampa ih VEĆ prikazuje u pozicijama po stopama (003/103, 004/104 iz
    //     sumByRate nad vat_ledger_entries UKLJUČUJUĆI ručne). Bez ovog dodavanja
    //     VatReturn.output/input (ukupno 005/105) i obaveza (109) bili bi manji od
    //     Σ po stopama → obrazac interno nekonzistentan i obaveza potcenjena.
    //     PAZI: GK-izvedene stavke (source != null) se NE sabiraju — one su već u
    //     sumVatAccounts (izvedene iz istih ledger_entries) → dupliranje bi precenilo.
    const manual = await this.sumManualVatEntries(year, months);
    const outputVat = gk.outputVat.add(manual.manualOutput);
    const inputVat = gk.inputVat.add(manual.manualInput);
    const vatLiability = outputVat.sub(inputVat);

    // 2) Pun POPDV (ako je definicija seed-ovana) — eval AOP formula.
    const definitions = await this.prisma.popdvDefinition.findMany({
      orderBy: { ordinal: "asc" },
    });
    const seeded = definitions.length > 0;

    // Konto→AOP mapiranje (self-ref punjenje) + saldo konta za period.
    // Učitavamo samo kad ima definicija (inače se ne koristi).
    const accountMap = seeded
      ? await this.prisma.popdvAccountMap.findMany()
      : [];
    const accountBalances = seeded
      ? await this.sumAccountBalances(year, months)
      : new Map<string, AccountBalance>();

    return this.prisma.$transaction(async (tx) => {
      // Upsert zaglavlja po periodu (idempotentno; uq_vat_returns_period).
      const existing = await tx.vatReturn.findFirst({
        where: {
          periodYear: year,
          periodMonth: month ?? null,
          periodQuarter: quarter ?? null,
        },
      });

      const returnData = {
        periodYear: year,
        periodMonth: month ?? null,
        periodQuarter: quarter ?? null,
        status: "CALCULATED",
        outputVat,
        inputVat,
        vatLiability,
      };

      let vatReturn;
      if (existing) {
        await tx.vatReturnLine.deleteMany({
          where: { vatReturnId: existing.id },
        });
        vatReturn = await tx.vatReturn.update({
          where: { id: existing.id },
          data: returnData,
        });
      } else {
        vatReturn = await tx.vatReturn.create({ data: returnData });
      }

      // POPDV linije — samo ako je definicija seed-ovana.
      let lineCount = 0;
      let unsupportedCount = 0;
      if (seeded) {
        const evalResult = this.evaluateDefinitions(
          definitions,
          outputVat,
          inputVat,
          accountMap,
          accountBalances,
        );
        const aopValues = evalResult.values;
        unsupportedCount = evalResult.unsupportedCount;
        const lines: Prisma.VatReturnLineCreateManyInput[] = definitions.map(
          (def) => ({
            vatReturnId: vatReturn.id,
            aop: def.aop,
            amount: aopValues.get(def.aop) ?? ZERO,
          }),
        );
        if (lines.length > 0) {
          await tx.vatReturnLine.createMany({ data: lines });
          lineCount = lines.length;
        }
      }

      const note = seeded
        ? `Pun POPDV obračun: ${lineCount} AOP linija iz popdv_definitions ` +
          `(self-ref AOP punjeni iz ${accountMap.length} konto→AOP mapiranja` +
          (unsupportedCount > 0
            ? `; ${unsupportedCount} AOP sa legacy formulom = 0, fallback na osnovni obračun`
            : "") +
          ")."
        : "Osnovni obračun (Σ izlazni PDV − Σ ulazni PDV). Pun POPDV " +
          "traži seed popdv_definitions — nije još učitan.";

      return {
        vatReturnId: vatReturn.id,
        periodYear: year,
        periodMonth: month ?? null,
        periodQuarter: quarter ?? null,
        outputVat,
        inputVat,
        vatLiability,
        lineCount,
        seededDefinition: seeded,
        note,
      };
    });
  }

  /** Lista sačuvanih PDV obračuna (opciono filter po godini). */
  async listReturns(year?: number) {
    return this.prisma.vatReturn.findMany({
      where: year != null ? { periodYear: year } : undefined,
      orderBy: [
        { periodYear: "desc" },
        { periodQuarter: "desc" },
        { periodMonth: "desc" },
      ],
      include: { lines: { orderBy: { aop: "asc" } } },
    });
  }

  /**
   * Zaključaj (proknjiži) PDV obračun: status CALCULATED → POSTED (D3). Posle
   * ovoga je period zaključan — `buildKifKuf`, ponovni `compute` i izmena ručnih
   * KIF/KUF stavki tog perioda se odbijaju (vidi `assertVatPeriodNotLocked`).
   *
   * CAS (compare-and-set) `updateMany where {id, status: CALCULATED}` — atomsko
   * prebacivanje bez trke; count = 0 znači da obračun nije u očekivanom stanju.
   */
  async postReturn(id: number) {
    const existing = await this.prisma.vatReturn.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`PDV obračun #${id} ne postoji.`);
    }
    if (existing.status === VAT_RETURN_POSTED) {
      throw new ConflictException(`PDV obračun #${id} je već proknjižen (POSTED).`);
    }
    if (existing.status !== VAT_RETURN_CALCULATED) {
      throw new ConflictException(
        `PDV obračun #${id} nije u statusu ${VAT_RETURN_CALCULATED} ` +
          `(trenutno ${existing.status}); knjiženje/zaključavanje nije moguće.`,
      );
    }

    const res = await this.prisma.vatReturn.updateMany({
      where: { id, status: VAT_RETURN_CALCULATED },
      data: { status: VAT_RETURN_POSTED },
    });
    if (res.count === 0) {
      // Status je promenjen između čitanja i upisa (paralelna sesija).
      throw new ConflictException(
        `PDV obračun #${id} je u međuvremenu promenjen; osveži pa pokušaj ponovo.`,
      );
    }

    return this.prisma.vatReturn.findUniqueOrThrow({
      where: { id },
      include: { lines: { orderBy: { aop: "asc" } } },
    });
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Σ PDV konta iz glavne knjige po smeru za period (osnovni obračun).
   *   output = Σ(kredit − debit) na 'output' kontima (47x — obaveza)
   *   input  = Σ(debit − kredit) na 'input'  kontima (27x — pretporez)
   * Samo proknjižen nalog (status = 'posted'), period po posting_date.
   */
  private async sumVatAccounts(
    year: number,
    months: number[],
  ): Promise<{ outputVat: Prisma.Decimal; inputVat: Prisma.Decimal }> {
    const rows = await this.prisma.$queryRaw<VatSumRow[]>(
      Prisma.sql`
        SELECT
          vam.direction AS direction,
          CASE
            WHEN vam.direction = 'output'
              THEN COALESCE(SUM(le.credit) - SUM(le.debit), 0)
            ELSE COALESCE(SUM(le.debit) - SUM(le.credit), 0)
          END AS vat_amount
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN vat_account_map vam ON vam.account = le.account_code
        WHERE je.status = 'posted'
          AND EXTRACT(YEAR FROM je.posting_date) = ${year}
          AND EXTRACT(MONTH FROM je.posting_date) IN (${Prisma.join(months)})
        GROUP BY vam.direction
      `,
    );

    let outputVat = ZERO;
    let inputVat = ZERO;
    for (const r of rows) {
      const v = new D(r.vat_amount ?? ZERO);
      if (r.direction === "output") outputVat = outputVat.add(v);
      else inputVat = inputVat.add(v);
    }
    return { outputVat, inputVat };
  }

  /**
   * Σ RUČNIH KIF/KUF stavki (`vat_ledger_entries` sa `sourceJournalEntryId=null`)
   * po smeru za period (review 1D nalaz — konzistentnost sa knjigom i PP-PDV štampom).
   *   output (KIF) → Σ vatAmount ide u outputVat (obaveza)
   *   input  (KUF) → Σ vatAmount ide u inputVat  (pretporez)
   * Period filter je ISTI kao u `buildKifKuf`/`sumByRate`: `taxPeriodYear = year` i
   * `taxPeriodMonth IN months` (mesec = [m]; kvartal = 3 meseca) — ne po posting_date,
   * jer ručna stavka nema nalog nego eksplicitan poreski period.
   * GK-izvedene stavke (`sourceJournalEntryId != null`) se NAMERNO izostavljaju —
   * već su obuhvaćene `sumVatAccounts` (Σ PDV konta iz GK).
   */
  private async sumManualVatEntries(
    year: number,
    months: number[],
  ): Promise<{ manualOutput: Prisma.Decimal; manualInput: Prisma.Decimal }> {
    let manualOutput = ZERO;
    let manualInput = ZERO;
    if (months.length === 0) return { manualOutput, manualInput };

    const grouped = await this.prisma.vatLedgerEntry.groupBy({
      by: ["direction"],
      where: {
        sourceJournalEntryId: null,
        taxPeriodYear: year,
        taxPeriodMonth: { in: months },
      },
      _sum: { vatAmount: true },
    });
    for (const g of grouped) {
      const v = new D(g._sum.vatAmount ?? ZERO);
      if (g.direction === "output") manualOutput = manualOutput.add(v);
      else manualInput = manualInput.add(v);
    }
    return { manualOutput, manualInput };
  }

  /**
   * Saldo (Σdebit, Σcredit) po kontu za period — proknjižene stavke (posted),
   * period po posting_date. Koristi se za self-ref AOP punjenje: columnDef
   * "D"/"P"/"D/0.2"… se evaluira nad ovim saldom.
   * Ključ mape = account_code; nedostajući konto = saldo 0 (nije uknjižen).
   */
  private async sumAccountBalances(
    year: number,
    months: number[],
  ): Promise<Map<string, AccountBalance>> {
    const rows = await this.prisma.$queryRaw<
      {
        account_code: string;
        debit: Prisma.Decimal | null;
        credit: Prisma.Decimal | null;
      }[]
    >(
      Prisma.sql`
        SELECT
          le.account_code AS account_code,
          COALESCE(SUM(le.debit), 0)  AS debit,
          COALESCE(SUM(le.credit), 0) AS credit
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        WHERE je.status = 'posted'
          AND EXTRACT(YEAR FROM je.posting_date) = ${year}
          AND EXTRACT(MONTH FROM je.posting_date) IN (${Prisma.join(months)})
        GROUP BY le.account_code
      `,
    );
    const map = new Map<string, AccountBalance>();
    for (const r of rows) {
      map.set(r.account_code, {
        debit: new D(r.debit ?? ZERO),
        credit: new D(r.credit ?? ZERO),
      });
    }
    return map;
  }

  /**
   * Evaluira sve AOP definicije. Tri slučaja formule:
   *   - SELF-REFERENCE (`formula = "[isti aop]"`) → punjenje iz konto→AOP mape
   *     (`accountMap`), NIJE ciklus. Vrednost = Σ po (account, columnDef) za taj
   *     AOP nad saldom konta iz `balances`.
   *   - AGREGACIJA (`[A]+[B]…`) → rekurzivno razreši reference (uz detekciju
   *     stvarnog ciklusa) i evaluiraj Faza-1 parserom.
   *   - NEPODRŽANA (legacy VBA poziv: `POPDV_Vred…(…)`, `iif(…)`) → 0 (nije
   *     uvezano); AOP se broji u `unsupported`, NE obara ceo obračun (fallback).
   * Direktna vrednost (formula=null) = 0. Markere [OUTPUT]/[INPUT] puni osnovni
   * obračun ako ih formula referiše.
   */
  private evaluateDefinitions(
    definitions: { aop: string; formula: string | null }[],
    outputVat: Prisma.Decimal,
    inputVat: Prisma.Decimal,
    accountMap: AccountMapRow[],
    balances: Map<string, AccountBalance>,
  ): { values: Map<string, Prisma.Decimal>; unsupportedCount: number } {
    // AOP-ovi čije formule safe parser ne podržava (legacy VBA pozivi) — 0.
    const unsupported = new Set<string>();

    // Definicije po NORMALIZOVANOM AOP-u — reference u formulama i seed AOP mogu
    // mešati pismo (8a↔8а); normalizacija oba oblika ih poravnava.
    const byAop = new Map<string, string | null>();
    for (const d of definitions) byAop.set(normalizeAop(d.aop), d.formula);

    // Indeks konto→AOP po normalizovanom AOP-u (popdvMark + "K" + columnIndex).
    const mapByAop = new Map<string, AccountMapRow[]>();
    for (const row of accountMap) {
      const aopKey = normalizeAop(`${row.popdvMark}K${row.columnIndex}`);
      const list = mapByAop.get(aopKey);
      if (list) list.push(row);
      else mapByAop.set(aopKey, [row]);
    }

    const resolved = new Map<string, Prisma.Decimal>();
    const inProgress = new Set<string>();

    // Rezultat po ORIGINALNOM aop-u (za linije), interno razrešava po normi.
    const resolveNorm = (normAop: string): Prisma.Decimal => {
      if (resolved.has(normAop)) return resolved.get(normAop)!;
      if (inProgress.has(normAop)) {
        throw new PopdvCycleException(normAop);
      }
      inProgress.add(normAop);

      const formula = byAop.get(normAop) ?? null;
      let value: Prisma.Decimal;
      if (formula == null || formula.trim() === "") {
        // Direktna vrednost — bez POPDV punjenja je 0.
        value = ZERO;
      } else if (isSelfRef(formula, normAop)) {
        // Self-ref: NIJE ciklus — puni se iz konto→AOP mape (Σ salda konta).
        value = this.evalSelfRefAop(normAop, mapByAop, balances);
      } else {
        value = this.evalFormula(
          formula,
          (ref) => resolveNorm(normalizeAop(ref)),
          outputVat,
          inputVat,
          normAop,
          unsupported,
        );
      }

      inProgress.delete(normAop);
      resolved.set(normAop, value);
      return value;
    };

    // Vrati mapu po ORIGINALNOM aop-u (compute() puni linije po def.aop).
    const out = new Map<string, Prisma.Decimal>();
    for (const d of definitions) {
      out.set(d.aop, resolveNorm(normalizeAop(d.aop)));
    }
    return { values: out, unsupportedCount: unsupported.size };
  }

  /**
   * Puni self-ref AOP iz konto→AOP mape: za svaki mapiran (account, columnDef)
   * uzmi saldo konta (D=Σdebit, P=Σcredit) za period i evaluiraj columnDef
   * (npr. "D/0.2" = Σdebit/0.2 = osnovica). Sabira po svim kontima tog AOP-a.
   * AOP bez mapiranja = 0.
   */
  private evalSelfRefAop(
    aop: string,
    mapByAop: Map<string, AccountMapRow[]>,
    balances: Map<string, AccountBalance>,
  ): Prisma.Decimal {
    const rows = mapByAop.get(normalizeAop(aop));
    if (!rows || rows.length === 0) return ZERO;

    let sum = ZERO;
    for (const row of rows) {
      const bal = balances.get(row.account) ?? { debit: ZERO, credit: ZERO };
      sum = sum.add(this.evalColumnDef(row.columnDef, bal, aop));
    }
    return sum;
  }

  /**
   * Evaluira columnDef izraz (npr. "D", "P", "D/0.2", "+P") nad saldom konta.
   * D→Σdebit, P→Σcredit; ostatak (/ brojevi + −) ide kroz Faza-1 safe parser.
   * Vodeći "+" (npr. "+P") se ignoriše (parser ionako podržava unarni +).
   */
  private evalColumnDef(
    columnDef: string,
    balance: AccountBalance,
    aop: string,
  ): Prisma.Decimal {
    const expr = columnDef.trim();
    if (expr === "") return ZERO;
    try {
      // Promenljive parsera su jednoslovne A–Z; D i P su već slova → direktno.
      return evaluateExpression<Prisma.Decimal>(
        expr,
        { D: balance.debit, P: balance.credit },
        prismaDecimalArith,
      );
    } catch (e) {
      throw new PopdvFormulaException(
        `${aop}:${columnDef}`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /**
   * Evaluira jednu KxDef agregacionu formulu. Reference `[AOP]` (i markeri
   * [OUTPUT]/[INPUT]) se zamene vrednostima preko jednoslovnih promenljivih, pa
   * se ostatak (+ − ( ) i brojevi) evaluira Faza-1 safe parserom nad Decimal-om.
   *
   * FALLBACK: legacy VBA pozivi (`POPDV_Vred…(…)`, `iif(…)`) i sve što safe
   * parser ne razume → vrednost 0, AOP se upiše u `unsupported` (NE obara ceo
   * obračun; osnovni obračon i validne AOP linije ostaju). Ciklus (PopdvCycle)
   * se NE guta — propagira se kao stvarna greška definicije.
   */
  private evalFormula(
    formula: string,
    resolve: (aop: string) => Prisma.Decimal,
    outputVat: Prisma.Decimal,
    inputVat: Prisma.Decimal,
    aop: string,
    unsupported: Set<string>,
  ): Prisma.Decimal {
    // Legacy VBA poziv (identifikator neposredno pred "(") — safe parser ga ne
    // podržava; tretira se kao neuvezano (0) umesto da obori obračun.
    if (LEGACY_CALL_RE.test(formula)) {
      unsupported.add(aop);
      return ZERO;
    }

    // Skupi sve reference [..] i dodeli im jednoslovne promenljive A, B, C…
    // (resolve() ovde može baciti PopdvCycleException — to MORA da propagira.)
    const vars: Record<string, Prisma.Decimal> = {};
    let nextVar = 65; // 'A'
    let tooManyRefs = false;
    const substituted = formula.replace(/\[([^\]]+)\]/g, (_m, ref: string) => {
      if (nextVar > 90) {
        // > 'Z' — previše referenci za jednoslovni parser; tretiraj kao neuvezano.
        tooManyRefs = true;
        return "0";
      }
      const letter = String.fromCharCode(nextVar++);
      const key = ref.trim();
      const upper = key.toUpperCase();
      if (upper === "OUTPUT") vars[letter] = outputVat;
      else if (upper === "INPUT") vars[letter] = inputVat;
      else vars[letter] = resolve(key); // može baciti PopdvCycleException
      return letter;
    });

    if (tooManyRefs) {
      unsupported.add(aop);
      return ZERO;
    }

    try {
      return evaluateExpression<Prisma.Decimal>(
        substituted,
        vars,
        prismaDecimalArith,
      );
    } catch {
      // Neparsabilna aritmetika (ne funkcijski poziv) — neuvezano (0), ne obara.
      unsupported.add(aop);
      return ZERO;
    }
  }

  /** Meseci koje period pokriva. Mesec → [m]; kvartal → 3 meseca. */
  private periodMonths(month: number | null, quarter: number | null): number[] {
    if (month != null) return [month];
    const q = quarter!;
    const start = (q - 1) * 3 + 1;
    return [start, start + 1, start + 2];
  }

  /** Normalizuj period: tačno jedan od month/quarter, u opsegu. */
  private resolvePeriod(input: ComputePopdvInput): {
    month: number | null;
    quarter: number | null;
  } {
    const { year, month, quarter } = input;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new InvalidVatPeriodException(year, month ?? quarter ?? 0);
    }
    const hasMonth = month != null;
    const hasQuarter = quarter != null;
    if (hasMonth === hasQuarter) {
      throw new PopdvPeriodException(
        "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
      );
    }
    if (hasMonth && (month < 1 || month > 12)) {
      throw new InvalidVatPeriodException(year, month);
    }
    if (hasQuarter && (quarter < 1 || quarter > 4)) {
      throw new PopdvPeriodException(`Nevalidan kvartal: ${quarter}.`);
    }
    return {
      month: hasMonth ? month : null,
      quarter: hasQuarter ? quarter : null,
    };
  }
}

/** Nevalidan POPDV period (izbor mesec/kvartal). */
export class PopdvPeriodException extends Error {
  readonly code = "PDV_POPDV_PERIOD";
  constructor(message: string) {
    super(message);
    this.name = "PopdvPeriodException";
  }
}

/** Ciklus u POPDV AOP formulama (npr. 1.5 referiše sam sebe). */
export class PopdvCycleException extends Error {
  readonly code = "PDV_POPDV_CYCLE";
  constructor(public readonly aop: string) {
    super(`Ciklus u POPDV formulama kod AOP "${aop}".`);
    this.name = "PopdvCycleException";
  }
}

/** Neispravna POPDV formula (parser/eval greška). */
export class PopdvFormulaException extends Error {
  readonly code = "PDV_POPDV_FORMULA";
  constructor(
    public readonly formula: string,
    public readonly reason: string,
  ) {
    super(`Neispravna POPDV formula "${formula}": ${reason}`);
    this.name = "PopdvFormulaException";
  }
}
