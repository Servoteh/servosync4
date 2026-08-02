/**
 * CONTROL RULES SERVICE — kontrolna pravila završnog računa.
 * =========================================================================
 * ZAŠTO JE CEO KATALOG PREPISAN (nezavisan pregled 28.07.2026, nalaz V1 / O1)
 * ─────────────────────────────────────────────────────────────────────────
 * Prethodni katalog je imao 7 pravila od kojih su 6 bila TAUTOLOGIJA: desna strana
 * je bila doslovan prepis seed formule leve strane, pa je pravilo poredilo formulu
 * SAMU SA SOBOM i nije moglo da padne ni za jedan ulaz.
 *   • `0401 = 0402+0403+…`  — seed formula AOP-a 0401 JESTE `A0402+A0403+…`
 *   • `1043 = 1001+1027+…`  — isto, znak za znak
 *   • `1044 = 1013+1032+…`  — isto
 *   • parovi `1025/1026`, `1037/1038`, `1055/1056` — identitet `clamp(x)−clamp(−x)=x`,
 *     jer je formula druge pozicije para tačno negacija prve
 * Sedmo pravilo (`0059 = 0456`) je jedino poredilo dva različita izraza — i ono je
 * padalo zbog 13 NEURAVNOTEŽENIH naloga zatečenih u BigBit-ovoj glavnoj knjizi
 * (Σduguje−Σpotražuje = 0,10 RSD), pa je finalizacija u praksi tražila `force=true`,
 * a `force` je gasio SVIH SEDAM. Ishod: sedam zelenih značaka koje ništa ne znače,
 * plus rutinsko gaženje jedine kontrole koja nešto proverava.
 *
 * ČIME SU ZAMENJENA — PRAVILO O NEZAVISNOSTI IZVORA
 * ─────────────────────────────────────────────────────────────────────────
 * Nijedno pravilo ovde ne sme se moći izvesti iz izvora koji proverava. Zato SVAKO
 * pravilo poredi IZRAČUNATI OBRAZAC (`financial_statement_lines`, tj. rezultat 179
 * seed formula kroz `GkEvalService`) sa SIROVOM GLAVNOM KNJIGOM — sopstvenim,
 * ravnim SQL agregatom nad `ledger_entries` koji NE prolazi kroz formula-motor,
 * ne zna za AOP maske i ne deli nijednu liniju koda sa `GkEvalService`.
 * Ako je maska pogrešna, ako duplo broji, ako neko konto ispadne iz obrasca ili ako
 * je prozor agregacije pogrešan — dve strane se raziđu i pravilo PADA.
 *
 * PROZOR AGREGACIJE (mora biti ISTI kao u `GkEvalService`)
 * ─────────────────────────────────────────────────────────────────────────
 * `je.year = periodYear` + `je.status IN ('POSTED','LOCKED')`. Prozor je jedna
 * fiskalna godina (BigBit paritet — vidi zaglavlje `gkeval.service.ts`). Ovaj servis
 * NAMERNO piše sopstveni SQL umesto da zove `GkEvalService`: zajednički kod bi značio
 * zajedničku grešku, a onda kontrola opet ne bi mogla da padne.
 *   ⚠️ Jedina namerno DELJENA pretpostavka je izuzimanje kontra-stavki zaključnog
 *   naloga (`ZAK`) za klase 5/6 — bez njega bi posle prenosa sirova strana bila nula
 *   a AOP strana tačna. To je RAČUNOVODSTVENA konvencija, ne implementacija, i
 *   zapisana je ovde nezavisno (konstante niže).
 *
 * ŠTA SE MERI (i šta koje pravilo NE može da uhvati)
 * ─────────────────────────────────────────────────────────────────────────
 *   PODACI       — kvar u ULAZNIM podacima (neuravnotežen nalog iz BigBita, saldo na
 *                  klasi van obrasca). Ne blokira finalizaciju: obrazac nije kriv i
 *                  knjigovođa ga ne može popraviti gaženjem kontrole. IMENUJE naloge.
 *
 * ZELENO JE SAMO „PROLAZI" (ispravka posle drugog kruga pregleda, 28.07.)
 * ─────────────────────────────────────────────────────────────────────────
 * Prva verzija ovog kataloga je `NEPRIMENLJIVO` preslikavala u `passed=true`, pa je
 * jedini potrošač koji gleda `passed` (štampani obrazac i ekran) prikazivao ZELENO
 * „PROLAZI" iznad aktive i pasive koje se razlikuju za 110,8 miliona. To je bila ista
 * greška zbog koje je stari katalog i oboren, samo obrnuta. Od sada:
 *   • `passed = (status === "PROLAZI")` — ništa drugo nije zeleno;
 *   • finalizaciju blokira `blocking && status !== "PROLAZI" && status !== "UPOZORENJE"`
 *     (dakle PADA i NEPRIMENLJIVO koje je označeno kao blokirajuće);
 *   • `NEPRIMENLJIVO` koje je NORMALNO stanje (bilansna ravnoteža pre zaključnog
 *     naloga) nosi `blocking=false` i ne blokira ništa — ali ni tada nije zeleno.
 *   • `valueKind` kaže potrošaču da li su `left`/`right` DINARI ili BROJAČI, da papir
 *     ne bi štampao „169 konta" kroz formatter za hiljade dinara i dobio „0".
 *   POKRIVENOST  — konto sa prometom koje ne hvata nijedna AOP maska. Blokira.
 *   UKRSNA       — obrazac protiv sirove glavne knjige / drugog obrasca. Blokira.
 *   ODSECANJE    — pozicije spuštene na nulu (clamp). Ne blokira, ali se VIDI
 *                  (do sada se `clamped` beležio a nigde nije prikazivan — nalaz S6).
 *   TRAG         — zapis o forsiranoj finalizaciji (ko, kada, koja pravila su pala).
 *
 * TOLERANCIJA (nalaz S3 — „13 neuravnoteženih naloga vs tolerancija 0,01")
 * ─────────────────────────────────────────────────────────────────────────
 * Tolerancija se NE podiže na proizvoljan iznos. Umesto toga se neuravnoteženost
 * glavne knjige MERI i ulazi u pravilo kao IMENOVAN sabirak: pravilo koje poredi
 * bilans stanja sa bilansom uspeha očekuje razliku tačno jednaku toj neuravnoteženosti
 * i prolazi, a poruka kaže koliki je deo razlike „iz izvora". Time knjigovođa dobija
 * odgovor „ulazni podaci su neuravnoteženi za 0,10 RSD, evo naloga" umesto poziva na
 * `force=true`.
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2): sve vrednosti su Prisma.Decimal.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { STATEMENT_TYPE } from "./statement-type";

const D = Prisma.Decimal;

/**
 * Tolerancija jednakosti (dinar) za ČISTU aritmetiku — zaokruženja u lancu Decimal
 * operacija. NIJE mesto za „popravljanje" neuravnoteženih ulaznih podataka: taj deo
 * razlike se meri i imenuje (vidi `LedgerFacts.imbalance`).
 */
const TOLERANCE = new D("0.01");

/** Statusi naloga koji ulaze u obračun (isto kao GkEvalService). */
const POSTED_STATUSES = ["POSTED", "LOCKED"];

/** Vrsta zaključnog naloga i klase koje on zatvara (isto kao GkEvalService). */
const CLOSING_ORDER_TYPE = "ZAK";
const CLOSED_ACCOUNT_CLASSES = ["5", "6"];

