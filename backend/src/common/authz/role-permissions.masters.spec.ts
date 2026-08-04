import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PERMISSIONS as P, type PermissionKey } from "./permissions";
import { roleHasPermission } from "./role-permissions";
import { ROLES, ALL_ROLE_KEYS } from "./roles";
import { PermissionsGuard } from "./permissions.guard";
import { PERMISSION_KEY_METADATA } from "./require-permission.decorator";
import { PrismaService } from "../../prisma/prisma.service";
import { ItemsController } from "../../modules/masters/items.controller";
import { MasterCustomersController } from "../../modules/masters/customers.controller";
import { assertItemWritesAllowed } from "../../modules/masters/items.write-policy";
import {
  CUSTOMERS_WRITE_OPEN,
  assertCustomerWriteAllowed,
} from "../../modules/masters/customers.service";

/**
 * `masters.write` — sopstveni ključ za UPIS matičnih podataka (artikli + komitenti).
 *
 * Nalaz adversarnog pregleda 28.07.2026 (VISOK): POST/PATCH `/v1/komitenti` su
 * nasleđivali KLASNI `directory.read` — READ ključ na PISAČKOJ ruti, a `directory.read`
 * je u `VIEWER_READ_BASELINE` pa ga ima skoro svaka rola; POST/PATCH `/v1/artikli` su
 * visili na `sync.run` (admin-only, semantički „pokreni sinhronizaciju"). Dva različita
 * gejta za istu vrstu radnje, jedan preširok, drugi pogrešan.
 *
 * Ovaj spec pinuje ČETIRI stvari, jer svaka bez ostalih može tiho da otkaže:
 *   A) katalog — ključ postoji i nije alias postojećeg;
 *   B) rola-sloj — TAČAN skup nosilaca (nabrojan, ne „bar ovi"), pa svako kasnije
 *      širenje mora da obori test umesto da prođe kao dopuna;
 *   C) dekoratori — sve četiri pisačke rute stvarno nose ključ (čita se PRAVA
 *      metadata preko pravog `Reflector`-a, ne prepis iz koda), a GET rute i dalje
 *      padaju na klasni `directory.read`;
 *   D) ponašanje guarda — nosilac `directory.read` bez novog ključa dobija 403,
 *      nosilac novog ključa prolazi guard i staje tek na 409 brani.
 *
 * ⚠️ Talas NE otvara unos: `CUSTOMERS_WRITE_OPEN=false` i `assertItemWritesAllowed()`
 * i dalje vraćaju 409 — poslednji blok to pinuje da se ključ ne pomeša sa otvaranjem.
 */

/** Krug koji sme da UPISUJE matične podatke (admin ide kroz ALL). */
const WRITE_CIRCLE = [ROLES.ADMIN, ROLES.MENADZMENT, ROLES.NABAVKA_VIEW];

type Handler = (...args: never[]) => unknown;

/** ExecutionContext nad PRAVIM handler-om/klasom kontrolera (metadata se ne izmišlja). */
function ctx(
  handler: Handler,
  cls: unknown,
  user: { userId: number; email: string; role: string } | undefined,
  method = "POST",
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user, method, url: "/api/v1/test" }),
    }),
  } as unknown as ExecutionContext;
}

/** Guard sa PRAVIM Reflector-om; `override` = red iz `user_permission_overrides`. */
function makeGuard(override: { allow: boolean } | null = null) {
  const prisma = {
    userPermissionOverride: {
      findUnique: jest.fn().mockResolvedValue(override),
    },
  } as unknown as PrismaService;
  return new PermissionsGuard(new Reflector(), prisma);
}

