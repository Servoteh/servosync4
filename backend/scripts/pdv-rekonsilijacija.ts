/**
 * DEV SMOKE — PDV REKONSILIJACIJA PROTIV BIGBITA.
 * =========================================================================
 * Jedini objektivni test paralelnog PDV obračuna: za svaki ZATVOREN mesec
 * godine poredi naš rezultat (pretporez − obaveza, kroz stvarne servise u Nest
 * DI kontekstu) sa BigBit-ovim odgovorom — saldom transitnih konta 2790/4790 u
 * mesečnom nalogu vrste `PDV`. Pada kad je razlika > 2,00 RSD (dozvoljeno je
 * samo zaokruženje obaveze na ceo dinar, koje BigBit knjiži na 6799/5799).
 *
 * Pokretanje (dev baza; NIKAD prod):
 *   DATABASE_URL="postgresql://…" npx ts-node -T scripts/pdv-rekonsilijacija.ts [godina]
 *
 * NAPOMENA: prolaz 6/6 dokazuje slaganje ZBIRA, ne i da je svaka KIF/KUF stavka
 * spremna za predaju (POPDV traži razvrstavanje po poljima 1.x–8.x). Nužan, ne
 * dovoljan uslov.
 */
import { NestFactory } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { VatLedgerService } from "../src/modules/pdv/vat-ledger.service";
import { PopdvService } from "../src/modules/pdv/popdv.service";
import {
  VAT_RECON_TOLERANCE,
  VAT_SETTLEMENT_ORDER_TYPE,
  VAT_TRANSIT_ACCOUNTS,
  fmtRsd,
} from "../src/modules/pdv/vat-sanity";

const D = Prisma.Decimal;
const year = Number(process.argv[2] ?? 2026);

/**
 * Implicitna stopa knjige (Σ PDV / Σ osnovica). Mora pasti između najniže i
 * najviše mapirane stope (10–20%) — sve van toga znači da neko konto skida PDV
 * a ne skida osnovicu. To je greška koju kontrola prema BigBitu NE vidi, jer
 * ona poredi samo iznos poreza.
 */
function implicitRate(vat: Prisma.Decimal, base: Prisma.Decimal): string {
  if (new D(base).isZero()) return "—";
  return new D(vat).div(new D(base)).mul(100).toFixed(1);
}

let pass = 0;
let fail = 0;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error"],
  });
  const prisma = app.get(PrismaService);
  const ledger = app.get(VatLedgerService);
  const popdv = app.get(PopdvService);

  console.log(`\nPDV REKONSILIJACIJA ${year} — naš obračun vs BigBit nalog zatvaranja\n`);
  console.log(
    "mesec | KIF stavki |     KIF PDV |   KIF osnov. | KIF% | KUF stavki |      KUF PDV |   KUF osnov. | KUF% |     naš (P−O) |   BigBit 2790/4790 | razlika",
  );
  console.log("-".repeat(170));

  for (let month = 1; month <= 12; month++) {
    // Postoji li uopšte promet u mesecu?
    const any = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      SELECT COUNT(*) AS n FROM journal_entries je
      WHERE je.status IN ('POSTED','LOCKED')
        AND EXTRACT(YEAR FROM je.posting_date) = ${year}
        AND EXTRACT(MONTH FROM je.posting_date) = ${month}`);
    if (Number(any[0]?.n ?? 0) === 0) continue;

    // BigBit-ov odgovor: saldo transitnih konta u nalogu vrste PDV.
    const ctrl = await prisma.$queryRaw<{ n: bigint; net: Prisma.Decimal | null }[]>(Prisma.sql`
      SELECT COUNT(*) AS n, COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS net
      FROM ledger_entries le JOIN journal_entries je ON je.id = le.journal_entry_id
      WHERE je.status IN ('POSTED','LOCKED')
        AND COALESCE(je.order_type_code,'') = ${VAT_SETTLEMENT_ORDER_TYPE}
        AND le.account_code IN (${Prisma.join([...VAT_TRANSIT_ACCOUNTS])})
        AND EXTRACT(YEAR FROM je.posting_date) = ${year}
        AND EXTRACT(MONTH FROM je.posting_date) = ${month}`);
    const hasControl = Number(ctrl[0]?.n ?? 0) > 0;
    const control = hasControl ? new D(ctrl[0]?.net ?? 0) : null;

    let line = `${String(month).padStart(2, "0")}/${year}`;
    try {
      const built = await ledger.buildKifKuf(year, month);
      const computed = await popdv.compute({ year, month });
      const ours = new D(computed.inputVat).sub(new D(computed.outputVat));
      const diff = control ? ours.sub(control) : null;

      line +=
        ` | ${String(built.kifCount).padStart(10)}` +
        ` | ${fmtRsd(built.outputVat).padStart(11)}` +
        ` | ${fmtRsd(built.outputBase).padStart(12)}` +
        ` | ${implicitRate(built.outputVat, built.outputBase).padStart(4)}` +
        ` | ${String(built.kufCount).padStart(10)}` +
        ` | ${fmtRsd(built.inputVat).padStart(12)}` +
        ` | ${fmtRsd(built.inputBase).padStart(12)}` +
        ` | ${implicitRate(built.inputVat, built.inputBase).padStart(4)}` +
        ` | ${fmtRsd(ours).padStart(13)}` +
        ` | ${(control ? fmtRsd(control) : "— (otvoren)").padStart(18)}` +
        ` | ${diff ? fmtRsd(diff) : "—"}`;

      if (diff && diff.abs().gt(VAT_RECON_TOLERANCE)) {
        fail += 1;
        console.log(`${line}   ← PAD (> ${fmtRsd(VAT_RECON_TOLERANCE)})`);
      } else {
        pass += 1;
        console.log(line);
      }
      for (const w of built.sanity.warnings) console.log(`        napomena: ${w}`);
    } catch (e) {
      fail += 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${line} | GREŠKA: ${msg.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }

  console.log("-".repeat(150));
  console.log(`\nREZULTAT: ${pass} prolaz / ${fail} pad\n`);
  await app.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
