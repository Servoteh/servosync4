/**
 * Dev smoke — STAVKA D (brane oko noćnog BigBit uvoza).
 * ============================================================================
 * Vozi stvarni `BigbitMdbImportService` nad sintetičkim drop-om i proverava tri
 * stvari koje su do sada bile samo tvrdnje:
 *
 *   1) PREKIDAČ JE SEJAN ISKLJUČEN (migracija 20260728130000) — uvoz pokrenut
 *      nad svežom bazom vraća `DISABLED` i NE upisuje ništa.
 *   2) BRANA ZAKLJUČANIH NALOGA — drugi drop menja i običan i ZAKLJUČAN nalog;
 *      običan se preuzme, zaključan NE, a odbijena izmena završi u
 *      `bb_import_rejected_changes` sa starom i novom vrednošću. Uz to se
 *      proverava i suprotan smer: PRVI uvoz zaključanog naloga MORA da donese
 *      njegove stavke (inače zaglavlje ostaje bez knjiženja), a stavka DODATA
 *      kasnije na taj isti zaključan nalog mora da bude odbijena.
 *   3) POVRATAK — `scripts/bigbit-mdb-unimport.ts` briše sve što je drop uneo.
 *      (Skripta se pokreće zasebno; ovaj smoke ostavlja bazu spremnu za nju i
 *      na kraju sam ispiše šta u bazi stoji.)
 *
 * POKRETANJE (NIKAD nad produkcijom — traži bazu čije ime sadrži `dokaz`/`test`):
 *   DATABASE_URL=postgresql://…/servosync_dokaz_d npx ts-node -T scripts/smoke-stavka-d.ts
 */
import { PrismaClient } from "@prisma/client";
import { BigbitMdbImportService } from "../src/modules/sync/bigbit-mdb-import.service";
import { PrismaService } from "../src/prisma/prisma.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

const prisma = new PrismaClient();
const svc = new BigbitMdbImportService(prisma as unknown as PrismaService);

