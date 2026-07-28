/**
 * Dev smoke — BRANA ZAKLJUČANIH NALOGA, tri scenarija iz DRUGOG kruga pregleda.
 * ============================================================================
 * `smoke-stavka-d.ts` dokazuje da brana ODBIJA ono što treba. Ovaj smoke dokazuje
 * ono suprotno — da NE odbija ono što ne sme, jer su sva tri promašaja nađena tek
 * u drugom krugu i sva tri su tiho kvarila glavnu knjigu:
 *
 *   R1 · 4.0-NATIVNO ZAKLJUČAVANJE (`gl-write.lockOlderThan`, dugme „Zaključaj
 *        starije") prevodi uvezene naloge POSTED→LOCKED, dok BigBit za iste naloge
 *        i dalje šalje Zakljucano=0. Dok je status bio deo poređenja, ta razlika je
 *        bila TRAJNA: svaki takav nalog se SVAKE noći brojao kao „odbijena izmena"
 *        i TRAJNO ispadao iz upsert-a. Mereno pre ispravke: 3/3 naloga, svake noći.
 *
 *   R2 · ISTI FAJL i menja i zaključava nalog (uobičajen sled: ispravi pa zatvori
 *        mesec). Korak zaglavlja je upisivao LOCKED, korak stavki je isti nalog
 *        zaticao kao LOCKED i odbijao iznose IZ TOG ISTOG FAJLA — novo zaglavlje,
 *        stari iznosi.
 *
 *   R3 · PREKINUT UVOZ ostavlja zaključan nalog sa DELOM stavki. Sledeći fajl je
 *        drugi drop, pa izuzetak „prvi uvoz istim drop-om" više ne važi i te stavke
 *        ne bi ušle NIKAD — nalog trajno ne zatvara, a uvoz vraća DONE.
 *
 * POKRETANJE (NIKAD nad produkcijom — traži bazu čije ime sadrži `dokaz`/`test`):
 *   DATABASE_URL=postgresql://…/servosync_int_dokaz_d npx ts-node -T scripts/smoke-uvoz-zakljucani.ts
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
const ok = (name: string, detail = "") =>
  (pass += 1) && log.push(`  OK   ${name}${detail ? " — " + detail : ""}`);
const bad = (name: string, detail: unknown) =>
  (fail += 1) && log.push(`  FAIL ${name} — ${String(detail)}`);
const eq = (name: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? ok(name, JSON.stringify(got))
    : bad(name, `dobijeno ${JSON.stringify(got)}, očekivano ${JSON.stringify(want)}`);

const q = <T>(sql: string, ...args: unknown[]): Promise<T[]> =>
  prisma.$queryRawUnsafe<T[]>(sql, ...args);
const x = (sql: string, ...args: unknown[]) => prisma.$executeRawUnsafe(sql, ...args);

/** Jedan drop sa JEDNIM nalogom (dve stavke), zadatom zastavicom i iznosom. */
async function stage(opts: {
  file: string;
  sha: string;
  bbNalog: number;
  broj: string;
  zakljucano: "0" | "1";
  opis: string;
  iznos: string;
  /** Koje stavke ući u fajl (podrazumevano obe). */
  stavke?: number[];
}): Promise<number> {
  const [d] = await q<{ id: number }>(
    `INSERT INTO bb_mdb_drops (file_name, file_mtime, file_size, file_sha256, stage_status, staged_at)
     VALUES ($1, now(), 1024, $2, 'LOADED', now()) RETURNING id`,
    opts.file,
    opts.sha,
  );
  const id = d.id;
  await x(
    `INSERT INTO bb_mdb_stage_kontni_plan (drop_id, konto, opis, dozvoljen_unos_analitike)
     VALUES ($1,'2040','Kupci u zemlji','0'), ($1,'4700','PDV po izdatim fakturama 20%','0')`,
    id,
  );
  await x(
    `INSERT INTO bb_mdb_stage_vrsta_naloga (drop_id, vrsta_naloga, opis) VALUES ($1,'TZK','Test zakljucavanja')`,
    id,
  );
  await x(
    `INSERT INTO bb_mdb_stage_nalozi
       (drop_id, id_firma, id_naloga, broj_naloga, vrsta_naloga, datum_naloga, datum_knjizenja, godina, zakljucano, opis_naloga)
     VALUES ($1,'1',$2,$3,'TZK','2026-01-15','2026-01-15','2026',$4,$5)`,
    id,
    String(opts.bbNalog),
    opts.broj,
    opts.zakljucano,
    opts.opis,
  );
  const wanted = opts.stavke ?? [1, 2];
  if (wanted.includes(1))
    await x(
      `INSERT INTO bb_mdb_stage_gk (drop_id, stavka_id, konto, id_naloga, datum_knjizenja, duguje, potrazuje, opis_dokumenta, broj_dokumenta)
       VALUES ($1,$2,'2040',$3,'2026-01-15',$4,'0','duguje','Z-1')`,
      id,
      String(opts.bbNalog * 10 + 1),
      String(opts.bbNalog),
      opts.iznos,
    );
  if (wanted.includes(2))
    await x(
      `INSERT INTO bb_mdb_stage_gk (drop_id, stavka_id, konto, id_naloga, datum_knjizenja, duguje, potrazuje, opis_dokumenta, broj_dokumenta)
       VALUES ($1,$2,'4700',$3,'2026-01-15','0',$4,'potrazuje','Z-1')`,
      id,
      String(opts.bbNalog * 10 + 2),
      String(opts.bbNalog),
      opts.iznos,
    );
  return id;
}

