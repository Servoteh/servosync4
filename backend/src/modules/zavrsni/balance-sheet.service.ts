/**
 * BALANCE SHEET SERVICE — završni račun / bilansi (Faza 7).
 * =========================================================================
 * Generiše bilans stanja (BS), bilans uspeha (BU) i statistički izveštaj (SI)
 * iz bruto stanja glavne knjige (ledger_entries) preko `GkEvalService` formula-
 * engine-a, i snima ih kao `FinancialStatement` + `FinancialStatementLine`.
 *
 * TOK (doc 37 §C/§D):
 *   BalanceFormulaDefinition (po statementType, deklarativno, seed iz .MDB)
 *     ──► za svaku AOP pozicija: GkEvalService.evalFormula(formula, asOf, resolveAop)
 *        (A<aop> reference se rešavaju iz već izračunatih linija istog obrasca)
 *       ──► FinancialStatement(DRAFT) + FinancialStatementLine[] po AOP-u
 *
 * BEZ SEED-a (doc 37 §C, KRITIČNO): ako je BalanceFormulaDefinition za taj tip
 * prazna, `computeBalanceSheet`/`computeIncomeStatement` padaju na SIROVI BRUTO
 * BILANS — svako konto (Σdebit/Σcredit/saldo) kao jedna linija (formula=null),
 * uz upozorenje da pun AOP-bilans traži seed formula. `getGrossTrialBalance`
 * (GET /zavrsni/bruto-bilans) uvek radi, potpuno nezavisno od seed-a.
 *
 * OS POZICIJE (doc 37 §A/scope, Nenad 18.07): klasa 0 (zemljište/objekti/oprema)
 * se vode KOD KNJIGOVOĐE — te AOP linije se u obrascu čuvaju sa formula=null i
 * ručno unetim `amount` (MANUAL). Ovaj servis ih NE računa; ako u definiciji
 * pozicija ima formula="" ili "MANUAL", tretira se kao ručni unos (amount 0,
 * knjigovođa dopunjuje).
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2). Svi iznosi Prisma.Decimal.
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { GkEvalService, fiscalYearPeriod } from "./gkeval.service";
import {
  ControlRulesService,
  ControlResult,
  isBlockingFailure,
} from "./control-rules.service";

const D = Prisma.Decimal;

// STATEMENT_TYPE je izdvojen u ./statement-type.ts (prekid kružnog importa sa
// control-rules); re-export radi kompatibilnosti postojećih potrošača (apr-xml…).
export { STATEMENT_TYPE } from "./statement-type";
import { STATEMENT_TYPE } from "./statement-type";

/** Ručni-unos marker u BalanceFormulaDefinition.formula (OS pozicije kod knjigovođe). */
const MANUAL_FORMULA_MARKERS = new Set(["", "MANUAL", "OS", "RUCNO"]);

export interface StatementLineResult {
  aop: string;
  label: string | null;
  amount: string; // Decimal → string (BACKEND_RULES §6) — kolona 1 (tekuća godina)
  amount2: string; // Iznos_2 (prethodna godina / AB) — D9
  amount3: string; // Iznos_3 (pretprethodna godina / AC) — D9
  formula: string | null;
}

export interface StatementResult {
  id: number;
  statementType: string;
  periodYear: number;
  status: string;
  seeded: boolean; // false = pao na sirovi bruto bilans (nema AOP definicija)
  note?: string;
  /**
   * Pozicije čija je SIROVA vrednost bila negativna pa je odsečena na nulu (clamp).
   * Obrazac ne poznaje negativan iznos, ali negativan rezultat je istovremeno i signal
   * da je u formuli možda okrenut smer (duguje/potražuje) — zato se odsečene vrednosti
   * PRIJAVLJUJU, a ne gutaju. Prazno = nijedna formula nije dala negativan rezultat.
   */
  clamped?: Array<{ aop: string; rawAmount: string }>;
  lines: StatementLineResult[];
}

/** Rezultat finalizacije obračuna (POST /statements/:id/finalize). */
export interface FinalizeResult {
  id: number;
  statementType: string;
  periodYear: number;
  status: string;
  finalizedAt: string; // ISO
  forced: boolean; // true = finalizovano uprkos padu BLOKIRAJUĆIH pravila (force=true)
  /** Šifre blokirajućih pravila koja su pala i bila pregažena (prazno ako forced=false). */
  forcedRules: string[];
  /** Šifre pravila koja NE blokiraju a nisu prošla (neuravnotežen izvor, odsecanje). */
  warnings: string[];
  controls: ControlResult[];
}

