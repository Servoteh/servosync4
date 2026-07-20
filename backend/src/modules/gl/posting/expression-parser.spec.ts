/**
 * Testovi za SAFE EXPRESSION PARSER — NACRT (van build-a).
 * ========================================================
 * AKTIVIRATI ZAJEDNO SA PARSEROM: preimenuj `expression-parser.ts.nacrt` →
 * `expression-parser.ts` I ovaj fajl `expression-parser.spec.ts.nacrt` →
 * `expression-parser.spec.ts`, pa `npm test`. Dok parser ima `.nacrt`, i ovaj
 * spec mora ostati `.nacrt` (Jest ga inače pokupi a import puca).
 *
 * Testovi rade nad `numberArith` (JS number) — čista logika, BEZ baze/Prisme.
 * Isti izrazi/asocijativnost važe i za Decimal adapter (adapter menja samo
 * preciznost, ne redosled operacija). Preciznost Decimala se testira posebno
 * kad se aktivira produkcioni adapter (vidi README.nacrt.md).
 */

import {
  evaluateExpression,
  ExpressionError,
  numberArith,
  buildVarMap,
  type Arith,
} from "./expression-parser";

/** Kratka pomoćna: evaluiraj sa number aritmetikom i mapom promenljivih. */
const ev = (expr: string, vars: Record<string, number> = {}): number =>
  evaluateExpression<number>(expr, vars, numberArith);

