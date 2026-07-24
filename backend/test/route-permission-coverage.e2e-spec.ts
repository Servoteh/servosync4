import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  PATH_METADATA,
  METHOD_METADATA,
  GUARDS_METADATA,
  MODULE_METADATA,
} from "@nestjs/common/constants";
import * as fs from "node:fs";
import * as path from "node:path";
import { PERMISSION_KEY_METADATA } from "../src/common/authz/require-permission.decorator";
// AppModule se učitava DINAMIČKI u beforeAll (posle postavljanja JWT_SECRET-a) —
// njegov import okida SEC-01 fail-closed guard (auth.module → requireJwtSecret),
// a statički `import` bi se hoist-ovao pre postavljanja env-a.

/**
 * ROUTE → PERMISSION COVERAGE AUDIT (Blok C / Nivo 1 permission matrice).
 *
 * Čist reflection nad Nest metapodacima — BEZ boot-a, BEZ baze, BEZ supertest-a.
 * Živi u `test/` (van deploy paths-filtera `src/**` — commit NE restartuje prod);
 * u CI ga vozi namenski DB-less korak `test:e2e -- --testPathPattern permission|coverage`.
 *
 * Cilj: dokazati da je SVAKA mutacija (POST/PUT/PATCH/DELETE) stvarno zaštićena
 * (ima `@RequirePermission` I `PermissionsGuard` u lancu), i izlistati sve rute +
 * njihovu permisiju za pregled/presudu. NIJE tautologija sa `ROLE_PERMISSIONS`:
 * ne pita „koja rola sme", nego „da li rutu uopšte išta zaključava".
 *
 * Ključni nalaz-tipovi:
 *  - MRTVA PERMISIJA: `@RequirePermission` postoji, ali PermissionsGuard NIJE u
 *    lancu rute → dekorator se nikad ne izvršava (tiho otvoreno). Nedvosmislen bug.
 *  - NEZAŠTIĆENA MUTACIJA: POST/PATCH/... bez permisije i van allowlist-a.
 *  - GUARD-BEZ-PERMISIJE: PermissionsGuard registrovan, ali ruta nema permisiju →
 *    guard je no-op (pušta sve). OK za read, sumnjivo za mutaciju.
 */

interface RouteInfo {
  controller: string;
  httpMethod: string;
  isMutation: boolean;
  fullPath: string;
  permission: string | null;
  guards: string[];
  hasJwtGuard: boolean;
  hasPermGuard: boolean;
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Ctor = new (...args: unknown[]) => unknown;

/** Rekurzivno pokupi SVE kontrolere iz stabla modula (dinamički moduli + forwardRef). */
function collectControllers(entry: unknown, seen = new Set<unknown>()): Ctor[] {
  if (!entry) return [];
  // Odmotaj forwardRef ({ forwardRef: () => Type }) i dinamički modul ({ module, ... }).
  const asObj = entry as {
    forwardRef?: () => unknown;
    module?: unknown;
    controllers?: unknown[];
    imports?: unknown[];
  };
  let mod: unknown = entry;
  if (typeof asObj.forwardRef === "function") mod = asObj.forwardRef();
  else if (asObj.module) mod = asObj.module;
  if (!mod || seen.has(mod)) return [];
  seen.add(mod);

  const metaControllers =
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) as Ctor[]) ?? [];
  const metaImports =
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod as object) as unknown[]) ?? [];
  // Dinamički modul može nositi controllers/imports na samom objektu.
  const dynControllers = (asObj.controllers as Ctor[]) ?? [];
  const dynImports = (asObj.imports as unknown[]) ?? [];

  let out: Ctor[] = [...metaControllers, ...dynControllers];
  for (const imp of [...metaImports, ...dynImports]) {
    out = out.concat(collectControllers(imp, seen));
  }
  return out;
}

