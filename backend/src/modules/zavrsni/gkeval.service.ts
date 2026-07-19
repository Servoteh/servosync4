/**
 * GKEVAL SERVICE — bilansni formula-engine (Faza 7).
 * =========================================================================
 * Port legacy BigBit evaluatora `GKEval.bas` (doc 37 §F, doc 18 §2.2 t.6):
 * računa vrednost jedne bilansne pozicije iz salda glavne knjige (ledger_entries)
 * na osnovu formule sa prefiksima nad kontima + wildcard maskom.
 *
 * SINTAKSA (doc 44 §2.4, verbatim iz `ZR.ZRVrednostClanaIzrazaTG`):
 *   D<konto>*   = Σ dugovni promet (SUM debit)   konta koja LIKE '<konto>%'  (ZR_BrutoStanje_TG.[Duguje])
 *   P<konto>*   = Σ potražni promet (SUM credit)  konta koja LIKE '<konto>%'  (…[Potrazuje])
 *   PSD<konto>* = početno stanje dugovno  (Σ PSDuguje;    kod nas Σ debit  naloga vrste PS)
 *   PSP<konto>* = početno stanje potražno (Σ PSPotrazuje; kod nas Σ credit naloga vrste PS)
 *   A<aop>      = vrednost druge AOP pozicije, KOLONA 1 (Iznos_1)  — rešava BalanceSheetService
 *   AB<aop>     = vrednost druge AOP pozicije, KOLONA 2 (Iznos_2)
 *   AC<aop>     = vrednost druge AOP pozicije, KOLONA 3 (Iznos_3)
 *   konstanta   = decimalni literal
 * Operatori: `+ - ( )` (aritmetika nad Decimal). `*` iza konta = Like-wildcard,
 * NIKAD množenje (legacy DSL). `?` = jedan znak (SQL `_`).
 *
 * PREFIKS-ČITANJE 3→2→1 znak (BigBit `ZRVrednostClanaIzrazaTG`, doc 44 §2.4):
 *   1) Left(3) == PSD | PSP        → prefiks 3 znaka, ostatak = maska konta
 *   2) inače Left(2) == AB | AC    → prefiks 2 znaka, ostatak = oznaka AOP
 *   3) inače Left(1) == D | P | A  → prefiks 1 znak,  ostatak = maska konta / AOP
 * Bez ovog redosleda bi se `AB0002` pogrešno čitalo kao `A` + operand `B0002`.
 *
 * ⚠️ RAZLIKA OD `expression-parser.ts` (GL posting): tamo su promenljive JEDNA
 * slova A–Z i `*` JESTE množenje. Ovde su „promenljive" celi atomi `D200*` i `*`
 * je wildcard. Zato GKEval ima SOPSTVENI tokenizer/evaluator, ne deli parser.
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2): agregacija ide kroz `$queryRaw` SUM
 * nad `Decimal(19,4)` kolonama; rezultat je `Prisma.Decimal`. Aritmetika izraza
 * takođe nad `Prisma.Decimal`.
 *
 * A/AB/AC<aop> reference se NE rešavaju ovde (GkEval ne zna za druge pozicije) —
 * vraćaju se preko `resolveAop(aop, column)` callback-a koji prosleđuje pozivalac
 * (BalanceSheetService). `column` ∈ {1,2,3}: A→1 (Iznos_1), AB→2 (Iznos_2),
 * AC→3 (Iznos_3). Za prethodnu godinu (PG grana, doc 44 §2.4) pozivalac u
 * `resolveAop` mapira A(col 1) → Iznos_3; to je odluka pozivaoca, ne ovog motora.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const D = Prisma.Decimal;

/** Vrsta naloga za početno stanje (doc 37 §B: „Otvaranje nove godine = nalog vrste PS"). */
const PS_ORDER_TYPE_PREFIX = "PS";

