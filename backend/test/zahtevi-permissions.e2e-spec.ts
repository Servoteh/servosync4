import "reflect-metadata";
import {
  ExecutionContext,
  ValidationPipe,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { PERMISSION_KEY_METADATA } from "../src/common/authz/require-permission.decorator";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";
import { ZahteviController } from "../src/modules/zahtevi/zahtevi.controller";
import { ZahteviService } from "../src/modules/zahtevi/zahtevi.service";
import { ZahteviAiService } from "../src/modules/zahtevi/zahtevi-ai.service";
import { ZahteviRewardsService } from "../src/modules/zahtevi/zahtevi-rewards.service";
import { ZahteviDecisionsService } from "../src/modules/zahtevi/zahtevi-decisions.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PrismaService } from "../src/prisma/prisma.service";
import {
  PERMISSIONS,
  type PermissionKey,
} from "../src/common/authz/permissions";

/**
 * e2e PERMISSION MATRICA — Zahtevi, PROVERA ISPORUKE OD PODNOSIOCA (03.08.2026).
 * Rola × endpoint × 200/403 sa AUTHZ_ENFORCE=true. JwtAuthGuard je stub (identitet iz
 * `x-test-role`); ZahteviService i sateliti su mokovani (bez baze).
 *
 * ŠTA SE OVDE DOKAZUJE (i zašto modul do sada nije imao ovaj spec):
 *
 *  1. `POST :id/confirm` i `POST :id/reopen` traže `zahtevi.write` — NE `zahtevi.admin`.
 *     To je cela poenta: isporuku testira OBIČAN korisnik. Da su admin-gated, feature
 *     ne bi postojao (korisnik bi i dalje mogao samo da napiše komentar „RADI").
 *
 *  2. ASIMETRIJA: `POST :id/status` (proizvoljan realizacioni prelaz) OSTAJE admin-only.
 *     Korisnik sme da presudi SAMO o svojoj isporuci (radi / ne radi), ne da gura zahtev
 *     kroz status mašinu. Bez ove razlike bi `write` postao tihi admin.
 *
 *  3. VLASNIŠTVO NIJE GUARD, nego SERVIS. Guard propušta svakog nosioca `write`; da li je
 *     pozivalac podnosilac (ili admin) presuđuje `ZahteviService` kroz prosleđen `AuthUser`
 *     (row-scope + `assertSubmitterOrAdmin`). Zato ovde dokazujemo da kontroler stvarno
 *     PROSLEĐUJE identitet servisu — bez toga bi servisna provera bila slepa.
 *
 * Napomena o skupovima: `zahtevi.write` ima SVAKA SSO rola (role-permissions: petlja nad
 * ROLE_PERMISSIONS), pa je „rola bez write-a" prazan skup. To NIJE propust testa nego
 * svesna politika modula (§2: svako sme da podnese zahtev) — i eksplicitno je tvrdimo,
 * da bi test pao ako neko ikad suzi dodelu i tiho zaključa potvrdu korisnicima.
 */
describe("Zahtevi permission matrica — potvrda isporuke (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;

  /** Poslednji `AuthUser` koji je servis dobio — dokaz da kontroler prosleđuje identitet. */
  let lastActor: unknown = null;

  const zahteviMock: Record<string, jest.Mock> = {};
  for (const m of [
    "list",
    "inboxMeta",
    "podnosioci",
    "slicni",
    "create",
    "getDetail",
    "update",
    "remove",
    "submit",
    "withdraw",
    "confirmDelivery",
    "reopenDelivery",
    "addAttachments",
    "getAttachmentUrl",
    "removeAttachment",
    "transcribeAttachment",
    "addComment",
    "decision",
    "setStatus",
    "returnForInfo",
  ]) {
    zahteviMock[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
  }
  // confirm/reopen dodatno beleže aktera (poslednji argument servisnog poziva).
  for (const m of ["confirmDelivery", "reopenDelivery"]) {
    zahteviMock[m] = jest.fn().mockImplementation((...args: unknown[]) => {
      lastActor = args[args.length - 1];
      return Promise.resolve({ data: { ok: true } });
    });
  }

  const simpleMock = (methods: string[]): Record<string, jest.Mock> => {
    const out: Record<string, jest.Mock> = {};
    for (const m of methods)
      out[m] = jest.fn().mockResolvedValue({ data: { ok: true } });
    return out;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-not-real-secret";
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [ZahteviController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            userPermissionOverride: { findUnique: () => Promise.resolve(null) },
          },
        },
        { provide: ZahteviService, useValue: zahteviMock },
        {
          provide: ZahteviAiService,
          useValue: simpleMock([
            "retriage",
            "approveAnalysis",
            "patchAnalysis",
            "restore",
          ]),
        },
        {
          provide: ZahteviRewardsService,
          useValue: simpleMock([
            "getTariffs",
            "putTariffs",
            "payoutReport",
            "closeMonth",
            "score",
            "exclude",
          ]),
        },
        {
          provide: ZahteviDecisionsService,
          useValue: simpleMock([
            "list",
            "create",
            "getOne",
            "update",
            "supersede",
          ]),
        },
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
            userId: Number(req.headers["x-test-user"] ?? 42),
            email: "test@servoteh.com",
            role,
            workerId: null,
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

  beforeEach(() => {
    lastActor = null;
    jest.clearAllMocks();
  });

  const post = (path: string, role: string, body?: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/zahtevi${path}`)
      .set("x-test-role", role)
      .send(body ?? {});

  const rolesWith = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => roleHasPermission(r, perm));
  const rolesWithout = (perm: PermissionKey) =>
    ALL_ROLE_KEYS.filter((r) => !roleHasPermission(r, perm));

  const WRITE_ROLES = rolesWith(PERMISSIONS.ZAHTEVI_WRITE);
  const NO_WRITE = rolesWithout(PERMISSIONS.ZAHTEVI_WRITE);
  const ADMIN_ROLES = rolesWith(PERMISSIONS.ZAHTEVI_ADMIN);
  /** Nosioci write-a BEZ admina — ljudi zbog kojih ovaj feature i postoji. */
  const WRITE_NOT_ADMIN = WRITE_ROLES.filter(
    (r) => !roleHasPermission(r, PERMISSIONS.ZAHTEVI_ADMIN),
  );

  const ID = 10;

  // ═══════════════════════════════════════════════ politika dodele (osigurač)
  describe("politika dodele — ko uopšte sme u modul Zahtevi", () => {
    it("SVE operativne SSO role imaju zahtevi.write (§2 — svako sme da podnese/potvrdi)", () => {
      // Ako ovo padne, potvrda isporuke je nekome tiho zaključana — a upravo su
      // ovi ljudi (radnik, monter, magacioner…) ti koji testiraju isporuku.
      for (const role of [
        "proizvodni_radnik",
        "monter",
        "magacioner",
        "cnc_operater",
        "tehnolog",
        "kontrolor",
        "sef",
        "menadzment",
        "viewer",
      ])
        expect(WRITE_ROLES).toContain(role);
    });

    it("bez write-a su SAMO 4.0/servisne role (pinovano — dodela se ne menja slučajno)", () => {
      // nabavka/kvalitet/prodaja/finansije = 4.0 ERP role, `user` = generički ključ;
      // nijedna nije u petlji koja deli zahtevi.read+write nad ROLE_PERMISSIONS.
      expect([...NO_WRITE].sort()).toEqual([
        "finansije",
        "kvalitet",
        "nabavka",
        "prodaja",
        "user",
      ]);
    });

    it("`zahtevi.admin` je UŽI od write-a — drži ga samo `admin`", () => {
      expect(ADMIN_ROLES).toEqual(["admin"]);
      expect(WRITE_NOT_ADMIN.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════ metapodaci ruta (reflection)
  describe("metapodaci: confirm/reopen su write-rute, status ostaje admin-ruta", () => {
    // `Reflect.getMetadata` je tipiziran kao `any` — sužavamo na string|undefined
    // odmah, da asertacije ispod budu stvarno tipizovane (i lint čist).
    const permOf = (method: keyof ZahteviController): string | undefined =>
      Reflect.getMetadata(
        PERMISSION_KEY_METADATA,
        ZahteviController.prototype[method],
      ) as string | undefined;

    it("POST :id/confirm traži zahtevi.write (NE admin)", () => {
      expect(permOf("confirmDelivery")).toBe(PERMISSIONS.ZAHTEVI_WRITE);
    });
    it("POST :id/reopen traži zahtevi.write (NE admin)", () => {
      expect(permOf("reopenDelivery")).toBe(PERMISSIONS.ZAHTEVI_WRITE);
    });
    it("POST :id/status i dalje traži zahtevi.admin (asimetrija je namerna)", () => {
      expect(permOf("setStatus")).toBe(PERMISSIONS.ZAHTEVI_ADMIN);
    });
  });

  // ═══════════════════════════════════════════════ CONFIRM
  describe("POST :id/confirm — zahtevi.write", () => {
    it.each(WRITE_ROLES)(
      "201 za %s (obična rola SME da potvrdi)",
      async (role) => {
        await post(`/${ID}/confirm`, role, {}).expect(201);
      },
    );

    it.each(WRITE_ROLES)("201 za %s i uz propratni komentar", async (role) => {
      await post(`/${ID}/confirm`, role, { comment: "Radi." }).expect(201);
    });

    it.each(NO_WRITE)("403 za %s (nema zahtevi.write)", async (role) => {
      await post(`/${ID}/confirm`, role, {}).expect(403);
      expect(zahteviMock.confirmDelivery).not.toHaveBeenCalled();
    });

    it("bez identiteta → 403", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/zahtevi/${ID}/confirm`)
        .send({})
        .expect(403);
    });

    it("kontroler PROSLEĐUJE AuthUser servisu (vlasništvo presuđuje servis)", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/zahtevi/${ID}/confirm`)
        .set("x-test-role", "proizvodni_radnik")
        .set("x-test-user", "77")
        .send({})
        .expect(201);
      expect(lastActor).toMatchObject({
        userId: 77,
        role: "proizvodni_radnik",
      });
      expect(zahteviMock.confirmDelivery).toHaveBeenCalledTimes(1);
    });
  });

  // ═══════════════════════════════════════════════ REOPEN
  describe("POST :id/reopen — zahtevi.write", () => {
    it.each(WRITE_ROLES)("201 za %s uz obavezan komentar", async (role) => {
      await post(`/${ID}/reopen`, role, { comment: "Ne radi." }).expect(201);
    });

    it.each(NO_WRITE)("403 za %s (nema zahtevi.write)", async (role) => {
      await post(`/${ID}/reopen`, role, { comment: "ne radi" }).expect(403);
      expect(zahteviMock.reopenDelivery).not.toHaveBeenCalled();
    });

    it("bez identiteta → 403", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/zahtevi/${ID}/reopen`)
        .send({ comment: "x" })
        .expect(403);
    });

    it("kontroler PROSLEĐUJE AuthUser servisu", async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/zahtevi/${ID}/reopen`)
        .set("x-test-role", "monter")
        .set("x-test-user", "88")
        .send({ comment: "ne radi" })
        .expect(201);
      expect(lastActor).toMatchObject({ userId: 88, role: "monter" });
    });
  });

  // ═══════════════════════════════════════════════ ASIMETRIJA (jezgro odluke)
  describe("Asimetrija: korisnik potvrđuje isporuku, ali NE vozi status mašinu", () => {
    it.each(WRITE_NOT_ADMIN)(
      "%s: confirm 201 i reopen 201, ALI POST :id/status 403",
      async (role) => {
        await post(`/${ID}/confirm`, role, {}).expect(201);
        await post(`/${ID}/reopen`, role, { comment: "ne radi" }).expect(201);
        await post(`/${ID}/status`, role, { action: "done" }).expect(403);
      },
    );

    it.each(WRITE_NOT_ADMIN)(
      "%s: ni decision ni return-for-info (403)",
      async (role) => {
        await post(`/${ID}/decision`, role, { action: "approve" }).expect(403);
        await post(`/${ID}/return-for-info`, role, { questions: ["a"] }).expect(
          403,
        );
      },
    );

    it.each(ADMIN_ROLES)(
      "%s (admin): i confirm i status prolaze",
      async (role) => {
        await post(`/${ID}/confirm`, role, {}).expect(201);
        await post(`/${ID}/status`, role, { action: "done" }).expect(201);
      },
    );
  });

  // ═══════════════════════════════════════════════ ParseIntPipe (guard PRE pipe)
  describe("Param validacija — :id ParseIntPipe", () => {
    it("POST /nije-broj/confirm → 400 za nosioca write-a", async () => {
      await post("/nije-broj/confirm", "admin", {}).expect(400);
    });
    it("POST /nije-broj/reopen → 400 za nosioca write-a", async () => {
      await post("/nije-broj/reopen", "admin", { comment: "x" }).expect(400);
    });
    it("bez identiteta na ne-broj param → 403 (guard prethodi ParseInt)", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/zahtevi/nije-broj/confirm")
        .send({})
        .expect(403);
    });
  });
});
