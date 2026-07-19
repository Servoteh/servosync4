import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PracenjeService } from "./pracenje.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Popravni krug F1 — jedinični testovi mutacionog sloja (bez žive baze; Prisma mokovan).
 * Pinuju dva adversarna nalaza:
 *   #2  aktivnost mutacije pišu STRUKTURISAN audit red (entityType='operativna_aktivnost',
 *       entityId=String(id)) koji `PracenjeReadService.aktivnostIstorija` zaista čita —
 *       globalni interceptor upisuje pogrešan entityType iz URL-a ('pracenje'/'aktivnosti').
 *   #3  `upsertParentOverride` odbija ciklus (self + A→B→A preko override-a i preko BOM-a),
 *       ne samo self-parent.
 * Uz to: opciona Int polja ostaju null (ne 0) na servis-sloju.
 */

type Rec = Record<string, unknown>;
/** `data` argument prvog poziva Prisma create mocka (izbegava no-unsafe-member-access). */
const dataArg = (m: jest.Mock): Rec => {
  const calls = m.mock.calls as unknown as { data: Rec }[][];
  return calls[0][0].data;
};

/** Prisma-like mock (samo metode koje mutacioni servis dodiruje). */
function makePrisma() {
  const prisma = {
    operativnaAktivnost: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    operativnaAktivnostBlokada: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    },
    odeljenje: { findUnique: jest.fn() },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 100 }) },
    pracenjeStructureOverride: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    workOrderComponent: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma),
  );
  return prisma;
}

/** Puna aktivnost (create/update result) — snapshot helper čita ova polja. */
const fullAktivnost = (over: Partial<Rec> = {}): Rec => ({
  id: 42,
  workOrderId: null,
  projectId: null,
  odeljenjeId: 1,
  nazivAktivnosti: "A",
  status: "nije_krenulo",
  prioritet: "srednji",
  rb: 0,
  odgovoranUserId: null,
  odgovoranWorkerId: null,
  odgovoranLabel: null,
  planiraniPocetak: null,
  planiraniZavrsetak: null,
  statusMode: "manual",
  izvor: "rucno",
  ...over,
});

