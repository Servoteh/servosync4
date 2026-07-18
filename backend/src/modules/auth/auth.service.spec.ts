import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../../prisma/prisma.service";
import { AuthService } from "./auth.service";
import {
  generateRefreshToken,
  hashRefreshToken,
} from "./refresh-token.util";

// bcrypt je nativni modul (property `compare` nije redefinabilan pa jest.spyOn puca) —
// auto-mock ga zameni jest.fn-ovima; login test postavlja compare → true.
jest.mock("bcrypt");

/** Prisma mock — samo grane koje refresh/logout/login stvarno diraju. */
interface PrismaMock {
  user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
  refreshToken: {
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn(),
    },
    refreshToken: {
      findUnique: jest.fn(),
      // Rotacija: novi red dobija id kojim se stari red označava replacedByTokenId.
      create: jest.fn().mockResolvedValue({ id: 11 }),
      update: jest.fn().mockResolvedValue({}),
      // Default: atomski „claim" starog reda uspeva (count 1). Lost-race test override-uje na 0.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  // Interaktivna transakcija: callback dobija isti mock kao `tx`.
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

const activeUser = {
  id: 1,
  email: "ana@servoteh",
  fullName: "Ana",
  role: "admin",
  active: true,
  workerId: 55,
  passwordHash: "bcrypt-hash",
};

/** Valjan, aktivan refresh token red (nije opozvan, nije zamenjen, nije istekao). */
function liveToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    userId: 1,
    tokenHash: "irrelevant",
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    revokedAt: null,
    replacedByTokenId: null,
    ...overrides,
  };
}

