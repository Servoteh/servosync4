import { Injectable, Logger } from "@nestjs/common";
// SAMO TIP (`import type`) — nema runtime uvoza scheduler modula, pa nema
// kružne zavisnosti kad `SchedulerModule` uveze `SyncModule`.
import type { ScheduledJob } from "../scheduler/scheduler.types";
import { PrismaService } from "../../prisma/prisma.service";
import { SyncSwitchService } from "../podesavanja/sync-switch.service";
import { BigbitMdbImportService } from "./bigbit-mdb-import.service";
import {
  BIGBIT_MDB_SYNC_JOB_KEY,
  BIGBIT_MDB_SYNC_SWITCH,
  BIGBIT_MDB_WATCHDOG_JOB_KEY,
} from "../../common/switches/bigbit-sync";
import { ROLES } from "../../common/authz/roles";

/**
 * Zakazani poslovi noćnog BigBit .mdb uvoza. REGISTRUJE ih `SchedulerModule`
 * (`imports: [SyncModule]` + petlja u `onModuleInit`) — bez toga ovo je
 * biblioteka bez pozivaoca i noću se ne dešava ništa.
 *
 * KLJUČ POSLA dolazi iz `common/switches/bigbit-sync.ts` i ISTI je onaj koji
 * ekran Podešavanja → Integracije čita iz `scheduled_job_runs`. Ranije su to
 * bila dva različita stringa, pa ekran nikad nije mogao da prijavi ni pad ni
 * uspeh. Ne prekucavati literal — uvoziti konstantu.
 *
 * RASPORED
 *   • uvoz 03:45 — posle noćnog backupa (02:30–02:35), posle koraka 1 na hostu
 *     (systemd `bigbit-mdb-export.timer`, 02:50) i posle `retention-cleanup`
 *     (03:30), koji se u istom tiku izvršava serijski.
 *   • nadzornik 07:15 — pre početka radnog dana, da čovek zatekne poruku.
 *
 * PREKIDAČI (tri, nezavisna):
 *   • `SCHEDULER_ENABLED` — opšti pogon scheduler-a.
 *   • `app_switches` red `bigbit_mdb_sync` (`switchKey` ispod) — korisnički
 *     prekidač; scheduler ga proverava na JEDNOM mestu za sve ulaze.
 *   • ručno: `POST /api/v1/scheduler/jobs/bigbit-mdb-sync/run-now`.
 */
@Injectable()
export class BigbitMdbJobs {
  private readonly logger = new Logger(BigbitMdbJobs.name);

  constructor(
    private readonly importer: BigbitMdbImportService,
    private readonly switches: SyncSwitchService,
    private readonly prisma: PrismaService,
  ) {}

  buildJobs(): ScheduledJob[] {
    return [
      {
        key: BIGBIT_MDB_SYNC_JOB_KEY,
        description:
          "BigBit .mdb: uvoz glavne knjige, naloga i kontnog plana iz noćnog drop-a",
        schedule: { kind: "daily", at: "03:45" },
        // Deploy/restart tačno u terminu ne sme da pojede noćni uvoz; 4 h prozora
        // je dovoljno da se termin nadoknadi pre početka radnog dana.
        catchUpMinutes: 240,
        switchKey: BIGBIT_MDB_SYNC_SWITCH,
        run: async () => {
          const res = await this.importer.runImport();
          this.logger.log(`${BIGBIT_MDB_SYNC_JOB_KEY}: ${res.summary}`);
          return res.summary;
        },
      },
      {
        key: BIGBIT_MDB_WATCHDOG_JOB_KEY,
        description:
          "BigBit uvoz — jutarnji nadzor: gurni upozorenje adminima (zvonce) ako uvoz kasni, pada ili je ugašen",
        schedule: { kind: "daily", at: "07:15" },
        catchUpMinutes: 240,
        // NAMERNO BEZ `switchKey`: nadzornik mora da radi i kad je uvoz ugašen —
        // „ugašen mesec dana, a niko ne zna" je upravo kvar zbog kog postoji.
        run: async () => this.runWatchdog(),
      },
    ];
  }

  /**
   * Nadzor koji GURA poruku ka čoveku. Bez njega sva upozorenja postoje samo na
   * kartici u Podešavanja → Integracije — ekranu koji admin otvara par puta
   * godišnje, pa bi mrtav kanal bio otkriven tek pri poređenju PDV obračuna.
   *
   * IDEMPOTENCIJA: jedna poruka po danu po primaocu (provera `app_notifications`
   * od ponoći), pa catch-up/retry ne pravi tri obaveštenja.
   */
  private async runWatchdog(): Promise<string> {
    const status = await this.switches.bigbitStatus();
    const danger = status.data.warnings.filter((w) => w.level === "danger");
    if (!danger.length)
      return "sve u redu — nema upozorenja, ništa nije poslato";

    const recipients = await this.adminWorkerIds();
    if (!recipients.length)
      return `${danger.length} upozorenje(a), ali NEMA primaoca (nijedan aktivan admin nema povezanog radnika) — poruka nije poslata`;

    const sinceMidnight = new Date();
    sinceMidnight.setHours(0, 0, 0, 0);
    const already = await this.prisma.appNotification.findMany({
      where: {
        type: WATCHDOG_NOTIFICATION_TYPE,
        createdAt: { gte: sinceMidnight },
        recipientWorkerId: { in: recipients },
      },
      select: { recipientWorkerId: true },
    });
    const done = new Set(already.map((a) => a.recipientWorkerId));
    const todo = recipients.filter((id) => !done.has(id));
    if (!todo.length)
      return `${danger.length} upozorenje(a) — obaveštenje je već poslato danas (${recipients.length} primalac/laca)`;

    const message = `Uvoz iz BigBita: ${danger.map((w) => w.message).join(" ")}`;
    const created = await this.prisma.appNotification.createMany({
      data: todo.map((recipientWorkerId) => ({
        type: WATCHDOG_NOTIFICATION_TYPE,
        message: message.slice(0, 500),
        refTable: "app_switches",
        refId: null,
        recipientWorkerId,
      })),
    });
    this.logger.warn(
      `BigBit nadzor: ${danger.length} upozorenje(a), obavešteno ${created.count} korisnika`,
    );
    return `${danger.length} upozorenje(a) — obavešteno ${created.count} korisnika: ${message.slice(0, 200)}`;
  }

  /** Aktivni administratori koji imaju povezanog radnika (zvonce ide po `workers.id`). */
  private async adminWorkerIds(): Promise<number[]> {
    const users = await this.prisma.user.findMany({
      where: { active: true, role: ROLES.ADMIN, workerId: { not: null } },
      select: { workerId: true },
    });
    return [...new Set(users.map((u) => u.workerId as number))];
  }
}

/** `app_notifications.type` nadzornika — stabilan, ide u podatke. */
const WATCHDOG_NOTIFICATION_TYPE = "bigbit.sync.alarm";
