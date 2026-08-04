import {
  ExecutionContext,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { SyncController } from "../src/modules/sync/sync.controller";
import { SyncService } from "../src/modules/sync/sync.service";
import { ALL_ROLE_KEYS, ROLES } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Sync BigBit master podataka (/syncs ekran), rola ×
 * endpoint × 2xx/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje). JwtAuthGuard je
 * stub (identitet iz `x-test-role`); SyncService je mokovan (bez MSSQL-a).
 *
 * ZAHTEV 061/26 (Igor Voštić, 04.08.2026; odluka Nenad): „Pokreni sync" NIJE više
 * admin-only — otvara se za TEHNOLOGE + PLANERE + ADMIN, ne bukvalno za sve.
 * U role-mapi: `sync.run` = admin + menadzment + tehnolog (izmereno u prod bazi
 * 04.08.2026: svi živi planeri iz `predmet_planeri` i sam Igor nose `menadzment`;
 * tehnolozi nose `tehnolog`). `sync.read` (dnevnik/stanje) = i `sef` uz taj krug.
 *
 * Skupovi rola se IZVODE iz `roleHasPermission` (šablon mrp/reversi specova), a
 * TAČAN skup nosilaca `sync.run` je pinovan zasebnim testom — svako novo širenje
 * mora svesno da obori test, ne da se provuče kao dopuna.
 */
describe("Sync permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const svcMock = {
    run: jest.fn().mockResolvedValue({ id: 1, status: "success" }),
    getState: jest.fn().mockResolvedValue([]),
    getEntityState: jest.fn().mockResolvedValue({}),
    getLogs: jest.fn().mockResolvedValue([]),
    getLog: jest.fn().mockResolvedValue({ id: 1 }),
    health: jest.fn().mockResolvedValue({ source: "up" }),
  };

  beforeAll(async () => {
    // SEC-01: import kontrolera povlači auth lanac koji traži JWT_SECRET.
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: SyncService, useValue: svcMock },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(ctx: ExecutionContext) {
          const req = ctx.switchToHttp().getRequest<{
            headers: Record<string, string>;
            user?: unknown;
          }>();
          const role = req.headers["x-test-role"];
          if (!role) return false;
          req.user = { userId: 1, email: "test@servoteh.com", role };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    // Ogledalo main.ts konfiguracije (prefiks + versioning + validacija).
    app.setGlobalPrefix("api");
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: VERSION_NEUTRAL,
    });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  // SyncController je version-neutral (`@Controller('sync')`) → /api/sync/*.
  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/sync${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const postRun = (role?: string) => {
    const r = request(app.getHttpServer()).post("/api/sync/run").send({});
    return role ? r.set("x-test-role", role) : r;
  };

  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const RUN_ROLES = rolesWith(PERMISSIONS.SYNC_RUN);
  const NO_RUN = rolesWithout(PERMISSIONS.SYNC_RUN);
  const READ_ROLES = rolesWith(PERMISSIONS.SYNC_READ);
  const NO_READ = rolesWithout(PERMISSIONS.SYNC_READ);

  const READ_ROUTES: [name: string, path: string][] = [
    ["GET /state", "/state"],
    ["GET /state/:entity", "/state/items"],
    ["GET /log", "/log"],
    ["GET /log/:id", "/log/1"],
    ["GET /health", "/health"],
  ];

  describe("Pin skupa nosilaca (061/26 — ne SVI, nego tehnolozi+planeri+admin)", () => {
    it("`sync.run` = TAČNO admin + menadzment + tehnolog", () => {
      expect(RUN_ROLES).toEqual([
        ROLES.ADMIN,
        ROLES.MENADZMENT,
        ROLES.TEHNOLOG,
      ]);
    });
    it("`sync.read` = TAČNO admin + menadzment + sef + tehnolog", () => {
      expect(READ_ROLES).toEqual([
        ROLES.ADMIN,
        ROLES.MENADZMENT,
        ROLES.SEF,
        ROLES.TEHNOLOG,
      ]);
    });
  });

  describe("POST /run (sync.run) — HOLDER 2xx / NON-HOLDER 403", () => {
    it.each(RUN_ROLES)("→ 2xx za %s (holder)", async (role) => {
      const res = await postRun(role);
      expect([200, 201]).toContain(res.status);
    });
    it.each(NO_RUN)("→ 403 za %s (non-holder)", async (role) => {
      await postRun(role).expect(403);
    });
    it("→ 403 bez identiteta (JwtAuthGuard stub)", async () => {
      await postRun().expect(403);
    });
    it("→ 403 za `nepoznata_rola` (default deny)", async () => {
      await postRun("nepoznata_rola").expect(403);
    });
  });

  describe("Read rute (sync.read) — HOLDER 200 / NON-HOLDER 403 po svakoj ruti", () => {
    describe.each(READ_ROUTES)("%s", (_name, path) => {
      it.each(READ_ROLES)("→ 200 za %s (holder)", async (role) => {
        await get(path, role).expect(200);
      });
      it.each(NO_READ)("→ 403 za %s (non-holder)", async (role) => {
        await get(path, role).expect(403);
      });
      it("→ 403 bez identiteta", async () => {
        await get(path).expect(403);
      });
    });
  });

  describe("Srž zahteva 061/26 (imenovani slučajevi, ne-tautološki)", () => {
    it("tehnolog POKREĆE sync (do 04.08.2026 bi dobio 403)", async () => {
      expect(roleHasPermission("tehnolog", PERMISSIONS.SYNC_RUN)).toBe(true);
      const res = await postRun("tehnolog");
      expect([200, 201]).toContain(res.status);
    });
    it("menadzment (rola SVIH živih planera + Igora) POKREĆE sync", async () => {
      expect(roleHasPermission("menadzment", PERMISSIONS.SYNC_RUN)).toBe(true);
      const res = await postRun("menadzment");
      expect([200, 201]).toContain(res.status);
    });
    it("sef ima UVID (read) ali NE pokreće — odluka ga ne pominje", async () => {
      expect(roleHasPermission("sef", PERMISSIONS.SYNC_READ)).toBe(true);
      expect(roleHasPermission("sef", PERMISSIONS.SYNC_RUN)).toBe(false);
      await get("/log", "sef").expect(200);
      await postRun("sef").expect(403);
    });
    it("kontrolor/viewer/pm/leadpm/magacioner ne pokreću (nisu ni tehnolozi ni planeri)", async () => {
      for (const role of ["kontrolor", "viewer", "pm", "leadpm", "magacioner"]) {
        expect(roleHasPermission(role, PERMISSIONS.SYNC_RUN)).toBe(false);
        await postRun(role).expect(403);
      }
    });
  });

  describe("Param validacija (guard prethodi ParseIntPipe)", () => {
    it("GET /log/:id → 400 za ne-numerički id (holder tehnolog)", async () => {
      await get("/log/nije-broj", "tehnolog").expect(400);
    });
    it("GET /log/:id → 403 pre validacije za non-holder (viewer)", async () => {
      await get("/log/nije-broj", "viewer").expect(403);
    });
  });
});
