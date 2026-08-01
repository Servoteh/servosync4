/**
 * SMOKE: kontrolna pravila završnog računa nad STVARNOM uvezenom BigBit knjigom.
 * =========================================================================
 * Pokreće `ControlRulesService` kroz Nest DI nad dev bazom i ispisuje svako pravilo
 * sa obe strane, statusom i porukom. Uz to nezavisno (sopstvenim SQL-om, van servisa)
 * preračunava iste veličine — pa se vidi da leva strana dolazi iz obrasca, a desna iz
 * knjige, i da to nisu isti broj po konstrukciji.
 *
 * Drugi deo skripte dokazuje TRAG FORSIRANJA na privremenom obračunu (godina 1999):
 * finalizacija bez `force` mora biti odbijena, sa `force` mora upisati red u
 * `statement_control_overrides` i pojaviti se kao pseudo-pravilo na obračunu.
 * Privremeni obračun se briše na kraju — dev baza ostaje kakva je bila.
 *
 * Pokretanje:  npx ts-node --transpile-only scripts/smoke-zr-kontrole.ts [godina]
 */
import { readFileSync } from "fs";
import { join } from "path";

// DEV baza iz .env.dev (bez `?schema=public`) — MORA pre uvoza Prisma klijenta.
const envPath = join(__dirname, "..", ".env.dev");
const devUrl = readFileSync(envPath, "utf8").match(
  /DATABASE_URL="([^"]+)"/,
)?.[1];
if (!devUrl) throw new Error("DATABASE_URL nije nađen u backend/.env.dev");
process.env.DATABASE_URL = devUrl.replace("?schema=public", "");

/* eslint-disable import/first */
import { PrismaService } from "../src/prisma/prisma.service";
import { GkEvalService } from "../src/modules/zavrsni/gkeval.service";
import { ControlRulesService } from "../src/modules/zavrsni/control-rules.service";
import { BalanceSheetService } from "../src/modules/zavrsni/balance-sheet.service";
/* eslint-enable import/first */

const YEAR = Number(process.argv[2] ?? 2026);
const TEMP_YEAR = 1999;

