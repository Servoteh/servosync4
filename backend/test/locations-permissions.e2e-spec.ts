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
import { LocTpFeedService } from "../src/modules/locations/loc-tp-feed.service";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Lokacije (MODULE_SPEC_lokacije_30.md §2/§5), rola ×
 * endpoint × 200/403. Guard sloj se testira SA AUTHZ_ENFORCE=true (realno V2
 * ponašanje); JwtAuthGuard je zamenjen stubom koji identitet čita iz `x-test-role`.
 * LocationsService je mokovan (bez sy15 baze) — row-scope („manage ILI aktivan
 * zaposleni", RLS rev_tools) sprovode DB funkcije, ne testira se ovde.
 *
 * R1: GET rute — read (klasa), manage (definitions-audit), admin (sync/status,outbound).
 * R2: mutacije — move (POST movements), manage (POST/PATCH locations + POST cage-move),
 * admin (POST sync/arm,run-now), labels (POST labels/print). Guard-sloj (rola × 200/403).
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
    "syncHealth",
    // R2 mutacije
    "createMovement",
    "moveCage",
    "createLocation",
    "updateLocation",
    "syncArm",
    "syncRunNow",
    "printLabel",
  ]) {
    serviceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  // B1 loc-most feeder (RUNBOOK_LOC_MOST_REPOINT.md) — zaseban provider iza
  // `sync/feed-run` i `sync/feed-status`; oba su `lokacije.admin`.
  const feedMock: Record<string, jest.Mock> = {
    run: jest.fn().mockResolvedValue({ data: {} }),
    status: jest.fn().mockResolvedValue({ data: {} }),
  };

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: async () => null },
          },
        },
        { provide: LocationsService, useValue: serviceMock },
        { provide: LocTpFeedService, useValue: feedMock },
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
  const post = (path: string, role: string, body: object = {}) =>
    request(app.getHttpServer())
      .post(`/api/v1/locations${path}`)
      .set("x-test-role", role)
      .send(body);
  const patch = (path: string, role: string, body: object = {}) =>
    request(app.getHttpServer())
      .patch(`/api/v1/locations${path}`)
      .set("x-test-role", role)
      .send(body);

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
  // move = svi prijavljeni (loc_can_create_movement pušta i aktivnog zaposlenog;
  // guard-sloj je namerno širok → row-odluku donosi DB fn). Reprezentativan skup.
  const MOVE_ROLES = [
    "admin",
    "menadzment",
    "sef",
    "tehnolog",
    "magacioner",
    "proizvodni_radnik",
    "viewer",
    "monter",
    "cnc_operater",
    "tim_lider",
  ];
  const NOT_MOVE = ["user", "nepoznata_rola"];
  // labels = manage + magacioner + cnc_operater (1.0 canPrintLocLabels, spec §2).
  const LABELS_ROLES = [
    "admin",
    "menadzment",
    "pm",
    "leadpm",
    "magacioner",
    "cnc_operater",
  ];
  const NOT_LABELS = [
    "sef",
    "tehnolog",
    "kontrolor",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "tim_lider",
    "monter",
  ];

  // Validni body-ji da 201/200 grane prođu ValidationPipe (guard fura pre pipe-a,
  // pa 403 grane ne zavise od body-ja).
  const MOVE_BODY = {
    clientEventUuid: VALID_UUID,
    itemRefTable: "bigtehn_rn",
    itemRefId: "9400/165",
    movementType: "TRANSFER",
    toLocationId: VALID_UUID,
  };
  const CAGE_BODY = { cageId: VALID_UUID, newHallId: VALID_UUID };
  const CREATE_LOC_BODY = {
    locationCode: "H1-P05",
    name: "Polica 5",
    locationType: "SHELF",
  };
  const LABEL_BODY = { tspl2: "CLS\nPRINT 1,1\n" };

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
    // B1 loc-most: feed 2.0 → sy15 cache je admin operacija kao i ostatak Sync taba.
    it.each(ADMIN_ROLES)("GET /sync/feed-status → 200 za %s", async (role) => {
      await get("/sync/feed-status", role).expect(200);
    });
    it.each(NOT_ADMIN)("GET /sync/feed-status → 403 za %s", async (role) => {
      await get("/sync/feed-status", role).expect(403);
    });
  });

  // LOK-P3: sync/health je klasni lokacije.read (bez admin override-a) — SVE
  // uloge modula (uklj. magacioner/cnc) vide read-only zdravlje sync-a.
  describe("GET /sync/health — lokacije.read (svi, LOK-P3)", () => {
    it.each(ALL_READ_ROLES)("→ 200 za %s", async (role) => {
      await get("/sync/health", role).expect(200);
    });
  });

  // ==================== R2: MUTACIJE ====================

  describe("POST /movements — lokacije.move (loc_can_create_movement)", () => {
    it.each(MOVE_ROLES)("→ 201 za %s", async (role) => {
      await post("/movements", role, MOVE_BODY).expect(201);
    });
    it.each(NOT_MOVE)("→ 403 za %s (default deny)", async (role) => {
      await post("/movements", role, MOVE_BODY).expect(403);
    });
    it("nevalidan clientEventUuid → 400 (ValidationPipe, admin)", async () => {
      await post("/movements", "admin", {
        ...MOVE_BODY,
        clientEventUuid: "nije-uuid",
      }).expect(400);
    });
    it("nepoznat movementType → 400", async () => {
      await post("/movements", "admin", {
        ...MOVE_BODY,
        movementType: "NEPOSTOJI",
      }).expect(400);
    });
    it("nedostaje itemRefTable → 400", async () => {
      const { itemRefTable, ...rest } = MOVE_BODY;
      void itemRefTable;
      await post("/movements", "admin", rest).expect(400);
    });
  });

  describe("POST /cage-move — lokacije.manage (loc_can_manage_locations)", () => {
    it.each(MANAGE_ROLES)("→ 201 za %s", async (role) => {
      await post("/cage-move", role, CAGE_BODY).expect(201);
    });
    it.each(NOT_MANAGE)("→ 403 za %s", async (role) => {
      await post("/cage-move", role, CAGE_BODY).expect(403);
    });
    it("nevalidan cageId → 400 (admin)", async () => {
      await post("/cage-move", "admin", {
        cageId: "x",
        newHallId: VALID_UUID,
      }).expect(400);
    });
  });

  describe("POST /locations (create) — lokacije.manage", () => {
    it.each(MANAGE_ROLES)("→ 201 za %s", async (role) => {
      await post("", role, CREATE_LOC_BODY).expect(201);
    });
    it.each(NOT_MANAGE)("→ 403 za %s", async (role) => {
      await post("", role, CREATE_LOC_BODY).expect(403);
    });
    it("nepoznat locationType → 400 (admin)", async () => {
      await post("", "admin", {
        ...CREATE_LOC_BODY,
        locationType: "NEPOSTOJI",
      }).expect(400);
    });
  });

  describe("PATCH /locations/:id (update) — lokacije.manage", () => {
    it.each(MANAGE_ROLES)("→ 200 za %s", async (role) => {
      await patch(`/${VALID_UUID}`, role, { name: "Nova" }).expect(200);
    });
    it.each(NOT_MANAGE)("→ 403 za %s", async (role) => {
      await patch(`/${VALID_UUID}`, role, { name: "Nova" }).expect(403);
    });
    it("nevalidan :id → 400 (ParseUUIDPipe, admin)", async () => {
      await patch("/not-a-uuid", "admin", { name: "X" }).expect(400);
    });
  });

  describe("POST /sync/arm i /sync/run-now — lokacije.admin", () => {
    it.each(ADMIN_ROLES)("POST /sync/arm → 201 za %s", async (role) => {
      await post("/sync/arm", role, { armed: true }).expect(201);
    });
    it.each(NOT_ADMIN)("POST /sync/arm → 403 za %s", async (role) => {
      await post("/sync/arm", role, { armed: true }).expect(403);
    });
    it("POST /sync/arm armed nije boolean → 400 (admin)", async () => {
      await post("/sync/arm", "admin", { armed: "da" }).expect(400);
    });
    // PLK-02: run-now traži { confirm: true } (400 bez nje čak i za admina).
    it.each(ADMIN_ROLES)("POST /sync/run-now → 201 za %s", async (role) => {
      await post("/sync/run-now", role, { confirm: true }).expect(201);
    });
    it("POST /sync/run-now bez confirm → 400 (admin) — PLK-02 brana", async () => {
      await post("/sync/run-now", "admin", {}).expect(400);
    });
    it("POST /sync/run-now confirm:false → 400 (admin) — PLK-02 brana", async () => {
      await post("/sync/run-now", "admin", { confirm: false }).expect(400);
    });
    // B1 loc-most: feed-run nosi isti PLK-02 confirm gate (pomera watermark).
    it.each(ADMIN_ROLES)("POST /sync/feed-run → 201 za %s", async (role) => {
      await post("/sync/feed-run", role, { confirm: true }).expect(201);
    });
    it("POST /sync/feed-run bez confirm → 400 (admin) — PLK-02 brana", async () => {
      await post("/sync/feed-run", "admin", {}).expect(400);
    });
    it.each(NOT_ADMIN)("POST /sync/feed-run → 403 za %s", async (role) => {
      await post("/sync/feed-run", role, { confirm: true }).expect(403);
    });

    it.each(NOT_ADMIN)(
      "POST /sync/run-now → 403 za %s (guard pre validacije)",
      async (role) => {
        await post("/sync/run-now", role, {}).expect(403);
      },
    );
  });

  describe("POST /labels/print — lokacije.labels (1.0 canPrintLocLabels)", () => {
    it.each(LABELS_ROLES)("→ 201 za %s", async (role) => {
      await post("/labels/print", role, LABEL_BODY).expect(201);
    });
    it.each(NOT_LABELS)("→ 403 za %s", async (role) => {
      await post("/labels/print", role, LABEL_BODY).expect(403);
    });
  });
});
