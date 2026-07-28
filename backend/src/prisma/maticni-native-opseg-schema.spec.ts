import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma } from "@prisma/client";

import { NATIVE_ITEM_ID_BASE } from "../modules/masters/items.write-policy";
import {
  isAdditiveRefreshTable,
  isOwnedProductionTable,
  hasNativeColumns,
} from "../modules/sync/table-ownership";

/**
 * UGOVOR ŠEME za remedijaciju matičnih podataka (migracija
 * `20260728170000_maticni_native_opseg_i_poreklo`, adversarni pregled 28.07.2026).
 *
 * Ovaj spec NE testira poslovnu logiku — nje još nema, unos je i dalje zatvoren.
 * Testira ono što JESTE proizvod ove stavke: da brana protiv sudara ključeva
 * postoji i da je ISTA za komitente i za artikle, da marker porekla postoji pod
 * tačnim imenom, i da prateće tabele nisu završile ni u jednom sync skupu.
 *
 * Zašto baš ovako: sve četiri stvari se lako „poprave" tihim preimenovanjem ili
 * jednim dodatim redom u tuđem modulu. Kad se to desi, treba da padne test ovde,
 * a ne komitent prepisan tuđom firmom na produkciji.
 *
 * Tri nivoa provere:
 *   1) `Prisma.*ScalarFieldEnum` — imena polja u GENERISANOM klijentu (dakle i
 *      `prisma generate` je morao da prođe nad izmenjenom šemom);
 *   2) tekst `schema.prisma` — tipovi koje enum ne vidi (Decimal vs Float, širina);
 *   3) tekst migracije — DB brane (CHECK, trigger, setval) koje ne postoje kao
 *      Prisma koncept.
 */

const MIGRATION_SQL = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "prisma",
    "migrations",
    "20260728170000_maticni_native_opseg_i_poreklo",
    "migration.sql",
  ),
  "utf8",
);

const SCHEMA_PRISMA = readFileSync(
  join(__dirname, "..", "..", "prisma", "schema.prisma"),
  "utf8",
);

/** Granica rezervisanog opsega ključeva — jedan broj za obe tabele. */
const NATIVE_ID_BASE = 900_000_000;

/** `Int` kolona je PG `integer` → tvrd plafon prostora ključeva. */
const INT4_MAX = 2_147_483_647;

/** Devet cenovnih kolona artikla koje su bile `Float` (BigBit `Double`). */
const ITEM_MONEY_FIELDS = [
  "wholesalePrice",
  "retailPrice",
  "fxPurchasePrice",
  "fxSalePrice",
  "priceToWritePricelist",
  "itemFee",
  "itemExcise",
  "nonTaxablePart",
  "finalProcessingCost",
] as const;

/**
 * Izvršni deo migracije — bez `--` komentara. Zaglavlje migracije NAMERNO
 * imenuje prekidače (`CUSTOMERS_WRITE_OPEN`, `sync-map.generated.ts`) da bi
 * objasnilo šta migracija NE radi; provera da ih ne dira mora gledati SQL koji
 * se stvarno izvršava, ne prozu oko njega.
 */
const MIGRATION_BODY = MIGRATION_SQL.replace(/^\s*--.*$/gm, "").replace(
  /\s--[^\n]*$/gm,
  "",
);

/** Izvuci telo `model X { … }` iz teksta schema.prisma. */
function modelBlock(name: string): string {
  const re = new RegExp(`^model ${name} \\{$([\\s\\S]*?)^\\}$`, "m");
  const m = re.exec(SCHEMA_PRISMA);
  if (!m) throw new Error(`Model ${name} ne postoji u schema.prisma.`);
  return m[1];
}

