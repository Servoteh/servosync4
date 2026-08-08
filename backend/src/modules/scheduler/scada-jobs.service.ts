import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ScadaSourceService } from "../../common/sy15/scada-source.service";
import type { ScheduledJob } from "./scheduler.types";

/*
 * Seoba SCADA sy15 -> 3.0 (07.08.2026) — dva pozadinska posla domena koje je u sy15
 * vozio pg_cron, odnosno sam relej. Runbook: docs/SEOBA_SCADA_2026-08-07.md.
 *
 * OBA SE REGISTRUJU SAMO POD `SCADA_IZVOR=3.0`. Razlog nije kozmetika: dok je izvor
 * `sy15`, podatke drzi sy15 i tamo ih vec obradjuju pg_cron `scada_watchdog_every_5_min`
 * i retencija u releju. Da se ovi poslovi registruju bezuslovno, oba sistema bi radila
 * isti posao nad DVE baze — a watchdog bi u 3.0 (gde su snapshotovi prazni i `updated_at`
 * nikad ne stize) digao BRIDGE_STALE alarm za svih 5 sistema odmah po deploy-u, na
 * ekranu koji jos gleda u sy15. Prekidac je zato uslov registracije, ne uslov unutar `run`.
 */

/** Kljucevi poslova u `scheduled_job_runs.job_key` — ne menjati posle uvodjenja. */
export const SCADA_WATCHDOG_JOB_KEY = "scada-watchdog";
export const SCADA_RETENTION_JOB_KEY = "scada-retention";

/**
 * Posle koliko minuta bez svezeg snapshota sistem vazi za „bridge ne salje".
 * 5 min = doslovno iz sy15 `scada_watchdog()` (relej pise na svakih 5 s, pa je 5 min
 * ~60 propustenih prolaza — dovoljno da ne alarmira na jedan mrezni trzaj).
 */
const STALE_AFTER_MINUTES = 5;

/** Ozbiljnost BRIDGE_STALE alarma — 2 (doslovno iz sy15 funkcije). */
const STALE_SEVERITY = 2;

/**
 * Koliko dana uzoraka trenda se cuva.
 *
 * 🔴 60 = ODLUKA VLASNIKA (Nenad, 07.08.2026): *„ta istorija nam ne treba, posebno ne
 * tolika i da opterecuje server — zadnjih dva meseca uvek da bude aktuelno u nasoj bazi
 * mi je sasvim OK"*. Ranije je stajalo 90 (nasledjeno iz `SCADA_HISTORY_RETENTION_DAYS`
 * u bridge/src/config.js, tj. ono sto je sy15 radila) — pri seobi je namerno ostavljeno
 * netaknuto da se dve odluke ne mesaju, a sada se sprovodi trazeni rok.
 *
 * IZMERENO 08.08.2026 na 3.0: **67.850 redova / 16,6 MB dnevno**. Odatle:
 *   90 dana ≈ 6,1 mil. redova ≈ 1,5 GB
 *   60 dana ≈ 4,1 mil. redova ≈ 1,0 GB   ← ovo
 * Razlika je ~500 MB trajnog zauzeca, sto je i bio razlog odluke.
 *
 * Istorija iz sy15 NIJE prenosena (runbook §0), pa se prozor puni od 07.08.2026 —
 * prvi stvarni rez pada oko 06.10.2026.
 */
const HISTORY_RETENTION_DAYS = 60;

@Injectable()
export class ScadaJobsService {
  private readonly logger = new Logger(ScadaJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly izvor: ScadaSourceService,
  ) {}

  buildJobs(): ScheduledJob[] {
    if (!this.izvor.isThreeZero) return [];
    return [this.watchdogJob(), this.retentionJob()];
  }

