import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SIROV SQL MORA DA GAĐA KOLONE KOJE STVARNO POSTOJE.
 * =============================================================================
 * POVOD (izmereno 05.08.2026): noćni uvoz iz BigBita je PAO na produkciji sa
 *
 *   Raw query failed. Code: `42703`.
 *   Message: `column "delivery_date" of relation "purchase_order_items_mirror" does not exist`
 *
 * Uzrok: `INSERT INTO purchase_order_items_mirror (…)` je pisao `delivery_date`, a
 * kolona se zove `actual_delivery_date`. Uveo PR #90 (`6ca0e44f`, 05.08.2026).
 *
 * ⚠️ ZAŠTO OVO NIJE UHVATILA NIJEDNA POSTOJEĆA BRANA: `schema.prisma` uz tu kolonu
 * IMA izričito upozorenje da je par `expected_*` / `actual_*` uveden baš zato što je
 * raniji sudar imena proizveo POGREŠAN zakonski rok od 15 dana na ulaznim fakturama,
 * i da je od tada „zabranjeno branom u `modules/sales/datum-prometa.spec.ts`". Ali ta
 * brana čuva SEMANTIKU u Prisma modelima — a `$queryRaw` ne prolazi kroz Prisma
 * klijent, pa ga ni tipovi ni ta brana ne vide. Sirov SQL je jedina rupa kroz koju
 * pogrešno ime kolone stigne do produkcije, i stiglo je.
 *
 * Ova brana zatvara baš tu rupu: čita imena kolona iz `schema.prisma` i poredi ih sa
 * onima koje uvoz zaista upisuje. Pada u testu, ne u 03:45 na produkciji.
 */

const ROOT = join(__dirname, "..", "..", "..");
const SCHEMA = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const IMPORT_SRC = readFileSync(
  join(__dirname, "bigbit-mdb-import.service.ts"),
  "utf8",
);

/** Kolone jedne tabele iz `schema.prisma`, po `@@map` imenu tabele. */
function kolonePoTabeli(tabela: string): Set<string> {
  // Model se nalazi tako što se traži blok koji sadrži `@@map("<tabela>")`.
  const modeli = SCHEMA.split(/\nmodel\s+/).slice(1);
  const blok = modeli.find((m) => m.includes(`@@map("${tabela}")`));
  if (!blok) throw new Error(`Nema modela sa @@map("${tabela}") u schema.prisma`);

  const kolone = new Set<string>();
  for (const linija of blok.split("\n")) {
    const red = linija.trim();
    if (!red || red.startsWith("//") || red.startsWith("@@")) continue;
    // `ime  Tip  @map("kolona")` → uzmi @map ako postoji, inače samo ime polja.
    const map = red.match(/@map\("([^"]+)"\)/);
    if (map) {
      kolone.add(map[1]);
      continue;
    }
    const polje = red.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+\w/);
    if (polje) kolone.add(polje[1]);
  }
  return kolone;
}

/** Spisak kolona iz `INSERT INTO <tabela> ( … )` u sirovom SQL-u uvoza. */
function koloneIzInserta(tabela: string): string[] {
  const re = new RegExp(
    `INSERT\\s+INTO\\s+${tabela}\\s*\\(([^)]*)\\)`,
    "gi",
  );
  const nadjene: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(IMPORT_SRC)) !== null) {
    for (const deo of m[1].split(",")) {
      const ime = deo.trim().replace(/\s+/g, " ");
      // Preskoči prazno i eventualne komentare u listi.
      if (ime && /^[a-z_][a-z0-9_]*$/i.test(ime)) nadjene.push(ime);
    }
  }
  return nadjene;
}

/** Ogledala koja uvoz puni sirovim SQL-om — spisak se širi kad se doda novo. */
const OGLEDALA = [
  "purchase_order_items_mirror",
  "purchase_orders_mirror",
];

describe("Uvoz iz BigBita — sirov SQL gađa kolone koje postoje u šemi", () => {
  it.each(OGLEDALA)(
    "%s: svaka kolona iz INSERT-a postoji u schema.prisma",
    (tabela) => {
      const uSemi = kolonePoTabeli(tabela);
      const uInsertu = koloneIzInserta(tabela);

      // Ako uvoz uopšte ne piše u tu tabelu sirovim SQL-om, nema šta da se proverava —
      // ali to je i signal da je spisak OGLEDALA zastareo, pa se traži bar jedan pogodak.
      expect(uInsertu.length).toBeGreaterThan(0);

      const nepostojece = [...new Set(uInsertu)].filter((k) => !uSemi.has(k));
      // Poruka nabraja SVE odjednom — ko ovo obori, treba da vidi celu sliku.
      expect({ tabela, nepostojece }).toEqual({ tabela, nepostojece: [] });
    },
  );

  it("ime `delivery_date` se NE koristi ni u jednom sirovom SQL-u uvoza", () => {
    // Doslovna zabrana dvoznačnog imena (v. zaglavlje). `expected_delivery_date` i
    // `actual_delivery_date` su dozvoljeni — traži se samo GOLO ime.
    const golo = IMPORT_SRC.match(/(?<![a-z_])delivery_date/gi) ?? [];
    expect(golo).toEqual([]);
  });
});
