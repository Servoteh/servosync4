# GL Posting — Safe Expression Parser (Faza 2) — NACRT

> **Status:** čista logika spremna i testirana, **NIJE aktivirano.** Svi fajlovi imaju `*.nacrt`
> ekstenziju → van TypeScript kompilacije (`npm run build` ih ignoriše), da referentna implementacija
> ne obori build dok GL Prisma modeli i posting servis ne postoje.
>
> Rekonstrukcija: [docs/migration/18 §2.2](../../../../docs/migration/18-gl-pdv-kontiranje-rekonstrukcija.md),
> [docs/migration/30 §B](../../../../docs/migration/30-glavna-knjiga-modul-dubinski.md).

## Šta je ovde

| Fajl | Uloga |
|---|---|
| `expression-parser.ts.nacrt` | recursive-descent (precedence-climbing) parser + evaluator za `DefDug`/`DefPot` formule; **bez `eval`/`Function`** |
| `expression-parser.spec.ts.nacrt` | iscrpni testovi (asocijativnost, prioritet, zagrade, unarni minus, greške, dokaz ispravke legacy bug-a). Aktivirati zajedno sa parserom. |
| `README.nacrt.md` | ovaj fajl |

## Šta parser radi

BigBit šeme za kontiranje (`Stavke seme za kontiranje`) drže formule nad slovima **A–Z** u kolonama
`DefDug`/`DefPot` (npr. `A+B+C`, `A*0.2`, `O+P+Q`, `-O-P-Q`, `(A+B)/C`). Slova mapiraju na iznose sa
dokumenta (autoritativno mapiranje: `SKStavkeZaKnjizenjeAnalitika1Korak.sql` — `A=NabNetoVred`, `B=ZTS`,
`C=ZTD`, `D=PPDOsn`, `E=PPDZel`, … `O=StvarnaVP`, `P/Q=PDV po stopama`, `X/Y/Z=avans`; **NE** iz starih
VBA komentara).

Podržana gramatika (zatvoren aritmetički jezik — ništa izvan ovoga se ne parsira, pa ni izvršava):

```
promenljive  A–Z (jednoslovne, velika slova)
brojevi      12, 0.2, .5, 12.   (decimalni; jedna tačka)
operatori    +  -  *  /         (binarni)
unarni       -x  +x  (ugnježdivo: --x)
zagrade      ( … )
```

## Zašto NE `eval()`

`DefDug`/`DefPot` su **podaci iz baze**. Provlačenje kroz `eval`/`new Function` = arbitrarno izvršavanje
koda iz DB reda (BACKEND_RULES §7; doc 30 Napomena 4). Ovaj parser prihvata isključivo gornju gramatiku;
sve ostalo (mala slova, `$`, `;`, `**`, imena funkcija) → `ExpressionError`.

## Ispravka legacy bug-a (levo-asocijativnost)

Access/VBA `Eval("A-B-C")` je **desno-asocijativan** → računa `A-(B-C)` (matematički pogrešno); isto
`Eval("A/B/C")` → `A/(B/C)`. Ovaj parser je **levo-asocijativan** za sve binarne operatore:

| Izraz | Legacy (desno-asoc., BUG) | Ovaj parser (levo-asoc., ispravno) |
|---|---|---|
| `A-B-C` (10,3,2) | `10-(3-2)=9` | `(10-3)-2=5` |
| `A/B/C` (100,5,2) | `100/(5/2)=40` | `(100/5)/2=10` |
| `100-20-30` | `110` | `50` |

Za `A+B-C` obe varijante daju isto (+/- kompatibilni sleva), pa postojeće `+`-dominantne šeme ostaju
nepromenjene; ispravka pogađa samo lance oduzimanja/deljenja. Levu asocijativnost obezbeđuje `while`
petlja (ne rekurzija) u `parseExpr`/`parseTerm` — akumulira sleva-nadesno. Ako je NEKA šema zaista
zavisila od desno-asoc. ponašanja, može se eksplicitno napisati zagradama: `A-(B-C)`.

Dokaz je u spec-u (`describe("asocijativnost — ISPRAVKA legacy...")`): svaki test tvrdi i tačan rezultat
i `not.toBe(legacyRightAssoc)`.

## Decimal-agnostičnost (novac = Decimal, nikad Float)