describe("PracenjeService (F1 popravni krug) — audit + cycle guard", () => {
  const actor = { userId: 7, email: "a@servoteh.com" };
  let prisma: ReturnType<typeof makePrisma>;
  let service: PracenjeService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new PracenjeService(prisma as unknown as PrismaService);
  });

  // ---------- Nalaz #2: strukturisan audit aktivnosti ----------

  describe("upsertAktivnost — strukturisan audit", () => {
    it("create → audit entityType='operativna_aktivnost', entityId=String(id), afterData set", async () => {
      prisma.odeljenje.findUnique.mockResolvedValue({ id: 1 });
      prisma.operativnaAktivnost.create.mockResolvedValue(
        fullAktivnost({ id: 42, planiraniPocetak: new Date("2026-07-01T00:00:00Z") }),
      );
      const res = await service.upsertAktivnost(actor, {
        odeljenjeId: 1,
        nazivAktivnosti: "A",
      } as never);
      expect(res).toEqual({ data: { id: 42 } });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const audit = dataArg(prisma.auditLog.create);
      expect(audit.entityType).toBe("operativna_aktivnost");
      expect(audit.entityId).toBe("42");
      expect(audit.action).toBe("CREATE aktivnost");
      expect(audit.actorUserId).toBe(7);
      expect(audit.actorUsername).toBe("a@servoteh.com");
      expect(audit.beforeData).toBeUndefined();
      expect(audit.afterData).toMatchObject({
        id: 42,
        status: "nije_krenulo",
        planirani_pocetak: "2026-07-01",
      });
    });

    it("update → audit ima beforeData + afterData; entityId=String(dto.id)", async () => {
      prisma.odeljenje.findUnique.mockResolvedValue({ id: 1 });
      prisma.operativnaAktivnost.findUnique.mockResolvedValue(
        fullAktivnost({ id: 9, status: "u_toku", nazivAktivnosti: "stari" }),
      );
      prisma.operativnaAktivnost.update.mockResolvedValue(
        fullAktivnost({ id: 9, status: "u_toku", nazivAktivnosti: "novi" }),
      );
      await service.upsertAktivnost(actor, {
        id: 9,
        odeljenjeId: 1,
        nazivAktivnosti: "novi",
      } as never);
      const audit = dataArg(prisma.auditLog.create);
      expect(audit.entityId).toBe("9");
      expect(audit.action).toBe("UPDATE aktivnost");
      expect(audit.beforeData).toMatchObject({ naziv_aktivnosti: "stari" });
      expect(audit.afterData).toMatchObject({ naziv_aktivnosti: "novi" });
    });

    it("update nepostojeće → NotFound, bez audit reda", async () => {
      prisma.odeljenje.findUnique.mockResolvedValue({ id: 1 });
      prisma.operativnaAktivnost.findUnique.mockResolvedValue(null);
      await expect(
        service.upsertAktivnost(actor, {
          id: 9,
          odeljenjeId: 1,
          nazivAktivnosti: "x",
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("izostavljena opciona Int polja ostaju null (ne 0) na servis-sloju", async () => {
      prisma.odeljenje.findUnique.mockResolvedValue({ id: 1 });
      prisma.operativnaAktivnost.create.mockResolvedValue(fullAktivnost());
      await service.upsertAktivnost(actor, {
        odeljenjeId: 1,
        nazivAktivnosti: "A",
        // radniNalogId / projekatId / odgovoranRadnikId izostavljeni (undefined)
      } as never);
      const created = dataArg(prisma.operativnaAktivnost.create);
      expect(created.workOrderId).toBeNull();
      expect(created.projectId).toBeNull();
      expect(created.odgovoranWorkerId).toBeNull();
      expect(created.odgovoranUserId).toBeNull();
    });

    it("nepostojeće odeljenje → BadRequest, bez audit reda", async () => {
      prisma.odeljenje.findUnique.mockResolvedValue(null);
      await expect(
        service.upsertAktivnost(actor, {
          odeljenjeId: 999,
          nazivAktivnosti: "A",
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("zatvori / blokiraj / odblokiraj — strukturisan audit", () => {
    it("zatvori → CLOSE aktivnost audit sa before/after status", async () => {
      prisma.operativnaAktivnost.findUnique.mockResolvedValue({ status: "u_toku" });
      prisma.operativnaAktivnost.update.mockResolvedValue({ id: 5 });
      await service.zatvoriAktivnost(actor, 5, { napomena: "gotovo" } as never);
      const audit = dataArg(prisma.auditLog.create);
      expect(audit.entityType).toBe("operativna_aktivnost");
      expect(audit.entityId).toBe("5");
      expect(audit.action).toBe("CLOSE aktivnost");
      expect(audit.beforeData).toEqual({ status: "u_toku" });
      expect(audit.afterData).toEqual({ status: "zavrseno", napomena: "gotovo" });
    });

    it("zatvori nepostojeće → NotFound, bez update/audit", async () => {
      prisma.operativnaAktivnost.findUnique.mockResolvedValue(null);
      await expect(
        service.zatvoriAktivnost(actor, 5, {} as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.operativnaAktivnost.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("blokiraj → BLOCK aktivnost audit + blokada red (u transakciji)", async () => {
      prisma.operativnaAktivnost.findUnique.mockResolvedValue({ status: "nije_krenulo" });
      prisma.operativnaAktivnost.update.mockResolvedValue({ id: 3 });
      await service.blokirajAktivnost(actor, 3, { razlog: "kvar" } as never);
      expect(prisma.operativnaAktivnostBlokada.create).toHaveBeenCalledTimes(1);
      const audit = dataArg(prisma.auditLog.create);
      expect(audit.action).toBe("BLOCK aktivnost");
      expect(audit.entityId).toBe("3");
      expect(audit.afterData).toEqual({ status: "blokirano", razlog: "kvar" });
    });

    it("blokiraj prazan razlog → BadRequest pre svih upita", async () => {
      await expect(
        service.blokirajAktivnost(actor, 3, { razlog: "   " } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.operativnaAktivnost.findUnique).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("odblokiraj → UNBLOCK aktivnost audit", async () => {
      prisma.operativnaAktivnost.findUnique.mockResolvedValue({ status: "blokirano" });
      prisma.operativnaAktivnostBlokada.findFirst.mockResolvedValue({ id: 8 });
      prisma.operativnaAktivnost.update.mockResolvedValue({ id: 3 });
      await service.odblokirajAktivnost(actor, 3, { napomena: "ok" } as never);
      const audit = dataArg(prisma.auditLog.create);
      expect(audit.action).toBe("UNBLOCK aktivnost");
      expect(audit.entityId).toBe("3");
      expect(audit.afterData).toEqual({ status: "nije_krenulo", napomena: "ok" });
    });
  });

  // ---------- Nalaz #3: cycle guard u upsertParentOverride ----------

  describe("upsertParentOverride — cycle guard", () => {
    it("self-parent (parentRnId == RN) → 422, bez upsert", async () => {
      await expect(
        service.upsertParentOverride(actor, {
          bigtehnRnId: "5",
          parentRnId: "5",
        } as never),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.pracenjeStructureOverride.upsert).not.toHaveBeenCalled();
    });

    it("ciklus A→B→A preko override-a (B.parent = A) → 422, bez upsert", async () => {
      // child A=1, novi parent B=2; postoji override B(2).parent = A(1) → ciklus.
      prisma.pracenjeStructureOverride.findUnique.mockImplementation(
        (args: { where: { workOrderId: number } }) =>
          args.where.workOrderId === 2 ? { parentWorkOrderId: 1 } : null,
      );
      await expect(
        service.upsertParentOverride(actor, {
          bigtehnRnId: "1",
          parentRnId: "2",
        } as never),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.pracenjeStructureOverride.upsert).not.toHaveBeenCalled();
    });

    it("ciklus preko BOM roditelja (A sadrži B) → 422", async () => {
      // Bez override-a; BOM: A(1) je roditelj komponente B(2) → hod naviše od B nalazi A.
      prisma.pracenjeStructureOverride.findUnique.mockResolvedValue(null);
      prisma.workOrderComponent.findMany.mockImplementation(
        (args: { where: { componentWorkOrderId: number } }) =>
          args.where.componentWorkOrderId === 2 ? [{ workOrderId: 1 }] : [],
      );
      await expect(
        service.upsertParentOverride(actor, {
          bigtehnRnId: "1",
          parentRnId: "2",
        } as never),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("bez ciklusa → upsert se izvrši i vrati id", async () => {
      prisma.pracenjeStructureOverride.findUnique.mockResolvedValue(null);
      prisma.workOrderComponent.findMany.mockResolvedValue([]); // B nema roditelja
      prisma.pracenjeStructureOverride.upsert.mockResolvedValue({ id: 11 });
      const res = await service.upsertParentOverride(actor, {
        bigtehnRnId: "1",
        parentRnId: "2",
      } as never);
      expect(res).toEqual({ data: { id: 11 } });
      expect(prisma.pracenjeStructureOverride.upsert).toHaveBeenCalledTimes(1);
    });

    it("detach na koren (parentRnId izostavljen) → upsert sa null, bez cycle-provere", async () => {
      prisma.pracenjeStructureOverride.upsert.mockResolvedValue({ id: 12 });
      const res = await service.upsertParentOverride(actor, {
        bigtehnRnId: "1",
      } as never);
      expect(res).toEqual({ data: { id: 12 } });
      expect(prisma.pracenjeStructureOverride.findUnique).not.toHaveBeenCalled();
      const upsertArg = (
        prisma.pracenjeStructureOverride.upsert.mock.calls as unknown as {
          create: { parentWorkOrderId: number | null };
        }[][]
      )[0][0].create;
      expect(upsertArg.parentWorkOrderId).toBeNull();
    });

    it("clear → deleteMany, bez cycle-provere", async () => {
      prisma.pracenjeStructureOverride.deleteMany.mockResolvedValue({ count: 1 });
      const res = await service.upsertParentOverride(actor, {
        bigtehnRnId: "1",
        clear: true,
      } as never);
      expect(res).toEqual({ data: { id: null, cleared: true } });
      expect(prisma.pracenjeStructureOverride.findUnique).not.toHaveBeenCalled();
      expect(prisma.pracenjeStructureOverride.upsert).not.toHaveBeenCalled();
    });
  });
});
