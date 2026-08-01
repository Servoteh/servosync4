import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";

/**
 * UGOVOR ŠEME za pun ekran unosa dokumenata (docs/PLAN_UNOS_DOKUMENATA.md §5.1,
 * §5.3, §5.4 i odluke §8/O1, §8/O4).
 *
 * Ovaj spec NE testira poslovnu logiku — nje još nema. Testira ono što je jedini
 * proizvod ove stavke: da polja na koja se ostali gradioci oslanjaju POSTOJE, da
 * se zovu tačno tako, i da migracija koja ih uvodi seje registar onako kako je
 * odlučeno. Preimenovanje polja ili tiho brisanje reda iz seed-a obara test ovde,
 * a ne tri dana kasnije u tuđem modulu.
 *
 * Dva nivoa provere:
 *   1) `Prisma.*ScalarFieldEnum` — imena polja u GENERISANOM klijentu (dakle i
 *      `prisma generate` je morao da prođe);
 *   2) tekst migracije — semantika seed-a (grupa numeracije, profil ekrana,
 *      backfill osnovne cene), koju enum ne može da vidi.
 */

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260728150000_registar_vrsta_i_koeficijent_dokumenta",
    "migration.sql",
  ),
  "utf8",
);

/** Vrste koje po §8/O4.2 dele JEDAN godišnji niz `NNN/YY`. */
const INVOICE_OUT_TYPES = [
  "IFR",
  "IFGP",
  "IFUSL",
  "IZVRO",
  "IZVGP",
  "IZVUS",
] as const;

/** Red seed tabele `_reg_vrsta` iz migracije, kao lista kolona. */
function seedRow(code: string): string[] {
  const re = new RegExp(`^\\s*\\('${code}',(.*)$`, "m");
  const line = re.exec(MIGRATION_SQL);
  if (!line) throw new Error(`Seed red za vrstu ${code} ne postoji u migraciji.`);
  return line[1].split(",").map((cell) => cell.trim().replace(/\)[,;]?$/, ""));
}

describe("Registar vrsta dokumenata — ugovor šeme (§5.1)", () => {
  const fields = Object.keys(Prisma.DocumentTypeScalarFieldEnum);

  it.each([
    "numberingGroup",
    "numberingMode",
    "screenKind",
    "stockCheck",
    "reservesStock",
    "writesPriceList",
    "defaultPriceListCode",
    "defaultVatExemptionCode",
    "requiresProject",
    "requiresWorkOrder",
    "requiresPoNumber",
    "allowedPrintVariants",
    "carryOverTargets",
  ])("DocumentType.%s postoji u Prisma klijentu", (field) => {
    expect(fields).toContain(field);
  });

  it("kolone su snake_case u bazi, camelCase u modelu", () => {
    for (const [camel, snake] of [
      ["numberingGroup", "numbering_group"],
      ["screenKind", "screen_kind"],
      ["allowedPrintVariants", "allowed_print_variants"],
      ["carryOverTargets", "carry_over_targets"],
    ]) {
      expect(fields).toContain(camel);
      expect(MIGRATION_SQL).toContain(`"${snake}"`);
    }
  });

  it("dozvoljene vrednosti su ograničene CHECK-om, ali NULL prolazi", () => {
    // Vrste koje plan ne raspoređuje smeju da ostanu neopredeljene — ne dobijaju
    // izmišljenu vrednost samo zato što kolona postoji.
    expect(MIGRATION_SQL).toMatch(
      /chk_document_types_screen_kind[\s\S]*?"screen_kind" IS NULL OR "screen_kind" IN \('GOODS', 'SERVICE', 'ORDER'\)/,
    );
    expect(MIGRATION_SQL).toMatch(
      /chk_document_types_stock_check[\s\S]*?"stock_check" IS NULL OR "stock_check" IN \('BLOCK', 'WARN', 'OFF'\)/,
    );
  });
});

