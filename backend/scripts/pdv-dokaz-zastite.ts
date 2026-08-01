/**
 * DEV DOKAZ ZAŠTITE — vraća stanje „pre ispravke" na dev bazi i pokazuje da
 * obračun i štampa SADA javljaju grešku umesto da tiho izađu. Na kraju vraća
 * registar u ispravno stanje.
 *
 *   DATABASE_URL="…" JWT_SECRET="…" npx ts-node -T scripts/pdv-dokaz-zastite.ts
 */
import { NestFactory } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { VatLedgerService } from "../src/modules/pdv/vat-ledger.service";
import { PopdvService } from "../src/modules/pdv/popdv.service";
import { PdvPrintService } from "../src/modules/pdv/pdv-print.service";

const DEO3_TITLE =
  '╔══ DEO 3: „VAN PDV" STAVKA NE SME DA ONEMOGUĆI PP-PDV ════════════════╗';

const YEAR = 2026;
const MONTH = 3;

function short(e: unknown): string {
  const any = e as { getResponse?: () => unknown; message?: string };
  const body = typeof any.getResponse === "function" ? any.getResponse() : null;
  const msg =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: string }).message)
      : (any.message ?? String(e));
  return msg.replace(/\s*\n\s*/g, " ⏎ ");
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  const prisma = app.get(PrismaService);
  const ledger = app.get(VatLedgerService);
  const popdv = app.get(PopdvService);
  const print = app.get(PdvPrintService);

  console.log("\n╔══ DEO 1: DOKAZ ZAŠTITE — vraćamo pogrešno mapiranje konta 2050 ═══════╗");
  await prisma.$executeRaw`
    INSERT INTO vat_account_map (account, name, direction, rate, role)
    VALUES ('2050', 'Kupci u inostranstvu (izvoz, 0%)', 'output', 0, 'standard')
    ON CONFLICT (account) DO UPDATE SET direction = 'output', rate = 0`;
  console.log("  registar vraćen u pogrešno stanje (2050 kao izlazni PDV, stopa 0)\n");

  try {
    console.log("1) punjenje KIF/KUF za 03/2026:");
    const res = await ledger.buildKifKuf(YEAR, MONTH);
    console.log(`   ✗ PROŠLO BEZ GREŠKE (loše): ${JSON.stringify(res.sanity.problems)}`);
  } catch (e) {
    console.log(`   ✓ ZAUSTAVLJENO: ${short(e)}\n`);
  }

  try {
    console.log("2) obračun PDV (POPDV compute) za 03/2026:");
    await popdv.compute({ year: YEAR, month: MONTH });
    console.log("   ✗ PROŠLO BEZ GREŠKE (loše)");
  } catch (e) {
    console.log(`   ✓ ZAUSTAVLJENO: ${short(e)}\n`);
  }

  // Napuni knjige sa force da bismo dokazali i ponašanje ŠTAMPE nad lošim podacima.
  await ledger.buildKifKuf(YEAR, MONTH, { force: true });
  try {
    console.log("3) štampa KUF specifikacije za 03/2026:");
    await print.buildLedgerSpecPdf("input", YEAR, MONTH);
    console.log("   ✗ PROŠLO BEZ GREŠKE (loše)");
  } catch (e) {
    console.log(`   ✓ ZAUSTAVLJENO: ${short(e)}\n`);
  }

  console.log("4) ista štampa sa force=true (dijagnostički izlaz):");
  const forced = await print.buildLedgerSpecPdf("input", YEAR, MONTH, { force: true });
  console.log(
    `   ✓ PDF izdat (${forced.buffer.length} B) ali sa žigom „NEISPRAVAN OBRAČUN — NIJE ZA PREDAJU"; ` +
      `problema: ${forced.sanity.problems.length}\n`,
  );

  console.log("╚═══════════════════════════════════════════════════════════════════════╝");
  console.log("\nVraćam registar u ispravno stanje…");
  await prisma.$executeRaw`DELETE FROM vat_account_map WHERE account = '2050'`;
  const fixed = await ledger.buildKifKuf(YEAR, MONTH);
  const computed = await popdv.compute({ year: YEAR, month: MONTH });
  console.log(
    `  KIF ${fixed.kifCount} stavki · PDV ${fixed.outputVat.toFixed(2)} · osnovica ${fixed.outputBase.toFixed(2)}`,
  );
  console.log(
    `  KUF ${fixed.kufCount} stavki · PDV ${fixed.inputVat.toFixed(2)} · osnovica ${fixed.inputBase.toFixed(2)}`,
  );
  console.log(
    `  PP-PDV poz.110 (povraćaj) = ${new Prisma.Decimal(computed.vatLiability).neg().toFixed(2)}` +
      `  · BigBit 2790 = ${fixed.sanity.bigbitControl?.toFixed(2)}` +
      `  · razlika ${fixed.sanity.controlDiff?.toFixed(2)}`,
  );
  const pdf = await print.buildLedgerSpecPdf("input", YEAR, MONTH);
  console.log(`  štampa KUF prolazi: ${pdf.fileName} (${pdf.buffer.length} B), bez žiga\n`);

  // ── DEO 2 ────────────────────────────────────────────────────────────────
  // Ručna KIF/KUF stavka (dugme „Nova stavka", feature D4) NE SME da obori
  // period. Ranije je jedna jedina stavka trajno vraćala 409 na punjenju,
  // obračunu i obe štampe: kontrola je poredila CEO zbir knjige sa BigBit-ovim
  // nalogom zatvaranja, a ručna stavka po definiciji nema nalog u glavnoj knjizi.
  console.log("╔══ DEO 2: RUČNA KIF/KUF STAVKA NE SME DA OBORI PERIOD ═════════════════╗");
  const manual = await ledger.createManualEntry({
    direction: "input",
    documentNumber: "PROBE-RUCNA-1",
    documentDate: `${YEAR}-0${MONTH}-15`,
    taxPeriodYear: YEAR,
    taxPeriodMonth: MONTH,
    vatBase: 100000,
    vatAmount: 20000,
    vatRateCode: "20",
  });
  await runStep("1) punjenje KIF/KUF", () => ledger.buildKifKuf(YEAR, MONTH));
  const m2 = await runStep("2) obračun PDV (POPDV compute)", () =>
    popdv.compute({ year: YEAR, month: MONTH }),
  );
  await runStep("3) štampa KUF specifikacije", () =>
    print.buildLedgerSpecPdf("input", YEAR, MONTH),
  );
  await runStep("4) štampa PP-PDV obrasca", () =>
    print.buildPpPdvPdf(`${YEAR}-0${MONTH}`),
  );
  if (m2) {
    console.log(
      `   pretporez sa ručnom stavkom = ${new Prisma.Decimal(m2.inputVat).toFixed(2)} ` +
        `(GK 26.689.144,42 + 20.000,00)`,
    );
    const w = m2.sanity.warnings.find((x) => /ručno/.test(x));
    console.log(`   odstupnica prijavljena kao NAPOMENA: ${w ? "da" : "NE (loše)"}`);
  }

  // ── DEO 3 ────────────────────────────────────────────────────────────────
  // „Van PDV" (ulazni račun bez prava na odbitak — reprezentacija, putnički
  // automobil). Ranije je činio PP-PDV NEŠTAMPIVIM: `sumByRate` ga je brojala,
  // a `VatReturn.inputVat` ne — pa je provera „Σ pozicija = ukupno" pucala
  // tačno za njegov iznos.
  console.log(String.fromCharCode(10) + DEO3_TITLE);
  await ledger.updateManualEntry(manual.id, { noDeduction: true });
  await runStep("1) obračun PDV (POPDV compute)", () =>
    popdv.compute({ year: YEAR, month: MONTH }),
  );
  const vpPdf = await runStep("2) štampa PP-PDV obrasca", () =>
    print.buildPpPdvPdf(`${YEAR}-0${MONTH}`),
  );
  if (vpPdf) {
    console.log(
      `   PDF ${vpPdf.fileName} (${vpPdf.buffer.length} B), žig: ` +
        `${vpPdf.sanity.ok ? "NEMA (ispravan)" : "IMA (neispravan)"}`,
    );
  }

  // ── čišćenje: dev baza se vraća u polazno stanje ─────────────────────────
  await ledger.deleteManualEntry(manual.id);
  const final = await popdv.compute({ year: YEAR, month: MONTH });
  console.log(
    `\nčišćenje: ručna stavka obrisana · pretporez ${new Prisma.Decimal(final.inputVat).toFixed(2)} ` +
      `· obaveza ${new Prisma.Decimal(final.vatLiability).toFixed(2)}\n`,
  );

  await app.close();
}

/** Pokreni korak i prijavi PROLAZ/PAD bez rušenja celog dokaza. */
async function runStep<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const r = await fn();
    console.log(`   ✓ ${label}: PROLAZI`);
    return r;
  } catch (e) {
    console.log(`   ✗ ${label}: ZAUSTAVLJENO — ${short(e)}`);
    return null;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
