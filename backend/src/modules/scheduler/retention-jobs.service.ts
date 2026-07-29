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
// Diktafon „sanduče": preuzet (delivered) diktat je prolazni tekst — čisti se brzo;
// NEPREUZETI (delivered_at IS NULL) se NIKAD ne diraju (čekaju Claude pull).
const DICTATION_DELIVERED_DAYS = 30;

@Injectable()
export class RetentionJobsService {
  constructor(private readonly prisma: PrismaService) {}

  buildJobs(): ScheduledJob[] {
    return [
      {
        key: "retention-cleanup",
        description:
          `Retention: audit_log > ${AUDIT_LOG_MONTHS} mes., pročitane notifikacije > ` +
          `${NOTIFICATIONS_READ_DAYS} d, završeni job-runovi > ${JOB_RUNS_DAYS} d, ` +
          `preuzeti diktati > ${DICTATION_DELIVERED_DAYS} d`,
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
          const dictCutoff = new Date(
            now - DICTATION_DELIVERED_DAYS * 86_400_000,
          );

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
          // `deliveredAt < cutoff` implicira deliveredAt NOT NULL — nepreuzeti diktati
          // (delivered_at IS NULL) se NE brišu, čekaju Claude pull koliko god treba.
          const dict = await this.prisma.dictationInbox.deleteMany({
            where: { deliveredAt: { lt: dictCutoff } },
          });
          return `audit_log −${audit.count}, notifikacije −${notif.count}, job-runovi −${runs.count}, diktati −${dict.count}`;
        },
      },
    ];
  }
}
