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
import { WorkOrdersController } from "../src/modules/work-orders/work-orders.controller";
import { WorkOrdersService } from "../src/modules/work-orders/work-orders.service";
import { WorkOrderPrintService } from "../src/modules/work-orders/work-order-print.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Radni nalozi (work-orders.controller.ts),
 * rola × endpoint × 2xx/403 sa AUTHZ_ENFORCE=true (realno V2 ponašanje).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); servisi su mokovani (bez baze).
 *
 * Legacy Int id-jevi (ParseIntPipe) — nevalidan tip param-a → 400 (posle guard-a).
 * Skup rola po permisiji se IZVODI iz ALL_ROLE_KEYS × roleHasPermission → nova/
 * pogrešno-grantovana rola se ne može provući; intent pinuje `role-permissions.ts`.
 *
 * Gating po ruti (kontroler):
 *   rn.write           → create/updateHeader/operations(add/update/delete)/remove/
 *                        lock/copy-from/clone-variant/rework/quality-child/bulk-clone
 *   rn.approve         → :id/approve   (drugi gate Worker.definesApproval je V2 u servisu)
 *   rn.launch          → :id/launch    (drugi gate Worker.definesLaunch  je V2 u servisu)
 *   rn.delete.force    → :id/force     (samo admin/sef)
 *   tehnologija.write  → operations/:opId/priority (CNC programer prioritizuje, NE piše RN)
 * READ rute (list / :id / :id/print / operations/queue) su SAMO iza JwtAuthGuard-a
 * (bez PermissionsGuard) — svaki prijavljen prolazi; bez identiteta → 403.
 */