/** Greška parsiranja/evaluacije bilansne formule. */
export class GkEvalError extends Error {
  readonly code = "ZR_FORMULA_INVALID";
  constructor(
    message: string,
    public readonly position: number = -1,
  ) {
    super(message);
    this.name = "GkEvalError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer — atomi (prefiks+konto+wildcard), broj, operator, zagrade
// ─────────────────────────────────────────────────────────────────────────────

type TokType = "atom" | "num" | "op" | "lparen" | "rparen";

interface Tok {
  type: TokType;
  value: string;
  pos: number;
}

/** Atom = prefiks (D/P/PSD/PSP/A) + telo. Prepoznat pri tokenizaciji, tumačen pri evaluaciji. */
function isAtomStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z");
}

/** Znak koji sme u telo atoma: cifra, wildcard (* ?), slovo (za AOP oznake tipa "AB"). */
function isAtomBody(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    ch === "*" ||
    ch === "?" ||
    ch === "." ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z")
  );
}

const OPERATORS = new Set(["+", "-"]);

function tokenize(input: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // atom: počinje slovom (prefiks), telo = slova/cifre/wildcard
    if (isAtomStart(ch)) {
      const start = i;
      i++;
      while (i < n && isAtomBody(input[i])) {
        i++;
      }
      tokens.push({ type: "atom", value: input.slice(start, i), pos: start });
      continue;
    }

    // broj: cifre + opciona decimalna tačka
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const start = i;
      let seenDot = false;
      while (i < n) {
        const c = input[i];
        if (c >= "0" && c <= "9") {
          i++;
        } else if (c === ".") {
          if (seenDot) {
            throw new GkEvalError(`Broj sa dve decimalne tačke na poziciji ${i}`, i);
          }
          seenDot = true;
          i++;
        } else {
          break;
        }
      }
      const text = input.slice(start, i);
      if (text === ".") {
        throw new GkEvalError(`Nevalidan broj "${text}" na poziciji ${start}`, start);
      }
      tokens.push({ type: "num", value: text, pos: start });
      continue;
    }

    if (OPERATORS.has(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch, pos: i });
      i++;
      continue;
    }

    throw new GkEvalError(`Nepoznat znak "${ch}" na poziciji ${i}`, i);
  }

  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atom → značenje
// ─────────────────────────────────────────────────────────────────────────────

type AtomKind = "D" | "P" | "PSD" | "PSP" | "AOP";

/** AOP kolona iznosa (BigBit Iznos_1/2/3): A→1, AB→2, AC→3. */
export type AopColumn = 1 | 2 | 3;

interface ParsedAtom {
  kind: AtomKind;
  /** Za D/P/PSD/PSP: LIKE maska konta (wildcard * → %, ? → _). Za AOP: oznaka pozicije. */
  operand: string;
  /** Samo za kind=AOP: koja kolona iznosa (A→1, AB→2, AC→3). */
  column?: AopColumn;
}

/**
 * Razdvoji prefiks od tela atoma čitajući TAČNO 3→2→1 znak (BigBit
 * `ZRVrednostClanaIzrazaTG`, doc 44 §2.4). Redosled je bitan: PSD/PSP (3) pre
 * AB/AC (2) pre D/P/A (1), inače bi `AB0002` palo na `A`+`B0002`.
 */
function parseAtom(raw: string, pos: number): ParsedAtom {
  const upper = raw.toUpperCase();

  // 1) tri znaka: PSD / PSP
  const p3 = upper.slice(0, 3);
  if (p3 === "PSD") {
    return { kind: "PSD", operand: raw.slice(3) };
  }
  if (p3 === "PSP") {
    return { kind: "PSP", operand: raw.slice(3) };
  }

  // 2) dva znaka: AB / AC (druga AOP pozicija, kolona 2 / 3)
  const p2 = upper.slice(0, 2);
  if (p2 === "AB") {
    return { kind: "AOP", operand: raw.slice(2), column: 2 };
  }
  if (p2 === "AC") {
    return { kind: "AOP", operand: raw.slice(2), column: 3 };
  }

  // 3) jedan znak: D / P / A (A = druga AOP pozicija, kolona 1)
  const p1 = upper[0];
  if (p1 === "D") {
    return { kind: "D", operand: raw.slice(1) };
  }
  if (p1 === "P") {
    return { kind: "P", operand: raw.slice(1) };
  }
  if (p1 === "A") {
    return { kind: "AOP", operand: raw.slice(1), column: 1 };
  }
  throw new GkEvalError(`Nepoznat prefiks u atomu "${raw}"`, pos);
}

