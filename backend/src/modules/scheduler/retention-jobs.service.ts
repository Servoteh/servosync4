import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { JOB_STATUS, type ScheduledJob } from "./scheduler.types";

/*
 * Retention poslovi glavne baze (DB audit DB-043; rokovi = odluka 25.07.2026).
 * Do sada je JEDINA tabela sa čišćenjem bila refresh_tokens (prune pri loginu) —
 * audit_log je rastao ~1k redova/dan (globalni interceptor po svakoj mutaciji).
 *
 * NE briše se (odluka): sef_status_log, sef_outbox, bb_sync_log, drawing_import_log
 * — SEF/sync trag ostaje do posebne odluke o zakonskim rokovima.
 */
const AUDIT_LOG_MONTHS = 24;
const NOTIFICATIONS_READ_DAYS = 90;
const JOB_RUNS_DAYS = 60;
/**
 * Koliko poslednjih BigBit .mdb drop-ova zadržava STAGING (sirove CSV redove).
 * Staging je međukorak: ~7,4 MB po noći danas, a kad stigne puna BigBit istorija
 * to su stotine hiljada redova po noći — bez čišćenja bi nadrastao stvarne
 * podatke na istom disku na kome radi 4.0.
 *
 * ZAPISNIK (`bb_mdb_drops`) SE NE BRIŠE: FK ka njemu je `ON DELETE RESTRICT`
 * upravo zato što je oznaka porekla uvezenih redova (`imported_drop_id`) jedini
 * način da se posle kaže IZ KOG fajla je koji red došao.
 */
const MDB_STAGE_KEEP_DROPS = 7;

@Injectable()
export class RetentionJobsService {
  constructor(private readonly prisma: PrismaService) {}

  buildJobs(): ScheduledJob[] {
    return [
      {
        key: "retention-cleanup",
        description:
          `Retention: audit_log > ${AUDIT_LOG_MONTHS} mes., pročitane notifikacije > ` +
          `${NOTIFICATIONS_READ_DAYS} d, završeni job-runovi > ${JOB_RUNS_DAYS} d`,
        // 03:30 — POSLE noćnog backupa (02:30–02:35): sve što se briše već je u
        // sinoćnom dump-u, pa je svaki obrisani red i dalje povrativ iz kopije.
        schedule: { kind: "daily", at: "03:30" },
        run: async () => {
          const now = Date.now();
          const auditCutoff = new Date(now);
          auditCutoff.setMonth(auditCutoff.getMonth() - AUDIT_LOG_MONTHS);
          const notifCutoff = new Date(
            now - NOTIFICATIONS_READ_DAYS * 86_400_000,
          );
          const runsCutoff = new Date(now - JOB_RUNS_DAYS * 86_400_000);

          const audit = await this.prisma.auditLog.deleteMany({
            where: { createdAt: { lt: auditCutoff } },
          });
          // `readAt < cutoff` implicira readAt NOT NULL — nepročitane se NE brišu.
          const notif = await this.prisma.appNotification.deleteMany({
            where: { readAt: { lt: notifCutoff } },
          });
          // uq (jobKey, scheduledFor) je mutex claim-a — briše se SAMO završeno,
          // daleko van svakog catch-up prozora (max je 180 min, rok je 60 dana).
          const runs = await this.prisma.scheduledJobRun.deleteMany({
            where: {
              status: { in: [JOB_STATUS.DONE, JOB_STATUS.FAILED] },
              scheduledFor: { lt: runsCutoff },
            },
          });
          const stage = await this.purgeMdbStaging();
          return (
            `audit_log −${audit.count}, notifikacije −${notif.count}, ` +
            `job-runovi −${runs.count}, bb_mdb staging −${stage}`
          );
        },
      },
    ];
  }

  /**
   * Obriši SIROV staging starih .mdb drop-ova, uz zadržavanje reda u
   * `bb_mdb_drops`. Vraća broj obrisanih redova preko svih staging tabela.
   *
   * Tabele se navode eksplicitno (ne `information_schema` pretragom) da bi
   * spisak bio vidljiv i da nova staging tabela ne bi tiho ostala neočišćena.
   */
  private async purgeMdbStaging(): Promise<number> {
    const keep = await this.prisma.bbMdbDrop.findMany({
      orderBy: { id: "desc" },
      take: MDB_STAGE_KEEP_DROPS,
      select: { id: true },
    });
    if (!keep.length) return 0;
    const keepIds = keep.map((k) => k.id);
    const del = (t: {
      deleteMany: (a: unknown) => Promise<{ count: number }>;
    }) => t.deleteMany({ where: { dropId: { notIn: keepIds } } });
    const counts = await Promise.all([
      del(this.prisma.bbMdbStageGk),
      del(this.prisma.bbMdbStageNalog),
      del(this.prisma.bbMdbStageAccount),
      del(this.prisma.bbMdbStageOrderType),
      del(this.prisma.bbMdbStageSaldakonto),
      del(this.prisma.bbMdbStageScheme),
      del(this.prisma.bbMdbStageSchemeLine),
      del(this.prisma.bbMdbStagePdvGk),
      del(this.prisma.bbMdbStagePopdvGk),
    ]);
    return counts.reduce((a, c) => a + c.count, 0);
  }
}