describe("Radni nalozi permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const svcMock: Record<string, jest.Mock> = {};
  for (const m of [
    "list",
    "operationQueue",
    "findOne",
    "create",
    "updateHeader",
    "addOperation",
    "updateOperation",
    "setOperationPriority",
    "deleteOperation",
    "remove",
    "forceRemove",
    "approve",
    "launch",
    "setLock",
    "copyFrom",
    "cloneVariant",
    "rework",
    "createQualityChild",
    "bulkClone",
  ]) {
    svcMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  const printMock: Record<string, jest.Mock> = {
    buildRnPdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("%PDF-1.4"), fileName: "rn.pdf" }),
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-not-real-secret"; // SEC-01: import kontrolera ne sme pući
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkOrdersController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: WorkOrdersService, useValue: svcMock },
        { provide: WorkOrderPrintService, useValue: printMock },
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
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTHZ_ENFORCE;
  });

  const base = "/api/v1/work-orders";
  const send = (
    r: request.Test,
    role?: string,
    payload?: Record<string, unknown>,
  ) => {
    if (role) r.set("x-test-role", role);
    return payload === undefined ? r : r.send(payload);
  };
  const get = (path: string, role?: string) =>
    send(request(app.getHttpServer()).get(`${base}${path}`), role);
  const post = (path: string, role?: string, payload?: Record<string, unknown>) =>
    send(request(app.getHttpServer()).post(`${base}${path}`), role, payload ?? {});
  const patch = (
    path: string,
    role?: string,
    payload?: Record<string, unknown>,
  ) =>
    send(request(app.getHttpServer()).patch(`${base}${path}`), role, payload ?? {});
  const del = (path: string, role?: string) =>
    send(request(app.getHttpServer()).delete(`${base}${path}`), role);

  // Skupovi rola izvedeni iz IZVORA ISTINE (role-permissions.ts) — bez ručnih lista.
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const WRITE_ROLES = rolesWith(PERMISSIONS.RN_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.RN_WRITE);
  const APPROVE_ROLES = rolesWith(PERMISSIONS.RN_APPROVE);
  const NO_APPROVE = rolesWithout(PERMISSIONS.RN_APPROVE);
  const LAUNCH_ROLES = rolesWith(PERMISSIONS.RN_LAUNCH);
  const NO_LAUNCH = rolesWithout(PERMISSIONS.RN_LAUNCH);
  const FORCE_ROLES = rolesWith(PERMISSIONS.RN_DELETE_FORCE);
  const NO_FORCE = rolesWithout(PERMISSIONS.RN_DELETE_FORCE);
  const TEHWRITE_ROLES = rolesWith(PERMISSIONS.TEHNOLOGIJA_WRITE);
  const NO_TEHWRITE = rolesWithout(PERMISSIONS.TEHNOLOGIJA_WRITE);

  const createBody = () => ({
    projectId: 1,
    externalCustomerId: 0,
    partName: "Osovina",
    drawingNumber: "9000/131",
    material: "C45",
    materialDimension: "Ø50",
    pieceCount: 2,
  });

  // ---------------------------------------------------------------------------
  // READ rute — SAMO JwtAuthGuard (bez PermissionsGuard): svaki prijavljen prolazi.
  // ---------------------------------------------------------------------------
  describe("READ rute (ungated iza JWT-a) — svaki prijavljen 200, bez identiteta 403", () => {
    it("GET / (list) → 200 čak i za user/nepoznatu (nema PermissionsGuard)", async () => {
      await get("", "user").expect(200);
      await get("", "nepoznata_rola").expect(200);
      await get("", "proizvodni_radnik").expect(200);
    });
    it("GET /:id (findOne) → 200 za bilo koju prijavljenu rolu", async () => {
      await get("/1", "user").expect(200);
      await get("/1", "viewer").expect(200);
    });
    it("GET /operations/queue → 200 (literal pre :id)", async () => {
      await get("/operations/queue", "user").expect(200);
      expect(svcMock.operationQueue).toHaveBeenCalled();
    });
    it("GET /:id/print → 200 (PDF stream, ungated)", async () => {
      await get("/1/print", "user").expect(200);
      expect(printMock.buildRnPdf).toHaveBeenCalled();
    });
    it("GET /:id → 400 za ne-integer param (ParseIntPipe)", async () => {
      await get("/nije-broj", "admin").expect(400);
    });
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer()).get(base).expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // rn.write — flagship enforcement (svaka rola dobija 2xx ili 403 asertciju).
  // ---------------------------------------------------------------------------
  describe("rn.write — POST / (create) flagship, sve role", () => {
    it.each(WRITE_ROLES)("POST / → 201 za %s (ima rn.write)", async (role) => {
      await post("", role, createBody()).expect(201);
    });
    it.each(NO_WRITE)("POST / → 403 za %s (nema rn.write)", async (role) => {
      await post("", role, createBody()).expect(403);
    });
    it.each(["user", "nepoznata_rola"])(
      "POST / → 403 za %s (default deny, dokaz enforcement-a)",
      async (role) => {
        await post("", role, createBody()).expect(403);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // rn.write — sve ostale write rute: holder(sef) 2xx + non-holder(kontrolor) 403
  // + default-deny(user) 403. Sef nosi rn.write/approve/launch/delete.force pa je
  // univerzalni holder; kontrolor čita RN ali nema rn.write.
  // ---------------------------------------------------------------------------
  describe("rn.write — ostale mutacije (holder=sef 2xx, non-holder=kontrolor 403, deny=user 403)", () => {
    const HOLDER = "sef";
    const NON = "kontrolor";
    it("PATCH /:id (updateHeader) → 200 sef / 403 kontrolor / 403 user", async () => {
      await patch("/1", HOLDER, { note: "x" }).expect(200);
      await patch("/1", NON, { note: "x" }).expect(403);
      await patch("/1", "user", { note: "x" }).expect(403);
    });
    it("POST /:id/operations (addOperation) → 201 sef / 403 kontrolor / 403 user", async () => {
      const b = { workCenterCode: "RC-1", workDescription: "Struganje" };
      await post("/1/operations", HOLDER, b).expect(201);
      await post("/1/operations", NON, b).expect(403);
      await post("/1/operations", "user", b).expect(403);
    });
    it("PATCH /:id/operations/:opId (updateOperation) → 200 sef / 403 kontrolor / 403 user", async () => {
      await patch("/1/operations/10", HOLDER, { cycleTime: 5 }).expect(200);
      await patch("/1/operations/10", NON, { cycleTime: 5 }).expect(403);
      await patch("/1/operations/10", "user", { cycleTime: 5 }).expect(403);
    });
    it("DELETE /:id/operations/:opId (deleteOperation) → 200 sef / 403 kontrolor / 403 user", async () => {
      await del("/1/operations/10", HOLDER).expect(200);
      await del("/1/operations/10", NON).expect(403);
      await del("/1/operations/10", "user").expect(403);
    });
    it("DELETE /:id (remove) → 200 sef / 403 kontrolor / 403 user", async () => {
      await del("/1", HOLDER).expect(200);
      await del("/1", NON).expect(403);
      await del("/1", "user").expect(403);
    });
    it("POST /:id/lock → 200 sef / 403 kontrolor / 403 user", async () => {
      await post("/1/lock", HOLDER, { locked: true }).expect(201);
      await post("/1/lock", NON, { locked: true }).expect(403);
      await post("/1/lock", "user", { locked: true }).expect(403);
    });
    it("POST /:id/copy-from/:sourceId → 201 sef / 403 kontrolor / 403 user", async () => {
      await post("/2/copy-from/1", HOLDER).expect(201);
      await post("/2/copy-from/1", NON).expect(403);
      await post("/2/copy-from/1", "user").expect(403);
    });
    it("POST /:id/clone-variant → 201 sef / 403 kontrolor / 403 user", async () => {
      await post("/1/clone-variant", HOLDER).expect(201);
      await post("/1/clone-variant", NON).expect(403);
      await post("/1/clone-variant", "user").expect(403);
    });
    it("POST /:id/rework → 201 sef / 403 kontrolor / 403 user", async () => {
      const b = { pieceCount: 1, qualityTypeId: 1 };
      await post("/1/rework", HOLDER, b).expect(201);
      await post("/1/rework", NON, b).expect(403);
      await post("/1/rework", "user", b).expect(403);
    });
    it("POST /:id/quality-child → 201 sef / 403 kontrolor / 403 user", async () => {
      const b = { qualityTypeId: 2, quantity: 1 };
      await post("/1/quality-child", HOLDER, b).expect(201);
      await post("/1/quality-child", NON, b).expect(403);
      await post("/1/quality-child", "user", b).expect(403);
    });
    it("POST /projects/:projectId/bulk-clone → 201 sef / 403 kontrolor / 403 user", async () => {
      const b = { targetProjectId: 9, coefficient: 2 };
      await post("/projects/1/bulk-clone", HOLDER, b).expect(201);
      await post("/projects/1/bulk-clone", NON, b).expect(403);
      await post("/projects/1/bulk-clone", "user", b).expect(403);
    });
    // Kontrast: menadzment IMA rn.write (create prolazi) — dokaz da NON=kontrolor 403
    // gore nije tautologija (rn.write skup je stvarno neprazan i kuriran).
    it("POST / → 201 za menadzment (ima rn.write) — anti-tautologija", async () => {
      await post("", "menadzment", createBody()).expect(201);
    });
    it("PATCH /:id → 400 za ne-integer param (holder prošao guard, ParseIntPipe)", async () => {
      await patch("/nije-broj", HOLDER, { note: "x" }).expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // rn.approve — :id/approve. menadzment ima rn.write ali NE rn.approve (namerna
  // asimetrija: approve/launch = {sef, tehnolog, admin}).
  // ---------------------------------------------------------------------------
  describe("rn.approve — POST /:id/approve", () => {
    it.each(APPROVE_ROLES)("→ 201 za %s (ima rn.approve)", async (role) => {
      await post("/1/approve", role, { approve: true }).expect(201);
    });
    it.each(NO_APPROVE)("→ 403 za %s (nema rn.approve)", async (role) => {
      await post("/1/approve", role, { approve: true }).expect(403);
    });
    it("menadzment ima rn.write ali → 403 na approve (asimetrija write≠approve)", async () => {
      await patch("/1", "menadzment", { note: "x" }).expect(200); // write da
      await post("/1/approve", "menadzment", { approve: true }).expect(403); // approve ne
    });
  });

  // ---------------------------------------------------------------------------
  // rn.launch — :id/launch. Kontrolor čita RN ali NE lansira (modul-specifično).
  // ---------------------------------------------------------------------------
  describe("rn.launch — POST /:id/launch", () => {
    it.each(LAUNCH_ROLES)("→ 201 za %s (ima rn.launch)", async (role) => {
      await post("/1/launch", role).expect(201);
    });
    it.each(NO_LAUNCH)("→ 403 za %s (nema rn.launch)", async (role) => {
      await post("/1/launch", role).expect(403);
    });
    it("kontrolor sme da čita RN ali NE sme launch (403)", async () => {
      await get("/1", "kontrolor").expect(200);
      await post("/1/launch", "kontrolor").expect(403);
    });
  });

  // ---------------------------------------------------------------------------
  // rn.delete.force — :id/force. Samo admin/sef; tehnolog (ima rn.write) NEMA force.
  // ---------------------------------------------------------------------------
  describe("rn.delete.force — DELETE /:id/force", () => {
    it.each(FORCE_ROLES)("→ 200 za %s (ima rn.delete.force)", async (role) => {
      await del("/1/force", role).expect(200);
    });
    it.each(NO_FORCE)("→ 403 za %s (nema rn.delete.force)", async (role) => {
      await del("/1/force", role).expect(403);
    });
    it("tehnolog ima rn.write (remove prolazi) ali NE force (403)", async () => {
      await del("/1", "tehnolog").expect(200); // rn.write
      await del("/1/force", "tehnolog").expect(403); // rn.delete.force ne
    });
    it("DELETE /:id/force → 400 ne-integer param (sef prošao guard, ParseIntPipe)", async () => {
      await del("/nije-broj/force", "sef").expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // tehnologija.write — operations/:opId/priority. CNC programer prioritizuje
  // (ima tehnologija.write) ali NEMA rn.write → create 403.
  // ---------------------------------------------------------------------------
  describe("tehnologija.write — PATCH /operations/:opId/priority", () => {
    it.each(TEHWRITE_ROLES)(
      "→ 200 za %s (ima tehnologija.write)",
      async (role) => {
        await patch("/operations/10/priority", role, { priority: 100 }).expect(
          200,
        );
      },
    );
    it.each(NO_TEHWRITE)(
      "→ 403 za %s (nema tehnologija.write)",
      async (role) => {
        await patch("/operations/10/priority", role, { priority: 100 }).expect(
          403,
        );
      },
    );
    it("cnc_programer sme prioritet (200) ali NE create RN (403) — namerna razlika", async () => {
      await patch("/operations/10/priority", "cnc_programer", {
        priority: 100,
      }).expect(200);
      await post("", "cnc_programer", createBody()).expect(403);
    });
    it("route ordering: /operations/:opId/priority ne senči PATCH /:id", async () => {
      svcMock.setOperationPriority.mockClear();
      svcMock.updateHeader.mockClear();
      await patch("/operations/10/priority", "admin", { priority: 50 }).expect(
        200,
      );
      expect(svcMock.setOperationPriority).toHaveBeenCalled();
      expect(svcMock.updateHeader).not.toHaveBeenCalled();
    });
  });
});
