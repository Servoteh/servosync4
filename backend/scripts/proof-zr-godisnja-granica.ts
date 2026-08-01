/**
 * DOKAZ — GODIŠNJA GRANICA MOTORA ZAVRŠNOG RAČUNA (dev baza, prava PostgreSQL).
 * =============================================================================
 * Zaseje TRI fiskalne godine sa PS i ZAK nalozima (struktura kakvu pravi
 * `gl/year-open.service.ts`) i pokaže brojeve PRE i POSLE ispravke, za sve tri:
 *
 *   PRE  = `aggregate()` sa HEAD-a — jedina vremenska granica `je.posting_date <= 31.12.Y`
 *          (kumulativ od početka knjige). SQL je prepisan VERBATIM iz
 *          `git show HEAD:src/modules/zavrsni/gkeval.service.ts` i ubačen u motor
 *          preko podklase, pa PRE prolazi kroz ISTI `BalanceSheetService`
 *          (ista fixed-point iteracija, isti clamp, istih 179 formula).
 *   POSLE = živi motor, prozor `je.year = Y`.
 *
 * Pokreće se:
 *   DEVURL="postgresql://…/servosync" npx ts-node --transpile-only \
 *     scripts/proof-zr-godisnja-granica.ts [--keep]
 *
 * `--keep` ostavlja zasejane podatke u bazi; podrazumevano se sve briše na kraju
 * (i zasejani nalozi i obračuni za probne godine). Prave godine se NE DIRAJU:
 * probne godine (2022–2024, 2032–2034, 2042–2044) su prazne u dev bazi, a probne
 * kompanije (9902/9904/9905) ne postoje u produkcionim podacima.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { GkEvalService, fiscalYearPeriod } from "../src/modules/zavrsni/gkeval.service";
import { BalanceSheetService } from "../src/modules/zavrsni/balance-sheet.service";
import { ControlRulesService } from "../src/modules/zavrsni/control-rules.service";
import { PostingEngineService } from "../src/modules/gl/posting/posting.service";
import { YearOpenService } from "../src/modules/gl/year-open.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

const D = Prisma.Decimal;

// ── Probni skup: knjiga A (ispravan izvor), knjiga B (posle 341→340), knjiga C ──
const BOOK_A = { company: 9902, years: [2022, 2023, 2024] };
const BOOK_B = { company: 9904, years: [2032, 2033, 2034] };
const BOOK_C = { company: 9905, years: [2042, 2043, 2044] };

const ACC = {
  kupac: "2410", // klasa 2 — „D2410*-P2410*" iz ugovora
  protiv: "2020", // klasa 2 — protivkonto da svaki nalog balansira
  rashod: "5110", // klasa 5
  prihod: "6010", // klasa 6 — „P6010*-D6010*" iz ugovora
  rezTekuca: "3410", // 341* = rezultat TEKUĆE godine (AOP 0410)
  rezRanije: "3400", // 340* = rezultat RANIJIH godina (AOP 0409)
};

const url = process.env.DEVURL;
if (!url) {
  console.error("Nedostaje DEVURL (bez ?schema=public).");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const posting = new PostingEngineService(prisma as any);
const yearOpen = new YearOpenService(prisma as any, posting);
const gkNew = new GkEvalService(prisma as any);
const controls = new ControlRulesService(prisma as any);

// ─────────────────────────────────────────────────────────────────────────────
// STARI MOTOR — `aggregate()` verbatim sa HEAD-a, ubačen u podklasu.
// Jedina razlika prema živom: `je.posting_date <= endOfYear(Y)` umesto `je.year = Y`.
// ─────────────────────────────────────────────────────────────────────────────

class GkEvalLegacy extends GkEvalService {}

(GkEvalLegacy.prototype as any).aggregate = async function (
  kind: "D" | "P" | "PSD" | "PSP",
  likePattern: string,
  period: { fiscalYear: number },
): Promise<Prisma.Decimal> {
  const asOf = endOfYear(period.fiscalYear);
  const column = kind === "D" || kind === "PSD" ? Prisma.sql`le.debit` : Prisma.sql`le.credit`;
  const isOpeningBalance = kind === "PSD" || kind === "PSP";
  const psFilter = isOpeningBalance
    ? Prisma.sql`AND je.order_type_code LIKE ${"PS%"}`
    : Prisma.sql`AND NOT (
        COALESCE(je.order_type_code, '') = ${"ZAK"}
        AND LEFT(le.account_code, 1) IN (${Prisma.join(["5", "6"])})
      )`;
  const rows = await (this as any).prisma.$queryRaw(Prisma.sql`
    SELECT COALESCE(SUM(${column}), 0)::numeric(19,4) AS total
    FROM ledger_entries le
    JOIN journal_entries je ON je.id = le.journal_entry_id
    WHERE le.account_code LIKE ${likePattern}
      AND je.posting_date <= ${asOf}
      AND je.status IN ('POSTED', 'LOCKED')
      ${psFilter}
  `);
  return new D(rows[0]?.total ?? 0);
};

const gkOld = new GkEvalLegacy(prisma as any);
const bsNew = new BalanceSheetService(prisma as any, gkNew, controls);
const bsOld = new BalanceSheetService(prisma as any, gkOld as any, controls);

function endOfYear(year: number): Date {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed
// ─────────────────────────────────────────────────────────────────────────────

type Line = [account: string, debit: number, credit: number];

async function post(
  companyId: number,
  orderType: string,
  date: string,
  description: string,
  lines: Line[],
): Promise<number> {
  const res = await posting.postManualEntry(prisma as any, {
    orderType,
    documentDate: new Date(date + "T00:00:00.000Z"),
    companyId,
    description,
    lines: lines.map(([accountCode, debit, credit]) => ({
      accountCode,
      debit: String(debit),
      credit: String(credit),
      description,
    })),
  });
  return res.journalEntryId;
}

/**
 * Poslovni promet tri godine (brojevi iz presuđenog ugovora):
 *   2022: 6010 P100, 5110 D40, 2410 D100/P40 → saldo 60, dobit 60
 *   2023: 6010 P250, 5110 D20, 2410 D10/P20 → saldo 50, dobit 230
 *   2024: 6010 P300, bez rashoda, 2410 D5    → saldo 55, dobit 300
 */