const WRITE_ROUTES: [string, Handler, unknown][] = [
  [
    "POST /v1/artikli",
    ItemsController.prototype.create as Handler,
    ItemsController,
  ],
  [
    "PATCH /v1/artikli/:id",
    ItemsController.prototype.update as Handler,
    ItemsController,
  ],
  [
    "POST /v1/komitenti",
    MasterCustomersController.prototype.create as Handler,
    MasterCustomersController,
  ],
  [
    "PATCH /v1/komitenti/:id",
    MasterCustomersController.prototype.update as Handler,
    MasterCustomersController,
  ],
];

const READ_ROUTES: [string, Handler, unknown][] = [
  [
    "GET /v1/artikli",
    ItemsController.prototype.list as Handler,
    ItemsController,
  ],
  [
    "GET /v1/artikli/:id",
    ItemsController.prototype.findOne as Handler,
    ItemsController,
  ],
  [
    "GET /v1/komitenti",
    MasterCustomersController.prototype.list as Handler,
    MasterCustomersController,
  ],
  [
    "GET /v1/komitenti/:id",
    MasterCustomersController.prototype.findOne as Handler,
    MasterCustomersController,
  ],
];

function requiredPermission(
  handler: Handler,
  cls: unknown,
): string | undefined {
  return new Reflector().getAllAndOverride<PermissionKey | undefined>(
    PERMISSION_KEY_METADATA,
    [handler, cls] as never,
  );
}

