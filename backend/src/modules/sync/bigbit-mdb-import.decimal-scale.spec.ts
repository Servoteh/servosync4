import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYNC_MAP } from "./sync-map.generated";

/**
 * BRANA NAD SKALOM DECIMAL KOLONA (31.07.2026).
 *
 * Uvoz „neizmenjeno" meri poređenjem po koloni, a `Decimal` mora da se poredi na
 * TAČNOJ skali koju kolona u bazi čuva. Nalaz koji je do ovoga doveo: BigBit
 * cene drži kao `Double`, izvoz ispiše `80.09999999999999`, kolona je
 * `numeric(19,4)` i pri upisu zaokruži na `80.1000` — poređenje sirovih
 * vrednosti bi zato SVAKE NOĆI prijavilo ~91.000 „izmenjenih" artikala i uzalud
 * ih prepisalo, a prava izmena bi se izgubila u tom šumu.
 *
 * Spisak skala živi u `bigbit-mdb-import.service.ts` (`DECIMAL_SCALE_DEFAULT` +
 * `DECIMAL_SCALE_BY_FIELD`). Ovaj test čita `schema.prisma` i traži da se spisak
 * i šema poklope, pa promena skale u šemi ne može tiho da razmine poređenje.
 */

const SCHEMA = readFileSync(
  join(__dirname, "..", "..", "..", "prisma", "schema.prisma"),
  "utf8",
);
const SERVICE = readFileSync(
  join(__dirname, "bigbit-mdb-import.service.ts"),
  "utf8",
);

/** Skale `Decimal` kolona jednog Prisma modela: Prisma polje -> skala. */
function declaredScales(model: string): Record<string, number> {
  const block = new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`).exec(SCHEMA);
  if (!block) throw new Error(`schema.prisma nema model ${model}`);
  const out: Record<string, number> = {};
  for (const line of block[0].split("\n")) {
    const m = /^\s*(\w+)\s+Decimal\??[\s\S]*@db\.Decimal\(\s*\d+\s*,\s*(\d+)\s*\)/.exec(
      line,
    );
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Podrazumevana skala i izuzeci, pročitani iz samog servisa (jedna istina). */
function serviceScales(): {
  fallback: number;
  exceptions: Record<string, Record<string, number>>;
} {
  const fb = /const DECIMAL_SCALE_DEFAULT = (\d+);/.exec(SERVICE);
  if (!fb) throw new Error("servis više ne deklariše DECIMAL_SCALE_DEFAULT");
  const blockMatch =
    /const DECIMAL_SCALE_BY_FIELD: Record<string, Record<string, number>> = \{([\s\S]*?)\n\};/.exec(
      SERVICE,
    );
  if (!blockMatch)
    throw new Error("servis više ne deklariše DECIMAL_SCALE_BY_FIELD");
  const exceptions: Record<string, Record<string, number>> = {};
  const tableRe = /(\w+):\s*\{([^}]*)\}/g;
  for (let t = tableRe.exec(blockMatch[1]); t; t = tableRe.exec(blockMatch[1])) {
    const fields: Record<string, number> = {};
    const fieldRe = /(\w+):\s*(\d+)/g;
    for (let f = fieldRe.exec(t[2]); f; f = fieldRe.exec(t[2]))
      fields[f[1]] = Number(f[2]);
    exceptions[t[1]] = fields;
  }
  return { fallback: Number(fb[1]), exceptions };
}

/** Tabele koje uvoz poredi ovim putem, i njihovi Prisma modeli. */
const COMPARED: { table: string; model: string }[] = [
  { table: "items", model: "Item" },
  { table: "projects", model: "Project" },
];

describe("skala Decimal kolona — poređenje mora da meri kao baza", () => {
  it("servis i dalje deklariše i podrazumevanu skalu i spisak izuzetaka", () => {
    const { fallback, exceptions } = serviceScales();
    expect(fallback).toBe(4); // novac po BACKEND_RULES: Decimal(19,4)
    expect(exceptions).toEqual({ projects: { exchangeRate: 6 } });
  });

  it.each(COMPARED)(
    "svaka MAPIRANA Decimal kolona u `$table` ima skalu kakvu servis koristi",
    ({ table, model }) => {
      const { fallback, exceptions } = serviceScales();
      const schema = declaredScales(model);
      const mapped = (SYNC_MAP.find((m) => m.targetDb === table)?.columns ?? [])
        .filter((c) => c.type === "Decimal")
        .map((c) => c.field);
      expect(mapped.length).toBeGreaterThan(0);

      for (const field of mapped) {
        const inSchema = schema[field];
        // Kolona koju mapa smatra Decimal-om MORA biti Decimal i u šemi —
        // inače se poredi po pravilu koje ne odgovara koloni.
        expect(inSchema).toBeDefined();
        const used = exceptions[table]?.[field] ?? fallback;
        expect({ field, used }).toEqual({ field, used: inSchema });
      }
    },
  );

  it("nijedan izuzetak nije suvišan — spisak ne sme da nadživi kolonu", () => {
    const { exceptions } = serviceScales();
    for (const [table, fields] of Object.entries(exceptions)) {
      const model = COMPARED.find((c) => c.table === table)?.model;
      expect(model).toBeDefined();
      const schema = declaredScales(model as string);
      for (const field of Object.keys(fields))
        expect(schema[field]).toBe(fields[field]);
    }
  });
});