async function seedBusiness(companyId: number, y: number, offset: number) {
  const Y = y - offset; // 0/1/2 = prva/druga/treća godina knjige
  if (Y === 0) {
    await post(companyId, "NALOG", `${y}-03-01`, "Prodaja", [
      [ACC.kupac, 100, 0],
      [ACC.prihod, 0, 100],
    ]);
    await post(companyId, "NALOG", `${y}-06-01`, "Trošak materijala", [
      [ACC.rashod, 40, 0],
      [ACC.kupac, 0, 40],
    ]);
  } else if (Y === 1) {
    await post(companyId, "NALOG", `${y}-04-01`, "Prodaja", [
      [ACC.kupac, 10, 0],
      [ACC.prihod, 0, 10],
    ]);
    await post(companyId, "NALOG", `${y}-05-01`, "Trošak materijala", [
      [ACC.rashod, 20, 0],
      [ACC.kupac, 0, 20],
    ]);
    await post(companyId, "NALOG", `${y}-09-01`, "Prodaja", [
      [ACC.protiv, 240, 0],
      [ACC.prihod, 0, 240],
    ]);
  } else {
    await post(companyId, "NALOG", `${y}-02-01`, "Prodaja", [
      [ACC.kupac, 5, 0],
      [ACC.prihod, 0, 5],
    ]);
    await post(companyId, "NALOG", `${y}-08-01`, "Prodaja", [
      [ACC.protiv, 295, 0],
      [ACC.prihod, 0, 295],
    ]);
  }
}

/**
 * ZAK nalog godine (identična struktura kao `year-open.service.ts`
 * `closeIncomeStatement`: kontra-stavke klasa 5/6 + rezultat na 341, datum 31.12.).
 */
async function seedClosing(companyId: number, y: number, income: number, expense: number) {
  const lines: Line[] = [[ACC.prihod, income, 0]];
  if (expense > 0) lines.push([ACC.rashod, 0, expense]);
  lines.push([ACC.rezTekuca, 0, income - expense]);
  await post(companyId, "ZAK", `${y}-12-31`, `Zatvaranje klasa 5 i 6 za ${y}`, lines);
}

/**
 * PS nalog (identična struktura kao `openBalanceSheet`: klase 0–4 sa saldom,
 * datum 01.01.). `resultAccount` bira da li preneti rezultat ide na 341 (kako
 * year-open radi DANAS) ili na 340 (reklasifikacija koju traži ugovor).
 */
async function seedOpening(
  companyId: number,
  y: number,
  balances: Line[],
) {
  await post(companyId, "PS", `${y}-01-01`, `Početno stanje ${y}`, balances);
}

