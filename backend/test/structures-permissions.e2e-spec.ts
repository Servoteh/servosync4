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
import { MachineAccessController } from "../src/modules/structures/machine-access.controller";
import { MachineAccessService } from "../src/modules/structures/machine-access.service";
import { OperationsController } from "../src/modules/structures/operations.controller";
import { OperationsService } from "../src/modules/structures/operations.service";
import { WorkUnitsController } from "../src/modules/structures/work-units.controller";
import { WorkUnitsService } from "../src/modules/structures/work-units.service";
import { WorkerTypesController } from "../src/modules/structures/worker-types.controller";
import { WorkerTypesService } from "../src/modules/structures/worker-types.service";
import { WorkersController } from "../src/modules/structures/workers.controller";
import { WorkersService } from "../src/modules/structures/workers.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Strukture (šifarnici radnici/RJ/operacije/vrste poslova +
 * matrica pristupa mašini), rola × endpoint × 200/201/403. Svih 5 kontrolera dele isti
 * gate: klasa = `strukture.read`, mutacije (POST/PATCH/DELETE) = `strukture.write`
 * (route-permission-coverage.txt, 22 rute).
 *
 * Guard sloj se testira SA AUTHZ_ENFORCE=true (realno V2 ponašanje); JwtAuthGuard je
 * zamenjen stubom koji identitet čita iz `x-test-role` header-a. Servisi su mokovani
 * (bez PG baze) — DTO validacija ovih modula živi U SERVISU (plain interface DTO, ne
 * class-validator), pa je mock zaobilazi: za 2xx mutacije dovoljno je da telo prođe guard.
 *
 * Izvor intenta = ROLE_PERMISSIONS (role-permissions.ts):
 *   strukture.read  → admin, menadzment, sef, tehnolog, cnc_programer, kontrolor,
 *                     magacioner, proizvodni_radnik
 *   strukture.write → admin, sef, tehnolog, menadzment (odluka Nenad 10.07 — D1)
 * Ključna modul-specifična asimetrija: cnc_programer/kontrolor/magacioner/
 * proizvodni_radnik SMEJU da čitice (200) ali NE smeju da pišu (403).
 */