describe("AuthService refresh tokens", () => {
  let service: AuthService;
  let prisma: PrismaMock;
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };

  beforeEach(async () => {
    prisma = prismaMock();
    jwt = {
      signAsync: jest.fn().mockResolvedValue("access.jwt"),
      verifyAsync: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("issueRefreshToken", () => {
    it("čuva SHA-256 hash (nikad sirov token) i vraća sirov token", async () => {
      const raw = await service.issueRefreshToken(1, {
        userAgent: "UA",
        ipAddress: "10.0.0.1",
      });
      expect(typeof raw).toBe("string");
      expect(raw.length).toBeGreaterThan(20);
      const arg = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { userId: number; tokenHash: string };
      };
      expect(arg.data.userId).toBe(1);
      expect(arg.data.tokenHash).toBe(hashRefreshToken(raw));
      expect(arg.data.tokenHash).not.toBe(raw); // sirov token NIJE u bazi
    });
  });

  describe("login", () => {
    it("vraća accessToken + refreshToken + user (bez workerId)", async () => {
      prisma.user.findUnique.mockResolvedValue(activeUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const res = await service.login("ana@servoteh", "pw", {
        userAgent: "UA",
        ipAddress: "1.2.3.4",
      });

      expect(res.accessToken).toBe("access.jwt");
      expect(typeof res.refreshToken).toBe("string");
      expect(res.user).toEqual({
        id: 1,
        email: "ana@servoteh",
        fullName: "Ana",
        role: "admin",
        readOnly: false,
      });
      expect(res.user as unknown as Record<string, unknown>).not.toHaveProperty(
        "workerId",
      );
      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("refresh — rotacija", () => {
    it("atomski claim-uje stari red, izdaje nov par i vezuje ga (replacedByTokenId)", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveToken());
      prisma.user.findUnique.mockResolvedValue(activeUser);

      const res = await service.refresh("raw-old", {
        userAgent: "UA",
        ipAddress: "9.9.9.9",
      });

      expect(res.accessToken).toBe("access.jwt");
      expect(typeof res.refreshToken).toBe("string");
      expect(res.refreshToken).not.toBe("raw-old");
      expect(res.user.id).toBe(1);
      expect(res.user as unknown as Record<string, unknown>).not.toHaveProperty(
        "workerId",
      );

      // Atomski „claim": stari red opozvan SAMO ako je još aktivan (guard u WHERE-u).
      const claimArg = prisma.refreshToken.updateMany.mock.calls[0][0] as {
        where: { id: number; revokedAt: null; replacedByTokenId: null };
        data: { revokedAt: Date };
      };
      expect(claimArg.where).toEqual({
        id: 10,
        revokedAt: null,
        replacedByTokenId: null,
      });
      expect(claimArg.data.revokedAt).toBeInstanceOf(Date);

      // Nov red nosi hash NOVOG sirovog tokena (kreiran tek posle uspešnog claim-a).
      const createArg = prisma.refreshToken.create.mock.calls[0][0] as {
        data: { userId: number; tokenHash: string };
      };
      expect(createArg.data.userId).toBe(1);
      expect(createArg.data.tokenHash).toBe(hashRefreshToken(res.refreshToken));

      // Stari red se vezuje na novi (replacedByTokenId = id novog reda, 11).
      const updateArg = prisma.refreshToken.update.mock.calls[0][0] as {
        where: { id: number };
        data: { replacedByTokenId: number };
      };
      expect(updateArg.where.id).toBe(10);
      expect(updateArg.data.replacedByTokenId).toBe(11);

      // Rotacija ide kroz transakciju.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("traži po hash-u datog tokena, ne po sirovom", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveToken());
      prisma.user.findUnique.mockResolvedValue(activeUser);
      await service.refresh("raw-old");
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: hashRefreshToken("raw-old") },
      });
    });

    it("izgubljena trka (claim count 0) → 401 BEZ revoke-all i BEZ novog reda", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveToken());
      prisma.user.findUnique.mockResolvedValue(activeUser);
      // Paralelan refresh je već preuzeo red pre naše transakcije → guard vrati count 0.
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      // Nema novog reda (kreira se tek posle uspešnog claim-a) i nema revoke-all.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      const revokeAll = prisma.refreshToken.updateMany.mock.calls.some(
        (c) => (c[0] as { where?: { userId?: number } })?.where?.userId === 1,
      );
      expect(revokeAll).toBe(false);
    });
  });

  describe("refresh — reuse detekcija", () => {
    it("STARO opozvan token (van grace) → opoziva SVE aktivne tokene + 401", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        // revokedAt daleko u prošlosti → van grace prozora → tretira se kao krađa.
        liveToken({ revokedAt: new Date(Date.now() - 5 * 60_000) }),
      );
      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 1, revokedAt: null },
        data: { revokedAt: expect.any(Date) as unknown as Date },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it("SKORO rotiran token (u grace) → 401 BEZ revoke-all (benigna cross-tab trka)", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        // revokedAt upravo sad → unutar grace prozora → NE opoziva sve sesije.
        liveToken({ revokedAt: new Date(), replacedByTokenId: 11 }),
      );
      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      const revokeAll = prisma.refreshToken.updateMany.mock.calls.some(
        (c) => (c[0] as { where?: { userId?: number } })?.where?.userId === 1,
      );
      expect(revokeAll).toBe(false);
    });

    it("zamenjen token bez revokedAt (replacedByTokenId != null) → revoke-all + 401", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        liveToken({ replacedByTokenId: 11 }),
      );
      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 1, revokedAt: null },
        data: { revokedAt: expect.any(Date) as unknown as Date },
      });
    });
  });

  describe("refresh — odbijanja", () => {
    it("nepoznat token → 401 (bez upita korisnika)", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);
      await expect(service.refresh("nope")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it("istekao token → 401 (bez rotacije)", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        liveToken({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it("neaktivan korisnik → opoziva TAJ red + 401", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(liveToken());
      prisma.user.findUnique.mockResolvedValue({ ...activeUser, active: false });
      await expect(service.refresh("raw-old")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 10 },
        data: { revokedAt: expect.any(Date) as unknown as Date },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("prazan token → 401", async () => {
      await expect(service.refresh("")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("logout — idempotentno", () => {
    it("dat token → opoziva samo aktivan red po hash-u, vraća { ok: true }", async () => {
      const res = await service.logout("raw-tok");
      expect(res).toEqual({ ok: true });
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: hashRefreshToken("raw-tok"), revokedAt: null },
        data: { revokedAt: expect.any(Date) as unknown as Date },
      });
    });

    it("bez tokena → { ok: true } bez ijednog upita u bazu", async () => {
      const res = await service.logout();
      expect(res).toEqual({ ok: true });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it("nepoznat token → { ok: true } (updateMany ne baca)", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      const res = await service.logout("unknown");
      expect(res).toEqual({ ok: true });
    });
  });

  describe("refresh-token.util", () => {
    it("generiše različite tokene, hash je determinističan hex", () => {
      const a = generateRefreshToken();
      const b = generateRefreshToken();
      expect(a).not.toBe(b);
      expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
      expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