@Injectable()
export class BalanceSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gkEval: GkEvalService,
    private readonly controlRules: ControlRulesService,
  ) {}

  /**
   * Sirovi bruto bilans za godinu — svako konto Σdebit/Σcredit/saldo.
   * Uvek radi, bez ikakvog seed-a (doc 37 §C).
   *
   * PROZOR = FISKALNA GODINA (`je.year`), isti kao u AOP obrascu. Polje `asOf` u
   * odgovoru je SAMO informativni ispis kraja godine (31.12.) za zaglavlje izveštaja
   * — NIJE granica agregacije i ne šalje se motoru.
   */
  async getGrossTrialBalance(year: number): Promise<{
    year: number;
    asOf: string;
    rows: Array<{
      accountCode: string;
      accountName: string | null;
      totalDebit: string;
      totalCredit: string;
      balance: string;
    }>;
    totals: { totalDebit: string; totalCredit: string; balance: string };
  }> {
    const displayAsOf = endOfYear(year);
    const rows = await this.gkEval.grossTrialBalance(fiscalYearPeriod(year));

    let sumDebit = new D(0);
    let sumCredit = new D(0);
    for (const r of rows) {
      sumDebit = sumDebit.add(r.totalDebit);
      sumCredit = sumCredit.add(r.totalCredit);
    }

    return {
      year,
      asOf: displayAsOf.toISOString(),
      rows: rows.map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        totalDebit: r.totalDebit.toFixed(4),
        totalCredit: r.totalCredit.toFixed(4),
        balance: r.balance.toFixed(4),
      })),
      totals: {
        totalDebit: sumDebit.toFixed(4),
        totalCredit: sumCredit.toFixed(4),
        balance: sumDebit.sub(sumCredit).toFixed(4),
      },
    };
  }

  /** Bilans stanja (BS) za godinu. */
  async computeBalanceSheet(
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    return this.computeStatement(STATEMENT_TYPE.BALANCE_SHEET, year, userId);
  }

  /** Bilans uspeha (BU) za godinu. */
  async computeIncomeStatement(
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    return this.computeStatement(STATEMENT_TYPE.INCOME_STATEMENT, year, userId);
  }

  /** Lista sačuvanih obračuna (filtriranje po tipu/godini). */
  async listStatements(filter: {
    statementType?: string;
    year?: number;
  }): Promise<StatementResult[]> {
    const statements = await this.prisma.financialStatement.findMany({
      where: {
        statementType: filter.statementType,
        periodYear: filter.year,
      },
      orderBy: [{ periodYear: "desc" }, { statementType: "asc" }],
      include: { lines: { orderBy: { ordinal: "asc" } } },
    });

    return statements.map((s) => ({
      id: s.id,
      statementType: s.statementType,
      periodYear: s.periodYear,
      status: s.status,
      seeded: s.lines.some((l) => l.formula !== null),
      lines: s.lines.map((l) => ({
        aop: l.aop,
        label: l.label,
        amount: l.amount.toFixed(4),
        amount2: l.amount2.toFixed(4),
        amount3: l.amount3.toFixed(4),
        formula: l.formula,
      })),
    }));
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Generiše obračun za dati tip: učita AOP definicije; ako ih ima → GkEval po
   * svakoj (uz A<aop> reference); ako nema → sirovi bruto bilans po kontu.
   * Upsert-uje FinancialStatement (jedan po tip+godina) i re-kreira linije.
   */
  private async computeStatement(
    statementType: string,
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    // PROZOR AGREGACIJE = CELA FISKALNA GODINA `year`, bez međuperiodnog preseka.
    // Ranije je ovde stajalo `asOf = endOfYear(year)` kao JEDINA vremenska granica —
    // to je bio kumulativ od početka knjige (BigBit sa OdDatumaNaloga = 1/1/1901) i
    // koren dva kvara: bilans uspeha je sabirao sve ranije godine, a bilans stanja je
    // brojao početno stanje dvaput (PS nalog + promet godine koju taj PS restatira).
    // `asOf` se NAMERNO ne prosleđuje: uz 31.12.Y bi nalog godine Y datiran u januaru
    // Y+1 ispao iz sopstvene godine. Vidi zaglavlje `gkeval.service.ts`.
    const period = fiscalYearPeriod(year);

    const definitions = await this.prisma.balanceFormulaDefinition.findMany({
      where: { statementType },
      orderBy: { ordinal: "asc" },
    });

    const seeded = definitions.length > 0;

    // Iznos_2 / Iznos_3 (kolone 2/3): PRETHODNA (year-1) i PRETPRETHODNA (year-2)
    // godina. POJEDNOSTAVLJENJE (D9, doc 44 §8 t.1): amount2/amount3 su LOOKUP već
    // sačuvanih `amount` vrednosti istog AOP-a iz obračuna za year-1 / year-2, a NE
    // pun re-eval formule sa bruto stanjem te godine. Isti map služi i AB/AC<aop>
    // referencama u formuli (resolveAop kolona 2→year-1, 3→year-2). Pun AB/AC eval
    // (ponovni GKEval prolaz nad prošlogodišnjim saldima) ide u Talas 2.
    const prevYearAmounts = await this.loadPriorYearAmounts(
      statementType,
      year - 1,
    );
    const prevPrevYearAmounts = await this.loadPriorYearAmounts(
      statementType,
      year - 2,
    );

    // Linije koje ćemo upisati: (aop, label, amount, amount2, amount3, formula, ordinal)
    const linesToWrite: Array<{
      aop: string;
      label: string | null;
      amount: Prisma.Decimal;
      amount2: Prisma.Decimal;
      amount3: Prisma.Decimal;
      formula: string | null;
      ordinal: number;
    }> = [];

    let note: string | undefined;
    /**
     * AOP → SIROVA negativna vrednost pre odsecanja na nulu. Bez ovog traga se greška
     * u smeru (D umesto P) ne razlikuje od pozicije koja je legitimno nula, a takvih
     * je u predatom obrascu za 2023. preko 60.
     */
    const clampedAops = new Map<string, Prisma.Decimal>();

    if (seeded) {
      // Kešuj izračunate AOP vrednosti radi A/AB/AC<aop> referenci (isti obrazac).
      // Kolona 1 (A) = tekuća godina (aopValues, iterativno). Kolona 2 (AB) = Iznos_2
      // = vrednost AOP-a iz obračuna za PRETHODNU godinu (year-1). Kolona 3 (AC) =
      // Iznos_3 = PRETPRETHODNA (year-2). Vrednosti kolona 2/3 su LOOKUP prošlogodišnjih
      // `amount`-a (pojednostavljenje D9; vidi gore), pa su konstantne kroz iteracije.
      const aopValues = new Map<string, Prisma.Decimal>();
      const resolveAop = (aop: string, column: 1 | 2 | 3): Prisma.Decimal => {
        if (column === 2) {
          return prevYearAmounts.get(aop) ?? new D(0);
        }
        if (column === 3) {
          return prevPrevYearAmounts.get(aop) ?? new D(0);
        }
        return aopValues.get(aop) ?? new D(0);
      };

      // ── ITERATIVNA KONVERGENCIJA (fixed-point) ──────────────────────────────
      // AOP formule sadrže FORWARD reference: npr. UKUPNA AKTIVA (0001 = A0002+A0044)
      // je prva po ordinalu, ali zavisi od pozicija koje se računaju kasnije. Jedan
      // prolaz po ordinalu bi te reference video kao 0 → UKUPNA AKTIVA = 0 (defekt B3).
      // Zato ponavljamo prolaze dok se mapa vrednosti ne stabilizuje (poređenje po
      // Decimal.equals), najviše MAX_ITER puta (BigBit ZR motor radi 7 prolaza, doc 44).
      // Isti put koristi i BILANS USPEHA (computeIncomeStatement → computeStatement),
      // pa i njegove A-reference (npr. NETO DOBITAK 1068 = A1064-A1066) konvergiraju.
      const MAX_ITER = 7;

      // Ručne (OS/knjigovođa) pozicije su fiksna 0 — upiši ih odmah da A-reference
      // na njih rade od prvog prolaza; formula-pozicije idu u iterativni skup.
      const formulaDefs: typeof definitions = [];
      for (const def of definitions) {
        if (MANUAL_FORMULA_MARKERS.has(def.formula.trim().toUpperCase())) {
          aopValues.set(def.aop, new D(0));
        } else {
          formulaDefs.push(def);
        }
      }

      for (let iter = 0; iter < MAX_ITER; iter++) {
        let changed = false;
        for (const def of formulaDefs) {
          // evalFormula rešava D/P/PSD/PSP iz baze (isto u svakom prolazu) i
          // A/AB/AC<aop> iz `aopValues` (menja se između prolaza dok ne konvergira).
          const raw = await this.gkEval.evalFormula(
            def.formula,
            period,
            resolveAop,
          );
          // CLAMP ≥ 0 — obrazac ne poznaje negativan iznos: znak nose PAROVI pozicija
          // („dobitak" / „gubitak"), a sam iznos je uvek nenegativan. BigBit klampuje
          // SVAKI upis (svih 8 ZR_Upisi* upita ima IIf(izraz > 0, izraz, 0)).
          // MORA biti UNUTAR iteracije: A<aop> reference čitaju VEĆ klampovanu vrednost,
          // pa clamp tek na kraju daje drugačiji — pogrešan — rezultat (neto dobitak
          // izlazi 70.794 umesto 34.636). Vidi ZR_ISPRAVKE_MOTORA.md §1.
          const next = raw.isNegative() ? new D(0) : raw;
          if (raw.isNegative()) {
            clampedAops.set(def.aop, raw);
          } else {
            clampedAops.delete(def.aop);
          }
          const prev = aopValues.get(def.aop);
          if (prev === undefined || !prev.equals(next)) {
            changed = true;
          }
          aopValues.set(def.aop, next);
        }
        // Stabilno — nema više promena; dalji prolazi bi dali isti rezultat.
        if (!changed) {
          break;
        }
      }

      // Emituj linije u redosledu obrasca (ordinal), sa konvergiranim vrednostima.
      for (const def of definitions) {
        const isManual = MANUAL_FORMULA_MARKERS.has(
          def.formula.trim().toUpperCase(),
        );
        linesToWrite.push({
          aop: def.aop,
          label: def.label,
          amount: aopValues.get(def.aop) ?? new D(0),
          amount2: prevYearAmounts.get(def.aop) ?? new D(0),
          amount3: prevPrevYearAmounts.get(def.aop) ?? new D(0),
          formula: isManual ? null : def.formula,
          ordinal: def.ordinal,
        });
      }
    } else {
      // Fallback: sirovi bruto bilans, jedna linija po kontu (formula=null).
      note =
        "Nema seed-ovanih AOP formula (BalanceFormulaDefinition prazna za ovaj tip) — " +
        "vraćen sirovi bruto bilans po kontu. Pun AOP-bilans traži seed formula (doc 37 §F).";
      const rows = await this.gkEval.grossTrialBalance(period);
      let ordinal = 0;
      for (const r of rows) {
        linesToWrite.push({
          aop: r.accountCode, // AOP = konto u sirovom modu
          label: r.accountName,
          amount: r.balance,
          // U sirovom modu AOP = konto; prošlogodišnja kolona = saldo istog konta
          // iz obračuna za year-1 / year-2 (ako je tada takođe generisan sirovi mod).
          amount2: prevYearAmounts.get(r.accountCode) ?? new D(0),
          amount3: prevPrevYearAmounts.get(r.accountCode) ?? new D(0),
          formula: null,
          ordinal: ordinal++,
        });
      }
    }

    // Persist: upsert zaglavlje + re-kreiraj linije u transakciji.
    const statement = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.financialStatement.findUnique({
        where: {
          statementType_periodYear: { statementType, periodYear: year },
        },
      });

      let statementId: number;
      if (existing) {
        // Ne diramo FINALIZED obračun (immutable posle predaje, doc 37 audit veza).
        if (existing.status === "FINALIZED") {
          throw new StatementFinalizedException(statementType, year);
        }
        statementId = existing.id;
        await tx.financialStatementLine.deleteMany({
          where: { statementId },
        });
      } else {
        const created = await tx.financialStatement.create({
          data: {
            statementType,
            periodYear: year,
            status: "DRAFT",
            createdByUserId: userId ?? null,
          },
        });
        statementId = created.id;
      }

      if (linesToWrite.length > 0) {
        await tx.financialStatementLine.createMany({
          data: linesToWrite.map((l) => ({
            statementId,
            aop: l.aop,
            label: l.label,
            amount: l.amount,
            amount2: l.amount2,
            amount3: l.amount3,
            formula: l.formula,
            ordinal: l.ordinal,
          })),
        });
      }

      return tx.financialStatement.findUniqueOrThrow({
        where: { id: statementId },
        include: { lines: { orderBy: { ordinal: "asc" } } },
      });
    });

    return {
      id: statement.id,
      statementType: statement.statementType,
      periodYear: statement.periodYear,
      status: statement.status,
      seeded,
      note,
      clamped: [...clampedAops.entries()].map(([aop, raw]) => ({
        aop,
        rawAmount: raw.toFixed(4),
      })),
      lines: statement.lines.map((l) => ({
        aop: l.aop,
        label: l.label,
        amount: l.amount.toFixed(4),
        amount2: l.amount2.toFixed(4),
        amount3: l.amount3.toFixed(4),
        formula: l.formula,
      })),
    };
  }

  /**
   * Učitaj mapu aop → amount (kolona 1) iz sačuvanog obračuna za dati tip/godinu.
   * Vraća praznu mapu ako obračun ne postoji (npr. prva godina korišćenja) — tada su
   * Iznos_2/Iznos_3 nule. Koristi se za popunu prethodne (year-1) i pretprethodne
   * (year-2) kolone (D9 pojednostavljenje, doc 44 §8 t.1).
   */
  private async loadPriorYearAmounts(
    statementType: string,
    year: number,
  ): Promise<Map<string, Prisma.Decimal>> {
    const map = new Map<string, Prisma.Decimal>();
    if (year < 1990) {
      return map;
    }
    const prior = await this.prisma.financialStatement.findUnique({
      where: {
        statementType_periodYear: { statementType, periodYear: year },
      },
      include: { lines: true },
    });
    if (!prior) {
      return map;
    }
    for (const l of prior.lines) {
      map.set(l.aop, l.amount instanceof D ? l.amount : new D(l.amount));
    }
    return map;
  }

  /**
   * FINALIZE obračuna (D9): DRAFT → FINALIZED + finalizedAt. Pre prelaska proverava
   * KONTROLNA PRAVILA (ControlRulesService).
   *
   * ŠTA BLOKIRA, A ŠTA NE (izmena 28.07.2026, nalazi V1/S3 nezavisnog pregleda)
   * ─────────────────────────────────────────────────────────────────────────
   * Finalizaciju odbija samo pad pravila označenog kao `blocking` — dakle onog koje
   * tvrdi da je OBRAZAC pogrešan. Pravila koja opisuju kvar u ULAZNIM PODACIMA
   * (neuravnoteženi nalozi iz BigBita) ili prijavljuju odsecanje na nulu NE blokiraju:
   * knjigovođa ih ne može popraviti gaženjem kontrole, a ranije su ga baš ona terala
   * na `force=true` — koji je onda gasio i sva ostala pravila.
   *
   * TRAG FORSIRANJA: ako se ipak forsira, upisuje se red u `statement_control_overrides`
   * (ko, kada, koja pravila su pala, pun snimak kontrola) — U ISTOJ TRANSAKCIJI sa
   * prelaskom u FINALIZED, da ne može postojati forsiran obračun bez traga. Trag se
   * vidi na obračunu kao pseudo-pravilo `FORSIRANA_FINALIZACIJA`.
   *
   * ATOMIČNOST: prelaz radi `updateMany` CAS guard-om (WHERE status<>FINALIZED) — ako
   * je između čitanja i upisa neko drugi već finalizovao (count=0), baca Conflict
   * umesto tihog gaženja. Regenerate guard već postoji u computeStatement (FINALIZED
   * se ne dira).
   */
  async finalizeStatement(
    id: number,
    opts: { force?: boolean; userId?: number; reason?: string } = {},
  ): Promise<FinalizeResult> {
    const statement = await this.prisma.financialStatement.findUnique({
      where: { id },
    });
    if (!statement) {
      throw new StatementNotFoundException(id);
    }
    if (statement.status === "FINALIZED") {
      throw new StatementAlreadyFinalizedException(id);
    }

    // Kontrolna pravila — finalizaciju blokiraju SAMO ona označena kao `blocking`.
    const controls = await this.controlRules.evaluateControls(id);
    // `isBlockingFailure` (jedan izvor istine, deljen sa ekranom kroz `status`):
    // blokiraju PADA i blokirajuće NEPRIMENLJIVO. UPOZORENJE (zatečeni neuravnoteženi
    // nalozi, propisano odsecanje) NIKAD ne blokira — inače bi knjigovođa svaki put
    // morao na `force` zbog tuđih podataka.
    const blockingFailures = controls.filter(isBlockingFailure);
    const warnings = controls.filter(
      (c) => !isBlockingFailure(c) && c.status !== "PROLAZI",
    );
    const forced = blockingFailures.length > 0 && opts.force === true;
    if (blockingFailures.length > 0 && !opts.force) {
      throw new StatementControlsFailedException(
        blockingFailures.map((f) => f.name),
      );
    }

    // E-mail forsiraoca se snima denormalizovano: trag mora ostati čitljiv i kad
    // korisnik nestane iz `users` (meki ref, bez FK — konvencija repoa).
    let forcedByEmail: string | null = null;
    if (forced && opts.userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: opts.userId },
        select: { email: true },
      });
      forcedByEmail = user?.email ?? null;
    }

    const finalizedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      // CAS: samo iz ne-FINALIZED stanja (sprečava dvostruki finalize u trci).
      const res = await tx.financialStatement.updateMany({
        where: { id, status: { not: "FINALIZED" } },
        data: { status: "FINALIZED", finalizedAt },
      });
      if (res.count === 0) {
        throw new StatementAlreadyFinalizedException(id);
      }
      if (forced) {
        await tx.statementControlOverride.create({
          data: {
            statementId: id,
            forcedByUserId: opts.userId ?? null,
            forcedByEmail,
            forcedAt: finalizedAt,
            failedRules: blockingFailures.map((c) => ({
              code: c.code,
              name: c.name,
              left: c.left,
              right: c.right,
              diff: c.diff,
              message: c.message,
            })),
            controlSnapshot: controls as unknown as Prisma.InputJsonValue,
            reason: opts.reason ?? null,
          },
        });
      }
    });

    return {
      id: statement.id,
      statementType: statement.statementType,
      periodYear: statement.periodYear,
      status: "FINALIZED",
      finalizedAt: finalizedAt.toISOString(),
      forced,
      forcedRules: blockingFailures.map((c) => c.code),
      warnings: warnings.map((c) => c.code),
      controls,
    };
  }
}

