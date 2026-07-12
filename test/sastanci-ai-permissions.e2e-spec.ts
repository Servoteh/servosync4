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
import { MediaAiController } from "../src/modules/media-ai/media-ai.controller";
import { MediaAiService } from "../src/modules/media-ai/media-ai.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

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
    // R2.2 storage
    "uploadArhivaPdf",
    "getArhivaPdfUrl",
    "uploadSlika",
    "updateSlika",
    "deleteSlika",
    "getSlikaUrl",
    // R2.3 AI rezime
    "aiSummary",
  ]) {
    sastanciMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  const aiMock: Record<string, jest.Mock> = {};
  for (const m of [
    "conversations",
    "messages",
    "me",
    "limit",
    // R2.3 mutacije
    "chat",
    "deleteConversation",
    "signImage",
    "projects",
  ]) {
    aiMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  const mediaMock: Record<string, jest.Mock> = {
    transcribe: jest.fn().mockResolvedValue({ data: { ok: true } }),
    refine: jest.fn().mockResolvedValue({ data: { ok: true } }),
  };

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true"; // pre instanciranja PermissionsGuard-a
    const moduleRef = await Test.createTestingModule({
      controllers: [SastanciController, AiChatController, MediaAiController],
      providers: [
        { provide: SastanciService, useValue: sastanciMock },
        { provide: AiChatService, useValue: aiMock },
        { provide: MediaAiService, useValue: mediaMock },
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

  // Test-hardening (bonus): liste se IZVODE iz ALL_ROLE_KEYS umesto ručno → svaka
  // uloga iz kataloga dobija 200/403 assertion (nova/pogrešno-grantovana uloga se
  // NE može provući). Tačnost skupova (koja rola sme šta) pinuje unit
  // `role-permissions.sastanci-ai.spec` (kompletnost nad ALL_ROLE_KEYS).
  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const SASTANCI_READ_ROLES = rolesWith(PERMISSIONS.SASTANCI_READ);
  const SASTANCI_NO_READ = rolesWithout(PERMISSIONS.SASTANCI_READ);
  const AI_ROLES = rolesWith(PERMISSIONS.AI_CHAT);
  const AI_DENIED = rolesWithout(PERMISSIONS.AI_CHAT);

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
    it.each(AI_DENIED)(
      "GET /ai/conversations → 403 za %s (nema ai.chat)",
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

  // Izvedeno iz ALL_ROLE_KEYS (test-hardening): svaka uloga pokrivena; skupove
  // pinuje unit spec. NO_* je puni komplement, uklj. i katalog-role bez modula
  // (tehnicar_odrzavanja/nabavka/…) — pogrešan budući grant obara test.
  const EDIT_ROLES = rolesWith(PERMISSIONS.SASTANCI_EDIT);
  const NO_EDIT_ROLES = rolesWithout(PERMISSIONS.SASTANCI_EDIT);
  const MANAGE_ROLES = rolesWith(PERMISSIONS.SASTANCI_MANAGE);
  const NO_MANAGE_ROLES = rolesWithout(PERMISSIONS.SASTANCI_MANAGE);
  const WEEKLY_ROLES = rolesWith(PERMISSIONS.SASTANCI_WEEKLY_MOVE);
  const NO_WEEKLY_ROLES = rolesWithout(PERMISSIONS.SASTANCI_WEEKLY_MOVE);

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
    // Boundary (review bonus): remind-unprepared + resend-locked su TAKOĐE manage.
    it.each(MANAGE_ROLES)(
      "POST /:id/remind-unprepared + /resend-locked → 201 za %s",
      async (role) => {
        await send(
          "post",
          `/sastanci/${VALID_UUID}/remind-unprepared`,
          role,
        ).expect(201);
        await send(
          "post",
          `/sastanci/${VALID_UUID}/resend-locked`,
          role,
        ).expect(201);
      },
    );
    it.each(NO_MANAGE_ROLES)(
      "POST /:id/remind-unprepared + /resend-locked → 403 za %s",
      async (role) => {
        await send(
          "post",
          `/sastanci/${VALID_UUID}/remind-unprepared`,
          role,
        ).expect(403);
        await send(
          "post",
          `/sastanci/${VALID_UUID}/resend-locked`,
          role,
        ).expect(403);
      },
    );
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
    it.each(WEEKLY_ROLES)(
      "POST /weekly/pomeri·odlozi·vrati → 201 za %s",
      async (role) => {
        await send("post", "/sastanci/weekly/pomeri", role, {
          datum: "2026-07-20",
        }).expect(201);
        // Boundary (review bonus): odlozi + vrati su TAKOĐE weekly_move.
        await send("post", "/sastanci/weekly/odlozi", role, {}).expect(201);
        await send("post", "/sastanci/weekly/vrati", role, {}).expect(201);
      },
    );
    it.each(NO_WEEKLY_ROLES)(
      "POST /weekly/pomeri·odlozi·vrati → 403 za %s",
      async (role) => {
        await send("post", "/sastanci/weekly/pomeri", role, {
          datum: "2026-07-20",
        }).expect(403);
        await send("post", "/sastanci/weekly/odlozi", role, {}).expect(403);
        await send("post", "/sastanci/weekly/vrati", role, {}).expect(403);
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

  describe("R2.3 AI chat mutacije — ai.chat (/ai za sve aktivne uloge)", () => {
    it.each(["admin", "monter", "magacioner", "viewer"])(
      "POST /ai/chat → 201 za %s",
      async (role) => {
        await send("post", "/ai/chat", role, { message: "zdravo" }).expect(201);
      },
    );
    it.each(["nepoznata_rola", "user"])(
      "POST /ai/chat → 403 za %s (default deny)",
      async (role) => {
        await send("post", "/ai/chat", role, { message: "x" }).expect(403);
      },
    );
    it("DELETE /ai/conversations/:id → 200 za monter (ai.chat), 400 ne-uuid", async () => {
      await send("delete", `/ai/conversations/${VALID_UUID}`, "monter").expect(
        200,
      );
      await send("delete", "/ai/conversations/nije-uuid", "monter").expect(400);
    });
    it("GET /ai/projects → 200 za tehnolog; GET /ai/images/sign → 200 za pm", async () => {
      await get("/ai/projects", "tehnolog").expect(200);
      await get("/ai/images/sign?path=abc/x.jpg", "pm").expect(200);
    });
    it("POST /ai/chat: engine van allowliste → 400 (admin)", async () => {
      await send("post", "/ai/chat", "admin", {
        message: "x",
        engine: "grok",
      }).expect(400);
    });
  });

  describe("R2.4 Media/AI — /ai/stt + /ai/refine (ai.chat, presuda B4)", () => {
    it.each(["admin", "monter", "magacioner", "viewer"])(
      "POST /ai/refine → 201 za %s",
      async (role) => {
        await send("post", "/ai/refine", role, { tekst: "sirov" }).expect(201);
      },
    );
    it.each(["nepoznata_rola", "user"])(
      "POST /ai/refine → 403 za %s (default deny)",
      async (role) => {
        await send("post", "/ai/refine", role, { tekst: "x" }).expect(403);
      },
    );
    it("POST /ai/refine: prazan tekst DTO nije (samo validacija tipa) → 201 (servis odlučuje)", async () => {
      await send("post", "/ai/refine", "admin", { tekst: "x" }).expect(201);
    });
    it("POST /ai/refine: profil van allowliste → 400", async () => {
      await send("post", "/ai/refine", "admin", {
        tekst: "x",
        profil: "nepostoji",
      }).expect(400);
    });
    it("POST /ai/stt → 201 za viewer (ai.chat)", async () => {
      await send("post", "/ai/stt", "viewer", {}).expect(201);
    });
    it("POST /ai/stt → 403 za nepoznata_rola", async () => {
      await send("post", "/ai/stt", "nepoznata_rola", {}).expect(403);
    });
  });

  describe("R2.3 AI rezime — /sastanci/:id/ai-summary (sastanci.read)", () => {
    it("POST /sastanci/:id/ai-summary → 201 viewer (read)", async () => {
      await send("post", `/sastanci/${VALID_UUID}/ai-summary`, "viewer", {
        sastanak: { naslov: "T" },
      }).expect(201);
    });
    it("POST /sastanci/:id/ai-summary → 403 magacioner (nema read)", async () => {
      await send("post", `/sastanci/${VALID_UUID}/ai-summary`, "magacioner", {
        sastanak: {},
      }).expect(403);
    });
    it("POST /sastanci/:id/ai-summary: bez `sastanak` → 400", async () => {
      await send(
        "post",
        `/sastanci/${VALID_UUID}/ai-summary`,
        "admin",
        {},
      ).expect(400);
    });
  });

  describe("R2.2 Storage — arhiva PDF / slike (edit vs read)", () => {
    it("GET /sastanci/:id/arhiva/pdf → 200 viewer (read-nivo)", async () => {
      await get(`/sastanci/${VALID_UUID}/arhiva/pdf`, "viewer").expect(200);
    });
    it("GET /sastanci/slike/:slikaId/sign → 200 viewer, 403 magacioner", async () => {
      await get(`/sastanci/slike/${VALID_UUID}/sign`, "viewer").expect(200);
      await get(`/sastanci/slike/${VALID_UUID}/sign`, "magacioner").expect(403);
    });
    it("POST /sastanci/:id/slike → 201 pm (edit), 403 viewer", async () => {
      await send("post", `/sastanci/${VALID_UUID}/slike`, "pm", {}).expect(201);
      await send("post", `/sastanci/${VALID_UUID}/slike`, "viewer", {}).expect(
        403,
      );
    });
    it("DELETE /sastanci/slike/:slikaId → 200 admin, 403 viewer", async () => {
      await send("delete", `/sastanci/slike/${VALID_UUID}`, "admin").expect(
        200,
      );
      await send("delete", `/sastanci/slike/${VALID_UUID}`, "viewer").expect(
        403,
      );
    });
    it("POST /sastanci/:id/arhiva/pdf → 403 viewer (edit-only)", async () => {
      await send("post", `/sastanci/${VALID_UUID}/arhiva/pdf`, "viewer").expect(
        403,
      );
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