/** Klase konta koje nosi bilans stanja (aktiva 0–2, kapital 3, obaveze 4). */
const BALANCE_SHEET_CLASSES = ["0", "1", "2", "3", "4"];
/** Klase konta koje nosi bilans uspeha (rashodi 5, prihodi 6). */
const INCOME_STATEMENT_CLASSES = ["5", "6"];
/**
 * Klase koje NIJEDNA od 179 formula ne dodiruje: 7 (tehnička/obračunska — BigBit-ov
 * PS nalog je nosi sa D=C pa se poništava), 8/9 (vanbilansno). Saldo na njima znači
 * da novac tiho stoji van OBA obrasca, a zbir bilansa i dalje zatvara — zato zasebno
 * pravilo. Izuzetak su poreska konta 721/722 koja BU čita kroz AOP 1051–1053.
 */
const OFF_FORM_CLASSES = ["7", "8", "9"];
/** Poreska konta koja bilans uspeha ipak čita (AOP 1051 / 1052 / 1053). */
const TAX_ACCOUNT_PREFIXES = ["721", "722"];
/**
 * Prenosna konta zaključka (599 „Prenos rashoda", 699 „Prenos prihoda"): obrazac ih
 * IZRIČITO isključuje na obe strane (AOP 1047/1048: `…-P699*+D699*…+D599*-P599*`),
 * pa moraju ispasti i iz sirove strane, inače se strane raziđu čim se knjiže.
 */
const RESULT_TRANSFER_PREFIXES = ["599", "699"];

// ─────────────────────────────────────────────────────────────────────────────
// Tipovi rezultata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PROLAZI          — dve nezavisne strane se poklapaju.
 * PADA             — raziđu se; ako je pravilo `blocking`, finalizacija se odbija.
 * UPOZORENJE       — nalaz je stvaran ali NIJE greška obrasca (kvar u ulaznim
 *                    podacima, odsečena pozicija). Ne blokira — `force` nije potreban.
 * NEPRIMENLJIVO    — pravilo se ne može oceniti (nedostaje drugi obrazac, zaključni
 *                    nalog još nije proknjižen). NIKAD se ne prijavljuje kao PROLAZI:
 *                    to je bio obrazac zbog kog je stara kontrola lažno bila zelena.
 */
export type ControlStatus = "PROLAZI" | "PADA" | "UPOZORENJE" | "NEPRIMENLJIVO";

/** Vrsta kontrole — vidi zaglavlje fajla. */
export type ControlKind =
  | "PODACI"
  | "POKRIVENOST"
  | "UKRSNA"
  | "ODSECANJE"
  | "TRAG";

/**
 * Šta su `left`/`right`: iznos u dinarima ili puki brojač (konta, pozicije).
 * Štampa i ekran MORAJU da razlikuju — brojač provučen kroz formatter za hiljade
 * dinara izlazi kao „0" (nalaz drugog kruga pregleda).
 */
export type ControlValueKind = "IZNOS" | "BROJ";

/** Rezultat evaluacije jednog pravila (kontroler vraća niz ovih; FE zeleno/crveno). */
export interface ControlResult {
  /** Stabilna šifra pravila (za FE/logove; ne menja se sa nazivom). */
  code: string;
  name: string;
  kind: ControlKind;
  left: string; // Decimal → string (.toFixed(4))
  right: string; // Decimal → string (.toFixed(4))
  diff: string; // left − right
  status: ControlStatus;
  /** Da li su left/right dinari ili brojači (štampa/ekran formatiraju različito). */
  valueKind: ControlValueKind;
  /** Kompatibilnost sa postojećim FE: true = ZELENO, i to SAMO za „PROLAZI". */
  passed: boolean;
  /** true = pad ovog pravila odbija finalizaciju (bez `force`). */
  blocking: boolean;
  /** Puna srpska rečenica: šta je izmereno, šta znači, šta korisnik treba da uradi. */
  message: string | null;
  /** Konkretni redovi dokaza (nalozi, konta, pozicije) — najviše `MAX_DETAILS`. */
  details: string[];
}

/** Koliko konkretnih redova dokaza se prikazuje pre „…i još N". */
const MAX_DETAILS = 15;