/** Obračun je FINALIZED (predat) — ne sme se ponovo generisati (doc 37 audit). */
export class StatementFinalizedException extends NotFoundException {
  readonly code = "ZR_STATEMENT_FINALIZED";
  constructor(statementType: string, year: number) {
    super(
      `Obračun ${statementType} za ${year} je FINALIZED (predat) — ponovno generisanje nije dozvoljeno.`,
    );
    this.name = "StatementFinalizedException";
  }
}

/** Obračun tražen za finalizaciju ne postoji. */
export class StatementNotFoundException extends NotFoundException {
  readonly code = "ZR_STATEMENT_NOT_FOUND";
  constructor(statementId: number) {
    super(`FinancialStatement ${statementId} ne postoji.`);
    this.name = "StatementNotFoundException";
  }
}

/** Obračun je već FINALIZED — finalizacija je idempotentno odbijena (Conflict). */
export class StatementAlreadyFinalizedException extends ConflictException {
  readonly code = "ZR_STATEMENT_ALREADY_FINALIZED";
  constructor(statementId: number) {
    super(`Obračun ${statementId} je već finalizovan (predat).`);
    this.name = "StatementAlreadyFinalizedException";
  }
}

/** Blokirajuća kontrolna pravila padaju — finalizacija odbijena (osim uz force=true). */
export class StatementControlsFailedException extends ConflictException {
  readonly code = "ZR_STATEMENT_CONTROLS_FAILED";
  constructor(failedRuleNames: string[]) {
    super(
      `Finalizacija odbijena — kontrolna pravila ne prolaze: ${failedRuleNames.join("; ")}. ` +
        `Ta pravila tvrde da je OBRAZAC pogrešan (upozorenja o ulaznim podacima ne ` +
        `blokiraju finalizaciju i ne traže force). Finalizacija uprkos tome je moguća ` +
        `sa force=true, ali se TRAJNO BELEŽI uz ime korisnika, vreme i spisak palih ` +
        `pravila, i prikazuje se na obračunu.`,
    );
    this.name = "StatementControlsFailedException";
  }
}

/**
 * 31.12. te godine — SAMO informativni ispis u zaglavlju bruto bilansa („stanje na
 * dan"). NIJE granica agregacije; prozor motora je `je.year` (vidi `fiscalYearPeriod`).
 */
function endOfYear(year: number): Date {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}