describe("masters.write — ključ za upis matičnih podataka", () => {
  // ── A) KATALOG ─────────────────────────────────────────────────────────────
  describe("A) katalog permisija", () => {
    it("ključ je `masters.write` i razlikuje se od read/sync ključeva", () => {
      expect(P.MASTERS_WRITE).toBe("masters.write");
      expect(P.MASTERS_WRITE).not.toBe(P.DIRECTORY_READ);
      expect(P.MASTERS_WRITE).not.toBe(P.SYNC_RUN);
    });
  });

  // ── B) ROLA-SLOJ ───────────────────────────────────────────────────────────
  describe("B) rola-sloj (mapa uloga)", () => {
    it.each(WRITE_CIRCLE)("%s ima masters.write", (role) => {
      expect(roleHasPermission(role, P.MASTERS_WRITE)).toBe(true);
    });

    // ⚠️ ODLUKA O-6 (vlasnik, 30.07.2026): „svako može da menja šifarnik."
    // Uzak krug je važio jedan dan; sada je pravilo: KO SME DA ČITA, SME I DA MENJA.
    it("O-6: SVAKA rola sa directory.read ima masters.write (pravilo, ne spisak)", () => {
      const readers = ALL_ROLE_KEYS.filter((r) =>
        roleHasPermission(r, P.DIRECTORY_READ),
      );
      expect(readers.length).toBeGreaterThan(5); // sanity: pravilo mora nešto da pokrije
      for (const role of readers) {
        expect(roleHasPermission(role, P.MASTERS_WRITE)).toBe(true);
      }
    });

    /**
     * Jezgro nalaza: `directory.read` NIJE dovoljan za upis. Lista se izvodi iz mape
     * (svaka rola sa read-om van kruga), pa nova rola sa read baseline-om automatski
     * ulazi u proveru — test se ne mora dopunjavati da bi uhvatio regresiju.
     */
    it("rola BEZ directory.read nema ni masters.write (upis bez čitanja je besmislen)", () => {
      const nonReaders = ALL_ROLE_KEYS.filter(
        (r) => !roleHasPermission(r, P.DIRECTORY_READ),
      );
      // Sanity: proizvodni_radnik i tehnicar_odrzavanja namerno nemaju read.
      expect(nonReaders.length).toBeGreaterThan(0);
      for (const role of nonReaders) {
        expect(roleHasPermission(role, P.MASTERS_WRITE)).toBe(false);
      }
    });

    it("kontrolor/viewer/tim_lider: read DA → write DA (O-6)", () => {
      for (const role of [ROLES.KONTROLOR, ROLES.VIEWER, ROLES.TIM_LIDER]) {
        expect(roleHasPermission(role, P.DIRECTORY_READ)).toBe(true);
        expect(roleHasPermission(role, P.MASTERS_WRITE)).toBe(true);
      }
    });

    it("nepoznata uloga = default deny", () => {
      expect(roleHasPermission("nepostojeca", P.MASTERS_WRITE)).toBe(false);
    });

    // Do 04.08.2026: `sync.run` samo admin. Zahtev 061/26 (Igor Voštić, odluka
    // Nenad): „Pokreni sync" i za tehnologe + planere → tehnolog + menadzment
    // (planeri i Igor nose menadzment — izmereno u prod bazi). Pin ostaje TAČAN
    // skup: svako novo širenje mora svesno da obori ovaj test.
    it("`sync.run` = admin + menadzment + tehnolog (061/26), niko više", () => {
      const holders = ALL_ROLE_KEYS.filter((r) =>
        roleHasPermission(r, P.SYNC_RUN),
      );
      expect(holders).toEqual([ROLES.ADMIN, ROLES.MENADZMENT, ROLES.TEHNOLOG]);
    });
  });

  // ── C) DEKORATORI NA RUTAMA ────────────────────────────────────────────────
  describe("C) dekoratori (prava metadata kontrolera)", () => {
    it.each(WRITE_ROUTES)("%s traži masters.write", (_name, handler, cls) => {
      expect(requiredPermission(handler, cls)).toBe(P.MASTERS_WRITE);
    });

    it.each(WRITE_ROUTES)(
      "%s NE stoji više iza read/sync ključa",
      (_name, handler, cls) => {
        const req = requiredPermission(handler, cls);
        expect(req).not.toBe(P.DIRECTORY_READ);
        expect(req).not.toBe(P.SYNC_RUN);
      },
    );

    it.each(READ_ROUTES)(
      "%s ostaje na klasnom directory.read (write ključ nije procurio na čitanje)",
      (_name, handler, cls) => {
        expect(requiredPermission(handler, cls)).toBe(P.DIRECTORY_READ);
      },
    );
  });

  // ── D) GUARD ───────────────────────────────────────────────────────────────
  describe("D) guard (AUTHZ_ENFORCE=true)", () => {
    const OLD = process.env.AUTHZ_ENFORCE;
    beforeEach(() => {
      process.env.AUTHZ_ENFORCE = "true";
    });
    afterEach(() => {
      process.env.AUTHZ_ENFORCE = OLD;
    });

    /** Rola koja ima SAMO `directory.read` (i baseline) — do sada je prolazila na upis. */
    const READ_ONLY_USER = {
      userId: 7,
      email: "kontrolor@servoteh.com",
      role: ROLES.KONTROLOR,
    };

    // O-6: kontrolor (čitalac) sada NOSI ključ → guard ga pušta do 409 brane.
    // Guard i dalje ume da odbije: to pinuje DENY-override test niže i
    // proizvodni_radnik (bez read → bez write).
    it.each(WRITE_ROUTES)(
      "%s: čitalac (kontrolor) prolazi guard — staje tek na 409 brani (O-6)",
      async (_name, handler, cls) => {
        const guard = makeGuard(null);
        expect(await guard.canActivate(ctx(handler, cls, READ_ONLY_USER))).toBe(
          true,
        );
      },
    );

    it.each(WRITE_ROUTES)(
      "%s: nabavka_view (nosilac ključa) → prolaz kroz guard",
      async (_name, handler, cls) => {
        const guard = makeGuard(null);
        const user = {
          userId: 8,
          email: "nabavka@servoteh.com",
          role: ROLES.NABAVKA_VIEW,
        };
        expect(await guard.canActivate(ctx(handler, cls, user))).toBe(true);
      },
    );

    it.each(WRITE_ROUTES)(
      "%s: menadzment i admin prolaze",
      async (_name, handler, cls) => {
        const guard = makeGuard(null);
        for (const role of [ROLES.MENADZMENT, ROLES.ADMIN]) {
          const user = { userId: 9, email: `${role}@servoteh.com`, role };
          expect(await guard.canActivate(ctx(handler, cls, user))).toBe(true);
        }
      },
    );

    it.each(READ_ROUTES)(
      "%s: kontrolor i dalje ČITA (pooštravanje nije zatvorilo pregled)",
      async (_name, handler, cls) => {
        const guard = makeGuard(null);
        expect(
          await guard.canActivate(ctx(handler, cls, READ_ONLY_USER, "GET")),
        ).toBe(true);
      },
    );

    it("proizvodni_radnik (bez directory.read) ne vidi ni listu — sanity mape", async () => {
      const guard = makeGuard(null);
      const user = {
        userId: 10,
        email: "radnik@servoteh.com",
        role: ROLES.PROIZVODNI_RADNIK,
      };
      const [, handler, cls] = READ_ROUTES[0];
      expect(await guard.canActivate(ctx(handler, cls, user, "GET"))).toBe(
        false,
      );
    });

    it("imenovan GRANT override daje upis roli koja ključ nema (bez širenja role)", async () => {
      const guard = makeGuard({ allow: true });
      const [, handler, cls] = WRITE_ROUTES[2];
      expect(await guard.canActivate(ctx(handler, cls, READ_ONLY_USER))).toBe(
        true,
      );
    });

    it("DENY override obara i nosioca role (deny > grant > rola)", async () => {
      const guard = makeGuard({ allow: false });
      const [, handler, cls] = WRITE_ROUTES[0];
      const user = {
        userId: 11,
        email: "menadzment@servoteh.com",
        role: ROLES.MENADZMENT,
      };
      expect(await guard.canActivate(ctx(handler, cls, user))).toBe(false);
    });
  });

  // ── E) PREKIDAČI OSTAJU ZATVORENI ──────────────────────────────────────────
  describe("E) brana je i dalje 409, a ne 403", () => {
    it("prekidači za unos nisu preklopljeni ovim talasom", () => {
      expect(CUSTOMERS_WRITE_OPEN).toBe(false);
    });

    it("nosilac masters.write prođe guard pa stane na 409 (artikli)", async () => {
      process.env.AUTHZ_ENFORCE = "true";
      const guard = makeGuard(null);
      const [, handler, cls] = WRITE_ROUTES[0];
      const user = {
        userId: 8,
        email: "nabavka@servoteh.com",
        role: ROLES.NABAVKA_VIEW,
      };
      expect(await guard.canActivate(ctx(handler, cls, user))).toBe(true);

      try {
        assertItemWritesAllowed();
        throw new Error("brana nije odbila upis");
      } catch (e) {
        const err = e as {
          getStatus?: () => number;
          getResponse?: () => unknown;
        };
        expect(err.getStatus?.()).toBe(409);
        expect(err.getResponse?.()).toMatchObject({
          code: "BIGBIT_OWNED_READ_ONLY",
        });
      }
      delete process.env.AUTHZ_ENFORCE;
    });

    it("nosilac masters.write prođe guard pa stane na 409 (komitenti)", async () => {
      process.env.AUTHZ_ENFORCE = "true";
      const guard = makeGuard(null);
      const [, handler, cls] = WRITE_ROUTES[2];
      const user = {
        userId: 8,
        email: "nabavka@servoteh.com",
        role: ROLES.NABAVKA_VIEW,
      };
      expect(await guard.canActivate(ctx(handler, cls, user))).toBe(true);

      try {
        assertCustomerWriteAllowed();
        throw new Error("brana nije odbila upis");
      } catch (e) {
        const err = e as {
          getStatus?: () => number;
          getResponse?: () => unknown;
        };
        expect(err.getStatus?.()).toBe(409);
        expect(err.getResponse?.()).toMatchObject({
          code: "BIGBIT_OWNED_READ_ONLY",
        });
      }
      delete process.env.AUTHZ_ENFORCE;
    });
  });
});
