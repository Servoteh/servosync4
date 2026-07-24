import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PrismaService } from "../../prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";

/**
 * Talas A — pregled i ručno okidanje zakazanih poslova (admin). `run-now` radi
 * i kad je pogon isključen (SCHEDULER_ENABLED) — za probu pre aktivacije.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ path: "scheduler", version: "1" })
export class SchedulerController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("jobs")
  @RequirePermission(PERMISSIONS.SCHEDULER_READ)
  async jobs() {
    const jobs = this.scheduler.list();
    // Poslednja 3 run-a PO POSLU — po ključu (globalni take bi 30-min posao
    // istisnuo istoriju dnevnih/nedeljnih); indeks (job_key, started_at DESC).
    const perKey = await Promise.all(
      jobs.map((jb) =>
        this.prisma.scheduledJobRun.findMany({
          where: { jobKey: jb.key },
          orderBy: [{ startedAt: "desc" }],
          take: 3,
        }),
      ),
    );
    const byKey = new Map(jobs.map((jb, i) => [jb.key, perKey[i]]));
    return {
      data: {
        enabled: this.scheduler.enabled,
        jobs: jobs.map((j) => ({
          key: j.key,
          description: j.description,
          schedule: j.schedule,
          lastRuns: (byKey.get(j.key) ?? []).map((r) => ({
            scheduledFor: r.scheduledFor,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            status: r.status,
            attempts: r.attempts,
            summary: r.summary,
            error: r.error,
          })),
        })),
      },
    };
  }

  @Post("jobs/:key/run-now")
  @RequirePermission(PERMISSIONS.SCHEDULER_RUN)
  async runNow(@Param("key") key: string) {
    try {
      const result = await this.scheduler.runNow(key);
      return { data: { key, ...result } };
    } catch (e) {
      throw new HttpException(
        e instanceof Error ? e.message : "Okidanje nije uspelo.",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }
}
