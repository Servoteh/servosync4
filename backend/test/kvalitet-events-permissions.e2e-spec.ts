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
import { QualityEventsController } from "../src/modules/kvalitet/quality-events.controller";
import { QualityEventsService } from "../src/modules/kvalitet/quality-events.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Škart i dorada (MODULE_SPEC_kvalitet_skart_dorada §3/§4),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true. JwtAuthGuard je stub (identitet iz
 * `x-test-role`); QualityEventsService je mokovan (bez baze).
 *
 * Politika:
 *   read     = KVALITET_READ (class-level): reason-codes / events / events/pareto / events/:id.
 *   write    = KVALITET_WRITE (handler): POST events / PATCH potvrdi / PATCH odbaci.
 *              KLJUČNA asimetrija: radnik (report_work) NE može da potvrdi/odbaci/unese.
 *   prijava  = TEHNOLOGIJA_REPORT_WORK (handler): kiosk prijava-signal — radnik SME.
 * Skupovi se IZVODE iz role-permissions (roleHasPermission) da pogrešno-grantovana uloga ne prođe.
 */
describe("Škart i dorada permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listReasonCodes",
    "list",
    "pareto",
    "getEvent",
    "createByController",
    "prijava",
    "confirm",
    "reject",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [QualityEventsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: () => Promise.resolve(null) },
          },
        },
        { provide: QualityEventsService, useValue: svcMock },
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
          req.user = {
            userId: 1,
            email: "test@servoteh.com",
            role,
            workerId: 9,
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: VERSION_NEUTRAL,
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
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

  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const READ_ROLES = rolesWith(PERMISSIONS.KVALITET_READ);
  const NO_READ = rolesWithout(PERMISSIONS.KVALITET_READ);
  const WRITE_ROLES = rolesWith(PERMISSIONS.KVALITET_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.KVALITET_WRITE);
  const REPORT_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK);
  const NO_REPORT = rolesWithout(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK);

  const VALID_ID = 1;

  // ================================================================= READ
  describe("READ — kvalitet.read", () => {
    const readPaths = [
      "/reason-codes",
      "/events",
      "/events/pareto",
      `/events/${VALID_ID}`,
    ];
    it.each(readPaths)("GET %s → 200 za READ nosioce", async (path) => {
      for (const role of READ_ROLES) await get(path, role).expect(200);
    });
    it.each(readPaths)(
      "GET %s → 403 za role bez kvalitet.read",
      async (path) => {
        for (const role of NO_READ) await get(path, role).expect(403);
      },
    );
    it("bez identiteta → 403", async () => {
      await get("/events").expect(403);
    });
  });

  // ================================================================= WRITE (kontrolor)
  describe("WRITE — kvalitet.write (kontrolorski unos + obrada prijave)", () => {
    it.each(WRITE_ROLES)("POST /events → 201 za %s", async (role) => {
      await post("/events", role, {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        reasonCodeId: 1,
      }).expect(201);
    });
    it.each(NO_WRITE)("POST /events → 403 za %s (nema write)", async (role) => {
      await post("/events", role, {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        reasonCodeId: 1,
      }).expect(403);
    });

    it.each(WRITE_ROLES)(
      "PATCH /events/:id/potvrdi → 200 za %s",
      async (role) => {
        await patch(`/events/${VALID_ID}/potvrdi`, role, {
          reasonCodeId: 1,
        }).expect(200);
      },
    );
    it.each(NO_WRITE)("PATCH /events/:id/potvrdi → 403 za %s", async (role) => {
      await patch(`/events/${VALID_ID}/potvrdi`, role, {
        reasonCodeId: 1,
      }).expect(403);
    });

    it.each(WRITE_ROLES)(
      "PATCH /events/:id/odbaci → 200 za %s",
      async (role) => {
        await patch(`/events/${VALID_ID}/odbaci`, role, {
          rejectReason: "x",
        }).expect(200);
      },
    );
    it.each(NO_WRITE)("PATCH /events/:id/odbaci → 403 za %s", async (role) => {
      await patch(`/events/${VALID_ID}/odbaci`, role, {
        rejectReason: "x",
      }).expect(403);
    });
  });

  // ================================================================= PRIJAVA (kiosk radnik)
  describe("PRIJAVA — tehnologija.report_work (kiosk radnik)", () => {
    it.each(REPORT_ROLES)("POST /events/prijava → 201 za %s", async (role) => {
      await post("/events/prijava", role, {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        workerCard: "C1",
      }).expect(201);
    });
    it.each(NO_REPORT)("POST /events/prijava → 403 za %s", async (role) => {
      await post("/events/prijava", role, {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        workerCard: "C1",
      }).expect(403);
    });
  });

  // ================================================================= ASIMETRIJA
  describe("Asimetrija: radnik prijavljuje ali NE potvrđuje", () => {
    it("proizvodni_radnik: prijava 201, ALI potvrdi/odbaci/unos 403", async () => {
      await post("/events/prijava", "proizvodni_radnik", {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        workerCard: "C1",
      }).expect(201);
      await post("/events", "proizvodni_radnik", {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        reasonCodeId: 1,
      }).expect(403);
      await patch(`/events/${VALID_ID}/potvrdi`, "proizvodni_radnik", {
        reasonCodeId: 1,
      }).expect(403);
    });
    it("kontrolor: i prijava (201) i potvrda (200) — ima oba ključa", async () => {
      await post("/events/prijava", "kontrolor", {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        workerCard: "C1",
      }).expect(201);
      await patch(`/events/${VALID_ID}/potvrdi`, "kontrolor", {
        reasonCodeId: 1,
      }).expect(200);
    });
    it("TEHNOLOG: read (200) ali write 403 (samo uvid — modul-asimetrija §7)", async () => {
      await get("/events", "tehnolog").expect(200);
      await post("/events", "tehnolog", {
        type: "SKART",
        workOrderId: 1,
        qty: 1,
        reasonCodeId: 1,
      }).expect(403);
    });
  });

  // ================================================================= ParseIntPipe
  describe("Param validacija — :id ParseIntPipe (guard PRE pipe)", () => {
    it("PATCH /events/x/potvrdi → 400 ne-broj (write-rola prošla guard)", async () => {
      await patch("/events/nije-broj/potvrdi", "admin", {
        reasonCodeId: 1,
      }).expect(400);
    });
    it("GET /events/pareto → 200 (literal segment ne pada na :id/ParseInt)", async () => {
      await get("/events/pareto", "kontrolor").expect(200);
    });
    it("non-holder na ne-broj param → 403 (guard prethodi ParseInt)", async () => {
      await patch("/events/nije-broj/potvrdi", "viewer", {
        reasonCodeId: 1,
      }).expect(403);
    });
  });
});
