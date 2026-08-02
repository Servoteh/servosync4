/**
 * JEDAN IZVOR ISTINE za ključeve i pragove noćnog BigBit (.mdb) uvoza.
 *
 * ZAŠTO POSTOJI OVAJ FAJL (integracija 26.07.2026): tri paralelno građene stavke
 * su svaka za sebe prekucale iste stringove i RAZIŠLE SE — posao se registrovao
 * kao `bigbit-mdb-import`, a ekran Podešavanja je čitao `scheduled_job_runs` po
 * `bigbit-mdb-sync`. Posledica: ekran napravljen baš da prijavi pad NIJE mogao
 * da prijavi ništa (prazan niz → „još nije bilo uvoza" i kad uvoz radi i kad je
 * mrtav). Ključ ide u `scheduled_job_runs.job_key` i `app_switches.key`, dakle u
 * PODATKE — menja se samo uz migraciju, nikad usput.
 *
 * Zavisi ISKLJUČIVO od tipova (nema Nest providera, nema Prisma klijenta), pa ga
 * smeju uvoziti i sync, i scheduler, i podesavanja bez rizika od ciklusa.
 */

/** `app_switches.key` — korisnički prekidač (Podešavanja → Integracije). */
export const BIGBIT_MDB_SYNC_SWITCH = "bigbit_mdb_sync";

/** `ScheduledJob.key` = `scheduled_job_runs.job_key` noćnog uvoza. */
export const BIGBIT_MDB_SYNC_JOB_KEY = "bigbit-mdb-sync";

/** `ScheduledJob.key` jutarnjeg nadzornika (gura upozorenje ka čoveku). */
export const BIGBIT_MDB_WATCHDOG_JOB_KEY = "bigbit-sync-watchdog";

/** `bb_sync_state.entity` red u koji uvoz upisuje heartbeat za ekran. */
export const BIGBIT_MDB_SYNC_STATE_ENTITY = "bigbit-mdb";

/**
 * TVRD PRAG: drop stariji od ovoga obara posao (`BigbitMdbDropStaleError`).
 * Dostava ~02:00, korak 1 u 02:50, korak 2 u 03:45 → zdrav drop je star 1–2 h.
 * Sa 24 h JEDNA propuštena noć već diže uzbunu (~25,5 h).
 */
export const MAX_DROP_AGE_HOURS = 24;

/**
 * MEKI PRAGOVI za ekran. Namerno su IZNAD tvrdog: ekran mora da ume da kaže i
 * „posao već pada" (24 h) i „kasni, ali još nije kritično". Da ne bi postojao
 * prozor u kome posao svake noći puca a ekran je zelen, `bigbitStatus()` prvo
 * poredi sa `MAX_DROP_AGE_HOURS` i tek onda sa ovima.
 */
export const IMPORT_STALE_AFTER_HOURS = 36;
export const IMPORT_CRITICAL_AFTER_HOURS = 72;
export const SOURCE_STALE_AFTER_HOURS = 36;
export const SOURCE_CRITICAL_AFTER_HOURS = 72;

/**
 * Koliko dugo „još nije bilo uvoza" sme da bude blago upozorenje pre nego što
 * postane crveno. Bez ovoga sistem koji NIKAD nije proradio izgleda mirnije od
 * onog koji je jednom zakasnio — a to je stanje u kome kanal ne postoji.
 */
export const NEVER_IMPORTED_GRACE_HOURS = 48;

/** RUNNING duži od ovoga = proces je ubijen/restartovan, ne „radi". */
export const RUN_STUCK_AFTER_HOURS = 6;

/** Ljudsko ime prekidača u porukama (bez tehničkog ključa u korisničkom tekstu). */
export const SWITCH_LABELS: Record<string, string> = {
  [BIGBIT_MDB_SYNC_SWITCH]: "Noćni uvoz iz BigBita",
};

/** Jedinstvena srpska poruka o ugašenom prekidaču (dnevnik, 409, ekran). */
export function switchDisabledReason(key: string): string {
  const label = SWITCH_LABELS[key] ?? key;
  return `${label} je isključen u Podešavanjima → Integracije. Uključite ga da bi se posao ponovo izvršavao.`;
}

/**
 * Datum dnevne dostave IZ IMENA FAJLA: `BB_T_26_30-07-26.mdb` -> 30.07.2026 (podne UTC).
 *
 * OVDE je (a ne u sync modulu) zato što svežinu po istoj osnovi mere DVE strane:
 * uvoz (`bigbit-mdb-import.service.ts`, brana bajatog drop-a) i ekran/nadzornik
 * (`sync-switch.service.ts`, upozorenje IZVOR_ZASTAREO). Da mere različito,
 * ponedeljak posle mirnog vikenda bi na ekranu bio crven dok uvoz uredno prolazi —
 * dve istine o istom fajlu. (Podešavanja ne smeju da uvoze iz sync modula: sync
 * uvozi Podešavanja radi prekidača, pa bi nastao krug.)
 *
 * ZAŠTO IME A NE `mtime`: dostava pravi jedan backup dnevno i datum stavlja u ime;
 * `mtime` se kopiranjem NASLEĐUJE od izvorne baze, pa govori kad je BigBit
 * poslednji put pisao — ne kad je dostava radila. Izmereno 30.07.2026: ime nosi
 * 30.07, `mtime` 16:03, na server legao 21:38.
 *
 * Vraća PODNE tog dana (dostava stiže po podne; ponoć bi dala ~18 h lažne
 * starosti već na dan dolaska). `null` kad ime ne prati obrazac — pozivalac pada
 * na svoju rezervu.
 */
export function dropDateFromFileName(fileName: string | null | undefined): Date | null {
  if (!fileName) return null;
  const m = /_(\d{2})-(\d{2})-(\d{2})\.mdb$/i.exec(fileName);
  if (!m) return null;
  const [, dd, mm, yy] = m;
  const d = new Date(
    Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 12, 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}