describe("Matični podaci — rezervisan opseg ključeva (nalaz [1])", () => {
  it("granica je ISTA za komitente i za artikle — jedno pravilo, ne dva paketa", () => {
    // Artikli su granicu izabrali prvi; komitenti je preuzimaju bez odstupanja.
    expect(NATIVE_ITEM_ID_BASE).toBe(NATIVE_ID_BASE);
  });

  it("granica staje u int4 i ostavlja upotrebljiv prostor sa obe strane", () => {
    // BigBit prostor: MAX artikla 127.584, MAX komitenta 1.006.067 (mereno 28.07.2026).
    expect(NATIVE_ID_BASE).toBeGreaterThan(10_000_000);
    // 4.0-native prostor mora ostati veći od BigBit potrošnje, ne simboličan.
    expect(INT4_MAX - NATIVE_ID_BASE).toBeGreaterThan(1_000_000_000);
  });

  it("migracija pomera sekvence OBE tabele iznad BigBit prostora", () => {
    expect(MIGRATION_SQL).toMatch(/ARRAY\['customers',\s*'items'\]/);
    expect(MIGRATION_SQL).toContain("PERFORM setval(seq, target, true)");
    expect(MIGRATION_SQL).toContain(`base    bigint := ${NATIVE_ID_BASE}`);
  });

  it("setval je IDEMPOTENTAN — trenutna pozicija sekvence ulazi u GREATEST", () => {
    // Bez `cur` u GREATEST-u drugi prolaz bi vratio sekvencu unazad i ponovo
    // izdao već potrošene native id-jeve.
    expect(MIGRATION_SQL).toContain("GREATEST(base - 1, max_nat, cur)");
    expect(MIGRATION_SQL).toMatch(
      /last_value - \(CASE WHEN is_called THEN 0 ELSE 1 END\)/,
    );
  });

  it("opseg je zaključan CHECK-om (važi i u `replica` režimu), ne konvencijom", () => {
    // Ovo je ono što stvarno ubija nalaz [1]: native red FIZIČKI ne može da sedne
    // u BigBit prostor, pa ga `upsert({where:{id}})` nikad ne može pogoditi.
    for (const table of ["customers", "items"]) {
      expect(MIGRATION_SQL).toContain(`chk_${table}_native_id_range`);
    }
    expect(MIGRATION_SQL).toMatch(
      /CHECK \(\("source" = 'NATIVE'\) = \("id" >= 900000000\)\)/,
    );
  });
});

describe("Matični podaci — marker porekla (nalaz [3] i [4])", () => {
  it("`customers` ima `source` i `bbSifra` u generisanom klijentu", () => {
    const fields = Object.keys(Prisma.CustomerScalarFieldEnum);
    expect(fields).toContain("source");
    expect(fields).toContain("bbSifra");
  });

  it("`items` ima `source` — `externalItemId` sam za sebe NIJE dovoljan", () => {
    // 1.417 od 92.511 BigBit artikala ima `external_item_id = 0` (mereno 28.07.2026).
    const fields = Object.keys(Prisma.ItemScalarFieldEnum);
    expect(fields).toContain("source");
    expect(fields).toContain("externalItemId");
  });

  it("default je BIGBIT u obe tabele — smer greške mora biti read-only", () => {
    // Pisac koji za kolonu ne zna (danas `customer.syncer.ts`, koji mapira 56
    // kolona) mora proizvesti NEIZMENJIV red. Obrnut default bi značio da BigBit
    // red postane izmenjiv, a izmena nestane na sledećem delta prolazu.
    for (const model of ["Customer", "Item"]) {
      expect(modelBlock(model)).toMatch(
        /source\s+String\s+@default\("BIGBIT"\)/,
      );
    }
    expect(MIGRATION_SQL).toMatch(
      /"source"\s+VARCHAR\(10\) NOT NULL DEFAULT 'BIGBIT'/,
    );
  });

  it("`bb_sifra` puni trigger koji radi i pod `session_replication_role='replica'`", () => {
    // ENABLE ALWAYS je jedini razlog zašto `customer.syncer.ts` sme da ostane
    // netaknut: obični (ORIGIN) trigeri u replica režimu ne rade.
    expect(MIGRATION_SQL).toContain(
      'ALTER TABLE "customers" ENABLE ALWAYS TRIGGER "trg_customers_bb_sifra"',
    );
    expect(MIGRATION_SQL).toContain("chk_customers_bb_sifra_origin");
  });

  it("jedna BigBit šifra pripada najviše jednom redu", () => {
    expect(modelBlock("Customer")).toMatch(
      /bbSifra\s+Int\?\s+@unique\(map: "uq_customers_bb_sifra"\)/,
    );
  });
});