Parser **ne importuje** nijednu Decimal biblioteku. Računa nad apstraktnim tipom `T` kroz injektovan
`Arith<T>` adapter (`add/sub/mul/div/neg/fromString/isZero`). Zamena biblioteke = jedan adapter, bez
diranja parsera.

- **Testovi / float-ok mesta:** ugrađen `numberArith` (JS `number`).
- **Produkcija (novac):** napiši tanak adapter nad `Prisma.Decimal` (decimal.js — već u repou preko
  `@prisma/client`):

  ```ts
  import { Prisma } from "@prisma/client";
  import { Arith } from "./expression-parser";

  const D = Prisma.Decimal;
  export const prismaDecimalArith: Arith<Prisma.Decimal> = {
    fromString: (s) => new D(s),
    add: (a, b) => a.add(b),
    sub: (a, b) => a.sub(b),
    mul: (a, b) => a.mul(b),
    div: (a, b) => a.div(b),      // decimal.js baca na /0; parser i sam proverava isZero pre
    neg: (a) => a.neg(),
    isZero: (a) => a.isZero(),
  };
  ```

  (Adapter se piše pri aktivaciji GL modula — ovde ga NEMA da nacrt ne bi importovao Prismu van build-a.)

## Kako ga posting servis poziva

```
R_Vrste dokumenata (vrsta dok → IDSeme)
  → Sema za kontiranje (IDSeme → vrsta naloga)
    → Stavke seme za kontiranje (red = Konto + DefDug + DefPot)
      → za svaki red:
          debit  = evaluateExpression(row.defDebit,  varMap, prismaDecimalArith)  // "" → preskoči
          credit = evaluateExpression(row.defCredit, varMap, prismaDecimalArith)
      → ledger_entries: { konto: row.konto, analitika: komitent, duguje: debit, potrazuje: credit }
```

`varMap: Record<"A".."Z", Prisma.Decimal>` gradi servis iz kolona dokumenta (helper `buildVarMap` ako su
sirove `number`/`string`; ako su već Decimal, prosledi mapu direktno). Prazna formula (`""`) znači „ovaj
red nema tu stranu" — servis je preskače pre poziva parsera (parser na prazan string baca
`ExpressionError("Prazan izraz")`).

Poziv (skica u servisu):

```ts
import { evaluateExpression } from "./posting/expression-parser";
import { prismaDecimalArith } from "./posting/prisma-decimal-arith";

const debit = row.defDebit
  ? evaluateExpression(row.defDebit, varMap, prismaDecimalArith)
  : ZERO;
```

## Balans-kontrola ΣDug = ΣPot (NIJE u parseru)

Parser računa **jednu** stavku. Kontrola da nalog balansira — **Σ svih `duguje` = Σ svih `potrazuje`**
po nalogu (doc 30 §F: „balans-kontrola ΣDug=ΣPot") — je odgovornost **posting servisa**, nakon što
evaluira sve redove šeme:

- servis sabira Decimal `duguje` i `potrazuje` preko svih redova naloga;
- ako `ΣDug ≠ ΣPot` (uz toleranciju 0, Decimal je egzaktan) → tipizirana domenska greška, nalog se NE
  upisuje (transakcija se odbija), 500 se ne baca (BACKEND_RULES §7);
- tek na balansu → INSERT u `journal_orders` + `ledger_entries` (obrazac `NSK_ProknjiziStavkeIzRobnog`).

Parser namerno ne zna za nalog/šemu/bazu → ostaje 100% testabilan bez I/O.

## Aktivacija (checklist)

1. Kada GL Prisma modeli (`chart_of_accounts`, `journal_orders`, `ledger_entries`,
   `Sema za kontiranje`/`Stavke seme za kontiranje` rule-tabele) uđu u `schema.prisma` i posting servis
   se piše.
2. Preimenuj `expression-parser.ts.nacrt` → `expression-parser.ts` i
   `expression-parser.spec.ts.nacrt` → `expression-parser.spec.ts`.
3. Dodaj `prisma-decimal-arith.ts` (adapter iznad) — jedina tačka koja importuje Prismu.
4. `npm test` — spec mora proći (40+ asertacija, uklj. dokaz ispravke asocijativnosti).
5. Preimenuj ovaj `README.nacrt.md` → `README.md`.
