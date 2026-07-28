/**
 * JEDNOKRATNI uvoz istorijskih Excel redova (škart + dorada) u `quality_events`
 * (MODULE_SPEC_kvalitet_skart_dorada §2). ~150 redova iz 2 postojeća Excel fajla.
 *
 * ⚠️ NE POKREĆE SE NA PRODU BEZ POTVRDE. Podrazumevano je DRY-RUN (samo ispisuje
 * šta bi upisao). Skripta je NAMERNO van migracije (jednokratni podatak, ne šema)
 * i van nest build-a (`scripts/` je isključen iz tsconfig.build.json).
 *
 * Zavisnosti: BEZ novih (xlsx paket NIJE u repou). Zato ulaz nisu .xlsx nego CSV
 * EXPORT-i tih Excel fajlova (Excel → „Sačuvaj kao" → CSV UTF-8). Kolonske glave
 * se mapiraju u `COLUMN_MAP` ispod — PODESITI prema stvarnim naslovima kolona pre
 * pokretanja (naslovi nisu bili poznati pri gradnji V1).
 *
 * Pokretanje (iz backend/):
 *   # 1) proba na DEV bazi (5437), samo ispis:
 *   DATABASE_URL=<dev> npx ts-node --transpile-only scripts/import-quality-events-excel.ts \
 *       --skart ../_legacy/skart.csv --dorada ../_legacy/dorada.csv
 *   # 2) stvaran upis na DEV bazi:
 *   DATABASE_URL=<dev> npx ts-node --transpile-only scripts/import-quality-events-excel.ts \
 *       --skart ... --dorada ... --apply
 *   # Prod je zaključan: traži i --force-prod (svesna odluka vlasnika, posle provere na dev-u).
 */
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";

const prisma = new PrismaClient();

/** Naslovi kolona u CSV-u → logička polja. PODESITI prema stvarnom Excel-u. */
const COLUMN_MAP = {
  /** RN broj (ident) — traži se `work_orders` po ident_number. */
  rn: "RN",
  /** Datum događaja (dd.MM.yyyy ili ISO). */
  date: "Datum",
  /** Količina (broj). */
  qty: "Kolicina",
  /** Naziv/kod razloga — mapira se na `quality_reason_codes` (label ILI code, case-insensitive). */
  reason: "Razlog",
  /** Radna jedinica / mašina (RC kod) — opciono. */
  workUnit: "RadnaJedinica",
  /** Napomena — opciono. */
  note: "Napomena",
} as const;

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    skart: get("--skart"),
    dorada: get("--dorada"),
    apply: a.includes("--apply"),
    forceProd: a.includes("--force-prod"),
  };
}

/** Minimalni CSV parser (zarez separator, "" escaping) — bez novih zavisnosti. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) =>
      Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])),
    );
}

function parseDate(s: string): Date | null {
  const dmy = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(s.trim());
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadFile(
  path: string | undefined,
  type: "SKART" | "DORADA",
): Promise<Array<Record<string, string>> & { _type?: string }> {
  if (!path) return [];
  const text = fs.readFileSync(path, "utf8");
  const rows = parseCsv(text);
  console.log(`  ${type}: ${rows.length} redova iz ${path}`);
  return rows.map((r) => ({ ...r, __type: type })) as never;
}

async function main() {
  const args = parseArgs();
  const url = process.env.DATABASE_URL ?? "";
  const isDev = url.includes(":5437") || url.includes("192.168.64.28");
  if (!isDev && !args.forceProd) {
    console.error(
      "ODBIJENO: DATABASE_URL ne izgleda kao DEV (5437). Za prod dodaj --force-prod (svesna odluka).",
    );
    process.exit(2);
  }
  const dryRun = !args.apply;
  console.log(
    `Uvoz škart/dorada — ${dryRun ? "DRY-RUN (bez upisa)" : "APPLY (upis)"} · baza: ${isDev ? "DEV" : "PROD"}`,
  );

  const reasons = await prisma.qualityReasonCode.findMany({
    select: { id: true, code: true, label: true },
  });
  const reasonBy = new Map<string, number>();
  for (const r of reasons) {
    reasonBy.set(r.code.toLowerCase(), r.id);
    reasonBy.set(r.label.toLowerCase(), r.id);
  }
  const fallback = reasons.find((r) => r.code === "OSTALO")?.id ?? null;

  const rows = [
    ...(await loadFile(args.skart, "SKART")),
    ...(await loadFile(args.dorada, "DORADA")),
  ];
  let ok = 0;
  let skipped = 0;
  for (const row of rows as Array<Record<string, string>>) {
    const type = row.__type as "SKART" | "DORADA";
    const rnStr = row[COLUMN_MAP.rn]?.trim();
    const qty = Number((row[COLUMN_MAP.qty] ?? "").replace(",", "."));
    const date = parseDate(row[COLUMN_MAP.date] ?? "");
    if (!rnStr || !Number.isFinite(qty) || qty <= 0 || !date) {
      console.warn(`  SKIP (nepotpun red): ${JSON.stringify(row)}`);
      skipped++;
      continue;
    }
    const wo = await prisma.workOrder.findFirst({
      where: { identNumber: rnStr },
      select: { id: true },
    });
    if (!wo) {
      console.warn(`  SKIP (RN ${rnStr} nije nađen u work_orders)`);
      skipped++;
      continue;
    }
    const reasonKey = (row[COLUMN_MAP.reason] ?? "").trim().toLowerCase();
    const reasonCodeId = reasonBy.get(reasonKey) ?? fallback;
    const data = {
      type,
      status: "POTVRDJEN" as const,
      workOrderId: wo.id,
      qty,
      unit: "kom",
      reasonCodeId,
      note: row[COLUMN_MAP.note]?.trim() || null,
      workUnitCode: row[COLUMN_MAP.workUnit]?.trim()?.slice(0, 20) || null,
      reportedAt: date,
      confirmedAt: date,
    };
    if (dryRun) {
      console.log(
        `  [dry] ${type} RN ${rnStr} qty ${qty} razlog ${reasonCodeId ?? "—"}`,
      );
    } else {
      await prisma.qualityEvent.create({
        data: { ...data, qty: qty as never },
      });
    }
    ok++;
  }
  console.log(
    `Gotovo: ${ok} ${dryRun ? "za upis" : "upisano"}, ${skipped} preskočeno.`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
