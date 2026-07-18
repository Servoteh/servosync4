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
import { MrpController } from "../src/modules/mrp/mrp.controller";
import { MrpService } from "../src/modules/mrp/mrp.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — MRP / Nabavka (MODULE_SPEC_mrp.md), rola × endpoint × 200/403 sa
 * AUTHZ_ENFORCE=true (realno V2 ponašanje). JwtAuthGuard je stub (identitet iz `x-test-role`);
 * MrpService je mokovan (bez legacy baze). MRP je SAMO-UVID modul → sve 4 rute su GET/`mrp.read`
 * (nema mutacija dok BOM/MRP logika §11.3 ne bude dizajnirana). Row-scope ne postoji ovde — čist
 * rola-sloj. Skupovi rola se IZVODE iz `roleHasPermission(mrp.read)` (test-hardening: nova ili
 * pogrešno-grantovana uloga se ne može provući; tačnost mape pinuje unit spec).
 */
describe("MRP permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listDemands",
    "findOneDemand",
    "listStock",
    "listDemandItems",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    // SEC-01: import kontrolera povlači auth lanac koji traži JWT_SECRET.
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [MrpController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: MrpService, useValue: svcMock },
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

  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1/mrp${path}`);
    return role ? r.set("x-test-role", role) : r;
  };

  // Skupovi se izvode iz žive mape (paritet reversi/odrzavanje šablona).
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.MRP_READ);
  const NO_READ = rolesWithout(PERMISSIONS.MRP_READ);

  // Sve rute su GET/mrp.read; matricu vrtimo po svakoj ruti da nijedna ne izmakne.
  const ROUTES: [name: string, path: string][] = [
    ["GET /demands", "/demands"],
    ["GET /demands/:id", "/demands/1"],
    ["GET /stock", "/stock"],
    ["GET /demand-items", "/demand-items"],
  ];

  describe("Read guard (mrp.read) — HOLDER 200 / NON-HOLDER 403 po svakoj ruti", () => {
    describe.each(ROUTES)("%s", (_name, path) => {
      it.each(READ_ROLES)("→ 200 za %s (holder)", async (role) => {
        await get(path, role).expect(200);
      });
      it.each(NO_READ)(
        "→ 403 za %s (non-holder / deferred / prelazno)",
        async (role) => {
          await get(path, role).expect(403);
        },
      );
    });
  });

  describe("Default-deny (dokaz enforcement-a, ne-tautološki)", () => {
    it.each(ROUTES)(
      "%s → 403 za rolu `user` (prelazno, nema mrp.read)",
      async (_name, path) => {
        await get(path, "user").expect(403);
      },
    );
    it.each(ROUTES)(
      "%s → 403 za `nepoznata_rola` (default deny)",
      async (_name, path) => {
        await get(path, "nepoznata_rola").expect(403);
      },
    );
    it.each(ROUTES)(
      "%s → 403 bez identiteta (JwtAuthGuard stub)",
      async (_name, path) => {
        await get(path).expect(403);
      },
    );
  });

  describe("Modul-specifična razlika (kontrast prema drugim read-modulima)", () => {
    // kontrolor/viewer/proizvodni_radnik ČITAJU druge module (tehnologija/reversi/…),
    // ali MRP im NIJE dodeljen (matrica §3: MRP = nabavni/planerski uvid) → 403.
    it("kontrolor NEMA mrp.read → GET /demands 403 (ali ima druge read module)", async () => {
      expect(roleHasPermission("kontrolor", PERMISSIONS.MRP_READ)).toBe(false);
      expect(roleHasPermission("kontrolor", PERMISSIONS.REVERSI_READ)).toBe(
        true,
      );
      await get("/demands", "kontrolor").expect(403);
    });
    it("viewer NEMA mrp.read → GET /stock 403", async () => {
      expect(roleHasPermission("viewer", PERMISSIONS.MRP_READ)).toBe(false);
      await get("/stock", "viewer").expect(403);
    });
    it("proizvodni_radnik NEMA mrp.read → GET /demand-items 403", async () => {
      expect(
        roleHasPermission("proizvodni_radnik", PERMISSIONS.MRP_READ),
      ).toBe(false);
      await get("/demand-items", "proizvodni_radnik").expect(403);
    });
    // nabavka_view = nosilac MRP uvida (read podskup deferred `nabavka`).
    it("nabavka_view IMA mrp.read → GET /demands 200 (nosilac uvida)", async () => {
      expect(roleHasPermission("nabavka_view", PERMISSIONS.MRP_READ)).toBe(true);
      await get("/demands", "nabavka_view").expect(200);
    });
  });

  describe("Param validacija (:id ParseIntPipe — guard prošao, tip nevalidan → 400)", () => {
    it("GET /demands/:id → 200 za numerički id (holder magacioner)", async () => {
      await get("/demands/1", "magacioner").expect(200);
      expect(svcMock.findOneDemand).toHaveBeenCalled();
    });
    it("GET /demands/:id → 400 za ne-numerički id (holder tehnolog, ParseIntPipe)", async () => {
      await get("/demands/nije-broj", "tehnolog").expect(400);
    });
    it("GET /demands/:id → 403 pre validacije za non-holder (guard prethodi ParseIntPipe)", async () => {
      // Nevalidan id + non-holder: guard 403 mora doći PRE 400 (dokaz redosleda).
      await get("/demands/nije-broj", "viewer").expect(403);
    });
  });
});