describe("expression-parser (safe GL DefDug/DefPot evaluator)", () => {
  // ───────────────────────────────────────────────────────────────────────
  // Osnovno: brojevi, promenljive, operatori
  // ───────────────────────────────────────────────────────────────────────
  describe("osnovni operandi", () => {
    it("goli broj", () => {
      expect(ev("42")).toBe(42);
    });

    it("decimalni broj", () => {
      expect(ev("12.5")).toBe(12.5);
    });

    it("decimala bez vodeće nule (.5)", () => {
      expect(ev(".5")).toBe(0.5);
    });

    it("decimala bez trailing cifara (12.)", () => {
      expect(ev("12.")).toBe(12);
    });

    it("promenljiva", () => {
      expect(ev("A", { A: 100 })).toBe(100);
    });

    it("sabiranje dve promenljive", () => {
      expect(ev("A+B", { A: 10, B: 5 })).toBe(15);
    });

    it("legacy primer A+B-C", () => {
      expect(ev("A+B-C", { A: 10, B: 5, C: 3 })).toBe(12);
    });

    it("legacy primer A*0.2 (PDV 20%)", () => {
      expect(ev("A*0.2", { A: 1000 })).toBe(200);
    });

    it("realan DefPot UFROB: A+B+C+D+E", () => {
      expect(ev("A+B+C+D+E", { A: 100, B: 10, C: 5, D: 20, E: 2 })).toBe(137);
    });

    it("realan IFUSL DefDug: O+P+Q", () => {
      expect(ev("O+P+Q", { O: 1000, P: 200, Q: 0 })).toBe(1200);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // ISPRAVKA LEGACY BUG-a: LEVO-asocijativno oduzimanje i deljenje
  // ───────────────────────────────────────────────────────────────────────
  describe("asocijativnost — ISPRAVKA legacy desno-asoc. bug-a", () => {
    // Legacy VBA/Access Eval("A-B-C") = A-(B-C) = A-B+C. Naš parser = (A-B)-C.
    it("A-B-C je LEVO-asocijativno: (A-B)-C, ne A-(B-C)", () => {
      const vars = { A: 10, B: 3, C: 2 };
      const left = ev("A-B-C", vars); // (10-3)-2 = 5   ← ISPRAVNO
      const legacyRightAssoc = vars.A - (vars.B - vars.C); // 10-(3-2) = 9  ← BUG
      expect(left).toBe(5);
      // Dokaz da NIJE legacy ponašanje:
      expect(left).not.toBe(legacyRightAssoc);
    });

    it("A-B+C = (A-B)+C (razlikuje se od desno-asoc. tumačenja)", () => {
      // Desno-asoc. bi bio A-(B+C). Levo-asoc: (A-B)+C.
      const vars = { A: 10, B: 3, C: 2 };
      expect(ev("A-B+C", vars)).toBe(9); // (10-3)+2
      expect(ev("A-B+C", vars)).not.toBe(vars.A - (vars.B + vars.C)); // != 5
    });

    it("A/B/C je LEVO-asocijativno: (A/B)/C, ne A/(B/C)", () => {
      const vars = { A: 100, B: 5, C: 2 };
      const left = ev("A/B/C", vars); // (100/5)/2 = 10  ← ISPRAVNO
      const legacyRightAssoc = vars.A / (vars.B / vars.C); // 100/(5/2) = 40 ← BUG
      expect(left).toBe(10);
      expect(left).not.toBe(legacyRightAssoc);
    });

    it("A/B*C = (A/B)*C (levo-asoc., isti prioritet)", () => {
      expect(ev("A/B*C", { A: 100, B: 5, C: 2 })).toBe(40); // (100/5)*2
    });

    it("dugačak lanac oduzimanja: A-B-C-D = ((A-B)-C)-D", () => {
      expect(ev("A-B-C-D", { A: 20, B: 5, C: 4, D: 3 })).toBe(8);
    });

    it("čisti brojevi: 100-20-30 = 50 (ne 110)", () => {
      expect(ev("100-20-30")).toBe(50);
      // legacy A-(B-C) = 100-(20-30) = 110
      expect(ev("100-20-30")).not.toBe(110);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Prioritet operatora
  // ───────────────────────────────────────────────────────────────────────
  describe("prioritet operatora", () => {
    it("* pre + : A+B*C", () => {
      expect(ev("A+B*C", { A: 2, B: 3, C: 4 })).toBe(14); // 2+(3*4)
    });

    it("/ pre - : A-B/C", () => {
      expect(ev("A-B/C", { A: 10, B: 8, C: 2 })).toBe(6); // 10-(8/2)
    });

    it("mešano: 2+3*4-10/2 = 9", () => {
      expect(ev("2+3*4-10/2")).toBe(9); // 2+12-5
    });

    it("* i / isti prioritet, sleva: 2*3/4 = 1.5", () => {
      expect(ev("2*3/4")).toBe(1.5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Zagrade
  // ───────────────────────────────────────────────────────────────────────
  describe("zagrade", () => {
    it("zagrada menja prioritet: (A+B)*C", () => {
      expect(ev("(A+B)*C", { A: 2, B: 3, C: 4 })).toBe(20);
    });

    it("zagrada može da vrati desno-asoc. ako se EKSPLICITNO napiše: A-(B-C)", () => {
      expect(ev("A-(B-C)", { A: 10, B: 3, C: 2 })).toBe(9);
    });

    it("ugnježdene zagrade: ((A+B)*(C-D))", () => {
      expect(ev("((A+B)*(C-D))", { A: 1, B: 2, C: 5, D: 1 })).toBe(12);
    });

    it("zagrada oko celog izraza", () => {
      expect(ev("(A+B+C)", { A: 1, B: 2, C: 3 })).toBe(6);
    });

    it("realan primer: (A+B)/C", () => {
      expect(ev("(A+B)/C", { A: 30, B: 20, C: 2 })).toBe(25);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Unarni minus / plus
  // ───────────────────────────────────────────────────────────────────────
  describe("unarni minus/plus", () => {
    it("unarni minus na broju: -5", () => {
      expect(ev("-5")).toBe(-5);
    });

    it("unarni minus na promenljivoj: -A", () => {
      expect(ev("-A", { A: 7 })).toBe(-7);
    });

    it("realan KNO DefDug: -O-P-Q (storno)", () => {
      expect(ev("-O-P-Q", { O: 1000, P: 200, Q: 0 })).toBe(-1200);
    });

    it("unarni minus u sredini: A*-B", () => {
      expect(ev("A*-B", { A: 3, B: 4 })).toBe(-12);
    });

    it("unarni minus posle zagrade: (A)-(-B)", () => {
      expect(ev("(A)-(-B)", { A: 5, B: 3 })).toBe(8);
    });

    it("dupli unarni minus: --A", () => {
      expect(ev("--A", { A: 5 })).toBe(5);
    });

    it("unarni plus: +A", () => {
      expect(ev("+A", { A: 5 })).toBe(5);
    });

    it("unarni minus pre zagrade: -(A+B)", () => {
      expect(ev("-(A+B)", { A: 2, B: 3 })).toBe(-5);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Whitespace tolerancija
  // ───────────────────────────────────────────────────────────────────────
  describe("whitespace", () => {
    it("razmaci se ignorišu", () => {
      expect(ev("  A  +  B ", { A: 1, B: 2 })).toBe(3);
    });

    it("tabovi/nove linije", () => {
      expect(ev("A\t+\nB", { A: 1, B: 2 })).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Greške
  // ───────────────────────────────────────────────────────────────────────
  describe("greške", () => {
    it("prazan izraz baca ExpressionError", () => {
      expect(() => ev("")).toThrow(ExpressionError);
      expect(() => ev("   ")).toThrow(/[Pp]razan/);
    });

    it("nepoznata promenljiva (nije u mapi)", () => {
      expect(() => ev("A+B", { A: 1 })).toThrow(ExpressionError);
      expect(() => ev("A+B", { A: 1 })).toThrow(/[Nn]epoznata promenljiva/);
    });

    it("nepoznat znak (mala slova nisu promenljive)", () => {
      expect(() => ev("a+b")).toThrow(/[Nn]epoznat znak/);
    });

    it("nepoznat znak ($ / funkcije / eval-injekcija odbijeni)", () => {
      expect(() => ev("A;DROP", { A: 1 })).toThrow(ExpressionError);
      expect(() => ev("process", {})).toThrow(ExpressionError);
      expect(() => ev("A**B", { A: 1, B: 2 })).toThrow(ExpressionError); // ** nije operand
    });

    it("deljenje nulom (literal)", () => {
      expect(() => ev("A/0", { A: 10 })).toThrow(/[Dd]eljenje nulom/);
    });

    it("deljenje nulom (promenljiva == 0)", () => {
      expect(() => ev("A/B", { A: 10, B: 0 })).toThrow(/[Dd]eljenje nulom/);
    });

    it("nezatvorena zagrada", () => {
      expect(() => ev("(A+B", { A: 1, B: 2 })).toThrow(ExpressionError);
    });

    it("višak zatvorene zagrade", () => {
      expect(() => ev("A+B)", { A: 1, B: 2 })).toThrow(ExpressionError);
    });

    it("operator bez desnog operanda", () => {
      expect(() => ev("A+", { A: 1 })).toThrow(ExpressionError);
    });

    it("operator bez levog operanda (binarni *)", () => {
      expect(() => ev("*A", { A: 1 })).toThrow(ExpressionError);
    });

    it("dva operatora zaredom", () => {
      expect(() => ev("A+*B", { A: 1, B: 2 })).toThrow(ExpressionError);
    });

    it("dve decimalne tačke u broju", () => {
      expect(() => ev("1.2.3")).toThrow(ExpressionError);
    });

    it("prazne zagrade", () => {
      expect(() => ev("()")).toThrow(ExpressionError);
    });

    it("ExpressionError nosi poziciju kad je poznata", () => {
      try {
        ev("A@B", { A: 1, B: 2 });
        fail("očekivan throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ExpressionError);
        expect((e as ExpressionError).position).toBe(1); // "@" na indexu 1
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // buildVarMap helper
  // ───────────────────────────────────────────────────────────────────────
  describe("buildVarMap", () => {
    it("preslikava number/string vrednosti kroz arith.fromString", () => {
      const m = buildVarMap({ A: 100, B: "0.2" }, numberArith);
      expect(evaluateExpression("A*B", m, numberArith)).toBe(20);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Decimal-agnostičnost: parser radi nad proizvoljnim Arith<T> adapterom.
  // Ovde mock BigInt-based adapter (u „centima") dokazuje da nema number-a
  // zakucanog u logiku — asocijativnost/prioritet ostaju isti.
  // ───────────────────────────────────────────────────────────────────────
  describe("Arith<T> adapter (dokaz decimal-agnostičnosti)", () => {
    // "cent" adapter: vrednosti su bigint u centima; * i / skaliraju sa 100.
    const centArith: Arith<bigint> = {
      fromString: (s) => BigInt(Math.round(Number(s) * 100)),
      add: (a, b) => a + b,
      sub: (a, b) => a - b,
      mul: (a, b) => (a * b) / 100n,
      div: (a, b) => {
        if (b === 0n) throw new ExpressionError("Deljenje nulom");
        return (a * 100n) / b;
      },
      neg: (a) => -a,
      isZero: (a) => a === 0n,
    };

    it("levo-asoc. oduzimanje važi i za bigint adapter", () => {
      const vars = { A: centArith.fromString("10"), B: centArith.fromString("3"), C: centArith.fromString("2") };
      const r = evaluateExpression<bigint>("A-B-C", vars, centArith);
      expect(r).toBe(500n); // (10-3-2)=5.00 → 500 centi
    });

    it("A*0.2 nad bigint centima", () => {
      const vars = { A: centArith.fromString("1000") };
      const r = evaluateExpression<bigint>("A*0.2", vars, centArith);
      expect(r).toBe(20000n); // 200.00
    });

    it("deljenje nulom se propagira iz adaptera", () => {
      const vars = { A: centArith.fromString("10"), B: centArith.fromString("0") };
      expect(() => evaluateExpression<bigint>("A/B", vars, centArith)).toThrow(
        /[Dd]eljenje nulom/,
      );
    });
  });
});