  /**
   * PREPIS sy15 `scada_watchdog()` (pg_cron jobid 21, raspored „na svakih 5 minuta"),
   * izvucenog sa zive baze `pg_get_functiondef` 07.08.2026. Logika je prenesena DOSLOVNO:
   * za svaki sistem ciji je snapshot stariji od 5 min, a koji jos nema AKTIVAN
   * BRIDGE_STALE, ubaci alarm sa vremenom poslednjeg javljanja u lokalnoj zoni.
   *
   * ── KO GASI OVAJ ALARM ───────────────────────────────────────────────────────
   * NIKO ovde — i to je namerno, isto kao u sy15. Kad se relej vrati, njegov
   * diff-sync (`syncAlarms` u bridge/src/jobs/scadaSnapshot.js) vidi da BRIDGE_STALE
   * nije u skupu aktivnih alarma uredjaja i sam ga zatvori (`active=false` +
   * `cleared_at`). Zato watchdog SME samo da ubacuje: pisac koji gasi je relej.
   * Ako bi se ovde dodalo i gasenje, dva pisca bi se otimala o isti red.
   *
   * `ON CONFLICT DO NOTHING` + parcijalni UNIQUE `scada_alarms_one_active` znace da
   * ponovljen prolaz (catch-up posle restarta) ne moze da udvoji alarm.
   */
  private watchdogJob(): ScheduledJob {
    return {
      key: SCADA_WATCHDOG_JOB_KEY,
      description:
        `SCADA watchdog: sistem bez snapshota > ${STALE_AFTER_MINUTES} min → ` +
        `alarm BRIDGE_STALE (gasi ga relej kad se vrati)`,
      schedule: { kind: "everyMinutes", minutes: 5 },
      run: async () => {
        // Jedan INSERT ... SELECT, isto kao u sy15: provera i upis su u istom
        // izrazu, pa izmedju „nema aktivnog alarma" i upisa nema prozora.
        const inserted = await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO scada_alarms (site_key, code, severity, text)
          SELECT s.site_key, 'BRIDGE_STALE', ${STALE_SEVERITY}::smallint,
                 'Bridge ne šalje podatke od ' ||
                 to_char(s.updated_at AT TIME ZONE 'Europe/Belgrade', 'DD.MM. HH24:MI')
            FROM scada_snapshots s
           WHERE s.updated_at < now() - ${`${STALE_AFTER_MINUTES} minutes`}::interval
             AND NOT EXISTS (
               SELECT 1 FROM scada_alarms a
                WHERE a.site_key = s.site_key AND a.code = 'BRIDGE_STALE' AND a.active
             )
          ON CONFLICT DO NOTHING`);
        if (inserted > 0)
          this.logger.warn(
            `SCADA watchdog: ${inserted} sistem(a) bez snapshota > ${STALE_AFTER_MINUTES} min — BRIDGE_STALE upisan.`,
          );
        return inserted > 0
          ? `BRIDGE_STALE upisan za ${inserted} sistem(a)`
          : "svi sistemi svezi";
      },
    };
  }

  /**
   * Retencija `scada_history` — prepis `scadaHistoryCleanup()` iz releja.
   *
   * ZASTO JE PRESLA SA RELEJA NA SCHEDULER: u sy15 je brisanje radio relej jednom
   * dnevno iz svoje petlje. U 3.0 relej vise nema PostgREST kanal za masovni DELETE,
   * a i logicki je ovo posao baze, ne uredjaja — scheduler ga vozi kao i svaku drugu
   * retenciju (`retention-cleanup`, DB-043), sa dnevnikom u `scheduled_job_runs`
   * (relej je brisao bez ikakvog traga o tome koliko je redova otislo).
   *
   * Termin 03:40 prati obrazac `retention-cleanup` (03:30): POSLE nocnog backupa
   * (02:30-02:35), pa je svaki obrisan red i dalje povrativ iz sinocne kopije.
   * 10 min posle glavne retencije, da dva masovna DELETE-a ne idu u isti trenutak.
   */
  private retentionJob(): ScheduledJob {
    return {
      key: SCADA_RETENTION_JOB_KEY,
      description: `Retention: scada_history > ${HISTORY_RETENTION_DAYS} dana`,
      schedule: { kind: "daily", at: "03:40" },
      // Prvi rez posle seobe brise ~4,1 mil. redova odjednom (60 dana × ~67.850/dan) i
      // moze da traje duze od podrazumevanih 10 min — bez ovoga bi scheduler smatrao
      // posao zaglavljenim i pokrenuo ga drugi put PREKO prvog.
      staleAfterMinutes: 60,
      runNowBlockMinutes: 60,
      run: async () => {
        const cutoff = new Date(
          Date.now() - HISTORY_RETENTION_DAYS * 86_400_000,
        );
        const deleted = await this.prisma.scadaHistory.deleteMany({
          where: { ts: { lt: cutoff } },
        });
        return `scada_history: obrisano ${deleted.count} uzoraka starijih od ${cutoff.toISOString()}`;
      },
    };
  }
}
