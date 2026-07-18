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
import { QualityController } from "../src/modules/kvalitet/kvalitet.controller";
import { QualityService } from "../src/modules/kvalitet/kvalitet.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Kontrola kvaliteta (MODULE_SPEC_kontrola_kvaliteta §7),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); QualityService je mokovan (bez baze).
 *
 * Politika (route-permission-coverage.txt):
 *   read  = KVALITET_READ (class-level): reports/summary/summary-mini/detail/docs/docs-content.
 *           Nosioci: admin(ALL)/sef/tehnolog/kontrolor/menadzment.
 *   write = KVALITET_WRITE (handler override): create/update/confirm/recompute/delete/
 *           docs-upload/docs-delete. Nosioci: admin/sef/kontrolor/menadzment (TEHNOLOG ima
 *           SAMO read — ključna modul-asimetrija; §7).
 *   mine  = PROFILE_SELF (handler override): proizvodni radnik vidi SVOJE bez kvalitet.read.
 *           Nosioci: SVE aktivne uloge u mapi (Talas D loop).
 * Skupovi se IZVODE iz role-permissions (roleHasPermission) da nova/pogrešno-grantovana
 * uloga ne prođe. Legacy Int id → ParseIntPipe (ne-broj = 400 posle guarda).
 */
describe("Kontrola kvaliteta permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listReports",
    "summary",
    "summaryMini",
    "mine",
    "getReport",
    "createReport",
    "updateReport",
    "confirmReport",
    "recomputeReport",
    "deleteReport",
    "uploadDocument",
    "listDocuments",
    "getDocumentContent",
    "deleteDocument",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  // docContent handler čita buffer/fileName/contentType i STREAM-uje → mora vratiti
  // realan oblik (undefined fileName bi pao na .replace → 500). Dijakritik u imenu
  // dodatno pokriva RFC 5987 encoding granu.
  svcMock.getDocumentContent.mockResolvedValue({
    buffer: Buffer.from("test-sadržaj"),
    fileName: "izveštaj-škart.pdf",
    contentType: "application/pdf",
  });

  beforeAll(async () => {
    // SEC-01: import lanca (jwt.strategy) traži JWT_SECRET pre svega.
    process.env.JWT_SECRET = "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [QualityController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: QualityService, useValue: svcMock },
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
    const r = request(app.getHttpServer()).get(`/api/v1/kvalitet${path}`);
    return role ? r.set("x-test-role", role) : r;
  };
  const post = (path: string, role: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/kvalitet${path}`)
      .set("x-test-role", role)
      .send(body ?? {});
  const patch = (path: string, role: string, body?: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1/kvalitet${path}`)
      .set("x-test-role", role)
      .send(body ?? {});
  const del = (path: string, role: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1/kvalitet${path}`)
      .set("x-test-role", role);

  // Test-hardening: skupovi se IZVODE iz ALL_ROLE_KEYS × roleHasPermission → svaka
  // uloga dobija 200/403 assertion; pogrešno-grantovana uloga se NE može provući.
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.KVALITET_READ);
  const NO_READ = rolesWithout(PERMISSIONS.KVALITET_READ);
  const WRITE_ROLES = rolesWith(PERMISSIONS.KVALITET_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.KVALITET_WRITE);
  const SELF_ROLES = rolesWith(PERMISSIONS.PROFILE_SELF);
  const NO_SELF = rolesWithout(PERMISSIONS.PROFILE_SELF);

  const VALID_ID = 1;

  // ================================================================= READ (kvalitet.read)
  describe("READ endpointi — kvalitet.read", () => {
    const readPaths = [
      "/reports",
      "/summary",
      "/summary-mini",
      `/reports/${VALID_ID}`,
      "/docs",
      `/docs/${VALID_ID}/content`,
    ];
    it.each(readPaths)("GET %s → 200 za READ nosioce", async (path) => {
      for (const role of READ_ROLES) {
        await get(path, role).expect(200);
      }
    });
    it.each(readPaths)(
      "GET %s → 403 za role bez kvalitet.read (magacioner/viewer/…)",
      async (path) => {
        for (const role of NO_READ) {
          await get(path, role).expect(403);
        }
      },
    );
    it.each(["user", "nepoznata_rola"])(
      "GET /reports → 403 za %s (default deny — dokaz enforcement-a)",
      async (role) => {
        await get("/reports", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("/reports").expect(403);
    });
    it("TEHNOLOG ima read: GET /reports → 200 (kontrast prema write)", async () => {
      await get("/reports", "tehnolog").expect(200);
    });
  });

  // ================================================================= WRITE (kvalitet.write)
  describe("WRITE mutacije — kvalitet.write (POST→201, PATCH/DELETE→200)", () => {
    it.each(WRITE_ROLES)("POST /reports → 201 za %s", async (role) => {
      await post("/reports", role, {
        type: 2,
        quantity: 1,
        defectDescription: "škart",
      }).expect(201);
    });
    it.each(NO_WRITE)("POST /reports → 403 za %s (nema write)", async (role) => {
      await post("/reports", role, {
        type: 2,
        quantity: 1,
        defectDescription: "škart",
      }).expect(403);
    });

    it.each(WRITE_ROLES)("PATCH /reports/:id → 200 za %s", async (role) => {
      await patch(`/reports/${VALID_ID}`, role, { quantity: 3 }).expect(200);
    });
    it.each(NO_WRITE)("PATCH /reports/:id → 403 za %s", async (role) => {
      await patch(`/reports/${VALID_ID}`, role, { quantity: 3 }).expect(403);
    });

    it.each(WRITE_ROLES)(
      "POST /reports/:id/confirm → 201 za %s (dodela broja)",
      async (role) => {
        await post(`/reports/${VALID_ID}/confirm`, role).expect(201);
      },
    );
    it.each(NO_WRITE)(
      "POST /reports/:id/confirm → 403 za %s",
      async (role) => {
        await post(`/reports/${VALID_ID}/confirm`, role).expect(403);
      },
    );

    it.each(WRITE_ROLES)(
      "POST /reports/:id/recompute → 201 za %s (auto sati+kg)",
      async (role) => {
        await post(`/reports/${VALID_ID}/recompute`, role).expect(201);
      },
    );
    it.each(NO_WRITE)(
      "POST /reports/:id/recompute → 403 za %s",
      async (role) => {
        await post(`/reports/${VALID_ID}/recompute`, role).expect(403);
      },
    );

    it.each(WRITE_ROLES)(
      "DELETE /reports/:id → 200 za %s (SAMO draft; guard-sloj)",
      async (role) => {
        await del(`/reports/${VALID_ID}`, role).expect(200);
      },
    );
    it.each(NO_WRITE)("DELETE /reports/:id → 403 za %s", async (role) => {
      await del(`/reports/${VALID_ID}`, role).expect(403);
    });

    it.each(WRITE_ROLES)(
      "POST /docs → 201 za %s (upload QC dokumenta)",
      async (role) => {
        await post("/docs", role).expect(201);
      },
    );
    it.each(NO_WRITE)("POST /docs → 403 za %s", async (role) => {
      await post("/docs", role).expect(403);
    });

    it.each(WRITE_ROLES)("DELETE /docs/:id → 200 za %s", async (role) => {
      await del(`/docs/${VALID_ID}`, role).expect(200);
    });
    it.each(NO_WRITE)("DELETE /docs/:id → 403 za %s", async (role) => {
      await del(`/docs/${VALID_ID}`, role).expect(403);
    });
  });

  // ================================================================= MODUL-ASIMETRIJA
  describe("Modul-asimetrija: TEHNOLOG read ⊃ ali NE write (§7)", () => {
    it("TEHNOLOG: GET /reports 200, ALI POST /reports 403 (samo uvid, bez potvrde)", async () => {
      await get("/reports", "tehnolog").expect(200);
      await post("/reports", "tehnolog", {
        type: 1,
        quantity: 1,
        defectDescription: "dorada",
      }).expect(403);
      await patch(`/reports/${VALID_ID}`, "tehnolog", {}).expect(403);
      await post(`/reports/${VALID_ID}/confirm`, "tehnolog").expect(403);
    });
    it("READ_ROLES ⊇ WRITE_ROLES (svaki pisac je ujedno čitalac)", () => {
      for (const w of WRITE_ROLES) expect(READ_ROLES).toContain(w);
      // tehnolog je JEDINA rola read-bez-write (uz naredni test).
      expect(READ_ROLES).toContain("tehnolog");
      expect(WRITE_ROLES).not.toContain("tehnolog");
    });
  });

  // ================================================================= MINE (profile.self)
  describe("GET /mine — profile.self (override klasnog kvalitet.read)", () => {
    it.each(SELF_ROLES)("GET /mine → 200 za %s (self-scope)", async (role) => {
      await get("/mine", role).expect(200);
    });
    it.each(NO_SELF)(
      "GET /mine → 403 za %s (deferred/prelazna — nije u mapi)",
      async (role) => {
        await get("/mine", role).expect(403);
      },
    );
    it("proizvodni_radnik: GET /mine 200 (profile.self) ALI GET /reports 403 (nema kvalitet.read)", async () => {
      await get("/mine", "proizvodni_radnik").expect(200);
      await get("/reports", "proizvodni_radnik").expect(403);
    });
    it.each(["user", "nepoznata_rola"])(
      "GET /mine → 403 za %s (default deny)",
      async (role) => {
        await get("/mine", role).expect(403);
      },
    );
  });

  // ================================================================= ParseIntPipe (legacy Int id)
  describe("Param validacija — :id ParseIntPipe (guard PRE pipe)", () => {
    it("GET /reports/:id → 200 numeričko za read-rolu, 400 ne-broj (kontrolor)", async () => {
      await get(`/reports/${VALID_ID}`, "kontrolor").expect(200);
      await get("/reports/nije-broj", "kontrolor").expect(400);
    });
    it("PATCH /reports/:id → 400 ne-broj (write-rola prošla guard → ParseInt)", async () => {
      await patch("/reports/nije-broj", "admin", { quantity: 2 }).expect(400);
    });
    it("DELETE /docs/:id → 400 ne-broj (admin)", async () => {
      await del("/docs/nije-broj", "admin").expect(400);
    });
    it("non-holder na ne-broj param → 403 (guard prethodi ParseInt): PATCH /reports/x viewer", async () => {
      await patch("/reports/nije-broj", "viewer", {}).expect(403);
    });
  });
});