async function seedBook(companyId: number, years: number[], resultAccount: string) {
  const [y1, y2, y3] = years;

  await seedBusiness(companyId, y1, y1);
  await seedClosing(companyId, y1, 100, 40); // dobit 60 → 341 C60

  // PS y2: klase 0–4 na kraju y1 = 2410 D60, 341 C60
  await seedOpening(companyId, y2, [
    [ACC.kupac, 60, 0],
    [resultAccount, 0, 60],
  ]);
  await seedBusiness(companyId, y2, y1);
  await seedClosing(companyId, y2, 250, 20); // dobit 230 → 341 C230

  // PS y3: 2410 D50, 2020 D240, rezultat C290 (60 + 230)
  await seedOpening(companyId, y3, [
    [ACC.kupac, 50, 0],
    [ACC.protiv, 240, 0],
    [resultAccount, 0, 290],
  ]);
  await seedBusiness(companyId, y3, y1);
  await seedClosing(companyId, y3, 300, 0); // dobit 300 → 341 C300
}

// ─────────────────────────────────────────────────────────────────────────────
// Merenja
// ─────────────────────────────────────────────────────────────────────────────

function fmt(v: Prisma.Decimal | undefined): string {
  return v === undefined ? "—" : v.toFixed(2).padStart(14);
}

async function atom(
  engine: GkEvalService,
  formula: string,
  year: number,
): Promise<Prisma.Decimal> {
  return engine.evalFormula(formula, fiscalYearPeriod(year), () => new D(0));
}

async function atomTable(
  title: string,
  formula: string,
  years: number[],
  tacno: string[],
  ocekivanoLabel = "TAČNO",
) {
  console.log(`\n  ${title}   (${formula})`);
  console.log(
    `    godina |    STARI MOTOR |    NOVI MOTOR | ${ocekivanoLabel.padStart(13)}`,
  );
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const o = await atom(gkOld, formula, y);
    const n = await atom(gkNew, formula, y);
    const mark = n.toFixed(0) === tacno[i] ? "✔" : "✘";
    console.log(
      `      ${y} | ${fmt(o)} | ${fmt(n)} | ${tacno[i].padStart(13)}  ${mark}`,
    );
  }
}

interface Snap {
  amounts: Map<string, Prisma.Decimal>;
}

async function computeBoth(
  service: BalanceSheetService,
  years: number[],
): Promise<Map<number, Snap>> {
  const out = new Map<number, Snap>();
  for (const y of years) {
    const amounts = new Map<string, Prisma.Decimal>();
    const bs = await service.computeBalanceSheet(y);
    const bu = await service.computeIncomeStatement(y);
    for (const l of [...bs.lines, ...bu.lines]) {
      amounts.set(l.aop, new D(l.amount));
    }
    out.set(y, { amounts });
  }
  return out;
}

const AOP_OF_INTEREST: Array<[string, string]> = [
  ["0059", "D. UKUPNA AKTIVA"],
  ["0401", "A. KAPITAL"],
  ["0409", "  neraspoređeni dobitak RANIJIH godina"],
  ["0410", "  neraspoređeni dobitak TEKUĆE godine"],
  ["0414", "  gubitak tekuće godine"],
  ["0456", "E. UKUPNA PASIVA"],
  ["1043", "L. UKUPNI PRIHODI"],
  ["1044", "LJ. UKUPNI RASHODI"],
  ["1055", "Ć. NETO DOBITAK"],
  ["1056", "U. NETO GUBITAK"],
];

async function cleanupBook(companyId: number, years: number[]) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM ledger_entries WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE company_id = ${companyId})`,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE journal_entries SET status = 'DRAFT' WHERE company_id = ${companyId}`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM journal_entries WHERE company_id = ${companyId}`,
  );
  if (years.length > 0) {
    const list = years.join(",");
    await prisma.$executeRawUnsafe(
      `DELETE FROM financial_statement_lines WHERE statement_id IN (SELECT id FROM financial_statements WHERE period_year IN (${list}))`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM financial_statements WHERE period_year IN (${list})`,
    );
  }
}

/**
 * D · PRAVI PODACI (BigBit GK 2026) — razlika STARI vs NOVI mora biti NULA.
 *
 * Danas u knjizi postoji samo 2026, `year` = god(document_date) za sve naloge i
 * `posting_date` se ne razilazi — pa prozor godine i kumulativ MORAJU dati isti skup.
 * Time je izmena dokazivo bezopasna na današnjim podacima, a štiti od druge godine.
 *
 * MORA se pozvati PRE seed-a probnih knjiga: stari motor nema prozor godine, pa bi
 * pokupio i probne naloge (2022–2044) i prijavio lažnu razliku.
 */