/** Sve rute jednog kontrolera (metod-nivo permisija/guard override-uje klasni). */
function routesOf(ctrl: Ctor): RouteInfo[] {
  const basePathRaw = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? "";
  const basePath = Array.isArray(basePathRaw) ? basePathRaw[0] : basePathRaw;
  const classPerm = (Reflect.getMetadata(PERMISSION_KEY_METADATA, ctrl) as string) ?? null;
  const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, ctrl));

  const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
  const routes: RouteInfo[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const handler = proto[name];
    const method = Reflect.getMetadata(METHOD_METADATA, handler as object);
    if (method === undefined || method === null) continue; // nije route handler
    const httpMethod = RequestMethod[method as number] ?? String(method);
    const subPathRaw = (Reflect.getMetadata(PATH_METADATA, handler as object) as string) ?? "";
    const subPath = Array.isArray(subPathRaw) ? subPathRaw[0] : subPathRaw;
    const methodPerm = (Reflect.getMetadata(PERMISSION_KEY_METADATA, handler as object) as string) ?? null;
    const methodGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, handler as object));

    const permission = methodPerm ?? classPerm;
    const guards = Array.from(new Set([...classGuards, ...methodGuards]));
    const clean = (s: string) => s.replace(/^\/+|\/+$/g, "");
    const fullPath = "/" + [clean(basePath), clean(subPath)].filter(Boolean).join("/");

    routes.push({
      controller: (ctrl as { name: string }).name,
      httpMethod,
      isMutation: MUTATION_METHODS.has(httpMethod),
      fullPath,
      permission,
      guards,
      hasJwtGuard: guards.some((g) => /Jwt/.test(g)),
      hasPermGuard: guards.some((g) => /Permissions?Guard/.test(g)),
    });
  }
  return routes;
}

function guardNames(meta: unknown): string[] {
  if (!Array.isArray(meta)) return [];
  return meta
    .map((g) => {
      if (typeof g === "function") return g.name;
      const c = (g as { constructor?: { name?: string } })?.constructor?.name;
      return c ?? "";
    })
    .filter(Boolean);
}