/** Obračun za koji se traže kontrole ne postoji. */
export class ControlStatementNotFoundException extends NotFoundException {
  readonly code = "ZR_STATEMENT_NOT_FOUND";
  constructor(statementId: number) {
    super(`FinancialStatement ${statementId} ne postoji.`);
    this.name = "ControlStatementNotFoundException";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sirova glavna knjiga — nezavisan izvor istine (bez GkEvalService)
// ─────────────────────────────────────────────────────────────────────────────

/** Jedan nalog čije stavke ne zbrajaju u nulu (kvar u ULAZNIM podacima). */
export interface UnbalancedEntry {
  id: number;
  orderTypeCode: string | null;
  number: string | null;
  description: string | null;
  diff: Prisma.Decimal;
}

/** Konto sa prometom u prozoru godine. */
interface AccountTurnover {
  accountCode: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/**
 * Sve činjenice o glavnoj knjizi za jednu fiskalnu godinu, pročitane RAVNIM SQL-om.
 * Ovo je „druga strana" svakog ukrsnog pravila i namerno ne prolazi kroz motor formula.
 */
interface LedgerFacts {
  year: number;
  /** Σduguje − Σpotražuje nad CELOM knjigom godine. Ideal = 0. */
  imbalance: Prisma.Decimal;
  /** Nalozi koji ne zbrajaju u nulu (uzrok gornje razlike). */
  unbalanced: UnbalancedEntry[];
  unbalancedTotal: number;
  /** Konta sa prometom (sve klase). */
  accounts: AccountTurnover[];
  /** Klasa konta → Σ(duguje − potražuje). */
  classNet: Map<string, Prisma.Decimal>;
  /** Neto rezultat godine iz klasa 5/6 (bez ZAK kontra-stavki, bez 599/699, minus porez). */
  rawNetResult: Prisma.Decimal;
  /** Postoji li proknjižen zaključni nalog (ZAK) za tu godinu. */
  hasClosingEntry: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pomoćnici: formatiranje, čitanje AOP-a, maske
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Iznos u srpskom zapisu (1.234.567,89) — deterministički, bez `Intl` (test i server
 * moraju dati isti string bez obzira na locale okruženja).
 */
function money(value: Prisma.Decimal): string {
  const fixed = value.toFixed(2);
  const negative = fixed.startsWith("-");
  const [whole, frac] = (negative ? fixed.slice(1) : fixed).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${frac}`;
}

/** Vrednost AOP pozicije iz obračuna; `null` = pozicija NE POSTOJI (≠ nula). */
function readAop(
  amounts: Map<string, Prisma.Decimal>,
  aop: string,
): Prisma.Decimal | null {
  return amounts.get(aop) ?? null;
}

/**
 * Atom formule: prefiks (slovo) + telo (cifre/wildcard). Isti oblik kao u GkEval-u.
 * NOVA instanca po pozivu — globalni regex nosi `lastIndex`, a ovde se koristi i
 * `match` i `exec` nad istim obrascem.
 */
const atomPattern = (): RegExp => /[A-Za-z][0-9A-Za-z*?.]*/g;

/**
 * Izvuci MASKE KONTA iz formule (čitanje prefiksa 3→2→1 znak, isto kao GkEval:
 * PSD/PSP pre AB/AC pre D/P/A). AOP reference (`A`/`AB`/`AC`) nisu maske i ispadaju.
 */
export function accountMasksOf(formula: string): string[] {
  const out: string[] = [];
  for (const raw of formula.match(atomPattern()) ?? []) {
    const upper = raw.toUpperCase();
    if (upper.startsWith("PSD") || upper.startsWith("PSP")) {
      out.push(raw.slice(3));
      continue;
    }
    if (upper.startsWith("AB") || upper.startsWith("AC")) {
      continue;
    }
    if (upper[0] === "D" || upper[0] === "P") {
      out.push(raw.slice(1));
    }
    // `A<aop>` = referenca na drugu poziciju — nije maska konta.
  }
  return out;
}

/** Maska konta (`*` = bilo šta, `?` = jedan znak) → RegExp nad šifrom konta. */
function maskToRegExp(mask: string): RegExp {
  if (mask === "") {
    return /^.*$/;
  }
  let body = "";
  for (const ch of mask) {
    if (ch === "*") {
      body += ".*";
    } else if (ch === "?") {
      body += ".";
    } else {
      body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${body}$`);
}

/** Sabirak formule koja se sastoji SAMO od `A<aop>` referenci. */
interface AopTerm {
  aop: string;
  sign: 1 | -1;
}

/**
 * Ako je formula ZBIRNA (samo `A<aop>` reference, `+`/`-`, bez zagrada, konstanti,
 * maski konta i AB/AC referenci) — vrati njene sabirke; inače `null`.
 * Koristi se ISKLJUČIVO za otkrivanje odsecanja na nulu (vidi pravilo ODSECANJE).
 */
export function parseAggregateFormula(formula: string): AopTerm[] | null {
  if (/[()0-9]/.test(formula.replace(atomPattern(), ""))) {
    return null; // zagrade ili goli broj van atoma
  }
  const terms: AopTerm[] = [];
  const scanner = atomPattern();
  let sign: 1 | -1 = 1;
  let index = 0;
  const text = formula.trim();
  while (index < text.length) {
    const ch = text[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      index += 1;
      continue;
    }
    if (ch === "+" || ch === "-") {
      sign = ch === "-" ? -1 : 1;
      index += 1;
      continue;
    }
    scanner.lastIndex = index;
    const match = scanner.exec(text);
    if (!match || match.index !== index) {
      return null;
    }
    const raw = match[0];
    const upper = raw.toUpperCase();
    if (upper[0] !== "A" || upper.startsWith("AB") || upper.startsWith("AC")) {
      return null; // maska konta ili druga kolona — nije zbirna pozicija
    }
    terms.push({ aop: raw.slice(1), sign });
    sign = 1;
    index = match.index + raw.length;
  }
  return terms.length > 0 ? terms : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Servis
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class ControlRulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluiraj sva pravila primenljiva na obrazac datog obračuna.
   *
   * Redosled odgovora: prvo TRAG (ako je obračun ikad forsiran), pa PODACI, pa
   * POKRIVENOST, pa UKRSNA, pa ODSECANJE — od „zašto brojevi možda nisu tačni" ka
   * „da li se obrazac slaže".
   */
  async evaluateControls(statementId: number): Promise<ControlResult[]> {
    const statement = await this.prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: { lines: true },
    });
    if (!statement) {
      throw new ControlStatementNotFoundException(statementId);
    }

    const results: ControlResult[] = [];

    const forceTrail = await this.buildForceTrail(statementId);
    if (forceTrail) {
      results.push(forceTrail);
    }

    if (
      statement.statementType !== STATEMENT_TYPE.BALANCE_SHEET &&
      statement.statementType !== STATEMENT_TYPE.INCOME_STATEMENT
    ) {
      // SI/statistički izveštaj nema propisana kontrolna pravila (doc 44 §8 t.4).
      return results;
    }

    const amounts = new Map<string, Prisma.Decimal>();
    for (const line of statement.lines) {
      amounts.set(
        line.aop,
        line.amount instanceof D ? line.amount : new D(line.amount),
      );
    }
    const formulas = new Map<string, string>();
    for (const line of statement.lines) {
      if (line.formula) {
        formulas.set(line.aop, line.formula);
      }
    }

    const facts = await this.loadLedgerFacts(statement.periodYear);
    const isBalanceSheet =
      statement.statementType === STATEMENT_TYPE.BALANCE_SHEET;

    results.push(ruleLedgerBalanced(facts));
    results.push(ruleOffFormClasses(facts));
    results.push(
      ruleMaskCoverage(
        facts,
        formulas,
        isBalanceSheet ? BALANCE_SHEET_CLASSES : INCOME_STATEMENT_CLASSES,
      ),
    );

    if (isBalanceSheet) {
      results.push(ruleBalanceSheetVsLedger(facts, amounts));
      results.push(ruleAssetsEqualLiabilities(facts, amounts));
      results.push(await this.ruleResultCrossCheck(facts, amounts));
    } else {
      results.push(ruleIncomeStatementVsLedger(facts, amounts));
    }

    results.push(ruleClampedPositions(amounts, formulas));

    return results;
  }

  /**
   * Zapisi o forsiranim finalizacijama ovog obračuna (najnoviji prvi).
   * Vraća prazan niz ako obračun nikad nije forsiran.
   */
  async listForceOverrides(statementId: number) {
    return this.prisma.statementControlOverride.findMany({
      where: { statementId },
      orderBy: { forcedAt: "desc" },
    });
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Učitaj BILANS USPEHA iste godine (drugi obrazac!) i ukrsti rezultat sa bilansom
   * stanja. Namerno se čita ceo drugi obračun, a ne ponovo isti — poređenje pozicije
   * sa pozicijom unutar JEDNOG obrasca bi bilo tautologija.
   */
  private async ruleResultCrossCheck(
    facts: LedgerFacts,
    amounts: Map<string, Prisma.Decimal>,
  ): Promise<ControlResult> {
    const income = await this.prisma.financialStatement.findUnique({
      where: {
        statementType_periodYear: {
          statementType: STATEMENT_TYPE.INCOME_STATEMENT,
          periodYear: facts.year,
        },
      },
      include: { lines: true },
    });
    let incomeAmounts: Map<string, Prisma.Decimal> | null = null;
    if (income) {
      incomeAmounts = new Map<string, Prisma.Decimal>();
      for (const line of income.lines) {
        incomeAmounts.set(
          line.aop,
          line.amount instanceof D ? line.amount : new D(line.amount),
        );
      }
    }
    return evaluateResultCrossCheck(facts, amounts, incomeAmounts);
  }

  /**
   * TRAG · pseudo-pravilo koje se pojavljuje SAMO ako je obračun ikad finalizovan
   * uprkos padu kontrola. Namerno ide kroz isti odgovor kao i prava pravila: ekran
   * koji prikazuje kontrole time automatski prikazuje i forsiranje, bez ijedne izmene
   * na frontendu. Do sada je `force=true` tiho gasio svih sedam pravila i nigde se
   * nije video (nalaz S3 / zahtev B3).
   */
  private async buildForceTrail(
    statementId: number,
  ): Promise<ControlResult | null> {
    const overrides = await this.listForceOverrides(statementId);
    if (overrides.length === 0) {
      return null;
    }
    const last = overrides[0];
    const failed = Array.isArray(last.failedRules)
      ? (last.failedRules as unknown as Array<{ code?: string; name?: string }>)
      : [];
    const who = last.forcedByEmail ?? `korisnik #${last.forcedByUserId ?? "?"}`;
    const when = last.forcedAt.toISOString().slice(0, 19).replace("T", " ");
    const details = failed.map(
      (f) => `${f.code ?? "?"} — ${f.name ?? "(bez naziva)"}`,
    );
    if (last.reason) {
      details.push(`Obrazloženje: ${last.reason}`);
    }
    return {
      code: "FORSIRANA_FINALIZACIJA",
      name: "Obračun je finalizovan uprkos padu kontrola (force)",
      kind: "TRAG",
      valueKind: "BROJ",
      left: String(overrides.length),
      right: "0",
      diff: String(overrides.length),
      status: "UPOZORENJE",
      passed: false,
      blocking: false,
      message:
        `Obračun je ${overrides.length === 1 ? "jednom" : `${overrides.length} puta`} ` +
        `finalizovan sa force=true. Poslednji put: ${who}, ${when} UTC, ` +
        `pala pravila: ${failed.length}. Brojevi u obrascu NISU prošli sve kontrole — ` +
        `pre predaje proveri navedena pravila.`,
      details: details.slice(0, MAX_DETAILS),
    };
  }

  /**
   * Pročitaj sirovu glavnu knjigu za godinu — SOPSTVENIM SQL-om, bez GkEvalService.
   * Četiri upita: neuravnoteženi nalozi, promet po kontu, neto rezultat klasa 5/6,
   * postojanje zaključnog naloga.
   */
  private async loadLedgerFacts(year: number): Promise<LedgerFacts> {
    const statuses = Prisma.join(POSTED_STATUSES);

    // 1) Nalozi čije stavke ne zbrajaju u nulu — kvar u ULAZNIM podacima.
    const unbalancedRows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        order_type_code: string | null;
        number: string | null;
        description: string | null;
        diff: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT je.id                                                  AS id,
             je.order_type_code                                     AS order_type_code,
             je.number                                              AS number,
             je.description                                         AS description,
             (SUM(le.debit) - SUM(le.credit))::numeric(19,4)        AS diff
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.year = ${year}
        AND je.status IN (${statuses})
      GROUP BY je.id, je.order_type_code, je.number, je.description
      HAVING SUM(le.debit) <> SUM(le.credit)
      ORDER BY ABS(SUM(le.debit) - SUM(le.credit)) DESC, je.id ASC
    `);

    // 2) Promet po kontu (sve klase) — osnova za pokrivenost i saldo po klasama.
    const accountRows = await this.prisma.$queryRaw<
      Array<{
        account_code: string;
        total_debit: Prisma.Decimal;
        total_credit: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT le.account_code                            AS account_code,
             COALESCE(SUM(le.debit), 0)::numeric(19,4)  AS total_debit,
             COALESCE(SUM(le.credit), 0)::numeric(19,4) AS total_credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.year = ${year}
        AND je.status IN (${statuses})
      GROUP BY le.account_code
      ORDER BY le.account_code
    `);

    // 3) Neto rezultat godine iz sirovih klasa 5/6.
    //    • kontra-stavke ZAK naloga na klasama 5/6 I na poreskim 721/722 ispadaju —
    //      zaključni nalog zatvara i poreski rashod, pa bi bez ovog izuzimanja sirova
    //      strana posle zaključka izgubila porez a obrazac ga (AOP 1051) zadržao, i
    //      BU_GK_SAGLASNOST bi padao tačno za iznos poreza (nalaz drugog kruga);
    //    • prenosna konta 599/699 ispadaju (obrazac ih izričito isključuje);
    //    • poreski rashod 721/722 se oduzima (AOP 1051–1053).
    const resultRows = await this.prisma.$queryRaw<
      Array<{
        revenue: Prisma.Decimal;
        expense: Prisma.Decimal;
        tax: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT
        COALESCE(SUM(CASE WHEN LEFT(le.account_code, 1) = '6'
                           AND NOT (${Prisma.join(
                             RESULT_TRANSFER_PREFIXES.map(
                               (p) =>
                                 Prisma.sql`le.account_code LIKE ${p + "%"}`,
                             ),
                             " OR ",
                           )})
                          THEN le.credit - le.debit ELSE 0 END), 0)::numeric(19,4) AS revenue,
        COALESCE(SUM(CASE WHEN LEFT(le.account_code, 1) = '5'
                           AND NOT (${Prisma.join(
                             RESULT_TRANSFER_PREFIXES.map(
                               (p) =>
                                 Prisma.sql`le.account_code LIKE ${p + "%"}`,
                             ),
                             " OR ",
                           )})
                          THEN le.debit - le.credit ELSE 0 END), 0)::numeric(19,4) AS expense,
        COALESCE(SUM(CASE WHEN ${Prisma.join(
          TAX_ACCOUNT_PREFIXES.map(
            (p) => Prisma.sql`le.account_code LIKE ${p + "%"}`,
          ),
          " OR ",
        )} THEN le.debit - le.credit ELSE 0 END), 0)::numeric(19,4) AS tax
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.year = ${year}
        AND je.status IN (${statuses})
        AND NOT (
          COALESCE(je.order_type_code, '') = ${CLOSING_ORDER_TYPE}
          AND (
            LEFT(le.account_code, 1) IN (${Prisma.join(CLOSED_ACCOUNT_CLASSES)})
            OR ${Prisma.join(
              TAX_ACCOUNT_PREFIXES.map(
                (p) => Prisma.sql`le.account_code LIKE ${p + "%"}`,
              ),
              " OR ",
            )}
          )
        )
    `);

    // 4) Postoji li proknjižen zaključni nalog za tu godinu (od njega zavisi da li
    //    je rezultat uopšte prenet na kapital — vidi pravilo BS_AKTIVA_PASIVA).
    const closingCount = await this.prisma.journalEntry.count({
      where: {
        year,
        orderTypeCode: CLOSING_ORDER_TYPE,
        status: { in: POSTED_STATUSES },
      },
    });

    const accounts: AccountTurnover[] = accountRows.map((r) => ({
      accountCode: r.account_code,
      debit: new D(r.total_debit),
      credit: new D(r.total_credit),
    }));

    const classNet = new Map<string, Prisma.Decimal>();
    let imbalance = new D(0);
    for (const a of accounts) {
      const net = a.debit.sub(a.credit);
      imbalance = imbalance.add(net);
      const cls = a.accountCode.slice(0, 1);
      classNet.set(cls, (classNet.get(cls) ?? new D(0)).add(net));
    }

    const revenue = new D(resultRows[0]?.revenue ?? 0);
    const expense = new D(resultRows[0]?.expense ?? 0);
    const tax = new D(resultRows[0]?.tax ?? 0);

    return {
      year,
      imbalance,
      unbalanced: unbalancedRows.slice(0, MAX_DETAILS).map((r) => ({
        id: r.id,
        orderTypeCode: r.order_type_code,
        number: r.number,
        description: r.description,
        diff: new D(r.diff),
      })),
      unbalancedTotal: unbalancedRows.length,
      accounts,
      classNet,
      rawNetResult: revenue.sub(expense).sub(tax),
      hasClosingEntry: closingCount > 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pravila
// ─────────────────────────────────────────────────────────────────────────────

/** Σ(duguje − potražuje) za date klase konta. */
function netOfClasses(
  facts: LedgerFacts,
  classes: readonly string[],
): Prisma.Decimal {
  let sum = new D(0);
  for (const cls of classes) {
    sum = sum.add(facts.classNet.get(cls) ?? new D(0));
  }
  return sum;
}

/**
 * Σ(duguje − potražuje) klasa VAN OBRASCA — bez poreskih konta 721/722.
 *
 * Poreska konta su formalno klasa 7, ali ih bilans uspeha ČITA (AOP 1051–1053), pa nisu
 * „van obrasca". Prva verzija ih je sabirala u saldo a izbacivala iz spiska dokaza, pa
 * je pravilo padalo kao BLOKIRAJUĆE sa PRAZNOM listom konta čim se proknjiži porez na
 * dobit — na potpuno ispravnom obrascu (nalaz drugog kruga pregleda).
 */
function offFormNet(facts: LedgerFacts): Prisma.Decimal {
  let sum = new D(0);
  for (const a of facts.accounts) {
    if (!OFF_FORM_CLASSES.includes(a.accountCode.slice(0, 1))) {
      continue;
    }
    if (TAX_ACCOUNT_PREFIXES.some((p) => a.accountCode.startsWith(p))) {
      continue;
    }
    sum = sum.add(a.debit.sub(a.credit));
  }
  return sum;
}

/**
 * Sastavi rezultat sa izračunatim `diff`/`passed` iz statusa.
 * ZELENO JE SAMO „PROLAZI" — vidi zaglavlje fajla.
 */
function result(
  base: Omit<ControlResult, "diff" | "passed"> & { diff?: string },
): ControlResult {
  const left = new D(base.left);
  const right = new D(base.right);
  return {
    ...base,
    diff: base.diff ?? left.sub(right).toFixed(4),
    passed: base.status === "PROLAZI",
  };
}

/**
 * Da li pad ovog pravila ODBIJA finalizaciju bez `force`.
 * PADA i blokirajuće NEPRIMENLJIVO blokiraju; UPOZORENJE nikad (to su zatečeni podaci
 * i propisano odsecanje — knjigovođa ih ne popravlja gaženjem kontrole).
 */
export function isBlockingFailure(c: ControlResult): boolean {
  return c.blocking && (c.status === "PADA" || c.status === "NEPRIMENLJIVO");
}

/**
 * PODACI · „Glavna knjiga je uravnotežena".
 *
 * Poredi Σduguje i Σpotražuje CELE knjige godine. Ne dodiruje nijedan AOP — dakle ne
 * može biti tautologija. Odgovara na pitanje koje je do sada gurało knjigovođu na
 * `force`: ako bilans ne zatvara, da li je kriv OBRAZAC ili SU KRIVI ULAZNI PODACI.
 * NE blokira finalizaciju: obrazac je tačan koliko i knjiga, a knjiga se popravlja u
 * BigBitu, ne gaženjem kontrole.
 */
function ruleLedgerBalanced(facts: LedgerFacts): ControlResult {
  const balanced = facts.imbalance.abs().lessThanOrEqualTo(TOLERANCE);
  const details = facts.unbalanced.map(
    (e) =>
      `${e.orderTypeCode ?? "?"} ${e.number ?? "?"} (nalog #${e.id}` +
      `${e.description ? `, ${e.description}` : ""}): razlika ${money(e.diff)}`,
  );
  if (facts.unbalancedTotal > facts.unbalanced.length) {
    details.push(
      `…i još ${facts.unbalancedTotal - facts.unbalanced.length} naloga`,
    );
  }
  return result({
    code: "GK_URAVNOTEZENA",
    name: "Glavna knjiga je uravnotežena (Σ duguje = Σ potražuje)",
    kind: "PODACI",
    valueKind: "IZNOS",
    left: facts.imbalance.toFixed(4),
    right: "0.0000",
    status: balanced ? "PROLAZI" : "UPOZORENJE",
    blocking: false,
    message: balanced
      ? `Svi nalozi za ${facts.year}. godinu zbrajaju u nulu.`
      : `KVAR JE U ULAZNIM PODACIMA, NE U OBRASCU. ${facts.unbalancedTotal} ` +
        `naloga u ${facts.year}. godini ne zbraja u nulu; ukupna razlika je ` +
        `${money(facts.imbalance)} RSD. Ta razlika izlazi na videlo kao odstupanje ` +
        `aktive od pasive na bilansu stanja — obrazac je tu ispravan koliko i knjiga. ` +
        `Ispravi navedene naloge u izvoru (BigBit) ili ih prihvati kao zaokruženje; ` +
        `finalizacija zbog ovoga NIJE blokirana i force=true nije potreban.`,
    details,
  });
}

/**
 * PODACI · „Klase van obrasca ne nose saldo".
 *
 * Klase 7/8/9 ne hvata NIJEDNA od 179 maski (izuzev poreskih 721/722 koje čita BU).
 * Saldo na njima znači da iznos tiho stoji izvan OBA obrasca, a zbir i dalje zatvara
 * — dakle nijedno drugo pravilo to ne može uhvatiti. Blokira: to je stvarna rupa.
 */
function ruleOffFormClasses(facts: LedgerFacts): ControlResult {
  // Saldo i spisak dokaza MORAJU imati isti obuhvat: poreska konta 721/722 su izuzeta
  // iz OBA (bilans uspeha ih čita kroz AOP 1051–1053). Ranije su ulazila u saldo a
  // ispadala iz spiska, pa je pravilo padalo bez ijednog imenovanog konta.
  const net = offFormNet(facts);
  const ok = net.abs().lessThanOrEqualTo(TOLERANCE);
  // Konta se nabrajaju SAMO kad pravilo pada — na prolazu bi vanbilansni parovi
  // (koji se međusobno poništavaju) bili čist šum.
  const details = ok
    ? []
    : facts.accounts
        .filter((a) => OFF_FORM_CLASSES.includes(a.accountCode.slice(0, 1)))
        .filter(
          (a) => !TAX_ACCOUNT_PREFIXES.some((p) => a.accountCode.startsWith(p)),
        )
        .filter((a) => !a.debit.sub(a.credit).isZero())
        .map(
          (a) =>
            `konto ${a.accountCode}: duguje ${money(a.debit)}, potražuje ` +
            `${money(a.credit)}, saldo ${money(a.debit.sub(a.credit))}`,
        );
  return result({
    code: "GK_VAN_OBRASCA",
    name: "Klase 7/8/9 (van obrasca) nemaju saldo",
    kind: "PODACI",
    valueKind: "IZNOS",
    left: net.toFixed(4),
    right: "0.0000",
    status: ok ? "PROLAZI" : "PADA",
    blocking: true,
    message: ok
      ? `Klase 7, 8 i 9 se poništavaju (saldo 0) — ništa ne stoji izvan obrasca.`
      : `Klase 7/8/9 nose saldo ${money(net)} RSD. Nijedna AOP maska ne hvata te ` +
        `klase, pa taj iznos NE ULAZI ni u bilans stanja ni u bilans uspeha, a zbir ` +
        `obrasca svejedno zatvara — zato ga nijedna druga kontrola ne vidi. Proveri ` +
        `navedena konta: ili im nedostaje protivstavka, ili obrazac mora dobiti masku.`,
    details: details.slice(0, MAX_DETAILS),
  });
}

/**
 * POKRIVENOST · „Svako konto sa prometom ulazi u bar jednu AOP masku".
 *
 * Leva strana su konta iz SIROVE knjige, desna su maske iz formula obračuna — dva
 * nezavisna izvora. Pada čim se u BigBitu otvori novo analitičko konto koje nijedna
 * maska ne hvata (živ rizik: noćni uvoz stalno donosi nova konta). Takav iznos danas
 * tiho ispada iz obrasca a bilans i dalje zatvara, jer ispada sa OBE strane.
 */
function ruleMaskCoverage(
  facts: LedgerFacts,
  formulas: Map<string, string>,
  classes: readonly string[],
): ControlResult {
  const masks = new Set<string>();
  for (const formula of formulas.values()) {
    for (const mask of accountMasksOf(formula)) {
      masks.add(mask);
    }
  }
  const patterns = [...masks].map(maskToRegExp);
  const inScope = facts.accounts.filter((a) =>
    classes.includes(a.accountCode.slice(0, 1)),
  );
  const uncovered = inScope.filter(
    (a) => !patterns.some((re) => re.test(a.accountCode)),
  );

  const noMasks = patterns.length === 0;
  return result({
    code: "AOP_POKRIVENOST",
    name: "Svako konto sa prometom ulazi u bar jednu AOP poziciju",
    kind: "POKRIVENOST",
    valueKind: "BROJ",
    left: String(inScope.length - uncovered.length),
    right: String(inScope.length),
    status: noMasks
      ? "NEPRIMENLJIVO"
      : uncovered.length === 0
        ? "PROLAZI"
        : "PADA",
    blocking: true,
    message: noMasks
      ? `Obračun nema nijednu formulu sa maskom konta (sirovi bruto bilans ili prazan ` +
        `seed) — pokrivenost se ne može oceniti.`
      : uncovered.length === 0
        ? `Svih ${inScope.length} konta klasa ${classes.join("/")} sa prometom u ` +
          `${facts.year}. hvata bar jedna od ${patterns.length} maski obrasca.`
        : `${uncovered.length} od ${inScope.length} konta sa prometom NE HVATA nijedna ` +
          `maska obrasca — njihov iznos ne ulazi ni u jednu poziciju. Pošto ispada sa ` +
          `obe strane, bilans i dalje zatvara i nijedna druga kontrola to ne vidi. ` +
          `Dopuni formule (balance_formula_definitions) ili proveri da li su konta ` +
          `otvorena greškom.`,
    details: uncovered
      .slice(0, MAX_DETAILS)
      .map(
        (a) =>
          `konto ${a.accountCode}: duguje ${money(a.debit)}, potražuje ${money(a.credit)}`,
      )
      .concat(
        uncovered.length > MAX_DETAILS
          ? [`…i još ${uncovered.length - MAX_DETAILS} konta`]
          : [],
      ),
  });
}

/**
 * UKRSNA · „Bilans stanja odgovara glavnoj knjizi".
 *
 * `A0059 − A0456` (rezultat 117 AOP formula) protiv `Σ(duguje − potražuje)` klasa 0–4
 * (ravan SQL zbir po klasi). Dve strane nemaju nijednu zajedničku liniju koda niti
 * zajedničku formulu. Pada ako:
 *   • maska duplo broji ili je promašena (koeficijent konta ≠ ±1),
 *   • prozor agregacije nije jedna fiskalna godina (nalaz K1 — kumulativ bi levu
 *     stranu naduvao za PS iznos, desna bi ostala tačna),
 *   • pozicija koja ulazi u 0059/0456 je odsečena na nulu (tada vidi i pravilo
 *     ODSECANJE, pa je uzrok imenovan).
 * Neuravnoteženost knjige se OVDE NE VIDI: ista razlika je u obe strane i skraćuje se.
 */
function ruleBalanceSheetVsLedger(
  facts: LedgerFacts,
  amounts: Map<string, Prisma.Decimal>,
): ControlResult {
  const assets = readAop(amounts, "0059");
  const liabilities = readAop(amounts, "0456");
  if (!assets || !liabilities) {
    return missingAop(
      "BS_GK_SAGLASNOST",
      "Bilans stanja odgovara glavnoj knjizi",
      [assets ? null : "0059", liabilities ? null : "0456"],
    );
  }
  const left = assets.sub(liabilities);
  const right = netOfClasses(facts, BALANCE_SHEET_CLASSES);
  const ok = left.sub(right).abs().lessThanOrEqualTo(TOLERANCE);
  return result({
    code: "BS_GK_SAGLASNOST",
    name: "Bilans stanja odgovara glavnoj knjizi (klase 0–4)",
    kind: "UKRSNA",
    valueKind: "IZNOS",
    left: left.toFixed(4),
    right: right.toFixed(4),
    status: ok ? "PROLAZI" : "PADA",
    blocking: true,
    message: ok
      ? `Razlika aktive i pasive iz obrasca (${money(left)}) poklapa se sa saldom ` +
        `klasa 0–4 u glavnoj knjizi — nijedno konto se ne broji dvaput niti ispada.`
      : `Obrazac i glavna knjiga se ne slažu za ${money(left.sub(right))} RSD. ` +
        `Obrazac (AOP 0059 − 0456) kaže ${money(left)}, sirov saldo klasa 0–4 u ` +
        `knjizi kaže ${money(right)}. Najčešći uzroci: maska koja duplo broji ili ` +
        `promašuje konto, pozicija odsečena na nulu, ili pogrešan prozor agregacije ` +
        `(sabrane ranije godine). Ovo NIJE posledica neuravnoteženih naloga — ta ` +
        `razlika se u ovom pravilu skraćuje.`,
    details: [],
  });
}

/**
 * UKRSNA · „Bilans uspeha odgovara glavnoj knjizi".
 *
 * `A1055 − A1056` (par dobitak/gubitak — otporno na odsecanje) protiv sirovog neto
 * rezultata klasa 5/6 iz knjige (bez ZAK kontra-stavki, bez prenosnih 599/699, umanjeno
 * za poreski rashod 721/722 i za ručnu poziciju 1054). Pada ako maska prihoda/rashoda
 * promaši, duplo broji, ili ako se sabere više godina.
 */
function ruleIncomeStatementVsLedger(
  facts: LedgerFacts,
  amounts: Map<string, Prisma.Decimal>,
): ControlResult {
  const profit = readAop(amounts, "1055");
  const loss = readAop(amounts, "1056");
  if (!profit || !loss) {
    return missingAop(
      "BU_GK_SAGLASNOST",
      "Bilans uspeha odgovara glavnoj knjizi",
      [profit ? null : "1055", loss ? null : "1056"],
    );
  }
  // AOP 1054 („Isplaćena lična primanja poslodavca") je RUČNA pozicija i ulazi u 1055
  // sa minusom — nije izvodiva iz knjige, pa se sirovoj strani oduzima kako je uneta.
  const manual1054 = readAop(amounts, "1054") ?? new D(0);
  const left = profit.sub(loss);
  const right = facts.rawNetResult.sub(manual1054);
  const ok = left.sub(right).abs().lessThanOrEqualTo(TOLERANCE);
  return result({
    code: "BU_GK_SAGLASNOST",
    name: "Bilans uspeha odgovara glavnoj knjizi (klase 5/6)",
    kind: "UKRSNA",
    valueKind: "IZNOS",
    left: left.toFixed(4),
    right: right.toFixed(4),
    status: ok ? "PROLAZI" : "PADA",
    blocking: true,
    message: ok
      ? `Neto rezultat iz obrasca (${money(left)}) poklapa se sa sirovim saldom klasa ` +
        `5/6 u glavnoj knjizi.`
      : `Obrazac i glavna knjiga se ne slažu za ${money(left.sub(right))} RSD. ` +
        `Obrazac (AOP 1055 − 1056) kaže ${money(left)}, sirov rezultat klasa 5/6 u ` +
        `knjizi kaže ${money(right)}. Proveri maske prihoda/rashoda (duplo brojanje ` +
        `ili promašeno konto), ručnu poziciju 1054 i prozor agregacije.`,
    details:
      manual1054.isZero() === false
        ? [`ručna pozicija AOP 1054 uneta kao ${money(manual1054)}`]
        : [],
  });
}

/**
 * UKRSNA · „Bilansna ravnoteža: ukupna aktiva = ukupna pasiva".
 *
 * Jedino pravilo iz starog kataloga koje nije bilo tautologija — ostaje, ali sa dva
 * ispravka:
 *   1. PRE zaključnog naloga se prijavljuje kao NEPRIMENLJIVO, ne kao pad. Rezultat
 *      godine tada još nije prenet na kapital (konto 341 je prazan), pa bilans po
 *      prirodi ne zatvara; do sada je knjigovođa dobijao crveno bez ijedne reči
 *      objašnjenja (nalaz S4).
 *   2. POSLE zaključnog naloga tolerancija dobija IMENOVAN dodatak — neuravnoteženost
 *      same knjige — umesto da se prag podigne „napamet" (nalaz S3).
 */
function ruleAssetsEqualLiabilities(
  facts: LedgerFacts,
  amounts: Map<string, Prisma.Decimal>,
): ControlResult {
  const assets = readAop(amounts, "0059");
  const liabilities = readAop(amounts, "0456");
  if (!assets || !liabilities) {
    return missingAop(
      "BS_AKTIVA_PASIVA",
      "Bilansna ravnoteža: ukupna aktiva = ukupna pasiva",
      [assets ? null : "0059", liabilities ? null : "0456"],
    );
  }
  const diff = assets.sub(liabilities);
  const allowed = TOLERANCE.add(facts.imbalance.abs());

  if (!facts.hasClosingEntry) {
    // NEPRIMENLJIVO, ali NE blokira: stanje „pre zaključnog naloga" je normalno i
    // knjigovođa ga ne može popraviti. Zato `blocking=false` — a `passed` je i dalje
    // false, pa se na ekranu i na papiru NE prikazuje kao zeleno „PROLAZI" iznad dva
    // vidno različita broja (nalaz drugog kruga pregleda).
    return result({
      code: "BS_AKTIVA_PASIVA",
      name: "Bilansna ravnoteža: ukupna aktiva = ukupna pasiva",
      kind: "UKRSNA",
      valueKind: "IZNOS",
      left: assets.toFixed(4),
      right: liabilities.toFixed(4),
      status: "NEPRIMENLJIVO",
      blocking: false,
      message:
        `Zaključni nalog (vrsta ZAK) za ${facts.year}. još nije proknjižen, pa ` +
        `rezultat godine nije prenet na kapital (konta 341/351 su prazna). Bilans ` +
        `stanja zato PO PRIRODI ne zatvara — razlika ${money(diff)} RSD je očekivana ` +
        `i približno jednaka neto rezultatu godine. Tačnost te razlike proverava ` +
        `pravilo „Rezultat godine: bilans stanja = bilans uspeha". Kontrola se ` +
        `ocenjuje tek posle knjiženja zaključnog naloga.`,
      details: [],
    });
  }

  const ok = diff.abs().lessThanOrEqualTo(allowed);
  const sourcePart = facts.imbalance;
  return result({
    code: "BS_AKTIVA_PASIVA",
    name: "Bilansna ravnoteža: ukupna aktiva = ukupna pasiva",
    kind: "UKRSNA",
    valueKind: "IZNOS",
    left: assets.toFixed(4),
    right: liabilities.toFixed(4),
    status: ok ? "PROLAZI" : "PADA",
    blocking: true,
    message: ok
      ? sourcePart.isZero()
        ? `Aktiva i pasiva se poklapaju.`
        : `Aktiva i pasiva se razlikuju za ${money(diff)} RSD, što je u celosti ` +
          `objašnjeno neuravnoteženošću same glavne knjige (${money(sourcePart)} RSD, ` +
          `${facts.unbalancedTotal} naloga — vidi kontrolu „Glavna knjiga je ` +
          `uravnotežena"). Obrazac je ispravan; kvar je u izvoru.`
      : `Aktiva i pasiva se razlikuju za ${money(diff)} RSD. Od toga je ` +
        `${money(sourcePart)} objašnjeno neuravnoteženim nalozima iz izvora, a ` +
        `${money(diff.sub(sourcePart))} NIJE — taj deo je greška obrasca ili motora. ` +
        `Ne finalizuj sa force pre nego što se neobjašnjeni deo razjasni.`,
    details: [],
  });
}

/**
 * UKRSNA · „Rezultat godine: bilans stanja = bilans uspeha".
 *
 * Rezultat viđen sa BILANSA STANJA (klasa 3 — konta 341/351 iz zaključnog naloga, plus
 * još neprenet deo koji se vidi kao razlika aktive i pasive) protiv rezultata sa
 * BILANSA USPEHA (klase 5/6). Dve potpuno različite porodice formula, različite klase
 * konta, različiti nalozi — nijedna se ne može svesti na drugu.
 *
 * Zapisano tako da važi u OBE faze godine:
 *   • pre zaključnog naloga: `A0410−A0414 = 0`, a ceo rezultat sedi u razlici
 *     `A0059−A0456`;
 *   • posle zaključnog naloga: razlika aktive i pasive pada na nulu, a rezultat je na
 *     `A0410−A0414` (tražena provera `A0410−A0414 == A1055−A1056`).
 * Desnoj strani se dodaje IMENOVANA neuravnoteženost knjige (umanjena za klase van
 * obrasca), jer ona pada isključivo na bilans stanja — time je i poslednjih 0,10 RSD
 * razlike objašnjeno brojem, a ne podignutom tolerancijom.
 */
function evaluateResultCrossCheck(
  facts: LedgerFacts,
  amounts: Map<string, Prisma.Decimal>,
  incomeAmounts: Map<string, Prisma.Decimal> | null,
): ControlResult {
  const name = "Rezultat godine: bilans stanja = bilans uspeha";
  if (!incomeAmounts) {
    return result({
      code: "REZULTAT_BS_BU",
      name,
      kind: "UKRSNA",
      valueKind: "IZNOS",
      left: "0.0000",
      right: "0.0000",
      status: "NEPRIMENLJIVO",
      blocking: true,
      message:
        `Bilans uspeha za ${facts.year}. nije izračunat, pa se rezultat nema sa čim ` +
        `uporediti. Pokreni bilans uspeha za istu godinu pa ponovi kontrolu.`,
      details: [],
    });
  }
  const currentProfit = readAop(amounts, "0410");
  const currentLoss = readAop(amounts, "0414");
  const assets = readAop(amounts, "0059");
  const liabilities = readAop(amounts, "0456");
  const netProfit = readAop(incomeAmounts, "1055");
  const netLoss = readAop(incomeAmounts, "1056");
  const missing = [
    currentProfit ? null : "0410",
    currentLoss ? null : "0414",
    assets ? null : "0059",
    liabilities ? null : "0456",
    netProfit ? null : "1055",
    netLoss ? null : "1056",
  ];
  if (missing.some((m) => m !== null)) {
    return missingAop("REZULTAT_BS_BU", name, missing);
  }

  const notYetTransferred = assets!.sub(liabilities!);
  const left = currentProfit!.sub(currentLoss!).add(notYetTransferred);
  // Deo neuravnoteženosti koji pada na bilans stanja = ukupna neuravnoteženost umanjena
  // za ono što stoji na klasama VAN OBRASCA. Poreska konta 721/722 su i ovde izuzeta iz
  // „van obrasca" (bilans uspeha ih čita), inače bi proknjižen porez na dobit obarao i
  // ovo pravilo — istim mehanizmom kao GK_VAN_OBRASCA.
  const sourceSlack = facts.imbalance.sub(offFormNet(facts));
  const right = netProfit!.sub(netLoss!).add(sourceSlack);
  const ok = left.sub(right).abs().lessThanOrEqualTo(TOLERANCE);

  const phase = facts.hasClosingEntry
    ? `Zaključni nalog je proknjižen, pa rezultat stoji na AOP 0410/0414 ` +
      `(${money(currentProfit!.sub(currentLoss!))}).`
    : `Zaključni nalog još nije proknjižen, pa ceo rezultat stoji kao razlika aktive ` +
      `i pasive (${money(notYetTransferred)}).`;

  return result({
    code: "REZULTAT_BS_BU",
    name,
    kind: "UKRSNA",
    valueKind: "IZNOS",
    left: left.toFixed(4),
    right: right.toFixed(4),
    status: ok ? "PROLAZI" : "PADA",
    blocking: true,
    message: ok
      ? `${phase} Isti rezultat izračunat iz klasa 5/6 na bilansu uspeha je ` +
        `${money(netProfit!.sub(netLoss!))}` +
        (sourceSlack.isZero()
          ? `. Dva nezavisna puta daju isti broj.`
          : `, plus ${money(sourceSlack)} RSD neuravnoteženosti glavne knjige koja ` +
            `pada na bilans stanja (vidi kontrolu „Glavna knjiga je uravnotežena"). ` +
            `Dva nezavisna puta daju isti broj.`)
      : `${phase} Bilans stanja daje rezultat ${money(left)}, bilans uspeha ` +
        `${money(right)} — razlika ${money(left.sub(right))} RSD nije objašnjena ni ` +
        `neuravnoteženošću knjige ni klasama van obrasca. Rezultat se vidi sa dva ` +
        `nezavisna mesta i ta dva mesta se ne slažu: proveri maske klase 3 ` +
        `(340/341/350/351) i maske klasa 5/6.`,
    details: [],
  });
}

/**
 * ODSECANJE · „Pozicije odsečene na nulu".
 *
 * Motor odseca svaki negativan rezultat na nulu (obrazac ne poznaje negativan iznos),
 * ali se taj podatak do sada nigde nije prikazivao — nalaz S6. Ovde se odsečene ZBIRNE
 * pozicije rekonstruišu iz već upisanih linija: za svaku poziciju čija je formula samo
 * zbir `A<aop>` referenci, ponovo se sabere iz upisanih iznosa i uporedi sa upisanim.
 * Ako je upisano 0 a zbir negativan — pozicija je odsečena i to se IMENUJE zajedno sa
 * sirovim iznosom.
 *
 * ⚠️ ŠTA OVO PRAVILO NE VIDI (namerno zapisano, da se ne bi čitalo kao garancija):
 * odsecanje LISTA (pozicija sa maskom konta, npr. `P433*-D433*`) se odavde ne može
 * rekonstruisati — za to bi trebalo ponovo pokrenuti motor. Zato pravilo ne blokira i
 * ne tvrdi „nijedna pozicija nije odsečena", nego samo prijavljuje ono što dokazuje.
 */
function ruleClampedPositions(
  amounts: Map<string, Prisma.Decimal>,
  formulas: Map<string, string>,
): ControlResult {
  const clamped: Array<{ aop: string; raw: Prisma.Decimal }> = [];
  let checked = 0;
  for (const [aop, formula] of formulas) {
    const terms = parseAggregateFormula(formula);
    if (!terms) {
      continue;
    }
    let raw = new D(0);
    let resolvable = true;
    for (const term of terms) {
      const value = amounts.get(term.aop);
      if (value === undefined) {
        resolvable = false;
        break;
      }
      raw = term.sign === 1 ? raw.add(value) : raw.sub(value);
    }
    if (!resolvable) {
      continue;
    }
    checked += 1;
    const stored = amounts.get(aop) ?? new D(0);
    if (stored.isZero() && raw.isNegative()) {
      clamped.push({ aop, raw });
    }
  }
  clamped.sort((a, b) => (a.raw.lessThan(b.raw) ? -1 : 1));

  return result({
    code: "ODSECANJE_NA_NULU",
    name: "Pozicije odsečene na nulu (clamp)",
    kind: "ODSECANJE",
    valueKind: "BROJ",
    left: String(clamped.length),
    right: "0",
    status: clamped.length === 0 ? "PROLAZI" : "UPOZORENJE",
    blocking: false,
    message:
      clamped.length === 0
        ? `Nijedna od ${checked} proverenih zbirnih pozicija nije odsečena na nulu. ` +
          `(Odsecanje pojedinačnih listova sa maskom konta se ovim putem ne vidi.)`
        : `${clamped.length === 1 ? "Jedna zbirna pozicija je odsečena" : `${clamped.length} zbirnih pozicija je odsečeno`} ` +
          `sa negativnog iznosa na nulu. Odsecanje je propisano (obrazac ne poznaje negativan iznos) i najčešće je ` +
          `normalno, ALI je istovremeno jedini signal da je u formuli možda okrenut ` +
          `smer duguje/potražuje. Iznosi ispod su SIROVI, pre odsecanja.`,
    details: clamped
      .slice(0, MAX_DETAILS)
      .map((c) => `AOP ${c.aop}: sirovo ${money(c.raw)} → upisano 0,00`)
      .concat(
        clamped.length > MAX_DETAILS
          ? [`…i još ${clamped.length - MAX_DETAILS} pozicija`]
          : [],
      ),
  });
}

/**
 * Pravilo se ne može oceniti jer tražena AOP pozicija NE POSTOJI u obračunu.
 * Stara implementacija je nedostajući AOP čitala kao nulu (`amounts.get(t.aop) ?? 0`),
 * pa je pravilo `1068 == 1064 − 1066` nad tri nepostojeće pozicije LAŽNO PROLAZILO
 * (0 == 0 − 0). Nepostojeća pozicija od sada nikad nije „prošlo".
 */
function missingAop(
  code: string,
  name: string,
  missing: Array<string | null>,
): ControlResult {
  const list = missing.filter((m): m is string => m !== null);
  return result({
    code,
    name,
    kind: "UKRSNA",
    valueKind: "IZNOS",
    left: "0.0000",
    right: "0.0000",
    status: "NEPRIMENLJIVO",
    blocking: true,
    message:
      `Obračun nema poziciju ${list.map((m) => `AOP ${m}`).join(", ")}, pa se ovo ` +
      `pravilo ne može oceniti. Nepostojeća pozicija se NE tretira kao nula — ` +
      `regeneriši obračun sa punim seed-om formula.`,
    details: [],
  });
}
