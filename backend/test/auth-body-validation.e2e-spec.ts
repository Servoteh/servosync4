import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { App } from "supertest/types";
import { AuthController } from "./../src/modules/auth/auth.controller";
import { AuthService } from "./../src/modules/auth/auth.service";
import { JwtAuthGuard } from "./../src/modules/auth/jwt-auth.guard";
import { PrismaService } from "./../src/prisma/prisma.service";
import { Sy15Service } from "./../src/common/sy15/sy15.service";
import { __resetLoginThrottle } from "./../src/common/login-throttle";

/**
 * TELO AUTH RUTA MORA BITI VALIDIRANO (P12, 06.08.2026).
 *
 * ═══ ZAŠTO OVAJ TEST POSTOJI ═════════════════════════════════════════════════════════
 * `LoginBody`, `SsoBody` i `ChangePasswordBody` su bili INTERFEJSI. Interfejs u runtime-u
 * ne postoji, pa `design:paramtypes` nosi `Object` — a `Object` globalni `ValidationPipe`
 * PRESKAČE u celosti. Posledica: telo najosetljivijih ruta u sistemu (prijava, SSO,
 * promena lozinke — sve spolja dostupne) stizalo je do servisa NEVALIDIRANO i bez
 * `whitelist`-a. `{"email": {...}, "password": "x"}` je tako ulazio do
 * `AuthService.validate`, gde `email.toLowerCase()` puca → 500 umesto 400.
 *
 * ⚠️ Ovo je BLAŽI blizanac kvara od 05.08. (vidi `src/common/controller-body-dto.spec.ts`):
 * DTO klasa uvezena kao `import type` daje `Function`, pa pipe telo UNIŠTI. Interfejs
 * daje `Object`, pa pipe telo PROPUSTI. Oba se leče isto — klasa + VREDNOSNI uvoz.
 *
 * Test vozi ISTU konfiguraciju pipe-a kao `main.ts` (`transform: true, whitelist: true`)
 * i isti globalni prefiks/versioning, pa meri stvarno produkcijsko ponašanje ruta.
 */

/** Telo koje danas ne bi smelo da prođe dalje od pipe-a. */
const VALIDNA_LOZINKA = "tajna123";