let pass = 0;
let fail = 0;
function ok(name: string, detail = "") {
  pass += 1;
  console.log(`  OK   ${name}${detail ? " — " + detail : ""}`);
}
function bad(name: string, detail = "") {
  fail += 1;
  console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const prisma: any = new PrismaService();
  const gkEval = new GkEvalService(prisma);
  const controls: any = new ControlRulesService(prisma);
  const balance: any = new BalanceSheetService(prisma, gkEval, controls);

  // ── 1. Nezavisno merenje iz sirove knjige (van servisa) ───────────────────
  const classRows = await prisma.$queryRawUnsafe(
    `select left(le.account_code,1) k,
            (sum(le.debit)-sum(le.credit))::numeric(19,4) saldo
       from ledger_entries le join journal_entries je on je.id = le.journal_entry_id
      where je.year = $1 and je.status in ('POSTED','LOCKED')
      group by 1 order by 1`,
    YEAR,
  );
  const net = (classes: string[]) =>
    classRows
      .filter((r: any) => classes.includes(r.k))
      .reduce((a: number, r: any) => a + Number(r.saldo), 0);

  console.log(`\n=== SIROVA GLAVNA KNJIGA ${YEAR} (nezavisno od servisa) ===`);
  for (const r of classRows) {
    console.log(`  klasa ${r.k}: saldo ${r.saldo}`);
  }
  console.log(`  Σ klase 0–4 = ${net(["0", "1", "2", "3", "4"]).toFixed(2)}`);
  console.log(`  Σ klase 5–6 = ${net(["5", "6"]).toFixed(2)}`);
  console.log(`  Σ klase 7–9 = ${net(["7", "8", "9"]).toFixed(2)}`);

  // ── 2. Kontrole nad postojećim obračunima ─────────────────────────────────
  const statements = await prisma.financialStatement.findMany({
    where: { periodYear: YEAR },
    orderBy: { id: "asc" },
  });
  if (statements.length === 0) {
    bad(`obračuni za ${YEAR}`, "nema nijednog — pokreni bilanse pa ponovi");
  }
  for (const st of statements) {
    console.log(
      `\n=== ${st.statementType} ${st.periodYear} (id ${st.id}, ${st.status}) ===`,
    );
    const results = await controls.evaluateControls(st.id);
    for (const r of results) {
      console.log(
        `  [${r.status.padEnd(13)}] ${r.code.padEnd(22)} ${r.blocking ? "BLOKIRA" : "       "} ` +
          `L=${r.left} R=${r.right} Δ=${r.diff}`,
      );
      console.log(`      ${r.name}`);
      if (r.message) console.log(`      → ${r.message}`);
      for (const d of r.details) console.log(`        · ${d}`);
    }
    const blocking = results.filter((r: any) => r.blocking && !r.passed);
    if (blocking.length === 0) {
      ok(
        `${st.statementType}: nijedno blokirajuće pravilo ne pada (force nije potreban)`,
      );
    } else {
      bad(
        `${st.statementType}: blokirajuća pravila padaju`,
        blocking.map((b: any) => b.code).join(", "),
      );
    }
    if (results.some((r: any) => r.code === "GK_URAVNOTEZENA")) {
      ok(`${st.statementType}: kontrola izvora postoji i imenuje naloge`);
    }
  }

  // ── 3. Trag forsiranja na privremenom obračunu ────────────────────────────
  console.log(`\n=== TRAG FORSIRANJA (privremeni obračun ${TEMP_YEAR}) ===`);
  await prisma.financialStatement.deleteMany({
    where: { periodYear: TEMP_YEAR },
  });
  const temp = await prisma.financialStatement.create({
    data: {
      statementType: "BALANCE_SHEET",
      periodYear: TEMP_YEAR,
      status: "DRAFT",
      lines: {
        create: [
          // knjiga za 1999. je prazna → svaki nenulti obrazac se MORA raziću sa njom
          {
            aop: "0059",
            label: "UKUPNA AKTIVA",
            amount: "1000",
            formula: "D0*-P0*",
            ordinal: 1,
          },
          {
            aop: "0456",
            label: "UKUPNA PASIVA",
            amount: "400",
            formula: "A0401",
            ordinal: 2,
          },
          {
            aop: "0401",
            label: "KAPITAL",
            amount: "400",
            formula: "P30*-D30*",
            ordinal: 3,
          },
          {
            aop: "0410",
            label: "DOBITAK TEKUĆE",
            amount: "0",
            formula: "P341*-D341*",
            ordinal: 4,
          },
          {
            aop: "0414",
            label: "GUBITAK TEKUĆE",
            amount: "0",
            formula: "D351*-P351*",
            ordinal: 5,
          },
        ],
      },
    },
  });

  const before = await controls.evaluateControls(temp.id);
  const blockingBefore = before.filter((r: any) => r.blocking && !r.passed);
  if (blockingBefore.length > 0) {
    ok(
      "izmišljen obrazac pada na ukrsnoj kontroli",
      blockingBefore.map((b: any) => b.code).join(", "),
    );
  } else {
    bad("izmišljen obrazac je prošao sve kontrole — pravila ne rade");
  }

  try {
    await balance.finalizeStatement(temp.id, { userId: 1 });
    bad("finalizacija bez force", "prošla iako pravila padaju");
  } catch (e: any) {
    if (e?.code === "ZR_STATEMENT_CONTROLS_FAILED") {
      ok("finalizacija bez force je odbijena", e.message.slice(0, 90) + "…");
    } else {
      bad("finalizacija bez force", String(e));
    }
  }

  const forcedRes = await balance.finalizeStatement(temp.id, {
    force: true,
    userId: 1,
    reason: "smoke test",
  });
  if (forcedRes.forced && forcedRes.forcedRules.length > 0) {
    ok(
      "finalizacija sa force",
      `pregažena pravila: ${forcedRes.forcedRules.join(", ")}`,
    );
  } else {
    bad("finalizacija sa force", JSON.stringify(forcedRes));
  }

  const rows = await prisma.statementControlOverride.findMany({
    where: { statementId: temp.id },
  });
  if (rows.length === 1) {
    ok(
      "trag upisan u statement_control_overrides",
      `ko=${rows[0].forcedByEmail ?? rows[0].forcedByUserId}, palo=${(rows[0].failedRules as any[]).length}, ` +
        `snimak=${(rows[0].controlSnapshot as any[]).length} pravila, razlog="${rows[0].reason}"`,
    );
  } else {
    bad("trag upisan", `redova: ${rows.length}`);
  }

  const after = await controls.evaluateControls(temp.id);
  const trail = after.find((r: any) => r.code === "FORSIRANA_FINALIZACIJA");
  if (trail && after[0].code === "FORSIRANA_FINALIZACIJA") {
    ok("forsiranje se VIDI na obračunu", trail.message.slice(0, 110) + "…");
  } else {
    bad("forsiranje se ne vidi na obračunu");
  }

  await prisma.financialStatement.deleteMany({
    where: { periodYear: TEMP_YEAR },
  });
  const leftovers = await prisma.statementControlOverride.count({
    where: { statementId: temp.id },
  });
  if (leftovers === 0) {
    ok("privremeni obračun i trag obrisani (ON DELETE CASCADE)");
  } else {
    bad("ostao trag posle brisanja obračuna", String(leftovers));
  }

  console.log(`\n=== ${pass} prošlo / ${fail} palo ===`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
