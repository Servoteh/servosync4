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
    // R2 mutacije
    "createSastanak",
    "updateSastanak",
    "deleteSastanak",
    "lock",
    "reopen",
    "sendInvites",
    "remindUnprepared",
    "resendLocked",
    "setMyRsvp",
    "bulkUcesnici",
    "addUcesnik",
    "updateUcesnik",
    "removeUcesnik",
    "markPrisutni",
    "createAktivnost",
    "updateAktivnost",
    "deleteAktivnost",
    "reorderAktivnosti",
    "seedFromTeme",
    "createOdluka",
    "updateOdluka",
    "deleteOdluka",
    "createAkcija",
    "patchAkcija",
    "deleteAkcija",
    "bulkStatus",
    "createTema",
    "updateTema",
    "deleteTema",
    "setTemaHitno",
    "setTemaRazmatranje",
    "setTemaAdminRang",
    "reorderRang",
    "dodeliTemu",
    "createDraftTema",
    "draftTeme",
    "draftReview",
    "draftUvedi",
    "createTemplate",
    "updateTemplate",
    "deleteTemplate",
    "instantiate",
    "updatePrefs",
    "weeklyPomeri",
    "weeklyOdlozi",
    "weeklyVrati",
    "setAiModel",
  ]) {
    sastanciMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
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
  const send = (
    method: "post" | "patch" | "delete" | "put",
    path: string,
    role?: string,
    body?: object,
  ) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (role) r.set("x-test-role", role);
    return body ? r.send(body) : r;
  };
  const CID = "3b241101-e2bb-4255-8caf-4136c566a962";

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
    "cnc_programer",
    "kontrolor",
    "magacioner",
    "proizvodni_radnik",
    "nabavka_view",
    "tim_lider",
    "monter",
    "cnc_operater",
    "poslovni_admin", // ima edit ali NE read
    // Presuda B6 (§7 P6): biro role nisu u canAccessSastanci — pin protiv regresije.
    "projektant_vodja",
    "inzenjer",
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

  describe("Query DTO validacija (nalaz 3g — nevalidan uuid/datum = 400, ne 500)", () => {
    it("GET /sastanci/akcije?sastanakId=nije-uuid → 400; validan uuid → 200", async () => {
      await get("/sastanci/akcije?sastanakId=nije-uuid", "admin").expect(400);
      await get(`/sastanci/akcije?sastanakId=${VALID_UUID}`, "admin").expect(
        200,
      );
    });
    it("GET /sastanci/akcije/weekly-diff: since nije ISO → 400; ISO → 200", async () => {
      await get(
        "/sastanci/akcije/weekly-diff?since=nije-datum",
        "admin",
      ).expect(400);
      await get(
        "/sastanci/akcije/weekly-diff?since=2026-07-01T00:00:00Z",
        "admin",
      ).expect(200);
    });
    it("GET /sastanci/teme?projekatId=nije-uuid → 400", async () => {
      await get("/sastanci/teme?projekatId=nije-uuid", "admin").expect(400);
    });
    it("GET /sastanci/notifications?sastanakId=nije-uuid → 400", async () => {
      await get("/sastanci/notifications?sastanakId=nije-uuid", "hr").expect(
        400,
      );
    });
    it("GET /sastanci?from=nije-datum → 400; from=2026-07-01 → 200", async () => {
      await get("/sastanci?from=nije-datum", "viewer").expect(400);
      await get("/sastanci?from=2026-07-01", "viewer").expect(200);
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

  // ==========================================================================
  // R2 MUTACIJE — rola × endpoint × 200/403 (AUTHZ_ENFORCE=true)
  // ==========================================================================

  // has_edit_role paritet (menija: read-role + poslovni_admin koji NEMA read).
  const EDIT_ROLES = [
    "admin",
    "menadzment",
    "hr",
    "pm",
    "leadpm",
    "poslovni_admin",
  ];
  const NO_EDIT_ROLES = [
    "viewer", // read ali NE edit
    "sef",
    "magacioner",
    "monter",
    "proizvodni_radnik",
    "tehnolog",
  ];
  const MANAGE_ROLES = ["admin", "menadzment"];
  const NO_MANAGE_ROLES = ["hr", "pm", "leadpm", "poslovni_admin", "viewer"];

  describe("Create sastanak — sastanci.edit", () => {
    const body = { clientEventId: CID, naslov: "T", datum: "2026-07-15" };
    it.each(EDIT_ROLES)("POST /sastanci → 201 za %s", async (role) => {
      await send("post", "/sastanci", role, body).expect(201);
    });
    it.each(NO_EDIT_ROLES)("POST /sastanci → 403 za %s", async (role) => {
      await send("post", "/sastanci", role, body).expect(403);
    });
  });

  describe("PATCH/DELETE sastanak — sastanci.edit", () => {
    it("PATCH /sastanci/:id → 200 leadpm, 403 viewer", async () => {
      await send("patch", `/sastanci/${VALID_UUID}`, "leadpm", {
        naslov: "x",
      }).expect(200);
      await send("patch", `/sastanci/${VALID_UUID}`, "viewer", {
        naslov: "x",
      }).expect(403);
    });
    it("DELETE /sastanci/:id → 200 admin, 403 sef", async () => {
      await send("delete", `/sastanci/${VALID_UUID}`, "admin").expect(200);
      await send("delete", `/sastanci/${VALID_UUID}`, "sef").expect(403);
    });
  });

  describe("Manage-akcije (invites/remind/resend/reopen) — sastanci.manage", () => {
    it.each(MANAGE_ROLES)(
      "POST /sastanci/:id/invites → 201 za %s",
      async (role) => {
        await send("post", `/sastanci/${VALID_UUID}/invites`, role).expect(201);
      },
    );
    it.each(NO_MANAGE_ROLES)(
      "POST /sastanci/:id/invites → 403 za %s (edit ali ne manage)",
      async (role) => {
        await send("post", `/sastanci/${VALID_UUID}/invites`, role).expect(403);
      },
    );
    it("POST /sastanci/:id/reopen → 200 menadzment, 403 hr", async () => {
      await send("post", `/sastanci/${VALID_UUID}/reopen`, "menadzment").expect(
        201,
      );
      await send("post", `/sastanci/${VALID_UUID}/reopen`, "hr").expect(403);
    });
  });

  describe("RSVP + prefs — read-nivo (svako svoje)", () => {
    it("POST /sastanci/:id/rsvp → 201 za viewer (read-role)", async () => {
      await send("post", `/sastanci/${VALID_UUID}/rsvp`, "viewer", {
        status: "dolazim",
      }).expect(201);
    });
    it("PATCH /sastanci/prefs → 200 za viewer", async () => {
      await send("patch", "/sastanci/prefs", "viewer", {
        onNewAkcija: false,
      }).expect(200);
    });
    it("POST /sastanci/:id/rsvp → 403 za magacioner (nema sastanci.read)", async () => {
      await send("post", `/sastanci/${VALID_UUID}/rsvp`, "magacioner", {
        status: "dolazim",
      }).expect(403);
    });
  });

  describe("Weekly move — sastanci.weekly_move (mgmt vidljivost; DB movers gate)", () => {
    it.each(["admin", "menadzment"])(
      "POST /sastanci/weekly/pomeri → 201 za %s",
      async (role) => {
        await send("post", "/sastanci/weekly/pomeri", role, {
          datum: "2026-07-20",
        }).expect(201);
      },
    );
    it.each(["hr", "pm", "leadpm", "viewer", "poslovni_admin"])(
      "POST /sastanci/weekly/pomeri → 403 za %s",
      async (role) => {
        await send("post", "/sastanci/weekly/pomeri", role, {
          datum: "2026-07-20",
        }).expect(403);
      },
    );
  });

  describe("AI model — sastanci.ai_model (SAMO admin)", () => {
    it("PUT /sastanci/ai-model → 200 za admin", async () => {
      await send("put", "/sastanci/ai-model", "admin", {
        model: "claude-opus-4-8",
      }).expect(200);
    });
    it.each(["menadzment", "hr", "pm", "leadpm", "viewer"])(
      "PUT /sastanci/ai-model → 403 za %s",
      async (role) => {
        await send("put", "/sastanci/ai-model", role, {
          model: "claude-opus-4-8",
        }).expect(403);
      },
    );
  });

  describe("DTO validacija mutacija (400 pre servisa)", () => {
    it("POST /sastanci bez clientEventId → 400 (admin)", async () => {
      await send("post", "/sastanci", "admin", {
        naslov: "T",
        datum: "2026-07-15",
      }).expect(400);
    });
    it("POST /sastanci: nevalidan datum → 400", async () => {
      await send("post", "/sastanci", "admin", {
        clientEventId: CID,
        naslov: "T",
        datum: "nije-datum",
      }).expect(400);
    });
    it("PUT /sastanci/ai-model: model van allowliste → 400 (admin)", async () => {
      await send("put", "/sastanci/ai-model", "admin", {
        model: "gpt-4o",
      }).expect(400);
    });
    it("POST /sastanci/akcije/bulk-status: prazan ids → 400", async () => {
      await send("post", "/sastanci/akcije/bulk-status", "admin", {
        ids: [],
        status: "zavrsen",
      }).expect(400);
    });
    it("POST /sastanci/:id/rsvp: nevalidan status → 400", async () => {
      await send("post", `/sastanci/${VALID_UUID}/rsvp`, "viewer", {
        status: "mozda",
      }).expect(400);
    });
  });

  describe("Route ordering (write) — literali ne bivaju uhvaćeni kao :id", () => {
    it("POST /sastanci/akcije NIJE :id/lock (201 admin, ne 400 uuid)", async () => {
      await send("post", "/sastanci/akcije", "admin", {
        clientEventId: CID,
        naslov: "A",
      }).expect(201);
    });
    it("PATCH /sastanci/prefs NIJE PATCH /:id (200, ne 400 uuid)", async () => {
      await send("patch", "/sastanci/prefs", "admin", {}).expect(200);
    });
    it("POST /sastanci/weekly/vrati NIJE :id (201 admin)", async () => {
      await send("post", "/sastanci/weekly/vrati", "admin", {}).expect(201);
    });
  });
});
