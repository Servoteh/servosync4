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
import { ReversiController } from "../src/modules/reversi/reversi.controller";
import { ReversiService } from "../src/modules/reversi/reversi.service";

/**
 * e2e PERMISSION MATRICA — Reversi (MODULE_SPEC_reversi.md §8), rola × endpoint × 200/403.
 * Guard sloj se testira SA AUTHZ_ENFORCE=true (realno ponašanje V2 aktivacije);
 * JwtAuthGuard je zamenjen stubom koji identitet čita iz `x-test-role` header-a.
 * ReversiService je mokovan (bez sy15 baze) — row-scope („moji"/„tim" redovi) NIJE
 * ovde: njega sprovode DB funkcije, verifikovane smoke testom na živoj sy15 10.07.
 */
describe("Reversi permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const serviceMock: Record<string, jest.Mock> = {};
  for (const m of [
    "listDocuments",
    "findOneDocument",
    "listTools",
    "findOneTool",
    "inventoryTree",
    "listLedger",
    "reportMyIssued",
    "reportMyConsumed",
    "reportMyMachinesCutting",
    "reportTeamIssued",
    "reportWarehouse",
    "reportScrapped",
    "reportMachines",
    "issue",
    "confirmReturn",
    "cuttingIssue",
    "cuttingReturn",
    "stockDelta",
    "seedStock",
    "writeOff",
    "restore",
    "uploadSignaturePdf",
    "getSignaturePdfUrl",
    "lookupEmployees",
    "lookupBarcode",
    "bulkImportTools",
    "listCuttingTools",
    "createCuttingTool",
    "updateCuttingTool",
    "cuttingByMachine",
    "machineHeads",
  ]) {
    serviceMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [ReversiController],
      providers: [{ provide: ReversiService, useValue: serviceMock }],
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

  const get = (path: string, role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/reversi${path}`)
      .set("x-test-role", role);
  const post = (path: string, role: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/reversi${path}`)
      .set("x-test-role", role)
      .send(body);

  // Paritet žive politike: SELECT za sve prijavljene → sve aktivne uloge.
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
  ];
  const MANAGE_ROLES = ["admin", "menadzment", "pm", "leadpm", "magacioner"];
  const NOT_MANAGE = [
    "sef",
    "tehnolog",
    "cnc_programer",
    "kontrolor",
    "proizvodni_radnik",
    "nabavka_view",
    "viewer",
    "tim_lider",
  ];
  const TEAM_ROLES = ["admin", "menadzment", "sef", "tim_lider"];
  const NOT_TEAM = [
    "magacioner",
    "proizvodni_radnik",
    "viewer",
    "pm",
    "leadpm",
  ];

  describe("read endpoints — reversi.read", () => {
    it.each(ALL_READ_ROLES)("GET /documents → 200 za %s", async (role) => {
      await get("/documents", role).expect(200);
    });
    it.each(["user", "nepoznata_rola"])(
      "GET /documents → 403 za %s (default deny)",
      async (role) => {
        await get("/documents", role).expect(403);
      },
    );
    it("GET /reports/warehouse → 200 za viewer", async () => {
      await get("/reports/warehouse", "viewer").expect(200);
    });
    it("GET /lookups/barcode → 200 za magacioner (skener resolver = reversi.read)", async () => {
      await get("/lookups/barcode?code=ALAT-000057", "magacioner").expect(200);
    });
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/reversi/documents")
        .expect(403);
    });
  });

  describe("ledger — JEDINI ne-javni read (reversi.manage)", () => {
    it.each(MANAGE_ROLES)("GET /ledger → 200 za %s", async (role) => {
      await get("/ledger", role).expect(200);
    });
    it.each(NOT_MANAGE)("GET /ledger → 403 za %s", async (role) => {
      await get("/ledger", role).expect(403);
    });
  });

  describe("team-issued — reversi.team_read", () => {
    it.each(TEAM_ROLES)(
      "GET /reports/team-issued → 200 za %s",
      async (role) => {
        await get("/reports/team-issued", role).expect(200);
      },
    );
    it.each(NOT_TEAM)("GET /reports/team-issued → 403 za %s", async (role) => {
      await get("/reports/team-issued", role).expect(403);
    });
  });

  describe("mutacije — reversi.manage (rev_can_manage paritet)", () => {
    const issueBody = {
      clientEventId: VALID_UUID,
      payload: { docType: "TOOL" },
    };

    it.each(MANAGE_ROLES)("POST /issue → 201 za %s", async (role) => {
      await post("/issue", role, issueBody).expect(201);
    });
    it.each(NOT_MANAGE)("POST /issue → 403 za %s", async (role) => {
      await post("/issue", role, issueBody).expect(403);
    });
    it("POST /tools/:id/write-off → 403 za sef, 201 za magacioner", async () => {
      await post(`/tools/${VALID_UUID}/write-off`, "sef", {
        clientEventId: VALID_UUID,
      }).expect(403);
      await post(`/tools/${VALID_UUID}/write-off`, "magacioner", {
        clientEventId: VALID_UUID,
      }).expect(201);
    });
    it("POST /bulk-import/tools → 403 za viewer, 201 za magacioner", async () => {
      const body = { rows: [{ oznaka: "T1", naziv: "Test alat" }] };
      await post("/bulk-import/tools", "viewer", body).expect(403);
      await post("/bulk-import/tools", "magacioner", body).expect(201);
    });
    it("GET /cutting-tools → 200 za viewer (read); POST → 403 viewer, 201 magacioner", async () => {
      await get("/cutting-tools", "viewer").expect(200);
      const body = { oznaka: "RZN-1", naziv: "Glodalo" };
      await post("/cutting-tools", "viewer", body).expect(403);
      await post("/cutting-tools", "magacioner", body).expect(201);
    });
    it("POST /issue bez validnog clientEventId → 400 (ValidationPipe)", async () => {
      await post("/issue", "admin", {
        clientEventId: "nije-uuid",
        payload: {},
      }).expect(400);
    });
    it("POST /tools/:id/stock-delta sa delta=0 → 400", async () => {
      await post(`/tools/${VALID_UUID}/stock-delta`, "admin", {
        clientEventId: VALID_UUID,
        delta: 0,
        reason: "ADJUST",
      }).expect(400);
    });
  });
});
