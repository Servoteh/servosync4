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
import { PodesavanjaController } from "../src/modules/podesavanja/podesavanja.controller";
import { PodesavanjaService } from "../src/modules/podesavanja/podesavanja.service";
import { PodesavanjaUsersService } from "../src/modules/podesavanja/podesavanja-users.service";
import { ALL_ROLE_KEYS } from "../src/common/authz/roles";
import { roleHasPermission } from "../src/common/authz/role-permissions";
import { PERMISSIONS } from "../src/common/authz/permissions";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * e2e PERMISSION MATRICA — Podešavanja WRITE sloj (D1 dvostrano upravljanje nalozima), rola ×
 * endpoint × 200/403 sa AUTHZ_ENFORCE=true (MODULE_SPEC §5 t.43). DOKAZ: SAMO `settings.users`
 * (=admin) sme da poziva invite/edit/reset/deactivate/activate/must-change/delete; sve ostale
 * uloge → 403. JwtAuthGuard je stub (identitet iz `x-test-role`); servis je mokovan (bez sy15/2.0).
 * Guard (403) presuđuje PRE ValidationPipe-a → non-admin dobija 403 i bez validnog tela.
 */
describe("Podešavanja WRITE permisije (e2e, AUTHZ_ENFORCE=true)", () => {
  let app: INestApplication;
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const usersMock = {
    invite: jest.fn().mockResolvedValue({ data: { ok: true } }),
    update: jest.fn().mockResolvedValue({ data: { ok: true } }),
    resetPassword: jest.fn().mockResolvedValue({ data: { ok: true } }),
    deactivate: jest.fn().mockResolvedValue({ data: { ok: true } }),
    activate: jest.fn().mockResolvedValue({ data: { ok: true } }),
    setMustChangePassword: jest.fn().mockResolvedValue({ data: { ok: true } }),
    softDelete: jest.fn().mockResolvedValue({ data: { ok: true } }),
  };

  beforeAll(async () => {
    process.env.AUTHZ_ENFORCE = "true";
    const moduleRef = await Test.createTestingModule({
      controllers: [PodesavanjaController],
      providers: [
        { provide: PrismaService, useValue: { userPermissionOverride: { findUnique: async () => null } } },
        
        { provide: PodesavanjaService, useValue: {} },
        { provide: PodesavanjaUsersService, useValue: usersMock },
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

  const USERS_ROLES = ALL_ROLE_KEYS.filter((r) =>
    roleHasPermission(r, PERMISSIONS.SETTINGS_USERS),
  );
  const USERS_NO = ALL_ROLE_KEYS.filter(
    (r) => !roleHasPermission(r, PERMISSIONS.SETTINGS_USERS),
  );

  // Svaki write endpoint sa VALIDNIM telom (za 200 admin grana).
  const endpoints: Array<{
    name: string;
    call: (role?: string) => request.Test;
  }> = [
    {
      name: "POST /admin/users/invite",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .post("/api/v1/admin/users/invite")
            .send({ email: "x@servoteh.com", role: "viewer" }),
          role,
        ),
    },
    {
      name: "PATCH /admin/users/:id",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .patch(`/api/v1/admin/users/${UUID}`)
            .send({ fullName: "Ime" }),
          role,
        ),
    },
    {
      name: "POST /admin/users/:id/reset-password",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .post(`/api/v1/admin/users/${UUID}/reset-password`)
            .send({}),
          role,
        ),
    },
    {
      name: "POST /admin/users/:id/deactivate",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .post(`/api/v1/admin/users/${UUID}/deactivate`)
            .send({}),
          role,
        ),
    },
    {
      name: "POST /admin/users/:id/activate",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .post(`/api/v1/admin/users/${UUID}/activate`)
            .send({}),
          role,
        ),
    },
    {
      name: "POST /admin/users/:id/must-change-password",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .post(`/api/v1/admin/users/${UUID}/must-change-password`)
            .send({ value: true }),
          role,
        ),
    },
    {
      name: "DELETE /admin/users/:id",
      call: (role) =>
        set(
          request(app.getHttpServer())
            .delete(`/api/v1/admin/users/${UUID}`)
            .send({ confirmEmail: "x@servoteh.com" }),
          role,
        ),
    },
  ];

  function set(r: request.Test, role?: string): request.Test {
    return role ? r.set("x-test-role", role) : r;
  }

  it("settings.users = SAMO admin", () => {
    expect(USERS_ROLES).toEqual(["admin"]);
  });

  for (const ep of endpoints) {
    describe(ep.name, () => {
      it.each(USERS_ROLES)("→ 2xx za %s (settings.users)", async (role) => {
        const res = await ep.call(role);
        expect([200, 201]).toContain(res.status);
      });
      it.each(USERS_NO)("→ 403 za %s", async (role) => {
        await ep.call(role).expect(403);
      });
      it("bez identiteta → 403", async () => {
        await ep.call().expect(403);
      });
    });
  }
});
