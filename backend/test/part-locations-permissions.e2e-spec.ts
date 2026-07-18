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
import { PartLocationsController } from "../src/modules/part-locations/part-locations.controller";
import { PartLocationsService } from "../src/modules/part-locations/part-locations.service";
import { PositionsController } from "../src/modules/part-locations/positions.controller";
import { PositionsService } from "../src/modules/part-locations/positions.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Lokacije napravljenih delova (MODULE_SPEC_lokacije §1/§5)
 * + Pozicije/police, rola × endpoint × 200/403. Pokriva OBA kontrolera koji dele
 * `lokacije.read` (READ) / `lokacije.write` (mutacije):
 *   PartLocationsController  /api/v1/part-locations (+ /card/:workOrderId, /transfer, /requisition)
 *   PositionsController      /api/v1/positions (+ /:id)
 *
 * Guard sloj se testira SA AUTHZ_ENFORCE=true (realno ponašanje V2 aktivacije, koja
 * je ŽIVA na prod-u); JwtAuthGuard je zamenjen stubom koji identitet čita iz
 * `x-test-role` header-a. Servisi su mokovani (bez PG baze) — poslovne validacije
 * (validate*Dto, signed-balance 422) žive u servisu i NISU predmet ovog matrix-a;
 * ovde dokazujemo SAMO rola→permisija enforcement na svakoj ruti.
 *
 * NAPOMENA (legacy Int id): oba kontrolera koriste NUMERIČKE id-jeve sa ParseIntPipe
 * (ne UUID). ParseIntPipe se izvršava POSLE guard-a (pipes < guards), pa nevalidan
 * `:id`/`:workOrderId` daje 400 samo za autorizovanu rolu (neautorizovana → 403 pre pipe-a).
 */