let pass = 0;
let fail = 0;
const log: string[] = [];
const ok = (name: string, detail = "") => {
  pass += 1;
  log.push(`  OK   ${name}${detail ? " — " + detail : ""}`);
};
const bad = (name: string, detail: unknown) => {
  fail += 1;
  log.push(`  FAIL ${name} — ${String(detail)}`);
};
const eq = (name: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(name, `${JSON.stringify(got)}`)
    : bad(name, `dobijeno ${JSON.stringify(got)}, očekivano ${JSON.stringify(want)}`);

const q = <T = any>(sql: string, ...p: unknown[]) =>
  prisma.$queryRawUnsafe<T[]>(sql, ...p);
const x = (sql: string, ...p: unknown[]) => prisma.$executeRawUnsafe(sql, ...p);

/** Napravi drop + staging. `zakljucanDuguje` menja iznos na ZAKLJUČANOM nalogu. */
async function stageDrop(opts: {
  fileName: string;
  sha: string;
  obicanDuguje: string;
  zakljucanDuguje: string;
}): Promise<number> {
  const [d] = await q<{ id: number }>(
    `INSERT INTO bb_mdb_drops (file_name, file_mtime, file_size, file_sha256, stage_status, staged_at)
     VALUES ($1, now(), 1024, $2, 'LOADED', now()) RETURNING id`,
    opts.fileName,
    opts.sha,
  );
  const id = d.id;
  await x(
    `INSERT INTO bb_mdb_stage_kontni_plan (drop_id, konto, opis, dozvoljen_unos_analitike)
     VALUES ($1,'2040','Kupci u zemlji','0'), ($1,'4700','PDV po izdatim fakturama 20%','0')`,
    id,
  );
  await x(
    `INSERT INTO bb_mdb_stage_vrsta_naloga (drop_id, vrsta_naloga, opis)
     VALUES ($1,'TSD','Test nalog stavke D')`,
    id,
  );
  await x(
    `INSERT INTO bb_mdb_stage_psf_konta (drop_id, konto, din_saldo) VALUES ($1,'2040','0')`,
    id,
  );
  // 900001 = običan (POSTED), 900002 = ZAKLJUČAN u BigBitu (zakljucano='1' → LOCKED)
  await x(
    `INSERT INTO bb_mdb_stage_nalozi
       (drop_id, id_firma, id_naloga, broj_naloga, vrsta_naloga, datum_naloga, datum_knjizenja, godina, zakljucano, opis_naloga)
     VALUES ($1,'1','900001','9001','TSD','2026-02-01','2026-02-01','2026','0','Obican nalog'),
            ($1,'1','900002','9002','TSD','2026-03-01','2026-03-01','2026','1','Zakljucan nalog')`,
    id,
  );
  await x(
    `INSERT INTO bb_mdb_stage_gk
       (drop_id, stavka_id, konto, id_naloga, datum_knjizenja, duguje, potrazuje, opis_dokumenta, broj_dokumenta)
     VALUES ($1,'9100001','2040','900001','2026-02-01',$2,'0','obicna stavka','D-1'),
            ($1,'9100002','4700','900001','2026-02-01','0',$2,'obicna protivstavka','D-1'),
            ($1,'9100003','2040','900002','2026-03-01',$3,'0','zakljucana stavka','D-2'),
            ($1,'9100004','4700','900002','2026-03-01','0',$3,'zakljucana protivstavka','D-2')`,
    id,
    opts.obicanDuguje,
    opts.zakljucanDuguje,
  );
  return id;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/dokaz|test/i.test(url)) {
    console.error(
      "ODBIJENO: DATABASE_URL ne sadrži 'dokaz' ni 'test'. Ovaj smoke piše u glavnu knjigu " +
        "i sme samo nad bazom za dokazivanje.",
    );
    process.exitCode = 2;
    return;
  }

  // ── 1) PREKIDAČ JE SEJAN ISKLJUČEN ───────────────────────────────────────
  const [sw] = await q<{ enabled: boolean }>(
    `SELECT enabled FROM app_switches WHERE key = 'bigbit_mdb_sync'`,
  );
  eq("prekidač noćnog uvoza je posejan ISKLJUČEN", sw?.enabled, false);

  const drop1 = await stageDrop({
    fileName: "stavka-d-1.mdb",
    sha: "d".repeat(64),
    obicanDuguje: "100.00",
    zakljucanDuguje: "200.00",
  });

  const disabled = await svc.runImport({ dropId: drop1 });
  eq("uvoz sa isključenim prekidačem ne radi ništa", disabled.status, "DISABLED");
  eq(
    "isključen prekidač = nula naloga u knjizi",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM journal_entries WHERE imported_drop_id = ${drop1}`,
    ).then((r) => Number(r[0].c)),
    0,
  );

  // ── 2) PRVI (RUČNI) UVOZ — prekidač se pali svesno ───────────────────────
  await x(`UPDATE app_switches SET enabled = TRUE WHERE key = 'bigbit_mdb_sync'`);
  const r1 = await svc.runImport({ dropId: drop1 });
  eq("prvi uvoz prolazi", r1.status, "DONE");
  const je1 = await q<any>(
    `SELECT bb_nalog_id, status FROM journal_entries WHERE imported_drop_id = ${drop1} ORDER BY bb_nalog_id`,
  );
  eq(
    "uvezena dva naloga, drugi ZAKLJUČAN",
    je1.map((j: any) => `${j.bb_nalog_id}:${j.status}`),
    ["900001:POSTED", "900002:LOCKED"],
  );
  eq(
    "uvezene 4 stavke glavne knjige",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM ledger_entries WHERE imported_drop_id = ${drop1}`,
    ).then((r) => Number(r[0].c)),
    4,
  );
  // Ovo je poseban slučaj i mora se meriti odvojeno: nalog koji BigBit donosi
  // već ZAKLJUČAN dobija status LOCKED u istom prolazu u kom se i upisuje. Ako
  // ga brana shvati kao „zaključan pa se ne dira", zaglavlje uđe BEZ STAVKI i
  // glavna knjiga ne zatvara — a nigde ne piše da nešto fali.
  eq(
    "prvi uvoz ZAKLJUČANOG naloga donosi i njegove stavke",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
        WHERE j.bb_nalog_id = 900002`,
    ).then((r) => Number(r[0].c)),
    2,
  );
  eq(
    "prvi uvoz ne prijavljuje nijednu odbijenu izmenu",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM bb_import_rejected_changes WHERE drop_id = ${drop1}`,
    ).then((r) => Number(r[0].c)),
    0,
  );

  // ── 3) DRUGI DROP — BigBit menja OBA naloga ──────────────────────────────
  const drop2 = await stageDrop({
    fileName: "stavka-d-2.mdb",
    sha: "e".repeat(64),
    obicanDuguje: "111.00", // običan nalog: izmena SME da prođe
    zakljucanDuguje: "999.00", // zaključan nalog: izmena NE SME da prođe
  });
  await x(
    `UPDATE bb_mdb_stage_nalozi SET opis_naloga = 'Zakljucan nalog — PREKONTIRAN U BIGBITU'
      WHERE drop_id = ${drop2} AND id_naloga = '900002'`,
  );
  // NOVA stavka dopisana u BigBitu na već uvezen ZAKLJUČAN nalog — ne sme da uđe.
  await x(
    `INSERT INTO bb_mdb_stage_gk
       (drop_id, stavka_id, konto, id_naloga, datum_knjizenja, duguje, potrazuje, opis_dokumenta, broj_dokumenta)
     VALUES (${drop2},'9100005','2040','900002','2026-03-01','55','0','naknadno dopisana stavka','D-2')`,
  );
  const r2 = await svc.runImport({ dropId: drop2 });
  eq("drugi uvoz prolazi", r2.status, "DONE");

  const [obican] = await q<any>(
    `SELECT debit FROM ledger_entries WHERE bb_stavka_id = 9100001`,
  );
  eq("izmena OBIČNOG naloga je preuzeta", String(obican.debit), "111");

  const [zakljucan] = await q<any>(
    `SELECT debit FROM ledger_entries WHERE bb_stavka_id = 9100003`,
  );
  eq("izmena ZAKLJUČANOG naloga NIJE preuzeta", String(zakljucan.debit), "200");

  const [zaglavlje] = await q<any>(
    `SELECT description FROM journal_entries WHERE bb_nalog_id = 900002`,
  );
  eq(
    "zaglavlje ZAKLJUČANOG naloga nije prepisano",
    zaglavlje.description,
    "Zakljucan nalog",
  );

  eq(
    "naknadno dopisana stavka na ZAKLJUČANOM nalogu nije ušla",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM ledger_entries WHERE bb_stavka_id = 9100005`,
    ).then((r) => Number(r[0].c)),
    0,
  );

  const rej = await q<any>(
    `SELECT entity, bb_nalog_id, bb_stavka_id, reason,
            old_value->>'debit' staro, new_value->>'debit' novo,
            old_value->>'description' staro_opis, new_value->>'description' novo_opis
       FROM bb_import_rejected_changes WHERE drop_id = ${drop2}
      ORDER BY entity, coalesce(bb_stavka_id, 0)`,
  );
  eq(
    "odbijene izmene su zapisane (1 nalog + 3 stavke)",
    rej.map((r: any) => r.entity),
    [
      "journal_entries",
      "ledger_entries",
      "ledger_entries",
      "ledger_entries",
    ],
  );
  const gk = rej.filter((r: any) => r.entity === "ledger_entries");
  // 9100003 promenjen iznos duguje · 9100004 promenjen iznos potražuje (duguje
  // ostaje 0) · 9100005 stavke u 4.0 nema, pa STARO nema vrednost.
  eq(
    "dnevnik nosi STARO → NOVO za stavke",
    gk.map((r: any) => `${r.bb_stavka_id}:${r.staro}→${r.novo}`),
    [
      "9100003:200.0000→999.0000",
      "9100004:0.0000→0.0000",
      "9100005:null→55.0000",
    ],
  );
  const jeRej = rej.find((r: any) => r.entity === "journal_entries");
  eq(
    "dnevnik nosi STARO → NOVO za zaglavlje",
    `${jeRej.staro_opis} → ${jeRej.novo_opis}`,
    "Zakljucan nalog → Zakljucan nalog — PREKONTIRAN U BIGBITU",
  );

  // Treći prolaz istog problema NE sme da napravi drugi red u dnevniku.
  const drop3 = await stageDrop({
    fileName: "stavka-d-3.mdb",
    sha: "f".repeat(64),
    obicanDuguje: "111.00",
    zakljucanDuguje: "999.00",
  });
  await svc.runImport({ dropId: drop3 });
  eq(
    "ponovljena ista odbijena izmena ne duplira dnevnik",
    await q<{ c: bigint }>(
      `SELECT count(*) c FROM bb_import_rejected_changes WHERE resolved_at IS NULL`,
    ).then((r) => Number(r[0].c)),
    4,
  );

  console.log("\n".concat(log.join("\n")));
  console.log(`\n${pass} OK / ${fail} FAIL`);
  console.log(
    `\nDrop-ovi za probu poništavanja: ${drop1} (uneo knjigu), ${drop2}, ${drop3}.\n` +
      `Sledeći korak: npx ts-node -T scripts/bigbit-mdb-unimport.ts --drop=${drop1}`,
  );
  await prisma.$disconnect();
  if (fail) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
