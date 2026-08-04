import { Injectable, Logger } from "@nestjs/common";
import { SyncService } from "../sync/sync.service";
import {
  DEFAULT_SYNC_EXCLUDED,
  NIGHTLY_SYNC_EXCLUDED,
} from "../sync/table-ownership";
import type { ScheduledJob } from "./scheduler.types";

// Re-export radi kompatibilnosti postojećih uvoza (spec + docs referišu ovaj
// fajl). DEFINICIJA je preseljena u ../sync/table-ownership.ts (04.08.2026,
// dopuna 061/26): isti skup sada štiti i default ručnog `POST /sync/run`, pa
// mora živeti u sync modulu — jedan izvor, bez kopije logike.
export { NIGHTLY_SYNC_EXCLUDED };

/*
 * PRUGA P (docs/PLAN_AI_OS_2026-07.md §5; presuda Nenada 26.07.2026: „BigBit
 * noćni sync — UKLJUČITI ODMAH, paritet-guard ostaje").
 *
 * Do sada je BigBit master-data sync bio ISKLJUČIVO ručan (POST /api/v1/sync/run,
 * `sync.run` dozvola) — ukupno 3 povlačenja (08.07, 13.07, 22.07), pa 3.0/4.0
 * moduli rade nad zastarelim šifarnicima. Ovaj posao NE PRAVI NOV PUT PODATAKA:
 * zove ISTI `SyncService.run()` koji stoji iza dugmeta, samo sa `trigger:"cron"`.
 *
 * PUT PODATAKA (nepromenjen): BigBit Access front → njegov SQL Server backend
 * (`BIGBIT_DB_*`, Vasa-SQL:5765, read-only nalog `bridge_reader`, preko firmine
 * VPN mreže) → `MssqlClient` (samo SELECT) → per-entity syncer → Postgres +
 * dnevnik `bb_sync_log` / kursori `bb_sync_state`. Nema .mdb izvoza, nema pisanja
 * ka BigBit-u (BACKEND_RULES §4.7).
 *
 * IDEMPOTENTNOST (uslov za ponavljanje svake noći):
 *  • `incremental` synceri (watermark `PoslednjaIzmena`) rade `upsert` po PK →
 *    ponovljen prolaz daje isti rezultat; kursor napreduje tek posle uspeha.
 *  • `full_refresh` synceri rade `deleteMany` + `createMany` u jednoj transakciji
 *    → tabela je determinističko ogledalo izvora, takođe ponovljivo.
 * Oba oblika su bezbedna SAMO za tabele čiji je jedini pisac BigBit sync. Zato
 * postoji `DEFAULT_SYNC_EXCLUDED` (u `table-ownership.ts`) i zato posao NIKAD
 * ne šalje `force` (koji bi probio zaštitu ServoSync-owned tabela).
 *
 * REOPEN 061/26 (04.08.2026): `projects` i `customers` su IZBAČENI iz ovog
 * posla — od 30.07 ih vozi noćni .mdb uvoz (03:45), a MSSQL kopija je zamrznuta
 * na 22.07, pa bi ovaj prolaz (03:30) svako jutro vraćao predmete na staro
 * 15 minuta pre svežeg uvoza. Paritet-guard predmeta (`ADDITIVE_REFRESH_TABLES`
 * + `ADDITIVE_DEDUP_FIELDS.projects`) i dalje važi za admin-eksplicitni MSSQL
 * prolaz i pinovan je testom u `bigbit-sync-jobs.service.spec.ts`.
 */

/** Ključ posla u `scheduled_job_runs.job_key` — ne menjati posle uvođenja. */
export const BIGBIT_NIGHTLY_SYNC_JOB_KEY = "bigbit-nightly-sync";

// (Skup isključenih tokova — `NIGHTLY_SYNC_EXCLUDED` — definisan je u
// ../sync/table-ownership.ts; puno obrazloženje ZAŠTO je `items` isključen
// stoji tamo, uz sam skup.)

