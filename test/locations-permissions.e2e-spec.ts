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
import { LocationsController } from "../src/modules/locations/locations.controller";
import { LocationsService } from "../src/modules/locations/locations.service";

/**
 * e2e PERMISSION MATRICA — Lokacije (MODULE_SPEC_lokacije_30.md §2/§5), rola ×
 * endpoint × 200/403. Guard sloj se testira SA AUTHZ_ENFORCE=true (realno V2
 * ponašanje); JwtAuthGuard je zamenjen stubom koji identitet čita iz `x-test-role`.
 * LocationsService je mokovan (bez sy15 baze) — row-scope („manage ILI aktivan
 * zaposleni", RLS rev_tools) sprovode DB funkcije, ne testira se ovde.
 *
 * R1 ima SAMO GET rute: read (klasa), manage (definitions-audit), admin (sync/*).
 * Move/labels permisije postoje u mapi (unit test), ali NEMAJU R1 endpoint (mutacije=R2).
 */
describe("Lokacije permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const serviceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listLocations",
    "findLocation",
    "listPlacements",
    "listMovements",
    "reportByLocation",
    "reportSuggestNazivDela",
    "predmetTps",
    "validateOrder",
    "lookupBarcode",
    "definitionsAudit",
    "syncStatus",
    "syncOutbound",
  ]) {
    serviceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [{ provide: LocationsService, useValue: serviceMock }],
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

  const get = (path: string, role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/locations${path}`)
      .set("x-test-role", role);

  // read = svi prijavljeni → sve aktivne uloge (uklj. baseline SSO uloge).
  const ALL_READ_ROLES = [
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
    "hr",
    "poslovni_admin",
    "monter",
    "projektant_vodja",
    "inzenjer",
  ];
  const MANAGE_ROLES = ["admin", "menadzment", "pm", "leadpm"];
  const NOT_MANAGE = [
    "sef",
    "tehnolog",
    "magacioner",
    "kontrolor",
    "proizvodni_radnik",
    "cnc_operater",
    "nabavka_view",
    "viewer",
    "tim_lider",
  ];
  const ADMIN_ROLES = ["admin"];
  const NOT_ADMIN = [
    "menadzment",
    "pm",
    "leadpm",
    "magacioner",
    "sef",
    "viewer",
  ];

  // Read rute (klasni gate lokacije.read).
  const READ_ENDPOINTS = [
    "",
    "/placements",
    "/movements",
    "/reports/by-location",
    "/reports/suggest-naziv-dela",
    "/predmet/123/tps",
    "/lookups/validate-order",
    "/lookups/barcode?code=RNZ:8693:7351/1088:0:39757",
    `/${VALID_UUID}`,
  ];

  describe("read endpoints — lokacije.read (svi prijavljeni)", () => {
    for (const path of READ_ENDPOINTS) {
      it.each(ALL_READ_ROLES)(
        `GET ${path || "/"} → 200 za %s`,
        async (role) => {
          await get(path, role).expect(200);
        },
      );
    }
    it.each(["user", "nepoznata_rola"])(
      "GET / → 403 za %s (default deny)",
      async (role) => {
        await get("", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer()).get("/api/v1/locations").expect(403);
    });
    it("GET /lookups/barcode → 200 za magacioner (skener resolver = lokacije.read)", async () => {
      await get("/lookups/barcode?code=P1", "magacioner").expect(200);
    });
  });

  describe("istorija definicija — lokacije.manage (loc_can_manage_locations)", () => {
    it.each(MANAGE_ROLES)(
      "GET /definitions-audit → 200 za %s",
      async (role) => {
        await get("/definitions-audit", role).expect(200);
      },
    );
    it.each(NOT_MANAGE)("GET /definitions-audit → 403 za %s", async (role) => {
      await get("/definitions-audit", role).expect(403);
    });
  });

  describe("Sync tab — lokacije.admin (loc_is_admin, SAMO admin)", () => {
    it.each(ADMIN_ROLES)("GET /sync/status → 200 za %s", async (role) => {
      await get("/sync/status", role).expect(200);
    });
    it.each(ADMIN_ROLES)("GET /sync/outbound → 200 za %s", async (role) => {
      await get("/sync/outbound", role).expect(200);
    });
    it.each(NOT_ADMIN)(
      "GET /sync/status → 403 za %s (ni menadzment/pm nisu admin)",
      async (role) => {
        await get("/sync/status", role).expect(403);
      },
    );
    it.each(NOT_ADMIN)("GET /sync/outbound → 403 za %s", async (role) => {
      await get("/sync/outbound", role).expect(403);
    });
  });
});