const nalog = (bb: number) =>
  q<any>(
    `SELECT status, description, (SELECT count(*)::int FROM ledger_entries le WHERE le.journal_entry_id = j.id) AS stavki,
            (SELECT coalesce(sum(le.debit),0)::text FROM ledger_entries le WHERE le.journal_entry_id = j.id) AS duguje
       FROM journal_entries j WHERE j.bb_nalog_id = ${bb}`,
  ).then((r) => r[0]);

const odbijenih = () =>
  q<{ c: bigint }>(
    `SELECT count(*) c FROM bb_import_rejected_changes WHERE resolved_at IS NULL`,
  ).then((r) => Number(r[0].c));

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!/dokaz|test/i.test(url)) {
    console.error("ODBIJENO: DATABASE_URL ne sadrži 'dokaz' ni 'test'.");
    process.exitCode = 2;
    return;
  }
  await x(`UPDATE app_switches SET enabled = TRUE WHERE key = 'bigbit_mdb_sync'`);

  // ── R1 · 4.0 zaključa period, BigBit šalje NEPROMENJEN sadržaj ────────────
  const d1 = await stage({
    file: "zak-r1-a.mdb", sha: "1".repeat(64), bbNalog: 910001, broj: "R101",
    zakljucano: "0", opis: "R1 nalog", iznos: "100.00",
  });
  eq("R1 · prvi uvoz prolazi", (await svc.runImport({ dropId: d1 })).status, "DONE");
  eq("R1 · nalog je POSTED sa 2 stavke", await nalog(910001).then((n) => `${n.status}/${n.stavki}`), "POSTED/2");

  // Ovo radi `gl-write.lockOlderThan` (dugme „Zaključaj starije" na /glavna-knjiga).
  await x(`UPDATE journal_entries SET status = 'LOCKED' WHERE bb_nalog_id = 910001`);
  const preR1 = await odbijenih();

  const d2 = await stage({
    file: "zak-r1-b.mdb", sha: "2".repeat(64), bbNalog: 910001, broj: "R101",
    zakljucano: "0", opis: "R1 nalog", iznos: "100.00",
  });
  const r1b = await svc.runImport({ dropId: d2 });
  eq("R1 · sledeći uvoz prolazi", r1b.status, "DONE");
  eq(
    "R1 · nepromenjen sadržaj nad 4.0-zaključanim nalogom NE pravi nijednu odbijenu izmenu",
    (await odbijenih()) - preR1,
    0,
  );
  eq(
    "R1 · 4.0 zaključavanje NIJE skinuto BigBit-ovim POSTED",
    await nalog(910001).then((n) => n.status),
    "LOCKED",
  );

  // ── R2 · isti fajl i menja i zaključava ──────────────────────────────────
  const d3 = await stage({
    file: "zak-r2-a.mdb", sha: "3".repeat(64), bbNalog: 920001, broj: "R201",
    zakljucano: "0", opis: "R2 nalog", iznos: "700.00",
  });
  await svc.runImport({ dropId: d3 });
  eq("R2 · nalog uvezen kao POSTED sa 700", await nalog(920001).then((n) => `${n.status}/${n.duguje}`), "POSTED/700.0000");

  const preR2 = await odbijenih();
  const d4 = await stage({
    file: "zak-r2-b.mdb", sha: "4".repeat(64), bbNalog: 920001, broj: "R201",
    zakljucano: "1", opis: "R2 nalog ISPRAVLJEN", iznos: "777.00",
  });
  eq("R2 · uvoz prolazi", (await svc.runImport({ dropId: d4 })).status, "DONE");
  const n2 = await nalog(920001);
  eq("R2 · zaglavlje preuzeto", n2.description, "R2 nalog ISPRAVLJEN");
  eq("R2 · IZNOS iz istog fajla je preuzet (pre ispravke ostajalo 700)", n2.duguje, "777.0000");
  eq("R2 · nalog je zaključan tek na kraju uvoza", n2.status, "LOCKED");
  eq("R2 · nijedna izmena nije odbijena", (await odbijenih()) - preR2, 0);

  // ── R3 · prekinut uvoz: zaključan nalog sa DELOM stavki ──────────────────
  const d5 = await stage({
    file: "zak-r3-a.mdb", sha: "5".repeat(64), bbNalog: 930001, broj: "R301",
    zakljucano: "1", opis: "R3 nalog", iznos: "500.00",
  });
  await svc.runImport({ dropId: d5 });
  eq("R3 · prvi uvoz doneo zaključan nalog sa 2 stavke", await nalog(930001).then((n) => `${n.status}/${n.stavki}`), "LOCKED/2");
  // Simulacija pada koraka GK usred straničenja: druga stavka nikad nije upisana.
  await x(`DELETE FROM ledger_entries WHERE bb_stavka_id = 9300012`);
  eq(
    "R3 · posle prekida nalog NE ZATVARA (1 stavka)",
    await nalog(930001).then((n) => `${n.stavki}/${n.duguje}`),
    "1/500.0000",
  );

  const preR3 = await odbijenih();
  const d6 = await stage({
    file: "zak-r3-b.mdb", sha: "6".repeat(64), bbNalog: 930001, broj: "R301",
    zakljucano: "1", opis: "R3 nalog", iznos: "500.00",
  });
  eq("R3 · sledeći fajl prolazi", (await svc.runImport({ dropId: d6 })).status, "DONE");
  eq(
    "R3 · nedostajuća stavka je POPRAVLJENA (pre ispravke nikad ne bi ušla)",
    await nalog(930001).then((n) => n.stavki),
    2,
  );
  eq("R3 · popravka nije zavedena kao odbijena izmena", (await odbijenih()) - preR3, 0);

  // ── R3b · nalog koji ZATVARA i dalje ne prima novu stavku ────────────────
  const d7 = await stage({
    file: "zak-r3-c.mdb", sha: "7".repeat(64), bbNalog: 930001, broj: "R301",
    zakljucano: "1", opis: "R3 nalog", iznos: "500.00",
  });
  await x(
    `INSERT INTO bb_mdb_stage_gk (drop_id, stavka_id, konto, id_naloga, datum_knjizenja, duguje, potrazuje, opis_dokumenta, broj_dokumenta)
     VALUES (${d7},'9300013','2040','930001','2026-01-15','55.00','0','naknadno dopisana','Z-1')`,
  );
  await svc.runImport({ dropId: d7 });
  eq(
    "R3b · dopisana stavka na URAVNOTEŽENOM zaključanom nalogu je ODBIJENA",
    await nalog(930001).then((n) => n.stavki),
    2,
  );
  eq("R3b · odbijanje je zavedeno", (await odbijenih()) - preR3, 1);

  console.log("\n── SMOKE: brana zaključanih naloga (drugi krug) ────────────────");
  console.log(log.join("\n"));
  console.log(`\n${pass} OK / ${fail} FAIL`);
  process.exitCode = fail === 0 ? 0 : 1;
  await prisma.$disconnect();
}

void main();