/** Wildcard maska konta → SQL LIKE pattern (* → %, ? → _). Prazno telo = svi konti tog smera. */
function toLikePattern(operand: string): string {
  if (operand === "") {
    return "%";
  }
  // '*'/'?' su jedini wildcard-i; sve ostalo je literal. LIKE meta-znaci %/_ se
  // escape-uju jer se u kontima ne pojavljuju, ali branimo se od injekcije obrasca.
  let out = "";
  for (const ch of operand) {
    if (ch === "*") {
      out += "%";
    } else if (ch === "?") {
      out += "_";
    } else if (ch === "%" || ch === "_" || ch === "\\") {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GkEvalService
// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class GkEvalService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Izračunaj vrednost bilansne formule na dan `asOf` (uključivo).
   *
   * @param formula   npr. "D200* + P433* - PSD021*", "D202*+D203*", "A0071", "AB0002-AC0002"
   * @param asOf       gornja granica posting datuma (Date); stavke sa postingDate <= asOf
   * @param resolveAop callback za `A/AB/AC<aop>` reference (druge pozicije istog obrasca).
   *                   Prima `(aop, column)` gde je `column` ∈ {1,2,3} (A→1, AB→2, AC→3;
   *                   doc 44 §2.4). Ako izostane a formula sadrži A/AB/AC<aop> → GkEvalError.
   *                   Radi kompatibilnosti unazad, callback koji ignoriše drugi argument
   *                   (`(aop) => …`) i dalje radi za čist `A<aop>` (column=1).
   * @returns Prisma.Decimal (novac, nikad Float)
   */
  async evalFormula(
    formula: string,
    asOf: Date,
    resolveAop?: (
      aop: string,
      column: AopColumn,
    ) => Promise<Prisma.Decimal> | Prisma.Decimal,
  ): Promise<Prisma.Decimal> {
    const tokens = tokenize(formula);
    if (tokens.length === 0) {
      throw new GkEvalError("Prazna formula");
    }

    // Pred-učitaj sve saldo-agregate paralelno (jedan SQL po atomu; keširano po formuli).
    const cache = new Map<string, Prisma.Decimal>();
    const parser = new AtomEvaluator(
      tokens,
      (atom) => this.resolveAtom(atom, asOf, resolveAop, cache),
    );
    return parser.evaluate();
  }

  /**
   * Bruto bilans: za SVAKO konto koje ima stavke do `asOf`, vrati Σdebit, Σcredit
   * i saldo (debit − credit). MORA raditi bez ikakvog seed-a formula (doc 37 §C).
   */
  async grossTrialBalance(asOf: Date): Promise<
    Array<{
      accountCode: string;
      accountName: string | null;
      totalDebit: Prisma.Decimal;
      totalCredit: Prisma.Decimal;
      balance: Prisma.Decimal;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        account_code: string;
        account_name: string | null;
        total_debit: Prisma.Decimal;
        total_credit: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT le.account_code                         AS account_code,
             a.name                                  AS account_name,
             COALESCE(SUM(le.debit), 0)::numeric(19,4)  AS total_debit,
             COALESCE(SUM(le.credit), 0)::numeric(19,4) AS total_credit
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      LEFT JOIN accounts a ON a.code = le.account_code
      WHERE je.posting_date <= ${asOf}
        AND je.status = 'posted'
      GROUP BY le.account_code, a.name
      ORDER BY le.account_code
    `);

    return rows.map((r) => {
      const totalDebit = new D(r.total_debit);
      const totalCredit = new D(r.total_credit);
      return {
        accountCode: r.account_code,
        accountName: r.account_name,
        totalDebit,
        totalCredit,
        balance: totalDebit.sub(totalCredit),
      };
    });
  }

  // ── interno: jedan atom → Decimal ──────────────────────────────────────────

  private async resolveAtom(
    raw: string,
    asOf: Date,
    resolveAop:
      | ((
          aop: string,
          column: AopColumn,
        ) => Promise<Prisma.Decimal> | Prisma.Decimal)
      | undefined,
    cache: Map<string, Prisma.Decimal>,
  ): Promise<Prisma.Decimal> {
    const cached = cache.get(raw);
    if (cached !== undefined) {
      return cached;
    }

    const parsed = parseAtom(raw, -1);

    if (parsed.kind === "AOP") {
      if (!resolveAop) {
        throw new GkEvalError(
          `Formula referiše AOP "${parsed.operand}" ali resolver nije prosleđen`,
        );
      }
      // column je uvek postavljen za kind=AOP (parseAtom); default 1 iz opreza.
      const v = await resolveAop(parsed.operand, parsed.column ?? 1);
      const dec = v instanceof D ? v : new D(v);
      cache.set(raw, dec);
      return dec;
    }

    const like = toLikePattern(parsed.operand);
    const value = await this.aggregate(parsed.kind, like, asOf);
    cache.set(raw, value);
    return value;
  }

  /**
   * Σ prometa (D/P) ili početnog stanja (PSD/PSP) za konta koja LIKE maski.
   * PSD/PSP filtriraju naloge vrste PS (početno stanje); D/P uzimaju sav promet.
   */
  private async aggregate(
    kind: Exclude<AtomKind, "AOP">,
    likePattern: string,
    asOf: Date,
  ): Promise<Prisma.Decimal> {
    const column = kind === "D" || kind === "PSD" ? Prisma.sql`le.debit` : Prisma.sql`le.credit`;
    const psFilter =
      kind === "PSD" || kind === "PSP"
        ? Prisma.sql`AND je.order_type_code LIKE ${PS_ORDER_TYPE_PREFIX + "%"}`
        : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{ total: Prisma.Decimal }>>(Prisma.sql`
      SELECT COALESCE(SUM(${column}), 0)::numeric(19,4) AS total
      FROM ledger_entries le
      JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE le.account_code LIKE ${likePattern}
        AND je.posting_date <= ${asOf}
        AND je.status = 'posted'
        ${psFilter}
    `);

    return new D(rows[0]?.total ?? 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AtomEvaluator — recursive-descent nad tokenima; atomi rešeni async callback-om
// ─────────────────────────────────────────────────────────────────────────────
//
// Gramatika (LEVO-asocijativna): expr := term (('+'|'-') term)*
//                                term := ('-'|'+') term | atom | num | '(' expr ')'
// Prioriteta nema osim zagrada (legacy DSL nema *,/ u aritmetici — `*` je wildcard).

class AtomEvaluator {
  private pos = 0;

  constructor(
    private readonly tokens: Tok[],
    private readonly resolveAtom: (raw: string) => Promise<Prisma.Decimal>,
  ) {}

  async evaluate(): Promise<Prisma.Decimal> {
    const v = await this.parseExpr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new GkEvalError(`Neočekivan token "${t.value}" na poziciji ${t.pos}`, t.pos);
    }
    return v;
  }

  private peek(): Tok | undefined {
    return this.tokens[this.pos];
  }

  private async parseExpr(): Promise<Prisma.Decimal> {
    let acc = await this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op") {
        this.pos++;
        const rhs = await this.parseTerm();
        acc = t.value === "+" ? acc.add(rhs) : acc.sub(rhs);
      } else {
        break;
      }
    }
    return acc;
  }

  private async parseTerm(): Promise<Prisma.Decimal> {
    const t = this.peek();
    if (!t) {
      throw new GkEvalError("Neočekivan kraj formule (očekivan operand)");
    }

    // unarni +/-
    if (t.type === "op") {
      this.pos++;
      const operand = await this.parseTerm();
      return t.value === "-" ? operand.neg() : operand;
    }

    if (t.type === "num") {
      this.pos++;
      return new D(t.value);
    }

    if (t.type === "atom") {
      this.pos++;
      return this.resolveAtom(t.value);
    }

    if (t.type === "lparen") {
      this.pos++;
      const inner = await this.parseExpr();
      const close = this.peek();
      if (!close || close.type !== "rparen") {
        throw new GkEvalError(`Nezatvorena zagrada (očekivano ")")`, t.pos);
      }
      this.pos++;
      return inner;
    }

    throw new GkEvalError(`Neočekivan token "${t.value}" na poziciji ${t.pos}`, t.pos);
  }
}
