/**
 * SAFE EXPRESSION PARSER za GL posting engine (Faza 2) — NACRT (van build-a).
 * =========================================================================
 * Port legacy BigBit evaluatora `VredIzraza(Izraz, A..Z)` / `VBA Eval`
 * (`Module__SemaZaKontiranje.txt:3-52`), koji računa `DefDug`/`DefPot` formule
 * iz šeme za kontiranje nad slovima A–Z (vidi docs/migration/18 §2.2, 30 §B).
 *
 * ZAŠTO NE `eval()` / `new Function()` (BACKEND_RULES §7, doc 30 Napomena 4):
 *   DefDug/DefPot su PODACI iz baze (`Stavke seme za kontiranje`) — pustiti ih
 *   kroz JS `eval` = arbitrarno izvršavanje koda iz DB reda. Ovaj parser je
 *   zatvoren aritmetički jezik: SAMO promenljive A–Z, brojevi, + - * / ( ) i
 *   unarni minus. Ništa drugo se ne parsira → ništa drugo se ne izvršava.
 *
 * ISPRAVKA LEGACY BUG-a (glavni razlog za sopstveni parser):
 *   Access/VBA `Eval("A-B-C")` je desno-asocijativan → računa A-(B-C), a
 *   `Eval("A/B/C")` → A/(B/C). To je MATEMATIČKI POGREŠNO za oduzimanje i
 *   deljenje. Ovaj parser je LEVO-asocijativan za sve binarne operatore, pa
 *   "A-B-C" = (A-B)-C i "A/B/C" = (A/B)/C. Za "A+B-C" rezultat je isti u obe
 *   varijante (+ i - su asocijativno kompatibilni sleva), ali "A-B-C",
 *   "A-B+C", "A/B*C" itd. ovde daju ISPRAVAN rezultat. Test-suite to dokazuje.
 *
 * DECIMAL-AGNOSTIČNOST (doc 30 §F: "Decimal, nikad Float"; BACKEND_RULES §2):
 *   Parser ne importuje nijednu Decimal biblioteku. Radi nad apstraktnim tipom
 *   `T` kroz injektovan `Arith<T>` adapter (add/sub/mul/div/neg/fromString/
 *   isZero). Za PRODUKCIJU se prosledi `prismaDecimalArith` (Prisma.Decimal =
 *   decimal.js) — vidi README.nacrt.md. Za čiste unit-testove (bez baze/Prisme)
 *   koristi se `numberArith` (JS number) — dovoljno za dokazivanje
 *   asocijativnosti/prioriteta/parsiranja. Zamena biblioteke = jedan adapter.
 *
 * AKTIVACIJA: preimenovati u `expression-parser.ts` zajedno sa
 * `expression-parser.spec.ts.nacrt` → `.spec.ts` (vidi README.nacrt.md).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────────────────────
// Greška
// ─────────────────────────────────────────────────────────────────────────────

/** Sve greške parsera/evaluacije nose ovaj tip (jasna poruka + pozicija). */
export class ExpressionError extends Error {
  constructor(
    message: string,
    /** 0-bazna pozicija u izvornom izrazu (ili -1 ako nije primenljivo). */
    public readonly position: number = -1,
  ) {
    super(message);
    this.name = "ExpressionError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmetički adapter — jedina tačka vezivanja za konkretan brojni tip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimalni interfejs koji parser traži od brojnog tipa `T`. Namerno uzak —
 * zamena decimal.js/Prisma.Decimal drugom bibliotekom = implementiraj ovih 7.
 */
export interface Arith<T> {
  /** Parsira decimalni literal (npr. "0.2", "12", "1000.50") u T. */
  fromString(literal: string): T;
  add(a: T, b: T): T;
  sub(a: T, b: T): T;
  mul(a: T, b: T): T;
  /** Deljenje; MORA baciti (ili vratiti tako da `div` po nuli pukne) za b == 0. */
  div(a: T, b: T): T;
  /** Unarni minus. */
  neg(a: T): T;
  /** Da li je vrednost tačno nula (za detekciju deljenja nulom). */
  isZero(a: T): boolean;
}

/**
 * Referentni adapter nad JS `number`. NAMENJEN TESTOVIMA i mestima gde je
 * float-preciznost dovoljna. Za NOVAC koristi `prismaDecimalArith` (README).
 */
export const numberArith: Arith<number> = {
  fromString(literal: string): number {
    const n = Number(literal);
    if (!Number.isFinite(n)) {
      throw new ExpressionError(`Nevalidan broj: "${literal}"`);
    }
    return n;
  },
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div(a, b) {
    if (b === 0) {
      throw new ExpressionError("Deljenje nulom");
    }
    return a / b;
  },
  neg: (a) => -a,
  isZero: (a) => a === 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

type TokenType = "var" | "num" | "op" | "lparen" | "rparen";

interface Token {
  type: TokenType;
  /** Za "var": jedno slovo A–Z. Za "num": tekst literala. Za "op": +-*​/. */
  value: string;
  /** 0-bazna pozicija početka tokena u izrazu (za poruke o grešci). */
  pos: number;
}

const OPERATORS = new Set(["+", "-", "*", "/"]);

/**
 * Razbija izraz na tokene. Whitespace se ignoriše. Baca `ExpressionError` na
 * bilo koji znak koji nije: A–Z (velika slova, promenljive), cifra/tačka
 * (broj), + - * / ( ) ili whitespace.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // promenljiva: JEDNO veliko slovo A–Z (legacy: slova su jednoslovna)
    if (ch >= "A" && ch <= "Z") {
      tokens.push({ type: "var", value: ch, pos: i });
      i++;
      continue;
    }

    // broj: [0-9]* ('.' [0-9]*)?  — dozvoljava "12", "0.2", ".5", "12."
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const start = i;
      let seenDot = false;
      while (i < n) {
        const c = input[i];
        if (c >= "0" && c <= "9") {
          i++;
        } else if (c === ".") {
          if (seenDot) {
            throw new ExpressionError(
              `Broj sa dve decimalne tačke na poziciji ${i}`,
              i,
            );
          }
          seenDot = true;
          i++;
        } else {
          break;
        }
      }
      const text = input.slice(start, i);
      if (text === "." || text === "") {
        throw new ExpressionError(
          `Nevalidan broj "${text}" na poziciji ${start}`,
          start,
        );
      }
      tokens.push({ type: "num", value: text, pos: start });
      continue;
    }

    // operatori
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

    // Sve ostalo (uklj. mala slova, $, funkcije, ; itd.) = odbijeno.
    throw new ExpressionError(
      `Nepoznat znak "${ch}" na poziciji ${i}`,
      i,
    );
  }

  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser (recursive descent, precedence-climbing) + evaluacija u jednom prolazu
// ─────────────────────────────────────────────────────────────────────────────
//
// Gramatika (LEVO-asocijativna za sve binarne operatore):
//   expr   := term  (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := ('-' | '+') factor        // unarni minus/plus
//           | NUMBER
//           | VARIABLE
//           | '(' expr ')'
//
// Levu asocijativnost obezbeđuje `while` petlja (ne rekurzija) u expr/term:
// akumulira se sleva-nadesno, pa "A-B-C" → ((A-B)-C). Time je ispravljen
// legacy desno-asoc. bug.

class Parser<T> {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly arith: Arith<T>,
    private readonly vars: Readonly<Record<string, T>>,
  ) {}

  parse(): T {
    if (this.tokens.length === 0) {
      throw new ExpressionError("Prazan izraz");
    }
    const value = this.parseExpr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new ExpressionError(
        `Neočekivan token "${t.value}" na poziciji ${t.pos}`,
        t.pos,
      );
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  // expr := term (('+' | '-') term)*   — LEVO-asocijativno
  private parseExpr(): T {
    let acc = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.pos++;
        const rhs = this.parseTerm();
        acc = t.value === "+" ? this.arith.add(acc, rhs) : this.arith.sub(acc, rhs);
      } else {
        break;
      }
    }
    return acc;
  }

  // term := factor (('*' | '/') factor)*   — LEVO-asocijativno
  private parseTerm(): T {
    let acc = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.type === "op" && (t.value === "*" || t.value === "/")) {
        this.pos++;
        const rhs = this.parseFactor();
        if (t.value === "*") {
          acc = this.arith.mul(acc, rhs);
        } else {
          if (this.arith.isZero(rhs)) {
            throw new ExpressionError("Deljenje nulom", t.pos);
          }
          acc = this.arith.div(acc, rhs);
        }
      } else {
        break;
      }
    }
    return acc;
  }

  // factor := ('-'|'+') factor | NUMBER | VARIABLE | '(' expr ')'
  private parseFactor(): T {
    const t = this.peek();
    if (!t) {
      throw new ExpressionError("Neočekivan kraj izraza (očekivan operand)");
    }

    // unarni minus / plus
    if (t.type === "op" && (t.value === "-" || t.value === "+")) {
      this.pos++;
      const operand = this.parseFactor();
      return t.value === "-" ? this.arith.neg(operand) : operand;
    }

    if (t.type === "num") {
      this.pos++;
      return this.arith.fromString(t.value);
    }

    if (t.type === "var") {
      this.pos++;
      if (!Object.prototype.hasOwnProperty.call(this.vars, t.value)) {
        throw new ExpressionError(
          `Nepoznata promenljiva "${t.value}" (nije u mapi vrednosti)`,
          t.pos,
        );
      }
      return this.vars[t.value];
    }

    if (t.type === "lparen") {
      this.pos++;
      const inner = this.parseExpr();
      const close = this.peek();
      if (!close || close.type !== "rparen") {
        throw new ExpressionError(
          `Nezatvorena zagrada (očekivano ")")`,
          t.pos,
        );
      }
      this.pos++; // pojedi ')'
      return inner;
    }

    // rparen ili op*/ ovde = sintaksna greška
    throw new ExpressionError(
      `Neočekivan token "${t.value}" na poziciji ${t.pos}`,
      t.pos,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Javni API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluira DefDug/DefPot izraz nad mapom promenljivih A–Z.
 *
 * @param expression  npr. "A+B+C", "A*0.2", "O+P+Q", "-O-P-Q", "(A+B)/C"
 * @param vars        mapa slovo→vrednost (npr. { A: nabNeto, B: zts, ... })
 * @param arith       aritmetika (default: `numberArith`; za novac: Decimal adapter)
 * @returns           izračunata vrednost tipa T
 * @throws ExpressionError  na prazan izraz, nepoznat token/znak, sintaksu,
 *                          nepoznatu promenljivu ili deljenje nulom.
 */
export function evaluateExpression<T = number>(
  expression: string,
  vars: Readonly<Record<string, T>>,
  arith: Arith<T> = numberArith as unknown as Arith<T>,
): T {
  const tokens = tokenize(expression);
  const parser = new Parser<T>(tokens, arith, vars);
  return parser.parse();
}

/**
 * Pomoćna: napravi mapu promenljivih iz para (slovo, vrednost) preslikavanjem
 * primitivnih number vrednosti kroz `arith.fromString`. Korisno kad posting
 * servis ima kolone dokumenta kao Decimal već — tada NE treba ova helper,
 * prosto se prosledi Record<string, Decimal>.
 */
export function buildVarMap<T>(
  raw: Readonly<Record<string, number | string>>,
  arith: Arith<T>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(raw)) {
    out[key] = arith.fromString(String(raw[key]));
  }
  return out;
}