/**
 * Gornja granica čekanja na jedan noćni prolaz. Tik scheduler-a je SEKVENCIJALAN
 * (`tickBusy`) — zaglavljen sync bi blokirao sve ostale poslove (06:00 prisustvo
 * ima catch-up od svega 55 min i propao bi). Race prekida ČEKANJE (run → FAILED +
 * retry po postojećem mehanizmu); sam sync se u pozadini dovršava ili padne na
 * svojim MSSQL/transakcionim timeout-ima, a in-process `running` guard u
 * `SyncService` spreči da se preklopi sa sledećim pokušajem (drugi pokušaj tada
 * padne sa „A sync run is already in progress" — vidljivo u dnevniku).
 * 45 min: start 03:30 → najkasniji kraj 04:15, komotno pre prvog jutarnjeg posla.
 */
const NIGHTLY_SYNC_TIMEOUT_MS = 45 * 60_000;

/** Oblik jednog entiteta u `bb_sync_log.metadata` (piše ga `SyncService.run`). */
interface EntityMeta {
  rowsFetched?: number;
  rowsUpserted?: number;
  rowsSkipped?: number;
  note?: string;
  error?: string;
}

@Injectable()
export class BigbitSyncJobs {
  private readonly logger = new Logger(BigbitSyncJobs.name);

  constructor(private readonly sync: SyncService) {}

  /**
   * Prekidač posla — isti obrazac kao `SCHEDULER_ENABLED`: bez njega je deploy
   * koda potpuno bezbedan. Razlika je namerna: dok je `false`, posao se i NE
   * REGISTRUJE (ne vidi se u `/scheduler/jobs`, ne može ni `run-now`), jer
   * automatsko povlačenje master podataka mora da bude svesna Nenadova radnja.
   */
  get enabled(): boolean {
    return process.env.BIGBIT_NIGHTLY_SYNC === "true";
  }

  /**
   * Svi registrovani entiteti MINUS isključeni tokovi. Od reopena 061/26
   * (04.08.2026) filter je `DEFAULT_SYNC_EXCLUDED` — pored `items` ispadaju i
   * zamrznuti MSSQL tokovi: `projects`/`customers` od 30.07 vozi noćni .mdb
   * uvoz (03:45), pa bi ovaj posao (03:30, frozen kopija od 22.07) svako jutro
   * pregazio svežije podatke 15 minuta pre nego što stignu; šest praznih
   * izvora bi svake noći bacalo garantovanu grešku (obrazloženje uz skup u
   * table-ownership.ts).
   */
  nightlyEntities(): string[] {
    return this.sync.availableEntities.filter(
      (e) => !DEFAULT_SYNC_EXCLUDED.has(e),
    );
  }

  buildJobs(): ScheduledJob[] {
    if (!this.enabled) {
      this.logger.log(
        "BigBit noćni sync ISKLJUČEN (BIGBIT_NIGHTLY_SYNC != 'true') — posao nije registrovan; povlačenje ostaje ručno (POST /api/v1/sync/run).",
      );
      return [];
    }
    return [
      {
        key: BIGBIT_NIGHTLY_SYNC_JOB_KEY,
        description:
          "BigBit noćni sync: master podaci (MSSQL → Postgres) svih tokova osim " +
          `isključenih (${[...DEFAULT_SYNC_EXCLUDED].join(", ") || "—"})`,
        // 03:30 — noćni backup starta u 02:30 (backend/scripts/backup-nightly.sh,
        // cron admnenad; monitor diže alarm ako pređe 15 min), pa je u 03:30
        // sinoćnja kopija sigurno gotova: ako sync donese pokvarene podatke,
        // povratak na stanje pre njega postoji u dump-u. `retention-cleanup` deli
        // isti termin, ali je registrovan RANIJE i u istom tiku se izvršava prvi
        // (brza brisanja), pa se ne preklapaju.
        schedule: { kind: "daily", at: "03:30" },
        // Catch-up 120 min (review [8]): default 180 bi u najgorem slučaju
        // startovao pun sync tek u 06:30 — tačno kad kreću jutarnji poslovi i
        // kad ljudi ulaze u sistem. 120 min drži prozor unutar noći (do 05:30).
        catchUpMinutes: 120,
        // Zaglavljen RUNNING se preuzima tek posle 60 min (review [7]): default
        // od 10 min je kraći od normalnog trajanja ovog posla, pa bi ga sam
        // scheduler pokrenuo drugi put dok prvi još radi. 60 > 45 min koliko
        // posao uopšte čeka na sync.
        staleAfterMinutes: 60,
        // Isti razlog za ručno okidanje (review [14]) — admin ne sme da startuje
        // drugi prolaz preko prvog koji još radi.
        runNowBlockMinutes: 60,
        run: async () => this.runNightly(),
      },
    ];
  }