describe("Strukture permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const makeMock = (methods: string[]): Record<string, jest.Mock> => {
    const m: Record<string, jest.Mock> = {};
    for (const name of methods) m[name] = jest.fn().mockResolvedValue({ data: [] });
    return m;
  };

  const machineAccessMock = makeMock(["list", "create", "batch", "remove"]);
  const operationsMock = makeMock(["list", "create", "update", "remove"]);
  const workUnitsMock = makeMock(["list", "create", "update", "remove"]);
  const workerTypesMock = makeMock(["list", "create", "update", "remove"]);
  const workersMock = makeMock([
    "list",
    "findOne",
    "create",
    "update",
    "deactivate",
    "remove",
  ]);

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-not-real-secret"; // izbegni SEC-01 na importu auth-a
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [
        MachineAccessController,
        OperationsController,
        WorkUnitsController,
        WorkerTypesController,
        WorkersController,
      ],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: MachineAccessService, useValue: machineAccessMock },
        { provide: OperationsService, useValue: operationsMock },
        { provide: WorkUnitsService, useValue: workUnitsMock },
        { provide: WorkerTypesService, useValue: workerTypesMock },
        { provide: WorkersService, useValue: workersMock },
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

  const get = (path: string, role: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`).set("x-test-role", role);
  const post = (path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set("x-test-role", role)
      .send(body);
  const patch = (path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set("x-test-role", role)
      .send(body);
  const del = (path: string, role: string) =>
    request(app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set("x-test-role", role);

  // --- Grupe rola (paritet ROLE_PERMISSIONS) ---
  const READ_HOLDERS = [
    "admin",
    "menadzment",
    "sef",
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
  ];
  // Aktivne uloge koje NEMAJU strukture.read (default-deny na read).
  const NOT_READ = ["nabavka_view", "pm", "leadpm", "viewer", "tim_lider"];
  const WRITE_HOLDERS = ["admin", "sef", "tehnolog", "menadzment"];
  // Imaju read ali NE i write (dokaz asimetrije) + uloge bez ijedne strukture perm.
  const NOT_WRITE = [
    "cnc_programer",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "nabavka_view",
    "pm",
    "leadpm",
    "viewer",
    "tim_lider",
  ];
  // Ne-tautološki dokaz enforcement-a: prelazna „user" i izmišljena rola.
  const DEFAULT_DENY = ["user", "nepoznata_rola"];
  const READ_DENY = [...NOT_READ, ...DEFAULT_DENY];
  const WRITE_DENY = [...NOT_WRITE, ...DEFAULT_DENY];

  // ---------------- READ (GET) — strukture.read ----------------
  describe.each([
    ["machine-access", "/structures/machine-access"],
    ["operations", "/structures/operations"],
    ["work-units", "/structures/work-units"],
    ["worker-types", "/structures/worker-types"],
    ["workers", "/structures/workers"],
  ])("GET /%s (strukture.read)", (_label, base) => {
    it.each(READ_HOLDERS)("→ 200 za %s (holder)", async (role) => {
      await get(base, role).expect(200);
    });
    it.each(READ_DENY)("→ 403 za %s (non-holder / default-deny)", async (role) => {
      await get(base, role).expect(403);
    });
  });

  it("GET /structures/workers/:id → 200 read-holder, 403 default-deny", async () => {
    await get("/structures/workers/1", "proizvodni_radnik").expect(200);
    await get("/structures/workers/1", "viewer").expect(403);
    await get("/structures/workers/1", "user").expect(403);
  });

  it("bez identiteta → 403 (JwtAuthGuard stub odbija bez x-test-role)", async () => {
    await request(app.getHttpServer())
      .get("/api/v1/structures/workers")
      .expect(403);
  });

  // ---------------- WRITE (POST/PATCH/DELETE) — strukture.write ----------------

  describe("POST mutacije (strukture.write)", () => {
    const cases: [string, string, object][] = [
      ["machine-access create", "/structures/machine-access", { workerId: 1, workCenterCode: "1.10" }],
      ["machine-access batch", "/structures/machine-access/batch", { workerId: 1, add: ["1.10"] }],
      ["operations create", "/structures/operations", { workCenterCode: "1.10", workCenterName: "Struganje", workUnitCode: "01" }],
      ["work-units create", "/structures/work-units", { code: "01", name: "Sečenje" }],
      ["worker-types create", "/structures/worker-types", { name: "Bravar" }],
      ["workers create", "/structures/workers", { username: "pera" }],
      ["workers deactivate", "/structures/workers/1/deactivate", {}],
    ];
    describe.each(cases)("POST %s", (_label, path, body) => {
      it.each(WRITE_HOLDERS)("→ 201 za %s (holder)", async (role) => {
        await post(path, role, body).expect(201);
      });
      it.each(WRITE_DENY)("→ 403 za %s (non-holder / default-deny)", async (role) => {
        await post(path, role, body).expect(403);
      });
    });
  });

  describe("PATCH mutacije (strukture.write)", () => {
    const cases: [string, string, object][] = [
      ["operations update", "/structures/operations/1.10", { workCenterName: "X" }],
      ["work-units update", "/structures/work-units/1", { name: "X" }],
      ["worker-types update", "/structures/worker-types/1", { name: "X" }],
      ["workers update", "/structures/workers/1", { fullName: "X" }],
    ];
    describe.each(cases)("PATCH %s", (_label, path, body) => {
      it.each(WRITE_HOLDERS)("→ 200 za %s (holder)", async (role) => {
        await patch(path, role, body).expect(200);
      });
      it.each(WRITE_DENY)("→ 403 za %s (non-holder / default-deny)", async (role) => {
        await patch(path, role, body).expect(403);
      });
    });
  });

  describe("DELETE mutacije (strukture.write)", () => {
    const cases: [string, string][] = [
      ["machine-access remove", "/structures/machine-access/1"],
      ["operations remove", "/structures/operations/1.10"],
      ["work-units remove", "/structures/work-units/1"],
      ["worker-types remove", "/structures/worker-types/1"],
      ["workers remove", "/structures/workers/1"],
    ];
    describe.each(cases)("DELETE %s", (_label, path) => {
      it.each(WRITE_HOLDERS)("→ 200 za %s (holder)", async (role) => {
        await del(path, role).expect(200);
      });
      it.each(WRITE_DENY)("→ 403 za %s (non-holder / default-deny)", async (role) => {
        await del(path, role).expect(403);
      });
    });
  });

  // ---------------- Modul-specifične granice ----------------

  it("read-holder-ali-ne-write: magacioner GET 200 ali POST/PATCH/DELETE 403", async () => {
    await get("/structures/workers", "magacioner").expect(200);
    await post("/structures/workers", "magacioner", { username: "x" }).expect(403);
    await patch("/structures/workers/1", "magacioner", { fullName: "x" }).expect(403);
    await del("/structures/workers/1", "magacioner").expect(403);
  });

  it("kontrolor sme da čita strukture ali ne da menja operacije (read≠write)", async () => {
    await get("/structures/operations", "kontrolor").expect(200);
    await post("/structures/operations", "kontrolor", {
      workCenterCode: "1.10",
      workCenterName: "X",
      workUnitCode: "01",
    }).expect(403);
  });

  // Guard ide PRE ParseIntPipe: non-holder na nevalidan id i dalje dobija 403 (ne 400).
  it("DELETE /structures/work-units/:id nevalidan id → 400 za holder (ParseIntPipe posle guarda)", async () => {
    await del("/structures/work-units/nije-broj", "admin").expect(400);
  });
  it("DELETE /structures/work-units/:id nevalidan id → 403 za non-holder (guard pre pipe-a)", async () => {
    await del("/structures/work-units/nije-broj", "viewer").expect(403);
  });
  it("GET /structures/workers/:id nevalidan id → 400 za read-holder", async () => {
    await get("/structures/workers/nije-broj", "tehnolog").expect(400);
  });
});
