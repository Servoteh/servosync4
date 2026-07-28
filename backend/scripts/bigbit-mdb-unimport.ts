/**
 * PONIŠTAVANJE JEDNOG BIGBIT UVOZA (`drop_id`) — stavka D, nalaz V8.
 * ============================================================================
 * Zašto postoji: prva noć u kojoj korak 1 proradi upisuje ~1.100 naloga i
 * ~20.000 stavki glavne knjige u PRODUKCIJSKU knjigu. Do sada povratka nije
 * bilo: nalozi ulaze kao POSTED/LOCKED, DB triger `guard_delete` zabranjuje
 * brisanje, a pet FK-ova prema `bb_mdb_drops` je `ON DELETE RESTRICT`. Ostajala
 * je ručna hirurgija uz gašenje trigera — na produkciji, noću, bez zapisnika.
 *
 * ŠTA RADI
 *   Briše SVE što je jedan drop UNEO — redove sa `imported_drop_id = <drop>` u
 *   ledger_entries, journal_entries, saldakonto_accounts, order_types, accounts —
 *   i dnevnik odbijenih izmena tog drop-a. Manifest drop-a (`bb_mdb_drops`) se
 *   NE briše nego dobija `import_status = 'REVERTED'`: on je zapisnik (v.
 *   obrazloženje ON DELETE RESTRICT u migraciji 20260726170000), pa poništen
 *   uvoz mora ostati vidljiv.
 *
 * ŠTA NE MOŽE (i zato se ISPISUJE kao upozorenje, ne prećutkuje)
 *   `imported_drop_id` nosi drop koji je red PRVI put doneo. Ako je kasniji drop
 *   samo AŽURIRAO red iz ranijeg drop-a, poništavanje tog kasnijeg drop-a ne
 *   vraća staru vrednost — vraća se ponovnim uvozom ranijeg fajla.
 *
 * KAKO SE POKREĆE (podrazumevano NE BRIŠE NIŠTA)
 *   npx ts-node -T scripts/bigbit-mdb-unimport.ts --drop=12
 *       → samo ispis: šta bi obrisao i šta ga sprečava.
 *   npx ts-node -T scripts/bigbit-mdb-unimport.ts --drop=12 --izvrsi --potvrdi=12
 *       → stvarno briše (broj u `--potvrdi` mora da se poklopi sa `--drop`).
 *   ... --i-staging   → uz to prazni i `bb_mdb_stage_*` za taj drop
 *                        (bez toga staging ostaje, pa je ponovni uvoz moguć odmah).
 *
 * DATABASE_URL se uzima iz okruženja (za dev: `.env.dev`, bez `?schema=public`).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── argumenti ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "";
};
const dropId = Number(arg("drop"));
const izvrsi = arg("izvrsi") !== undefined;
const potvrdi = arg("potvrdi");
const iStaging = arg("i-staging") !== undefined;

// Redosled brisanja je OBAVEZAN (FK lanac uvoza, obrnut).
const OWNED_TABLES = [
  "ledger_entries",
  "journal_entries",
  "saldakonto_accounts",
  "order_types",
  "accounts",
] as const;

const STAGE_TABLES = [
  "bb_mdb_stage_gk",
  "bb_mdb_stage_nalozi",
  "bb_mdb_stage_kontni_plan",
  "bb_mdb_stage_vrsta_naloga",
  "bb_mdb_stage_psf_konta",
  "bb_mdb_stage_sema",
  "bb_mdb_stage_sema_stavke",
  "bb_mdb_stage_pdv_gk",
  "bb_mdb_stage_popdv_gk",
] as const;

const num = (v: unknown): number => Number((v as any) ?? 0);
const line = (s = "") => console.log(s);
const money = (v: unknown) =>
  Number(v ?? 0).toLocaleString("sr-RS", { minimumFractionDigits: 2 });

async function count(sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(sql);
  return num(rows[0]?.c);
}

async function main() {
  if (!Number.isInteger(dropId) || dropId <= 0) {
    line("Upotreba: --drop=<id> [--izvrsi --potvrdi=<id>] [--i-staging]");
    process.exitCode = 2;
    return;
  }

  const drop = await prisma.bbMdbDrop.findUnique({ where: { id: dropId } });
  if (!drop) {
    line(`Drop ${dropId} ne postoji u bb_mdb_drops — nema šta da se poništi.`);
    process.exitCode = 2;
    return;
  }

  line("═".repeat(78));
  line(`PONIŠTAVANJE UVOZA — drop ${drop.id}: ${drop.fileName}`);
  line(
    `  fajl od ${drop.fileMtime.toISOString()} · staging ${drop.stageStatus} · uvoz ${drop.importStatus}` +
      (drop.importedAt ? ` (${drop.importedAt.toISOString()})` : ""),
  );
  line("═".repeat(78));

  // ── 1) ŠTA BI SE OBRISALO ─────────────────────────────────────────────────
  const owned: Record<string, number> = {};
  for (const t of OWNED_TABLES)
    owned[t] = await count(
      `SELECT count(*) c FROM "${t}" WHERE imported_drop_id = ${dropId}`,
    );

  const stage: Record<string, number> = {};
  for (const t of STAGE_TABLES)
    stage[t] = await count(
      `SELECT count(*) c FROM "${t}" WHERE drop_id = ${dropId}`,
    );

  const rejected = await count(
    `SELECT count(*) c FROM bb_import_rejected_changes WHERE drop_id = ${dropId}`,
  );

  const [sum] = await prisma.$queryRawUnsafe<
    { debit: unknown; credit: unknown; years: string | null }[]
  >(`SELECT coalesce(sum(l.debit),0) debit, coalesce(sum(l.credit),0) credit,
            (SELECT string_agg(DISTINCT j.year::text, ', ' ORDER BY j.year::text)
               FROM journal_entries j WHERE j.imported_drop_id = ${dropId}) years
       FROM ledger_entries l WHERE l.imported_drop_id = ${dropId}`);

  line("");
  line("BIĆE OBRISANO:");
  for (const t of OWNED_TABLES) line(`  ${t.padEnd(24)} ${owned[t]}`);
  line(`  ${"bb_import_rejected_changes".padEnd(24)} ${rejected}`);
  if (iStaging)
    for (const t of STAGE_TABLES) line(`  ${t.padEnd(24)} ${stage[t]}`);
  else
    line(
      `  (staging ostaje: ${Object.values(stage).reduce((a, b) => a + b, 0)} redova — dodaj --i-staging da se i on obriše)`,
    );
  line("");
  line(
    `  glavna knjiga koja odlazi: duguje ${money(sum?.debit)} / potražuje ${money(sum?.credit)}` +
      `  · godine naloga: ${sum?.years ?? "—"}`,
  );
  line(
    `  manifest bb_mdb_drops ${dropId} OSTAJE (import_status → 'REVERTED') — zapisnik se ne briše.`,
  );

  // ── 2) BRANE ──────────────────────────────────────────────────────────────
  const blockers: string[] = [];
  const warnings: string[] = [];

  // (a) 4.0-native stavke zakačene na uvezen nalog: brisanje naloga bi ih povuklo
  //     ili palo na FK. To više nije „poništi uvoz" nego gubitak tuđeg rada.
  const strayLines = await count(
    `SELECT count(*) c FROM ledger_entries l
       JOIN journal_entries j ON j.id = l.journal_entry_id
      WHERE j.imported_drop_id = ${dropId}
        AND (l.imported_drop_id IS DISTINCT FROM ${dropId})`,
  );
  if (strayLines > 0)
    blockers.push(
      `${strayLines} stavk(i) glavne knjige visi na nalozima ovog drop-a, ali NIJE došlo iz njega ` +
        "(uneto u 4.0 ili iz drugog drop-a). Poništavanje bi obrisalo tuđi rad — prvo ih raščistite.",
    );

  // (b) predat završni račun za godinu koju uvoz dira
  const finalized = await prisma.$queryRawUnsafe<
    { statement_type: string; period_year: number; status: string }[]
  >(`SELECT statement_type, period_year, status FROM financial_statements
      WHERE status <> 'DRAFT'
        AND period_year IN (SELECT DISTINCT year FROM journal_entries WHERE imported_drop_id = ${dropId})`);
  for (const f of finalized)
    blockers.push(
      `predat obrazac ${f.statement_type} ${f.period_year} (status ${f.status}) računat je nad ovim ` +
        "nalozima — brisanjem bi ostao bez podloge. Vratite ga u DRAFT ili sačuvajte izvan aplikacije.",
    );

  // (c) predata PDV prijava za period koji uvoz dira
  const vat = await prisma.$queryRawUnsafe<
    {
      id: number;
      period_year: number;
      period_month: number | null;
      period_quarter: number | null;
      status: string;
    }[]
  >(`SELECT id, period_year, period_month, period_quarter, status FROM vat_returns
      WHERE status NOT IN ('DRAFT','CALCULATED')
        AND period_year IN (SELECT DISTINCT year FROM journal_entries WHERE imported_drop_id = ${dropId})`);
  for (const v of vat)
    blockers.push(
      `predata PDV prijava ${v.period_year}/${v.period_month ?? "K" + v.period_quarter} ` +
        `(status ${v.status}) računata je nad ovim stavkama — brisanjem bi ostala bez podloge.`,
    );

  // (d) bilo koji drugi FK na naloge/konta koje brišemo — traži se u katalogu,
  //     da nova tabela sutra ne bi tiho oborila skriptu na produkciji.
  const fks = await prisma.$queryRawUnsafe<
    {
      child_table: string;
      child_column: string;
      parent_table: string;
      parent_column: string;
    }[]
  >(`SELECT c.conrelid::regclass::text  AS child_table,
            ca.attname                  AS child_column,
            c.confrelid::regclass::text AS parent_table,
            pa.attname                  AS parent_column
       FROM pg_constraint c
       JOIN unnest(c.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
       JOIN unnest(c.confkey) WITH ORDINALITY AS pk(attnum, ord) ON pk.ord = ck.ord
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid  AND ca.attnum = ck.attnum
       JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = pk.attnum
      WHERE c.contype = 'f'
        AND c.confrelid::regclass::text = ANY (ARRAY['journal_entries','accounts','order_types','ledger_entries','saldakonto_accounts'])
        AND array_length(c.conkey, 1) = 1`);

  const ownedKeySql: Record<string, string> = {
    journal_entries: `SELECT id FROM journal_entries WHERE imported_drop_id = ${dropId}`,
    ledger_entries: `SELECT id FROM ledger_entries WHERE imported_drop_id = ${dropId}`,
    accounts: `SELECT code FROM accounts WHERE imported_drop_id = ${dropId}`,
    order_types: `SELECT code FROM order_types WHERE imported_drop_id = ${dropId}`,
    saldakonto_accounts: `SELECT account FROM saldakonto_accounts WHERE imported_drop_id = ${dropId}`,
  };

  for (const fk of fks) {
    if (OWNED_TABLES.includes(fk.child_table as any)) continue; // rešeno redosledom brisanja
    if (fk.child_table === "bb_import_rejected_changes") continue;
    const keys = ownedKeySql[fk.parent_table];
    if (!keys) continue;
    const parentKeyCol =
      fk.parent_table === "accounts"
        ? "code"
        : fk.parent_table === "order_types"
          ? "code"
          : fk.parent_table === "saldakonto_accounts"
            ? "account"
            : "id";
    if (fk.parent_column !== parentKeyCol) continue;
    const c = await count(
      `SELECT count(*) c FROM "${fk.child_table}" WHERE "${fk.child_column}" IN (${keys})`,
    );
    if (c > 0)
      blockers.push(
        `${c} red(ova) u tabeli "${fk.child_table}" pokazuje na ${fk.parent_table} koje ovaj drop ` +
          `briše (kolona ${fk.child_column}). Raščistite ih pre poništavanja.`,
      );
  }

  // (e) ono što se NE može vratiti — ažuriranja ranijih drop-ova
  const touchedOther = await count(
    `SELECT count(*) c FROM ledger_entries WHERE imported_drop_id IS NOT NULL
        AND imported_drop_id <> ${dropId}`,
  );
  if (touchedOther > 0)
    warnings.push(
      `${touchedOther} stavk(i) glavne knjige pripada RANIJIM drop-ovima. Ako ih je ovaj drop ` +
        "usput AŽURIRAO, poništavanje NE vraća stare vrednosti — vraća ih ponovni uvoz ranijeg fajla.",
    );
  if (drop.importStatus === "REVERTED")
    warnings.push("Ovaj drop je već jednom poništen (import_status = REVERTED).");

  line("");
  if (warnings.length) {
    line("UPOZORENJA:");
    for (const w of warnings) line(`  ! ${w}`);
    line("");
  }
  if (blockers.length) {
    line("ZAUSTAVLJENO — brisanje NIJE moguće dok se ovo ne reši:");
    for (const b of blockers) line(`  ✖ ${b}`);
    line("");
    line("Ništa nije obrisano.");
    process.exitCode = 1;
    return;
  }
  line("Brana: nijedna prepreka nije nađena.");

  // ── 3) POTVRDA ────────────────────────────────────────────────────────────
  if (!izvrsi) {
    line("");
    line(
      `PROBA (ništa nije obrisano). Za stvarno brisanje: --drop=${dropId} --izvrsi --potvrdi=${dropId}` +
        (iStaging ? " --i-staging" : ""),
    );
    return;
  }
  if (potvrdi !== String(dropId)) {
    line("");
    line(
      `ODBIJENO: --izvrsi traži i --potvrdi=${dropId} (dobijeno: ${potvrdi ?? "ništa"}).`,
    );
    process.exitCode = 2;
    return;
  }

  // ── 4) BRISANJE ───────────────────────────────────────────────────────────
  line("");
  line("BRIŠEM…");
  const removed: Record<string, number> = {};
  await prisma.$transaction(
    async (tx) => {
      removed["bb_import_rejected_changes"] = await tx.$executeRawUnsafe(
        `DELETE FROM bb_import_rejected_changes WHERE drop_id = ${dropId}`,
      );
      removed["ledger_entries"] = await tx.$executeRawUnsafe(
        `DELETE FROM ledger_entries WHERE imported_drop_id = ${dropId}`,
      );
      // DB triger `guard_delete` (20260725200000 / 20260725220000) zabranjuje
      // brisanje naloga u statusu POSTED/LOCKED. Trigger se NE gasi (za to treba
      // vlasnik tabele, a i gašenje bi otvorilo rupu široku koliko cela tabela):
      // nalozi koji ionako odlaze prvo se vrate u DRAFT, u istoj transakciji.
      removed["journal_entries_draft"] = await tx.$executeRawUnsafe(
        `UPDATE journal_entries SET status = 'DRAFT' WHERE imported_drop_id = ${dropId}`,
      );
      removed["journal_entries"] = await tx.$executeRawUnsafe(
        `DELETE FROM journal_entries WHERE imported_drop_id = ${dropId}`,
      );
      removed["saldakonto_accounts"] = await tx.$executeRawUnsafe(
        `DELETE FROM saldakonto_accounts WHERE imported_drop_id = ${dropId}`,
      );
      removed["order_types"] = await tx.$executeRawUnsafe(
        `DELETE FROM order_types WHERE imported_drop_id = ${dropId}`,
      );
      removed["accounts"] = await tx.$executeRawUnsafe(
        `DELETE FROM accounts WHERE imported_drop_id = ${dropId}`,
      );
      if (iStaging)
        for (const t of STAGE_TABLES)
          removed[t] = await tx.$executeRawUnsafe(
            `DELETE FROM "${t}" WHERE drop_id = ${dropId}`,
          );

      await tx.$executeRawUnsafe(
        `UPDATE bb_mdb_drops
            SET import_status = 'REVERTED',
                imported_at = NULL,
                import_started_at = NULL,
                import_error = NULL,
                note = coalesce(note || E'\\n', '') || 'Uvoz poništen ' ||
                       to_char(now(), 'DD.MM.YYYY HH24:MI') ||
                       ' skriptom bigbit-mdb-unimport.ts.'
          WHERE id = ${dropId}`,
      );
    },
    { timeout: 600_000, maxWait: 30_000 },
  );

  for (const [k, v] of Object.entries(removed))
    line(`  ${k.padEnd(28)} ${v}`);

  // ── 5) PROVERA POSLE ──────────────────────────────────────────────────────
  line("");
  line("PROVERA POSLE BRISANJA (sve mora biti 0):");
  let clean = true;
  for (const t of OWNED_TABLES) {
    const c = await count(
      `SELECT count(*) c FROM "${t}" WHERE imported_drop_id = ${dropId}`,
    );
    if (c !== 0) clean = false;
    line(`  ${t.padEnd(24)} ${c}`);
  }
  const after = await prisma.bbMdbDrop.findUnique({ where: { id: dropId } });
  line(`  bb_mdb_drops.import_status  ${after?.importStatus}`);
  line("");
  line(clean ? "GOTOVO — baza je vraćena u stanje pre ovog uvoza." : "PAŽNJA: nešto je ostalo — pogledaj gore.");
  if (!clean) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