describe("Auth telo — validacija (e2e)", () => {
  let app: INestApplication<App>;

  const authMock = {
    login: jest.fn(),
    ssoLogin: jest.fn(),
    changePassword: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    me: jest.fn(),
  };
  const prismaMock = {
    userPermissionOverride: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sy15Mock = { withUserRls: jest.fn().mockResolvedValue([]) };

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetLoginThrottle();
    authMock.login.mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      user: { id: 1, email: "ko@servoteh.com", role: "viewer" },
    });
    authMock.ssoLogin.mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      user: { id: 1, email: "ko@servoteh.com", role: "viewer" },
    });
    authMock.changePassword.mockResolvedValue({
      changed: true,
      sy15Synced: false,
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authMock },
        { provide: PrismaService, useValue: prismaMock },
        { provide: Sy15Service, useValue: sy15Mock },
      ],
    })
      // /auth/change-password je iza JwtAuthGuard-a; ovde merimo VALIDACIJU TELA,
      // ne autentikaciju, pa guard propuštamo sa fiksnim korisnikom.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: {
          switchToHttp: () => { getRequest: () => Record<string, unknown> };
        }) => {
          ctx.switchToHttp().getRequest().user = {
            userId: 1,
            email: "ko@servoteh.com",
            role: "viewer",
          };
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix("api");
    // ISTA konfiguracija kao main.ts — inače test ne bi merio produkcijsko ponašanje.
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/auth/login", () => {
    it("ispravno telo i dalje prolazi do servisa (regresiona brana za prijavu)", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ email: "ko@servoteh.com", password: VALIDNA_LOZINKA })
        .expect(201);
      expect(authMock.login).toHaveBeenCalledWith(
        "ko@servoteh.com",
        VALIDNA_LOZINKA,
        expect.anything(),
      );
    });

    it("e-pošta sa razmacima oko sebe se trimuje, ne odbija (mobilne tastature)", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ email: "  ko@servoteh.com  ", password: VALIDNA_LOZINKA })
        .expect(201);
      expect(authMock.login).toHaveBeenCalledWith(
        "ko@servoteh.com",
        VALIDNA_LOZINKA,
        expect.anything(),
      );
    });

    it("objekat umesto e-pošte je 400, ne 500 i ne dolazi do servisa", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ email: { neko: "polje" }, password: VALIDNA_LOZINKA });
      expect(res.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
    });

    it("broj umesto lozinke je 400 i ne dolazi do servisa", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ email: "ko@servoteh.com", password: 12345 });
      expect(res.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
    });

    it("e-pošta pogrešnog oblika je 400 (poruka srpska, bez odavanja postoji li nalog)", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({ email: "nije-eposta", password: VALIDNA_LOZINKA });
      expect(res.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
      const poruka = JSON.stringify(res.body);
      expect(poruka).toMatch(/oblik/i);
      // ⚠️ Ne sme odati da li nalog postoji (zahtev: „ne otkrivaj više nego što treba").
      expect(poruka).not.toMatch(/ne postoji|nepoznat nalog|nije registrovan/i);
    });

    it("nepoznato polje se odbacuje (whitelist) i ne stiže do servisa", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({
          email: "ko@servoteh.com",
          password: VALIDNA_LOZINKA,
          role: "admin",
        })
        .expect(201);
      // Kontroler prosleđuje polje-po-polje, pa se „role" ni ne vidi — ali telo je
      // sada klasa, pa ga pipe odbaci i pre toga. Vidi auth.dto.spec.ts za direktnu meru.
      expect(authMock.login).toHaveBeenCalledWith(
        "ko@servoteh.com",
        VALIDNA_LOZINKA,
        expect.anything(),
      );
    });

    it("prazno telo je 400 (nedostaju oba polja)", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/login")
        .send({});
      expect(res.status).toBe(400);
      expect(authMock.login).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/sso", () => {
    it("ispravan token prolazi do servisa", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/sso")
        .send({ token: "eyJhbGciOiJIUzI1NiJ9.e30.sig" })
        .expect(201);
      expect(authMock.ssoLogin).toHaveBeenCalled();
    });

    it("broj umesto tokena je 400 i ne dolazi do servisa", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/sso")
        .send({ token: 42 });
      expect(res.status).toBe(400);
      expect(authMock.ssoLogin).not.toHaveBeenCalled();
    });

    it("prazan token je 400", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/sso")
        .send({ token: "" });
      expect(res.status).toBe(400);
      expect(authMock.ssoLogin).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/auth/change-password", () => {
    it("ispravno telo prolazi do servisa", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/change-password")
        .send({ currentPassword: "staraLozinka", newPassword: "novaLozinka1" })
        .expect(201);
      expect(authMock.changePassword).toHaveBeenCalledWith(
        1,
        "staraLozinka",
        "novaLozinka1",
      );
    });

    it("kratka TRENUTNA lozinka prolazi (pravilo od 8 znakova važi samo za novu)", async () => {
      await request(app.getHttpServer())
        .post("/api/auth/change-password")
        .send({ currentPassword: "kratka", newPassword: "novaLozinka1" })
        .expect(201);
      expect(authMock.changePassword).toHaveBeenCalledWith(
        1,
        "kratka",
        "novaLozinka1",
      );
    });

    it("kratka NOVA lozinka je 400 sa srpskom porukom, bez dolaska do servisa", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/change-password")
        .send({ currentPassword: "staraLozinka", newPassword: "kratka" });
      expect(res.status).toBe(400);
      expect(authMock.changePassword).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).toMatch(/najmanje 8/i);
    });

    it("objekat umesto lozinke je 400, ne 500", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/auth/change-password")
        .send({ currentPassword: { $ne: null }, newPassword: "novaLozinka1" });
      expect(res.status).toBe(400);
      expect(authMock.changePassword).not.toHaveBeenCalled();
    });
  });
});
