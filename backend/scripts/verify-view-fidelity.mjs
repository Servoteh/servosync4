/**
 * Provera VERNOSTI pogleda `v_stock_movements` — daje li isti broj kao stari upiti.
 *
 * Refaktor od 04.08. zamenio je 10 prepisanih predikata jednim pogledom. Testovi to ne mogu
 * da dokažu (mockuju `$queryRaw`), a jednakost mora da važi nad PRAVOM bazom, po svakom
 * (artikal, magacin) paru. Ovo pušta STARI i NOVI upit jedan uz drugi i traži razliku.
 *
 * STARI upit je prepisan doslovno iz `git show origin/main:.../costing.service.ts` i
 * `listLager` agregata pre refaktora.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OLD = `
  SELECT sdi.item_id, sdi.warehouse_id,
         SUM(CASE WHEN dt.is_inbound THEN sdi.quantity ELSE -sdi.quantity END) AS on_hand,
         SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
             (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier)
         ) AS weighted_nab,
         SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
             sdi.calculated_wholesale_price) AS weighted_vp,
         SUM(CASE WHEN dt.is_inbound THEN 1 ELSE -1 END * sdi.quantity *
             COALESCE(NULLIF(sdi.calculated_retail_price, 0), sdi.actual_retail_price)) AS weighted_mp,
         COUNT(*)::int AS n
  FROM stock_document_items sdi
  JOIN stock_documents sd ON sd.id = sdi.document_id
  JOIN document_types dt ON dt.code = sd.document_type_code
  WHERE sd.document_type_code <> 'KODJ'
    AND COALESCE(dt.affects_stock, TRUE) = TRUE
    AND sdi.deleted_at IS NULL
  GROUP BY sdi.item_id, sdi.warehouse_id
`;

const NEW = `
  SELECT m.item_id, m.warehouse_id,
         SUM(m.signed_quantity)                        AS on_hand,
         SUM(m.signed_quantity * m.unit_purchase_net)  AS weighted_nab,
         SUM(m.signed_quantity * m.unit_wholesale)     AS weighted_vp,
         SUM(m.signed_quantity * m.unit_retail)        AS weighted_mp,
         COUNT(*)::int AS n
  FROM v_stock_movements m
  GROUP BY m.item_id, m.warehouse_id
`;

/** Poslednji ULAZ po (artikal, magacin) — `CostingService.lastPrice`, stara i nova verzija. */
const OLD_LAST = `
  SELECT DISTINCT ON (sdi.item_id, sdi.warehouse_id)
         sdi.item_id, sdi.warehouse_id,
         (sdi.purchase_price_net + sdi.dependent_cost_own + sdi.dependent_cost_supplier) AS last_nab,
         sdi.calculated_wholesale_price AS last_vp
  FROM stock_document_items sdi
  JOIN stock_documents sd ON sd.id = sdi.document_id
  JOIN document_types dt ON dt.code = sd.document_type_code
  WHERE sd.document_type_code <> 'KODJ'
    AND COALESCE(dt.affects_stock, TRUE) = TRUE
    AND dt.is_inbound = TRUE
    AND sdi.deleted_at IS NULL
  ORDER BY sdi.item_id, sdi.warehouse_id, sd.document_date DESC, sd.id DESC, sdi.id DESC
`;
const NEW_LAST = `
  SELECT DISTINCT ON (m.item_id, m.warehouse_id)
         m.item_id, m.warehouse_id,
         m.unit_purchase_net AS last_nab,
         m.unit_wholesale    AS last_vp
  FROM v_stock_movements m
  WHERE m.is_inbound = TRUE
  ORDER BY m.item_id, m.warehouse_id, m.document_date DESC, m.document_id DESC, m.item_line_id DESC
`;

const key = (r) => `${r.item_id}:${r.warehouse_id}`;
const num = (v) => (v == null ? "0" : String(v));