describe("Seed registra — odluke §8/O4", () => {
  it("svih šest izlaznih vrsta ide u JEDNU grupu numeracije INVOICE_OUT", () => {
    for (const code of INVOICE_OUT_TYPES) {
      expect(seedRow(code)).toContain("'INVOICE_OUT'");
    }
  });

  it("ponuda i predračun imaju svoju grupu (OFFER), avans svoju (ADVANCE)", () => {
    expect(seedRow("PON")).toContain("'OFFER'");
    expect(seedRow("PROF")).toContain("'OFFER'");
    // AVR u INVOICE_OUT bi napravio 100+ istorijskih sudara (§5.6).
    expect(seedRow("AVR")).toContain("'ADVANCE'");
    expect(seedRow("AVR")).not.toContain("'INVOICE_OUT'");
  });

  it("profil ekrana: roba GOODS, usluge SERVICE (§8/O4.4)", () => {
    for (const code of ["IFR", "IFGP", "IZVRO", "IZVGP"]) {
      expect(seedRow(code)).toContain("'GOODS'");
    }
    for (const code of ["IFUSL", "IZVUS"]) {
      expect(seedRow(code)).toContain("'SERVICE'");
    }
  });

  it("provera zaliha je isključena na predračunu i na uslugama (§2.7)", () => {
    for (const code of ["PON", "PROF", "IFUSL", "IZVUS"]) {
      expect(seedRow(code)).toContain("'OFF'");
    }
  });

  it("seed je nedestruktivan — postojeće vrste se dopunjuju samo gde je NULL", () => {
    expect(MIGRATION_SQL).toContain("WHERE NOT EXISTS");
    expect(MIGRATION_SQL).toMatch(/COALESCE\(d\."screen_kind", r\."screen_kind"\)/);
    expect(MIGRATION_SQL).toMatch(
      /COALESCE\(d\."numbering_group", r\."numbering_group"\)/,
    );
  });

  it("migracija NE dira numeraciju ni jedinstveni indeks broja (redosled §8/O4.4)", () => {
    // Prebacivanje ključa sekvence na grupu i obaranje uq_invoices_company_type_number
    // smeju tek POSLE uvoza istorije — svaki drugi redosled obara uvoz.
    expect(MIGRATION_SQL).not.toMatch(/DROP\s+INDEX[\s\S]*uq_invoices_company_type_number/i);
    expect(MIGRATION_SQL).not.toMatch(/ALTER TABLE "document_number_sequences"/i);
  });
});

describe("Koeficijent cene na dokumentu (§8/O1)", () => {
  it("Invoice nosi koeficijent + trag primene, InvoiceItem nosi osnovnu cenu", () => {
    const invoice = Object.keys(Prisma.InvoiceScalarFieldEnum);
    expect(invoice).toContain("priceCoefficient");
    expect(invoice).toContain("priceCoefficientAppliedAt");
    expect(invoice).toContain("priceCoefficientAppliedBy");
    expect(Object.keys(Prisma.InvoiceItemScalarFieldEnum)).toContain(
      "baseUnitPrice",
    );
  });

  it("koeficijent je podrazumevano 1 i ne sme biti 0 (dokument bi se utišao)", () => {
    expect(MIGRATION_SQL).toMatch(
      /"price_coefficient"\s+NUMERIC\(19, 6\) NOT NULL DEFAULT 1/,
    );
    expect(MIGRATION_SQL).toMatch(
      /chk_invoices_price_coefficient[\s\S]*?"price_coefficient" > 0/,
    );
  });

  it("osnovna cena je novac Decimal(19,4), ne float", () => {
    expect(MIGRATION_SQL).toMatch(
      /"base_unit_price" NUMERIC\(19, 4\) NOT NULL DEFAULT 0/,
    );
  });

  it("zatečene stavke dobijaju base_unit_price = unit_price (koeficijent je 1)", () => {
    // Bez backfill-a bi prvo otvaranje starog dokumenta prikazalo osnovnu cenu 0,
    // a onda bi „Primeni koeficijent" obrisao cene.
    expect(MIGRATION_SQL).toMatch(
      /UPDATE "invoice_items"[\s\S]*?SET "base_unit_price" = "unit_price"/,
    );
  });
});

describe("Profil stavki po dokumentu (§8/O4.5)", () => {
  it("Invoice.lineProfile postoji i sme biti prazan (= uzmi iz registra)", () => {
    expect(Object.keys(Prisma.InvoiceScalarFieldEnum)).toContain("lineProfile");
    expect(MIGRATION_SQL).toMatch(/"line_profile"\s+VARCHAR\(10\)(?!\s+NOT NULL)/);
  });

  it("dozvoljeno je samo GOODS ili SERVICE", () => {
    expect(MIGRATION_SQL).toMatch(
      /chk_invoices_line_profile[\s\S]*?"line_profile" IS NULL OR "line_profile" IN \('GOODS', 'SERVICE'\)/,
    );
  });
});