  /**
   * Jedan noćni prolaz. Vraća summary za `scheduled_job_runs.summary`; BACA samo
   * kad je nešto stvarno palo (vidi ispod) — tada scheduler upiše FAILED i
   * ponavlja po postojećem backoff-u (MAX_ATTEMPTS=3, 10min × attempts).
   */
  private async runNightly(): Promise<string> {
    const entities = this.nightlyEntities();
    const log = await this.withTimeout(
      // Bez `strategy` (svaki syncer bira svoju: incremental gde ima watermark,
      // inače full refresh) i bez `force` (zaštita ServoSync-owned tabela ostaje).
      this.sync.run({ entities, trigger: "cron" }),
    );

    const meta = (log.metadata ?? {}) as Record<string, EntityMeta>;
    const failed: string[] = [];
    const perEntity: string[] = [];
    for (const entity of entities) {
      const m = meta[entity];
      if (!m) {
        perEntity.push(`${entity}=?`);
        continue;
      }
      if (m.error) {
        failed.push(`${entity}: ${m.error}`);
        perEntity.push(`${entity}=GREŠKA`);
        continue;
      }
      const skipped = m.rowsSkipped ? `,presk=${m.rowsSkipped}` : "";
      perEntity.push(
        `${entity}=${m.rowsFetched ?? 0}/${m.rowsUpserted ?? 0}${skipped}`,
      );
    }

    const head =
      `sync #${log.id} ${log.status}: povučeno=${log.rowsFetched} ` +
      `upisano=${log.rowsUpserted} preskočeno=${log.rowsSkipped} ` +
      `(${entities.length} tokova, isključeno ${DEFAULT_SYNC_EXCLUDED.size})`;

    // Pad = ili ceo run (npr. BigBit nedostupan → svaki entitet baci) ili bar
    // jedan entitet sa greškom. `partial` SAM PO SEBI nije pad: `SyncService`
    // ga postavlja i kad su redovi samo PRESKOČENI (paritet-guard predmeta,
    // duplikat kataloškog broja DB-081) — to je očekivano stanje svake noći i
    // ne sme da okida retry ni alarm.
    if (log.status === "failed" || failed.length) {
      const detail = failed.length
        ? failed.join("; ").slice(0, 800)
        : (log.errorMessage ?? "bez detalja");
      throw new Error(
        `${head} — palo ${failed.length || "sve"} tokova: ${detail}`,
      );
    }

    return `${head}; ${perEntity.join(" ")}`;
  }

  /** Race koji oslobađa scheduler tik (vidi `NIGHTLY_SYNC_TIMEOUT_MS`). */
  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `BigBit sync nije završio za ${NIGHTLY_SYNC_TIMEOUT_MS / 60_000} min — čekanje prekinuto (sync se u pozadini dovršava; sledeći pokušaj će ga zateći kao „already in progress").`,
              ),
            ),
          NIGHTLY_SYNC_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  }
}
