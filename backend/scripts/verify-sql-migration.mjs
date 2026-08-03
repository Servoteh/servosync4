#!/usr/bin/env node
/**
 * verify-sql-migration.mjs — primeni SQL migraciju u transakciji, proveri, pa PONIŠTI.
 * ============================================================================
 *
 * ZAŠTO POSTOJI
 * SQL-only migracije (pogledi, funkcije, parcijalni indeksi, GRANT-ovi) Prisma ne
 * validira — ona ih samo prosledi bazi pri `migrate deploy`. Do tada niko ne zna ni da
 * li se parsiraju, a kamoli da li kolone koje pominju stvarno postoje. Prva greška se
 * vidi tek na deploy-u, na produkciji.
 *
 * Ovo je pusti kroz PRAVU bazu u transakciji i vrati `ROLLBACK` — dobiješ potpunu
 * proveru (sintaksa, imena kolona, tipovi, da agregati rade) bez ijedne trajne izmene.
 *
 * UPOTREBA
 *   DATABASE_URL=... node scripts/verify-sql-migration.mjs <folder-migracije> [--query "SELECT …"]
 *
 * Primer (pogled kretanja zaliha, provereno nad dev bazom 04.08.2026):
 *   DATABASE_URL=$(grep ^DATABASE_URL .env.dev | cut -d= -f2- | tr -d '"') \
 *   node scripts/verify-sql-migration.mjs prisma/migrations/20260804100000_v_stock_movements \
 *     --query "SELECT COUNT(*)::int AS n, COALESCE(SUM(signed_quantity),0)::text AS s FROM v_stock_movements"
 *
 * ⚠️ Gađaj DEV bazu. Iako je sve u transakciji koja se poništava, `CREATE`/`DROP` uzimaju
 * bravu na objektima — na produkciji bi to na trenutak blokiralo čitaoce.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const queryIdx = args.indexOf("--query");
const probe = queryIdx >= 0 ? args[queryIdx + 1] : null;

if (!dir) {
  console.error(
    "Upotreba: DATABASE_URL=... node scripts/verify-sql-migration.mjs <folder-migracije> [--query SQL]",
  );
  process.exit(2);
}
const file = existsSync(dir) && dir.endsWith(".sql") ? dir : join(dir, "migration.sql");
if (!existsSync(file)) {
  console.error(`Nema fajla: ${file}`);
  process.exit(2);
}

const raw = readFileSync(file, "utf8");
const sql = raw
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .trim();

/**
 * Podeli migraciju na pojedinačne naredbe.
 *
 * Prisma `$executeRawUnsafe` ide kroz prepared statement, koji NE prima više komandi
 * odjednom (`cannot insert multiple commands into a prepared statement`), pa deljenje
 * mora da postoji. Ali NE sme biti naivni `split(";")`:
 *   • tačka-zapeta ume da stoji unutar string literala (npr. u `COMMENT ON … IS '…;…'`),
 *   • i unutar `$$ … $$` tela funkcije, gde ih po pravilu ima više.
 * Naivno deljenje bi presekelo literal na pola i prijavilo lažnu grešku
 * „unterminated quoted string" — tačno to se i desilo pri prvoj proveri ove migracije.
 */
function splitStatements(text) {
  const out = [];
  let buf = "";
  let inSingle = false;
  let dollarTag = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (dollarTag) {
      buf += c;
      if (text.startsWith(dollarTag, i)) {
        buf += text.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingle) {
      buf += c;
      // '' unutar stringa je escape-ovan apostrof, ne kraj stringa.
      if (c === "'") {
        if (text[i + 1] === "'") {
          buf += "'";
          i++;
        } else inSingle = false;
      }
      continue;
    }
    if (c === "'") {
      inSingle = true;
      buf += c;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
    if (c === "$" && dollar) {
      dollarTag = dollar[0];
      buf += dollarTag;
      i += dollarTag.length - 1;
      continue;
    }
    if (c === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const statements = splitStatements(sql);

const prisma = new PrismaClient();
class Rollback extends Error {}
let ok = false;

try {
  await prisma.$transaction(async (tx) => {
    for (const s of statements) await tx.$executeRawUnsafe(s);
    console.log(
      `OK  migracija se primenila: ${file} (${statements.length} naredbi)`,
    );

    // Šta je novo nastalo (pogledi/tabele koje ova transakcija vidi) — gruba potvrda.
    const views = await tx.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`,
    );
    console.log(`OK  pogleda u šemi: ${views.length}`);

    if (probe) {
      const rows = await tx.$queryRawUnsafe(probe);
      console.log(`OK  kontrolni upit: ${JSON.stringify(rows)}`);
    }
    ok = true;
    throw new Rollback();
  });
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error(`GRESKA:\n${e.message}`);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}

if (ok) console.log("OK  ROLLBACK — baza je netaknuta.");