describe("Route → permission coverage audit", () => {
  let controllers: Ctor[] = [];
  let routes: RouteInfo[] = [];

  beforeAll(() => {
    // SEC-01: AppModule import okida requireJwtSecret() na učitavanju — postavi jaku
    // (ne-placeholder) tajnu PRE require-a. Vrednost je nebitna: app se NE bootuje,
    // ništa se ne potpisuje/verifikuje; ovo je čist reflection nad metapodacima.
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === "") {
      process.env.JWT_SECRET = "route-audit-ci-secret-not-real-value";
    }
    // Dinamički require (statički import bi se hoist-ovao pre gornje linije).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require("../src/app.module") as { AppModule: unknown };
    controllers = Array.from(new Set(collectControllers(AppModule)));
    routes = controllers
      .flatMap(routesOf)
      .sort((a, b) => (a.controller + a.fullPath).localeCompare(b.controller + b.fullPath));
  });

  // Rute NAMERNO bez permisije (dokumentovana odluka). Nova nezaštićena mutacija
  // van ovog spiska OBARA test (gejt). Presuda vlasnika širi/steže ovo.
  // Format: `${httpMethod} ${fullPath}`.
  const INTENTIONAL_OPEN = new Set<string>([
    // Auth lifecycle — kredencijal je sam token/refresh-token, ne rola-permisija.
    "POST /auth/login",
    "POST /auth/sso",
    "POST /auth/logout",
    "POST /auth/refresh",
    // Self-service promena lozinke: kredencijal je JWT + verifikacija trenutne lozinke (401),
    // ne rola-permisija — ista kategorija kao login/sso/logout/refresh.
    "POST /auth/change-password",
    // Notifikacije: SVESNA odluka D4 — samo JWT, izolacija po request.user.workerId
    // (korisnik čita/označava SVOJE notifikacije; permisija bi bila suvišna).
    "POST /notifications/:id/read",
    "POST /notifications/read-all",
  ]);

  it("izveštaj: sve rute + status zaštite (uvek prolazi — pregled)", () => {
    const lines: string[] = [];
    lines.push(`# Route → permission coverage — ${routes.length} ruta, ${controllers.length} kontrolera\n`);
    for (const r of routes) {
      const flags: string[] = [];
      if (r.permission && !r.hasPermGuard) flags.push("MRTVA-PERMISIJA");
      if (r.isMutation && !r.permission && !INTENTIONAL_OPEN.has(`${r.httpMethod} ${r.fullPath}`))
        flags.push("NEZAŠTIĆENA-MUTACIJA");
      if (r.isMutation && !r.permission && r.hasPermGuard) flags.push("GUARD-BEZ-PERMISIJE");
      if (!r.hasJwtGuard && !r.hasPermGuard) flags.push("BEZ-GUARDA(javno?)");
      lines.push(
        `${r.httpMethod.padEnd(6)} ${r.fullPath.padEnd(48)} perm=${(r.permission ?? "—").padEnd(24)} guards=[${r.guards.join(",")}] ${flags.join(" ")}`,
      );
    }
    const report = lines.join("\n");
    const outDir = path.resolve(__dirname, "../reports");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "route-permission-coverage.txt"), report + "\n");
    // eslint-disable-next-line no-console
    console.log(report);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("nema MRTVIH permisija (@RequirePermission bez PermissionsGuard u lancu)", () => {
    const dead = routes.filter((r) => r.permission && !r.hasPermGuard);
    if (dead.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "MRTVE PERMISIJE (dekorator se NIKAD ne izvršava — tiho otvoreno):\n  " +
          dead.map((r) => `${r.httpMethod} ${r.fullPath} (perm=${r.permission})`).join("\n  "),
      );
    }
    expect(dead).toHaveLength(0);
  });

  it("GEJT: svaka mutacija je zaštićena (nema NOVE nezaštićene van allowlist-a)", () => {
    const openMut = routes.filter(
      (r) =>
        r.isMutation &&
        !r.permission &&
        !INTENTIONAL_OPEN.has(`${r.httpMethod} ${r.fullPath}`),
    );
    if (openMut.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "NEZAŠTIĆENA MUTACIJA (nema @RequirePermission, van allowlist-a) — dodaj\n" +
          "permisiju ili, ako je namerno otvorena, upiši je u INTENTIONAL_OPEN uz razlog:\n  " +
          openMut.map((r) => `${r.httpMethod} ${r.fullPath} guards=[${r.guards.join(",")}]`).join("\n  "),
      );
    }
    expect(openMut).toHaveLength(0);
  });

  it("izveštaj: read rute bez permisije (samo JWT) — 'ko sme šta da čita', za presudu", () => {
    // GET bez permisije a sa JWT-om = svaki prijavljen korisnik čita, bez obzira na
    // rolu. Možda namerno (npr. RN read svima), možda kandidat za rn.read i sl.
    // NE obara — čisto informativno za vlasnika.
    const openReads = routes.filter(
      (r) => !r.isMutation && !r.permission && r.hasJwtGuard,
    );
    const grouped = new Map<string, string[]>();
    for (const r of openReads) {
      const seg = r.fullPath.split("/")[1] ?? "?";
      const arr = grouped.get(seg) ?? [];
      arr.push(`${r.httpMethod} ${r.fullPath}`);
      grouped.set(seg, arr);
    }
    const lines = [`# Read rute bez permisije (samo JWT) — ${openReads.length} ruta\n`];
    for (const [seg, arr] of [...grouped].sort()) {
      lines.push(`## ${seg} (${arr.length})`);
      for (const a of arr.sort()) lines.push(`  ${a}`);
    }
    const outDir = path.resolve(__dirname, "../reports");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "reads-without-permission.txt"), lines.join("\n") + "\n");
    // eslint-disable-next-line no-console
    console.log(`Read rute bez permisije: ${openReads.length} (detalji: reports/reads-without-permission.txt)`);
    expect(openReads.length).toBeGreaterThanOrEqual(0);
  });
});
