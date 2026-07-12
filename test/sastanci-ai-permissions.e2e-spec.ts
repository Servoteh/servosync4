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
import { SastanciController } from "../src/modules/sastanci/sastanci.controller";
import { SastanciService } from "../src/modules/sastanci/sastanci.service";
import { AiChatController } from "../src/modules/ai-chat/ai-chat.controller";
import { AiChatService } from "../src/modules/ai-chat/ai-chat.service";

/**
 * e2e PERMISSION MATRICA — Sastanci + AI (MODULE_SPEC_sastanci_ai_30.md §5 t.30),
 * rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true (realno ponašanje V2 aktivacije).
 * JwtAuthGuard je stub (identitet iz `x-test-role`); servisi su mokovani (bez sy15 baze).
 * Row-scope (učesnik/organizator-trio, pm_teme vidljivost, ai svoje-niti, zaključan=…)
 * sprovode DB RLS/DEFINER fn kroz GUC — to je R2 živi smoke, ne ovaj rola-sloj test.
 */
describe("Sastanci + AI permission matrica (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const VALID_UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const sastanciMock: Record<string, jest.Mock> = {};
  for (const m of [
    "list",
    "myMeetings",
    "nextWeekly",
    "search",
    "dashboardStats",
    "userDirectory",
    "weeklyStatus",
    "myPrefs",
    "notifications",
    "aiModel",
    "listAkcije",
    "akcijeWeeklyDiff",
    "akcijaIstorija",
    "listTeme",
    "listTemplates",
    "findTemplate",
    "listArhive",
    "findFull",
    "ucesnici",
    "aktivnosti",
    "slike",
    "odluke",
    "findArhiva",
    "findOne",
  ]) {
    sastanciMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }
  const aiMock: Record<string, jest.Mock> = {};
  for (const m of ["conversations", "messages", "me", "limit"]) {
    aiMock[m] = jest.fn().mockResolvedValue({ data: [] });
  }

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [SastanciController, AiChatController],
      providers: [
        { provide: SastanciService, useValue: sastanciMock },
        { provide: AiChatService, useValue: aiMock },
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

  const get = (path: string, role?: string) => {
    const r = request(app.getHttpServer()).get(`/api/v1${path}`);
    return role ? r.set("x-test-role", role) : r;
  };

  // Paritet 1.0 canAccessSastanci.
  const SASTANCI_READ_ROLES = [
    "admin",
    "menadzment",
    "hr",
    "pm",
    "leadpm",
    "viewer",
  ];
  const SASTANCI_NO_READ = [
    "sef",
    "tehnolog",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "nabavka_view",
    "tim_lider",
    "monter",
    "cnc_operater",
    "poslovni_admin", // ima edit ali NE read
  ];
  // 1.0 /ai za sve → sve aktivne uloge.
  const AI_ROLES = [
    "admin",
    "menadzment",
    "hr",
    "pm",
    "leadpm",
    "viewer",
    "sef",
    "tehnolog",
    "magacioner",
    "proizvodni_radnik",
    "tim_lider",
    "monter",
    "cnc_operater",
    "poslovni_admin",
    "nabavka_view",
  ];

  describe("Sastanci read — sastanci.read (canAccessSastanci paritet)", () => {
    it.each(SASTANCI_READ_ROLES)("GET /sastanci → 200 za %s", async (role) => {
      await get("/sastanci", role).expect(200);
    });
    it.each(SASTANCI_NO_READ)("GET /sastanci → 403 za %s", async (role) => {
      await get("/sastanci", role).expect(403);
    });
    it.each(["user", "nepoznata_rola"])(
      "GET /sastanci → 403 za %s (default deny)",
      async (role) => {
        await get("/sastanci", role).expect(403);
      },
    );
    it("bez identiteta → 403 (JwtAuthGuard stub)", async () => {
      await get("/sastanci").expect(403);
    });
  });

  describe("Sastanci route ordering (literali pre :id)", () => {
    it("GET /sastanci/user-directory → 200 (ne 400 od :id uuid-pipe) za admin", async () => {
      await get("/sastanci/user-directory", "admin").expect(200);
    });
    it("GET /sastanci/akcije → 200 za viewer (ne uhvaćeno kao :id)", async () => {
      await get("/sastanci/akcije", "viewer").expect(200);
    });
    it("GET /sastanci/dashboard-stats → 200 za hr", async () => {
      await get("/sastanci/dashboard-stats", "hr").expect(200);
    });
    it("GET /sastanci/weekly → 403 za magacioner (guard je read)", async () => {
      await get("/sastanci/weekly", "magacioner").expect(403);
    });
    it("GET /sastanci/:id → 200 za pm (uuid), 400 za ne-uuid", async () => {
      await get(`/sastanci/${VALID_UUID}`, "pm").expect(200);
      await get("/sastanci/nije-uuid", "pm").expect(400);
    });
  });

  describe("AI chat — ai.chat (1.0 /ai za sve)", () => {
    it.each(AI_ROLES)("GET /ai/conversations → 200 za %s", async (role) => {
      await get("/ai/conversations", role).expect(200);
    });
    it("GET /ai/me → 200 za monter, /ai/limit → 200 za proizvodni_radnik", async () => {
      await get("/ai/me", "monter").expect(200);
      await get("/ai/limit", "proizvodni_radnik").expect(200);
    });
    it.each(["nepoznata_rola", "user"])(
      "GET /ai/conversations → 403 za %s (default deny)",
      async (role) => {
        await get("/ai/conversations", role).expect(403);
      },
    );
    it("GET /ai/conversations/:id/messages → 200 uuid, 400 ne-uuid (magacioner ima ai.chat)", async () => {
      await get(
        `/ai/conversations/${VALID_UUID}/messages`,
        "magacioner",
      ).expect(200);
      await get("/ai/conversations/nije-uuid/messages", "magacioner").expect(
        400,
      );
    });
    it("bez identiteta → 403", async () => {
      await get("/ai/conversations").expect(403);
    });
  });
});