describe("Matični podaci — faleće kolone (stavka C)", () => {
  it("svih 9 cenovnih kolona artikla je Decimal(19,4), nijedna nije ostala Float", () => {
    const item = modelBlock("Item");
    for (const field of ITEM_MONEY_FIELDS) {
      const line = new RegExp(`^\\s*${field}\\s+(\\S+).*$`, "m").exec(item);
      expect(line).not.toBeNull();
      expect(`${field}: ${line![1]}`).toBe(`${field}: Decimal?`);
      expect(new RegExp(`${field}[^\\n]*@db\\.Decimal\\(19, 4\\)`).test(item)).toBe(
        true,
      );
    }
  });

  it("migracija kastuje kroz ROUND(...::numeric, 4) i vraća DEFAULT", () => {
    // Mereno na svih 92.511 produkcionih redova: 0 promenjenih vrednosti,
    // 0 overflow, 0 NaN — konverzija je tačna, ne „približna".
    for (const col of [
      "wholesale_price",
      "retail_price",
      "fx_purchase_price",
      "fx_sale_price",
      "price_to_write_pricelist",
      "item_fee",
      "item_excise",
      "non_taxable_part",
      "final_processing_cost",
    ]) {
      expect(MIGRATION_SQL).toContain(
        `TYPE NUMERIC(19,4) USING ROUND("${col}"::numeric, 4)`,
      );
      expect(MIGRATION_SQL).toContain(`ALTER COLUMN "${col}"`);
    }
  });

  it("`items.shelf` je proširen na 20 (BigBit `Polica` je Text(20))", () => {
    expect(modelBlock("Item")).toMatch(/shelf\s+String\?.*@db\.VarChar\(20\)/);
  });

  it("`items` ima trag izmene u vremenu (`updatedAt` + ko)", () => {
    const fields = Object.keys(Prisma.ItemScalarFieldEnum);
    expect(fields).toContain("updatedAt");
    expect(fields).toContain("updatedBy");
  });

  it("`customers` ima 57. BigBit kolonu `KoristiPNBZadModel`", () => {
    expect(Object.keys(Prisma.CustomerScalarFieldEnum)).toContain(
      "usesPaymentReferenceModel",
    );
  });
});

describe("Matični podaci — prateće tabele komitenta (stavka D)", () => {
  it("`customer_contacts` nosi polja BigBit `KomitentiKontaktOsobe`", () => {
    const fields = Object.keys(Prisma.CustomerContactScalarFieldEnum);
    for (const f of [
      "customerId",
      "contactName",
      "phone",
      "fax",
      "mobile",
      "email",
      "birthDate",
      "isDefault",
    ]) {
      expect(fields).toContain(f);
    }
  });

  it("`customer_delivery_locations` nosi SOPSTVENI GLN (SEF po lokaciji)", () => {
    const fields = Object.keys(Prisma.CustomerDeliveryLocationScalarFieldEnum);
    for (const f of [
      "customerId",
      "name",
      "city",
      "address",
      "gln",
      "salespersonId",
      "paymentAccountId",
      "routeId",
      "driverId",
      "region",
      "active",
    ]) {
      expect(fields).toContain(f);
    }
  });

  it("obe tabele su VAN svakog sync skupa — BigBit ih ne šalje kroz našu kopiju", () => {
    for (const t of ["customer_contacts", "customer_delivery_locations"]) {
      expect(isOwnedProductionTable(t)).toBe(false);
      expect(isAdditiveRefreshTable(t)).toBe(false);
      expect(hasNativeColumns(t)).toBe(false);
    }
  });

  it("brisanje komitenta sa decom pada GLASNO (Restrict, ne Cascade)", () => {
    // Ceo paket postoji zbog tihog gubitka podataka — kaskadno brisanje kontakata
    // bilo bi ista greška u novom ruhu.
    for (const model of ["CustomerContact", "CustomerDeliveryLocation"]) {
      expect(modelBlock(model)).toMatch(/onDelete: Restrict/);
    }
    expect(MIGRATION_SQL).not.toMatch(/REFERENCES "customers".*ON DELETE CASCADE/);
  });
});

describe("Matični podaci — migracija NE otvara nijedan prekidač", () => {
  it("`items` i dalje ne preživljava sync, pa upis ostaje zatvoren", () => {
    // Cilj talasa je bio da se unos posle otvara PREKLAPANJEM JEDNOG PREKIDAČA,
    // a ne da se otvori sada. Ako neko ovo obori zajedno sa ovim testom, mora
    // svesno da promeni i `sync/table-ownership.ts`.
    expect(isOwnedProductionTable("items")).toBe(false);
    expect(isAdditiveRefreshTable("items")).toBe(false);
    expect(hasNativeColumns("items")).toBe(false);
  });

  it("izvršni SQL ne dira sync mapu, prekidače ni sync bookkeeping", () => {
    expect(MIGRATION_BODY).not.toMatch(/sync-map|CUSTOMERS_WRITE_OPEN/);
    expect(MIGRATION_BODY).not.toMatch(/\b(sync_state|sync_cursors|sync_runs)\b/);
  });
});
