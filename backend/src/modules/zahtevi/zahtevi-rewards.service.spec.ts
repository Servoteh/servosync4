import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ZahteviRewardsService } from "./zahtevi-rewards.service";
import { ZahteviMailService } from "./zahtevi-mail.service";
import type { AuthUser } from "../auth/jwt.strategy";

const ADMIN: AuthUser = {
  userId: 1,
  email: "admin@servoteh.com",
  role: "admin",
  workerId: null,
};
const USER: AuthUser = {
  userId: 42,
  email: "u@servoteh.com",
  role: "viewer",
  workerId: null,
};

function calls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}
function firstArg<T>(mock: jest.Mock, i = 0): T {
  return calls(mock)[i][0] as T;
}

interface PrismaMock {
  changeRequest: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    count: jest.Mock;
  };
  changeRequestRewardTariff: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  changeRequestEvent: { create: jest.Mock };
  user: { findMany: jest.Mock; findUnique: jest.Mock };
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    changeRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    changeRequestRewardTariff: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    changeRequestEvent: { create: jest.fn().mockResolvedValue({}) },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

function baseReq(over: Record<string, unknown> = {}) {
  return {
    id: 10,
    reqNo: "001/26",
    title: "Naslov",
    description: "Opis",
    status: "SUBMITTED",
    finalScore: null,
    aiScore: 3,
    rewardAmount: null,
    rewardStatus: "PROPOSED",
    rewardMonth: null,
    createdByUserId: USER.userId,
    ...over,
  };
}

/** Tarifa red za dati score/amount. */
function tariff(score: number, amount: number) {
  return {
    id: score,
    score,
    amount: new Prisma.Decimal(amount),
    currency: "RSD",
    validFrom: new Date("2026-07-01T00:00:00.000Z"),
    createdByUserId: 0,
    createdAt: new Date(),
  };
}

/** Mail servis — closeMonth ga zove SAMO za opcioni zbirni mesečni pregled (fire-and-forget). */
function mailMock(): jest.Mocked<Pick<ZahteviMailService, "notifyMonthlySummary">> {
  return { notifyMonthlySummary: jest.fn().mockResolvedValue(0) };
}