describe("Part-locations + Positions permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  const partLocationsMock: Record<string, jest.Mock> = {};
  for (const m of ["list", "card", "create", "transfer", "requisition"]) {
    partLocationsMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }
  const positionsMock: Record<string, jest.Mock> = {};
  for (const m of ["list", "create", "update"]) {
    positionsMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [PartLocationsController, PositionsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: PartLocationsService, useValue: partLocationsMock },
        { provide: PositionsService, useValue: positionsMock },
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
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set("x-test-role", role);
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

  // --- Grupe rola (izvor: src/common/authz/role-permissions.ts) ---
  //
  // `lokacije.read` = svi prijavljeni (VIEWER_READ_BASELINE + eksplicitne dodele) →
  // SVAKA aktivna 2.0 uloga. `user`/nepoznata rola nisu u mapi → default-deny.
  const READ_ROLES = [
    "admin",
    "menadzment",
    "sef",
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "pm",
    "leadpm",
    "tim_lider",
    "cnc_operater",
    "monter",
    "hr",
    "poslovni_admin",
    "projektant_vodja",
    "inzenjer",
  ];

  // `lokacije.write` = admin (ALL) + sef + magacioner + menadzment (eksplicitne dodele).
  const WRITE_ROLES = ["admin", "sef", "magacioner", "menadzment"];

  // READ ali NE WRITE — dokaz da read-baseline NE nosi mutaciju ledgera/pozicija.
  // (Uklj. proizvodni_radnik/kontrolor/tehnolog koji u NOVOM loc_* modulu imaju
  // `lokacije.move`, ali OVI legacy kontroleri gate-uju `lokacije.write` — v. suspicious.)
  const NOT_WRITE = [
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "pm",
    "leadpm",
    "tim_lider",
    "cnc_operater",
    "monter",
    "hr",
    "poslovni_admin",
    "projektant_vodja",
    "inzenjer",
  ];

  // Ne-tautološki default-deny: prelazna `user` + potpuno nepoznata rola.
  const DENY_ROLES = ["user", "nepoznata_rola"];

  // ---------------------------------------------------------------- part-locations
  describe("PartLocations READ — lokacije.read", () => {
    it.each(READ_ROLES)("GET /part-locations → 200 za %s", async (role) => {
      await get("/part-locations", role).expect(200);
    });
    it.each(DENY_ROLES)(
      "GET /part-locations → 403 za %s (default deny)",
      async (role) => {
        await get("/part-locations", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/part-locations")
        .expect(403);
    });

    it("GET /part-locations/card/:workOrderId → 200 magacioner, 403 user", async () => {
      await get("/part-locations/card/1", "magacioner").expect(200);
      await get("/part-locations/card/1", "user").expect(403);
    });
    it("GET /part-locations/card/:workOrderId sa ne-brojem → 400 (ParseIntPipe, autorizovan)", async () => {
      await get("/part-locations/card/abc", "magacioner").expect(400);
    });
    it("GET /part-locations/card/:workOrderId sa ne-brojem → 403 pre pipe-a (neautorizovan)", async () => {
      // Guard ide PRE ParseIntPipe → neautorizovana rola nikad ne stigne do 400.
      await get("/part-locations/card/abc", "user").expect(403);
    });
  });

  describe("PartLocations WRITE — lokacije.write", () => {
    const createBody = {
      workOrderId: 1,
      positionId: 1,
      qualityTypeId: 0,
      workerId: 1,
      quantity: 1,
    };
    const transferBody = {
      workOrderId: 1,
      fromPositionId: 1,
      toPositionId: 2,
      quantity: 1,
      qualityTypeId: 0,
    };
    const requisitionBody = {
      workOrderId: 1,
      positionId: 1,
      quantity: 1,
      qualityTypeId: 0,
    };

    it.each(WRITE_ROLES)("POST /part-locations → 201 za %s", async (role) => {
      await post("/part-locations", role, createBody).expect(201);
    });
    it.each(NOT_WRITE)(
      "POST /part-locations → 403 za %s (read-baseline nema write)",
      async (role) => {
        await post("/part-locations", role, createBody).expect(403);
      },
    );
    it.each(DENY_ROLES)(
      "POST /part-locations → 403 za %s (default deny)",
      async (role) => {
        await post("/part-locations", role, createBody).expect(403);
      },
    );

    it("POST /part-locations/transfer → 201 magacioner, 403 kontrolor", async () => {
      await post("/part-locations/transfer", "magacioner", transferBody).expect(
        201,
      );
      await post("/part-locations/transfer", "kontrolor", transferBody).expect(
        403,
      );
    });
    it("POST /part-locations/requisition → 201 sef, 403 tehnolog", async () => {
      await post(
        "/part-locations/requisition",
        "sef",
        requisitionBody,
      ).expect(201);
      await post(
        "/part-locations/requisition",
        "tehnolog",
        requisitionBody,
      ).expect(403);
    });
  });

  // Modul-specifičan kontrast: kontrolor/tehnolog VIDE lokacije (read), ali NE SMEJU
  // da mutiraju ledger (write) — read ≠ write na istom modulu.
  describe("PartLocations read≠write kontrast", () => {
    it("kontrolor: GET → 200, POST → 403", async () => {
      await get("/part-locations", "kontrolor").expect(200);
      await post("/part-locations", "kontrolor", {}).expect(403);
    });
    it("tehnolog: GET → 200, POST /requisition → 403", async () => {
      await get("/part-locations", "tehnolog").expect(200);
      await post("/part-locations/requisition", "tehnolog", {}).expect(403);
    });
  });

  // ---------------------------------------------------------------- positions
  describe("Positions READ — lokacije.read", () => {
    it.each(READ_ROLES)("GET /positions → 200 za %s", async (role) => {
      await get("/positions", role).expect(200);
    });
    it.each(DENY_ROLES)(
      "GET /positions → 403 za %s (default deny)",
      async (role) => {
        await get("/positions", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer()).get("/api/v1/positions").expect(403);
    });
  });

  describe("Positions WRITE — lokacije.write", () => {
    const createBody = { positionCode: "P-1", description: "Polica 1" };
    const updateBody = { description: "Nova" };

    it.each(WRITE_ROLES)("POST /positions → 201 za %s", async (role) => {
      await post("/positions", role, createBody).expect(201);
    });
    it.each(NOT_WRITE)("POST /positions → 403 za %s", async (role) => {
      await post("/positions", role, createBody).expect(403);
    });
    it.each(DENY_ROLES)(
      "POST /positions → 403 za %s (default deny)",
      async (role) => {
        await post("/positions", role, createBody).expect(403);
      },
    );

    it("PATCH /positions/:id → 200 magacioner, 403 viewer", async () => {
      await patch("/positions/1", "magacioner", updateBody).expect(200);
      await patch("/positions/1", "viewer", updateBody).expect(403);
    });
    it("PATCH /positions/:id sa ne-brojem → 400 (ParseIntPipe, autorizovan)", async () => {
      await patch("/positions/abc", "magacioner", updateBody).expect(400);
    });
    it("PATCH /positions/:id sa ne-brojem → 403 pre pipe-a (neautorizovan)", async () => {
      await patch("/positions/abc", "viewer", updateBody).expect(403);
    });
  });
});