function compare(label, a, b, cols) {
  const ma = new Map(a.map((r) => [key(r), r]));
  const mb = new Map(b.map((r) => [key(r), r]));
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const diffs = [];
  for (const k of keys) {
    const x = ma.get(k);
    const y = mb.get(k);
    if (!x || !y) {
      diffs.push(`${k}: postoji samo u ${x ? "STAROM" : "NOVOM"}`);
      continue;
    }
    for (const c of cols) {
      if (num(x[c]) !== num(y[c]))
        diffs.push(`${k}.${c}: staro=${num(x[c])} novo=${num(y[c])}`);
    }
  }
  console.log(
    `${label}: ${keys.size} parova · ${diffs.length === 0 ? "IDENTIČNO" : `${diffs.length} RAZLIKA`}`,
  );
  diffs.slice(0, 20).forEach((d) => console.log("   ", d));
  return diffs.length;
}

// Pogled se pravi UNUTAR transakcije koja se na kraju poništava — dev baza ostaje netaknuta.
import { readFileSync } from "node:fs";
const viewSql = readFileSync(
  "prisma/migrations/20260804100000_v_stock_movements/migration.sql",
  "utf8",
)
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const createView = viewSql.slice(0, viewSql.indexOf("COMMENT ON VIEW")).trim().replace(/;\s*$/, "");

class Done extends Error {
  constructor(payload) {
    super("done");
    this.payload = payload;
  }
}

/**
 * Zaseje kretanja koja gađaju BAŠ IZUZETKE — tamo se refaktor predikata lomi, a ne na
 * običnom ulazu/izlazu. Sve ostaje u transakciji koja se poništava.
 *
 * Pokriveno: ulaz · izlaz · KODJ (mora biti izuzet) · `affects_stock=false` (izuzet) ·
 * meko obrisana stavka (izuzeta) · `calculated_retail_price=0` sa popunjenom `actual_retail_price`
 * (fallback za `unit_retail`) · dva ulaza različitih datuma (redosled za `lastPrice`).
 */
async function seed(tx) {
  const T = 990001; // visok id da se ne sudari sa zatečenim podacima
  // Bez `ON CONFLICT (code)` — dev šema možda nema taj unique, a duplirana vrsta bi
  // udvostručila JOIN i za STARI i za NOVI upit (jednakost bi ostala, merenje ne bi).
  const want = [
    ['ZUL', 'test ulaz', true, true],
    ['ZIZ', 'test izlaz', false, true],
    ['KODJ', 'test kodj', true, true],
    ['ZNS', 'test bez zaliha', true, false],
  ];
  const have = await tx.$queryRawUnsafe(
    `SELECT code FROM document_types WHERE code IN ('ZUL','ZIZ','KODJ','ZNS')`,
  );
  const haveSet = new Set(have.map((r) => r.code));
  for (const [code, desc, inb, aff] of want) {
    if (haveSet.has(code)) continue;
    await tx.$executeRawUnsafe(
      `INSERT INTO document_types (code, description, is_inbound, affects_stock)
       VALUES ($1, $2, $3, $4)`,
      code, desc, inb, aff,
    );
  }
  const docs = [
    ['ZUL', '2026-01-10'], ['ZUL', '2026-03-05'], ['ZIZ', '2026-04-01'],
    ['KODJ', '2026-02-01'], ['ZNS', '2026-02-15'], ['ZUL', '2026-05-20'],
  ];
  const ids = [];
  for (const [code, date] of docs) {
    const r = await tx.$queryRawUnsafe(
      `INSERT INTO stock_documents (company_id, kind, document_type_code, document_number, year,
                                    warehouse_id, document_date, posting_date, status)
       VALUES (0, 'UL', $1, $2, 2026, ${T}, $3::timestamptz, $3::timestamptz, 'POSTED')
       RETURNING id`,
      code, `T-${code}-${date}`, date,
    );
    ids.push(r[0].id);
  }
  // (docId, qty, nab, ztSop, ztDob, kalkVP, kalkMP, stvarnaMP, softDelete)
  const lines = [
    [ids[0], 100, 50, 1, 2, 70, 90, 95, false],
    [ids[1], 40, 60, 0, 0, 80, 0, 99, false],   // kalkMP=0 -> fallback na stvarnu MP
    [ids[2], 30, 0, 0, 0, 0, 0, 0, false],       // izlaz
    [ids[3], 999, 111, 0, 0, 111, 111, 111, false], // KODJ — mora biti izuzet
    [ids[4], 888, 222, 0, 0, 222, 222, 222, false], // affects_stock=false — izuzet
    [ids[5], 55, 70, 0, 0, 85, 100, 100, true],  // meko obrisana — izuzeta
  ];
  for (const [d, q, nab, zs, zd, vp, mp, amp, del] of lines) {
    await tx.$executeRawUnsafe(
      `INSERT INTO stock_document_items (document_id, item_id, warehouse_id, quantity,
         purchase_price_net, dependent_cost_own, dependent_cost_supplier,
         calculated_wholesale_price, calculated_retail_price, actual_retail_price, deleted_at)
       VALUES ($1, ${T}, ${T}, $2, $3, $4, $5, $6, $7, $8, ${del ? 'now()' : 'NULL'})`,
      d, q, nab, zs, zd, vp, mp, amp,
    );
  }
}