describe("ZahteviRewardsService", () => {
  let service: ZahteviRewardsService;
  let prisma: PrismaMock;
  let mail: ReturnType<typeof mailMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    mail = mailMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviRewardsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ZahteviMailService, useValue: mail },
      ],
    }).compile();
    service = module.get(ZahteviRewardsService);
  });

  const thisMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  // ── SCORE ────────────────────────────────────────────────────────────────
  describe("score (potvrda ocene §12.2)", () => {
    it("ne-admin → 403", async () => {
      await expect(
        service.score(10, { score: 3 }, USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("nevalidna ocena (6) → 400", async () => {
      await expect(
        service.score(10, { score: 6 }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("score ≥1 → snapshot iznosa iz važeće tarife + CONFIRMED + rewardMonth tekući", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(baseReq());
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue(
        tariff(3, 1500),
      );
      prisma.changeRequest.count.mockResolvedValue(0); // mesec nije zaključen
      prisma.changeRequest.update.mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ ...baseReq(), ...(a.data as object) }),
      );
      await service.score(10, { score: 3 }, ADMIN);
      const arg = firstArg<{
        data: {
          finalScore: number;
          rewardAmount: Prisma.Decimal;
          rewardStatus: string;
          rewardMonth: string;
        };
      }>(prisma.changeRequest.update);
      expect(arg.data.finalScore).toBe(3);
      expect(arg.data.rewardAmount.toString()).toBe("1500");
      expect(arg.data.rewardStatus).toBe("CONFIRMED");
      expect(arg.data.rewardMonth).toBe(thisMonth());
    });

    it("score 0 → REJECTED + rewardStatus NONE (iz SUBMITTED)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ status: "SUBMITTED" }),
      );
      prisma.changeRequest.update.mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ ...baseReq(), ...(a.data as object) }),
      );
      await service.score(10, { score: 0 }, ADMIN);
      const arg = firstArg<{
        data: { status?: string; rewardStatus: string; finalScore: number };
      }>(prisma.changeRequest.update);
      expect(arg.data.status).toBe("REJECTED");
      expect(arg.data.rewardStatus).toBe("NONE");
      expect(arg.data.finalScore).toBe(0);
      const types = calls(prisma.changeRequestEvent.create).map(
        (c) => (c[0] as { data: { type: string } }).data.type,
      );
      expect(types).toContain("SCORE_CONFIRMED");
      expect(types).toContain("REJECTED");
    });

    it("nema važeće tarife za ocenu → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(baseReq());
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue(null);
      await expect(
        service.score(10, { score: 4 }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("već PAID → 422 (zaključen mesec immutable)", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "PAID", rewardMonth: "2026-06" }),
      );
      await expect(
        service.score(10, { score: 5 }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("F4: korekcija nagrade koja PRIPADA zaključenom mesecu → 422 (ne dira zaključen obračun)", async () => {
      // Zahtev je CONFIRMED za 2026-07, ali 2026-07 je u međuvremenu zaključen (PAID postoji).
      // F4: izmena postojeće nagrade u zaključenom mesecu je zabranjena — menjala bi njegov total.
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "CONFIRMED", rewardMonth: "2026-07" }),
      );
      // isMonthClosed(2026-07): PAID postoji → count>0.
      prisma.changeRequest.count.mockResolvedValue(1);
      await expect(
        service.score(10, { score: 2 }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.changeRequest.update).not.toHaveBeenCalled();
    });

    it("F4: NOVA potvrda (rewardMonth null) kad je tekući mesec zaključen → prelazi u naredni otvoreni", async () => {
      // rewardMonth još null (nikad potvrđeno) → nextOpenMonth: tekući zaključen, naredni otvoren.
      const now = new Date();
      const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextKey = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "PROPOSED", rewardMonth: null }),
      );
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue(
        tariff(2, 1000),
      );
      prisma.changeRequest.count.mockImplementation(
        (a: { where: { rewardMonth: string } }) =>
          Promise.resolve(a.where.rewardMonth === cur ? 1 : 0),
      );
      prisma.changeRequest.update.mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ ...baseReq(), ...(a.data as object) }),
      );
      await service.score(10, { score: 2 }, ADMIN);
      const arg = firstArg<{ data: { rewardMonth: string } }>(
        prisma.changeRequest.update,
      );
      expect(arg.data.rewardMonth).toBe(nextKey);
    });
  });

  // ── EXCLUDE ────────────────────────────────────────────────────────────────
  describe("exclude ↔ confirm (§12.3)", () => {
    it("exclude → rewardStatus EXCLUDED + event", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "CONFIRMED", rewardMonth: thisMonth() }),
      );
      prisma.changeRequest.update.mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ ...baseReq(), ...(a.data as object) }),
      );
      await service.exclude(10, { reason: "redovni zadatak" }, ADMIN);
      const arg = firstArg<{ data: { rewardStatus: string } }>(
        prisma.changeRequest.update,
      );
      expect(arg.data.rewardStatus).toBe("EXCLUDED");
      const types = calls(prisma.changeRequestEvent.create).map(
        (c) => (c[0] as { data: { type: string } }).data.type,
      );
      expect(types).toContain("REWARD_EXCLUDED");
    });

    it("re-score EXCLUDED → vraća u CONFIRMED", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "EXCLUDED", rewardMonth: null }),
      );
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue(
        tariff(3, 1500),
      );
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.update.mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ ...baseReq(), ...(a.data as object) }),
      );
      await service.score(10, { score: 3 }, ADMIN);
      const arg = firstArg<{ data: { rewardStatus: string } }>(
        prisma.changeRequest.update,
      );
      expect(arg.data.rewardStatus).toBe("CONFIRMED");
    });

    it("exclude PAID → 422", async () => {
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "PAID" }),
      );
      await expect(service.exclude(10, {}, ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("F4: exclude nagrade koja PRIPADA zaključenom mesecu (CONFIRMED, mesec zaključen) → 422", async () => {
      // Zaostali CONFIRMED (status nije PAID) u zaključenom mesecu — isključivanje bi promenilo total.
      prisma.changeRequest.findUnique.mockResolvedValue(
        baseReq({ rewardStatus: "CONFIRMED", rewardMonth: "2026-07" }),
      );
      prisma.changeRequest.count.mockResolvedValue(1); // 2026-07 zaključen (PAID postoji)
      await expect(
        service.exclude(10, { reason: "greška" }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.changeRequest.update).not.toHaveBeenCalled();
    });
  });

  // ── TARIFA ────────────────────────────────────────────────────────────────
  describe("tarifa PUT (nov red po važenju §12.2)", () => {
    it("PUT upisuje 5 novih redova sa validFrom danas (bez izmene starih)", async () => {
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue(null); // nema današnjeg reda
      prisma.changeRequestRewardTariff.create.mockImplementation(
        (a: { data: { score: number; amount: Prisma.Decimal } }) =>
          Promise.resolve({
            id: a.data.score,
            ...a.data,
            validFrom: new Date(),
          }),
      );
      await service.putTariffs(
        { amounts: { "1": 600, "2": 1100, "3": 1600, "4": 2100, "5": 3100 } },
        ADMIN,
      );
      // 5 create-ova, 0 update starih redova.
      expect(prisma.changeRequestRewardTariff.create).toHaveBeenCalledTimes(5);
      expect(prisma.changeRequestRewardTariff.update).not.toHaveBeenCalled();
    });

    it("PUT dvaput istog dana → update postojećeg reda (idempotentno)", async () => {
      prisma.changeRequestRewardTariff.findFirst.mockResolvedValue({
        id: 99,
        score: 1,
        amount: new Prisma.Decimal(500),
        validFrom: new Date(),
      });
      prisma.changeRequestRewardTariff.update.mockImplementation(
        (a: { data: unknown }) =>
          Promise.resolve({
            id: 99,
            validFrom: new Date(),
            ...(a.data as object),
          }),
      );
      await service.putTariffs(
        { amounts: { "1": 700, "2": 700, "3": 700, "4": 700, "5": 700 } },
        ADMIN,
      );
      expect(prisma.changeRequestRewardTariff.update).toHaveBeenCalled();
      expect(prisma.changeRequestRewardTariff.create).not.toHaveBeenCalled();
    });

    it("nedostaje iznos → 400", async () => {
      await expect(
        service.putTariffs({ amounts: { "1": 500 } }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── OBRAČUN (AC §11 F4: 3 korisnika, mešane ocene, jedan EXCLUDED) ────────────
  describe("obracun (mesečni izveštaj)", () => {
    it("nevalidan mesec → 422", async () => {
      await expect(
        service.payoutReport("2026/08", ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("3 korisnika, mešane ocene, sume po korisniku + ukupno (EXCLUDED nije uključen)", async () => {
      // rewardMonth filter je u WHERE (in CONFIRMED/PAID) — EXCLUDED red neće ni doći iz baze.
      const month = "2026-08";
      prisma.changeRequest.findMany.mockResolvedValue([
        {
          id: 1,
          reqNo: "001/26",
          title: "A",
          finalScore: 3,
          rewardAmount: new Prisma.Decimal(1500),
          rewardStatus: "CONFIRMED",
          createdByUserId: 42,
        },
        {
          id: 2,
          reqNo: "002/26",
          title: "B",
          finalScore: 5,
          rewardAmount: new Prisma.Decimal(3000),
          rewardStatus: "CONFIRMED",
          createdByUserId: 42,
        },
        {
          id: 3,
          reqNo: "003/26",
          title: "C",
          finalScore: 2,
          rewardAmount: new Prisma.Decimal(1000),
          rewardStatus: "PAID",
          createdByUserId: 43,
        },
        {
          id: 4,
          reqNo: "004/26",
          title: "D",
          finalScore: 1,
          rewardAmount: new Prisma.Decimal(500),
          rewardStatus: "CONFIRMED",
          createdByUserId: 44,
        },
      ]);
      prisma.changeRequest.count.mockResolvedValue(0); // nije zaključen
      prisma.user.findMany.mockResolvedValue([
        { id: 42, fullName: "Ana", email: "ana@x" },
        { id: 43, fullName: "Bora", email: "bora@x" },
        { id: 44, fullName: "Cveta", email: "cveta@x" },
      ]);

      const res = await service.payoutReport(month, ADMIN);
      const data = res.data;
      expect(data.userCount).toBe(3);
      expect(data.itemCount).toBe(4);
      expect(data.total).toBe("6000"); // 1500+3000+1000+500
      const ana = data.users.find((u) => u.userId === 42)!;
      expect(ana.total).toBe("4500");
      expect(ana.count).toBe(2);
      expect(ana.items.length).toBe(2);
    });
  });

  // ── ZAKLJUČIVANJE (immutable) ────────────────────────────────────────────────
  describe("zakljuci mesec (CONFIRMED→PAID, immutable)", () => {
    it("već zaključen (postoji PAID) → 422", async () => {
      prisma.changeRequest.count.mockResolvedValue(2); // PAID postoji
      await expect(service.closeMonth("2026-08", ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("nema CONFIRMED → 422 (nema šta da se zaključi)", async () => {
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.findMany.mockResolvedValue([]);
      await expect(service.closeMonth("2026-08", ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("zaključi → updateMany CONFIRMED→PAID + event po zahtevu + suma", async () => {
      prisma.changeRequest.count.mockResolvedValue(0); // nije zaključen
      prisma.changeRequest.findMany.mockResolvedValue([
        { id: 1, rewardAmount: new Prisma.Decimal(1500) },
        { id: 2, rewardAmount: new Prisma.Decimal(3000) },
      ]);
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 2 });
      const res = await service.closeMonth("2026-08", ADMIN);
      expect(prisma.changeRequest.updateMany).toHaveBeenCalledWith({
        where: { rewardMonth: "2026-08", rewardStatus: "CONFIRMED" },
        data: { rewardStatus: "PAID" },
      });
      expect(res.data.paidCount).toBe(2);
      expect(res.data.total).toBe("4500");
      const types = calls(prisma.changeRequestEvent.create).map(
        (c) => (c[0] as { data: { type: string } }).data.type,
      );
      expect(types.filter((t) => t === "REWARD_PAID").length).toBe(2);
    });

    it("DOPUNA 24.07: bez notifyUsers → NE šalje zbirni mesečni pregled", async () => {
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.findMany.mockResolvedValue([
        { id: 1, rewardAmount: new Prisma.Decimal(1500) },
      ]);
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      await service.closeMonth("2026-08", ADMIN);
      expect(mail.notifyMonthlySummary).not.toHaveBeenCalled();
    });

    it("DOPUNA 24.07: notifyUsers=true → šalje zbirni mesečni pregled za taj mesec (po korisniku)", async () => {
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.findMany.mockResolvedValue([
        { id: 1, rewardAmount: new Prisma.Decimal(1500) },
      ]);
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 1 });
      const res = await service.closeMonth("2026-08", ADMIN, true);
      expect(mail.notifyMonthlySummary).toHaveBeenCalledWith("2026-08");
      // Zaključenje je uspelo bez obzira na (fire-and-forget) slanje.
      expect(res.data.paidCount).toBe(1);
    });

    it("DOPUNA 24.07: pad zbirnog mejla NE obara zaključenje (best-effort)", async () => {
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.findMany.mockResolvedValue([
        { id: 1, rewardAmount: new Prisma.Decimal(1500) },
        { id: 2, rewardAmount: new Prisma.Decimal(3000) },
      ]);
      prisma.changeRequest.updateMany.mockResolvedValue({ count: 2 });
      mail.notifyMonthlySummary.mockRejectedValue(new Error("resend down"));
      const res = await service.closeMonth("2026-08", ADMIN, true);
      expect(res.data.paidCount).toBe(2);
      expect(res.data.total).toBe("4500");
    });

    it("F5: confirmed se čita UNUTAR tx — paralelni drugi poziv vidi 0 CONFIRMED → 422, bez duplih REWARD_PAID", async () => {
      // Simulacija: prvi poziv je „ispraznио" CONFIRMED (drugi poziv sada vidi 0 unutar tx).
      // isMonthClosed još 0 (PAID event tek treba da se vidi u drugom procesu) → prolazi prvu proveru,
      // ali tx-čitanje CONFIRMED vraća prazno → 422 i nijedan REWARD_PAID se ne piše.
      prisma.changeRequest.count.mockResolvedValue(0);
      prisma.changeRequest.findMany.mockResolvedValue([]); // unutar tx: nema CONFIRMED
      await expect(service.closeMonth("2026-08", ADMIN)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.changeRequest.updateMany).not.toHaveBeenCalled();
      const types = calls(prisma.changeRequestEvent.create).map(
        (c) => (c[0] as { data: { type: string } }).data.type,
      );
      expect(types).not.toContain("REWARD_PAID");
    });
  });

  // „Moje nagrade" (myRewards) uklonjeno u tihom režimu (24.07) — korisnicima se nagrade
  // više ne prikazuju; endpoint i servisna metoda su izbrisani (mesečni pregled je admin-only).
});