async function realDataDelta() {
  console.log("═".repeat(78));
  console.log("D · PRAVI PODACI (BigBit GK 2026) — razlika STARI vs NOVI mora biti NULA");
  console.log("═".repeat(78));
  const defs = await prisma.balanceFormulaDefinition.findMany({
    select: { formula: true },
  });
  const atoms = new Set<string>();
  for (const d of defs) {
    for (const m of d.formula.matchAll(/\b(PSD|PSP|D|P)[0-9][0-9*?]*/g)) {
      atoms.add(m[0]);
    }
  }
  let diff = 0;
  const razlike: string[] = [];
  for (const a of atoms) {
    const o = await atom(gkOld, a, 2026);
    const n = await atom(gkNew, a, 2026);
    if (!o.equals(n)) {
      diff++;
      if (razlike.length < 5) {
        razlike.push(`${a}: stari ${o.toFixed(2)} / novi ${n.toFixed(2)}`);
      }
    }
  }
  console.log(`\n  Različitih atoma: ${diff} od ${atoms.size}`);
  for (const r of razlike) console.log(`    ${r}`);
  const health = await prisma.$queryRawUnsafe<any[]>(
    `SELECT count(*) FILTER (WHERE year = 0)::int AS godina_nula,
            count(*) FILTER (WHERE year <> extract(year from document_date))::int AS neslaganje,
            count(*)::int AS ukupno
       FROM journal_entries`,
  );
  console.log(
    `  Zdravlje kolone year: year=0 → ${health[0].godina_nula}, ` +
      `year ≠ god(document_date) → ${health[0].neslaganje}, ukupno naloga ${health[0].ukupno}\n`,
  );
}

