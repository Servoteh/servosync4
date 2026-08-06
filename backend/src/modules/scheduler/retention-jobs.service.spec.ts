import { RetentionJobsService } from "./retention-jobs.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Retention posao glavne baze. Ovde se pini SAMO ono što tiho odlazi ako se
 * pokvari: da svaka tabela sa rokom zaista bude počišćena, i da se briše po
 * PRAVOM uslovu (rok, ne „sve").
 */

function prismaStub() {
  const del = () => jest.fn().mockResolvedValue({ count: 1 });
  return {
    auditLog: { deleteMany: del() },
    appNotification: { deleteMany: del() },
    scheduledJobRun: { deleteMany: del() },
    dictationInbox: { deleteMany: del() },
    apiIdempotency: { deleteMany: del() },
    bbMdbDrop: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
}

describe("RetentionJobsService — registar idempotencije", () => {
  it("posao čisti `api_idempotency` po starosti", async () => {
    // 🔴 sy15 parnjak (`rev_api_idempotency`) NEMA čišćenje: izmereno 05.08.2026 —
    // 0 pg_cron poslova, 0 trigera, najstariji red od dana nastanka registra i
    // nijedan nikad obrisan. Ako ovaj poziv ispadne, 3.0 nasleđuje isti kvar.
    const prisma = prismaStub();
    const jobs = new RetentionJobsService(prisma).buildJobs();
    const posao = jobs.find((j) => j.key === "retention-cleanup");
    expect(posao).toBeDefined();

    const pre = Date.now();
    const summary = await posao!.run({} as never);

    const arg = (prisma.apiIdempotency.deleteMany as jest.Mock).mock.calls[0][0];
    // Briše se po `created_at < cutoff` — nikad bezuslovno.
    expect(Object.keys(arg.where)).toEqual(["createdAt"]);
    expect(Object.keys(arg.where.createdAt)).toEqual(["lt"]);
    const dana = (pre - arg.where.createdAt.lt.getTime()) / 86_400_000;
    expect(Math.round(dana)).toBe(30);
    expect(summary).toContain("ključevi idempotencije");
  });

  it("uklopljen je u POSTOJEĆI posao (03:30, posle noćnog backupa) — ne pravi novi", async () => {
    // Sve što se briše mora već biti u sinoćnem dump-u, pa je svaki obrisani red
    // povrativ iz kopije. Zaseban posao u drugom terminu to svojstvo ne bi imao.
    const jobs = new RetentionJobsService(prismaStub()).buildJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].schedule).toEqual({ kind: "daily", at: "03:30" });
  });
});