let oldAgg, newAgg, oldLast, newLast;
try {
  await prisma.$transaction(async (tx) => {
    await seed(tx);
    await tx.$executeRawUnsafe(createView);
    const a = await tx.$queryRawUnsafe(OLD);
    const b = await tx.$queryRawUnsafe(NEW);
    const c = await tx.$queryRawUnsafe(OLD_LAST);
    const d = await tx.$queryRawUnsafe(NEW_LAST);
    throw new Done([a, b, c, d]);
  });
} catch (e) {
  if (!(e instanceof Done)) throw e;
  [oldAgg, newAgg, oldLast, newLast] = e.payload;
}

const totalRows = oldAgg.reduce((s, r) => s + r.n, 0);
console.log(`Baza ima ${totalRows} redova kretanja u ${oldAgg.length} (artikal, magacin) parova.`);
if (totalRows < 50)
  console.log(
    "⚠️ MALO PODATAKA — jednakost je dokazana samo na ovom uzorku, nije dokaz za produkciju.",
  );

// Izričita tvrdnja o IZUZECIMA — ne zaključuj iz ukupnog broja redova.
// Zasejano je 6 stavki na paru 990001:990001; proći smeju samo 3 (ulaz 100, ulaz 40, izlaz 30):
// KODJ, `affects_stock=false` i meko obrisana stavka moraju biti izuzete. Stanje = 100+40−30 = 110.
const seededNew = newAgg.find((r) => Number(r.item_id) === 990001);
const seededOld = oldAgg.find((r) => Number(r.item_id) === 990001);
let bad = 0;
for (const [label, row] of [["NOVI", seededNew], ["STARI", seededOld]]) {
  if (!row) {
    console.log(`✗ ${label}: zasejani par 990001 se ne vidi — test ne meri izuzetke!`);
    bad++;
    continue;
  }
  const okN = Number(row.n) === 3;
  const okQ = String(row.on_hand) === "110.000000" || Number(row.on_hand) === 110;
  console.log(
    `Izuzeci (${label}): prošlo ${row.n}/6 stavki ${okN ? "✓" : "✗ (očekivano 3)"} · stanje ${row.on_hand} ${okQ ? "✓" : "✗ (očekivano 110)"}`,
  );
  if (!okN || !okQ) bad++;
}

bad += compare("Agregat (stanje + ponderi)", oldAgg, newAgg, [
  "on_hand",
  "weighted_nab",
  "weighted_vp",
  "weighted_mp",
  "n",
]);
bad += compare("Poslednja cena (lastPrice)", oldLast, newLast, ["last_nab", "last_vp"]);

await prisma.$disconnect();
console.log(bad === 0 ? "\n✓ Prelaz na pogled je VERAN na ovim podacima." : `\n✗ ${bad} razlika — refaktor NIJE veran.`);
process.exitCode = bad === 0 ? 0 : 1;