async function main() {
  const keep = process.argv.includes("--keep");

  // ⚠️ SAMO JEDNA INSTANCA. Skripta seje i briše iste probne kompanije/godine, pa dva
  // paralelna pokretanja jedno drugom obrišu podatke usred merenja (zatečeno 28.07:
  // druga instanca je u toku A2 pokupila brisanje prve i 2024. je izašla u nulama).
  const [lock] = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT pg_try_advisory_lock(hashtext('proof-zr-godisnja-granica')) AS ok`,
  );
  if (!lock?.ok) {
    console.error(
      "Druga instanca ove skripte već radi nad istom bazom — prekidam (merenje bi bilo neispravno).",
    );
    await prisma.$disconnect();
    process.exit(2);
  }

  // Higijena: probne godine/kompanije moraju biti prazne pre seed-a.
  for (const b of [BOOK_A, BOOK_B, BOOK_C]) await cleanupBook(b.company, b.years);

  // ⚠️ Odeljak D MORA ići PRE seed-a: stari motor nema prozor godine, pa bi pokupio
  // i probne knjige (2022–2044) i lažno prijavio razliku nad pravim podacima.
  const realOnly = process.argv.includes("--real-only");
  if (realOnly || process.argv.includes("--real")) await realDataDelta();
  if (realOnly) {
    await prisma.$disconnect();
    return;
  }

  console.log("═".repeat(78));
  console.log("A · KNJIGA OD TRI GODINE (PS + ZAK, struktura iz year-open.service.ts)");
  console.log("═".repeat(78));
  await seedBook(BOOK_A.company, BOOK_A.years, ACC.rezTekuca);

  const seeded = await prisma.$queryRawUnsafe<any[]>(
    `SELECT je.year, je.order_type_code, count(*)::int AS naloga, sum(le.debit)::text AS duguje
       FROM journal_entries je JOIN ledger_entries le ON le.journal_entry_id = je.id
      WHERE je.company_id = ${BOOK_A.company}
      GROUP BY 1,2 ORDER BY 1,2`,
  );
  console.log("\n  Zasejano:");
  for (const r of seeded) {
    console.log(
      `    ${r.year}  ${String(r.order_type_code).padEnd(6)} stavki=${String(r.naloga).padStart(2)}  Σduguje=${r.duguje}`,
    );
  }

  console.log("\n" + "─".repeat(78));
  console.log("A1 · ATOMI — PRE / POSLE / TAČNO");
  console.log("─".repeat(78));
  await atomTable(
    "BILANS USPEHA — prihod godine",
    "P6010*-D6010*",
    BOOK_A.years,
    ["100", "250", "300"],
  );
  await atomTable(
    "BILANS STANJA — saldo konta na dan",
    "D2410*-P2410*",
    BOOK_A.years,
    ["60", "50", "55"],
  );
  // ⚠️ „OČEKIVANO" ovde NIJE računovodstveno tačna vrednost pozicije 0410, nego ono
  // što mora izaći dok PS nalog prenosi rezultat 341→341 (kako year-open radi DANAS).
  // Rezultat godine JESTE u kapitalu i nije nula — to je ono što se dokazuje. Podela
  // 0409/0410 se ispravlja tek reklasifikacijom u year-open (odeljak B).
  await atomTable(
    "AOP 0410 — rezultat ULAZI u kapital (nije nula)",
    "P341*-D341*",
    BOOK_A.years,
    ["60", "290", "590"],
    "OČEKIVANO",
  );

  console.log("\n" + "─".repeat(78));
  console.log("A2 · PUN OBRAZAC (svih 179 formula kroz BalanceSheetService)");
  console.log("─".repeat(78));
  const pre = await computeBoth(bsOld, BOOK_A.years);
  const post = await computeBoth(bsNew, BOOK_A.years);

  for (const y of BOOK_A.years) {
    console.log(`\n  ── ${y} ────────────────────────────────────────────`);
    console.log("   AOP  |     STARI MOTOR |      NOVI MOTOR | pozicija");
    for (const [aop, label] of AOP_OF_INTEREST) {
      console.log(
        `   ${aop} | ${fmt(pre.get(y)!.amounts.get(aop))} | ${fmt(post.get(y)!.amounts.get(aop))} | ${label}`,
      );
    }
    for (const [name, snap] of [
      ["STARI", pre.get(y)!],
      ["NOVI", post.get(y)!],
    ] as Array<[string, Snap]>) {
      const a = snap.amounts;
      const aktiva = a.get("0059") ?? new D(0);
      const pasiva = a.get("0456") ?? new D(0);
      const bsRez = (a.get("0410") ?? new D(0)).sub(a.get("0414") ?? new D(0));
      const buRez = (a.get("1055") ?? new D(0)).sub(a.get("1056") ?? new D(0));
      console.log(
        `   ${name.padEnd(5)} kontrola  aktiva−pasiva = ${aktiva.sub(pasiva).toFixed(2).padStart(12)}` +
          `   |  (0410−0414)−(1055−1056) = ${bsRez.sub(buRez).toFixed(2).padStart(12)}`,
      );
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("B · ISTA KNJIGA, ali PS prenosi rezultat 341 → 340 (ugovor t.5)");
  console.log("═".repeat(78));
  await seedBook(BOOK_B.company, BOOK_B.years, ACC.rezRanije);
  console.log("\n   godina | AOP 0409 (ranije) | AOP 0410 (tekuća) | 0409+0410");
  for (const y of BOOK_B.years) {
    const a0409 = await atom(gkNew, "P340*-D340*", y);
    const a0410 = await atom(gkNew, "P341*-D341*", y);
    console.log(
      `     ${y} | ${fmt(a0409)} | ${fmt(a0410)} | ${fmt(a0409.add(a0410))}`,
    );
  }

  console.log("\n" + "═".repeat(78));
  console.log("C · KONTROLA IZVORA — šta STVARNO proizvede year-open.service.ts");
  console.log("═".repeat(78));
  await seedBusiness(BOOK_C.company, BOOK_C.years[0], BOOK_C.years[0]);
  const r1 = await yearOpen.createYearOpen({
    fromYear: BOOK_C.years[0],
    toYear: BOOK_C.years[1],
    companyId: BOOK_C.company,
  });
  await seedBusiness(BOOK_C.company, BOOK_C.years[1], BOOK_C.years[0]);
  const r2 = await yearOpen.createYearOpen({
    fromYear: BOOK_C.years[1],
    toYear: BOOK_C.years[2],
    companyId: BOOK_C.company,
  });
  for (const [label, res] of [
    [`PS ${BOOK_C.years[1]} (prvi prenos)`, r1],
    [`PS ${BOOK_C.years[2]} (drugi prenos)`, r2],
  ] as Array<[string, any]>) {
    const lines = await prisma.$queryRawUnsafe<any[]>(
      `SELECT account_code, debit::text, credit::text FROM ledger_entries
        WHERE journal_entry_id = ${res.openingEntryId} ORDER BY account_code`,
    );
    console.log(`\n  ${label}:`);
    for (const l of lines) {
      console.log(
        `    ${l.account_code}  D=${String(l.debit).padStart(10)}  P=${String(l.credit).padStart(10)}`,
      );
    }
  }

  if (!keep) {
    for (const b of [BOOK_A, BOOK_B, BOOK_C]) await cleanupBook(b.company, b.years);
    // year-open je napravio i PS za godinu posle poslednje probne.
    await cleanupBook(BOOK_C.company, [BOOK_C.years[2] + 1]);
    console.log("\n  Zasejani podaci obrisani (--keep da ostanu).");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
