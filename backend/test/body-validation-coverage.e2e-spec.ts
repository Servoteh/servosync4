import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";
import {
  PATH_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  ROUTE_ARGS_METADATA,
} from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * BODY → VALIDATION COVERAGE AUDIT
 * ============================================================================
 *
 * Čist reflection nad Nest metapodacima (bez boot-a, bez baze, bez supertest-a) —
 * isti obrazac kao `route-permission-coverage.e2e-spec.ts`, samo što ovaj ne pita
 * „da li rutu išta zaključava" nego **„da li telo zahteva iko validira"**.
 *
 * ZAŠTO POSTOJI (izmereno 04.08.2026)
 * Globalni `ValidationPipe({ transform: true, whitelist: true })` iz `src/main.ts`
 * validira SAMO ako `design:paramtypes` za `@Body()` parametar pokazuje na klasu sa
 * `class-validator` dekoratorima. Postoje TRI načina da to tiho otkaže, i sva tri su
 * zatečena u ovom repou:
 *
 *  1. `@Body() dto: NekiInterfejs` → metapodatak je `Object`. Pipe preskoči telo.
 *     Posledica u `robno`: `{"invoicePrice": "abc"}` je prošao do `toDec`, koji hvata
 *     izuzetak i vraća **0** — stavka je dobila cenu 0 bez ijedne greške.
 *
 *  2. `@Body() dto: { a: string }` (inline tip) → isto `Object`, nikad validirano.
 *
 *  3. 🔴 `import type { NekiDto }` gde je `NekiDto` PRAVA klasa sa dekoratorima →
 *     TypeScript obriše binding, `emitDecoratorMetadata` upiše **`Function`**, i
 *     `whitelist: true` obriše SVA polja tela. Ovo je najgore od tri, jer u DTO fajlu
 *     stoje uredni dekoratori koji nikad ne izvrše — kod izgleda ispravno.
 *     Zatečeno na `PUT /admin/firma` i `PUT /admin/firma/racuni/:id`: memorandum, PIB,
 *     IBAN i devizni račun **nisu mogli da se sačuvaju nikako**, a ruta je vraćala
 *     „Nijedno polje nije prosleđeno".
 *
 * DVE RAZLIČITE KAPIJE
 *  • `Function` = TVRDA GREŠKA, uvek, bez izuzetka i bez baseline-a. Ne postoji
 *    legitiman razlog da telo bude tipovano kao `Function` — to je uvek `import type`
 *    na klasi, i uvek znači da ruta ne radi ono što piše da radi.
 *  • `Object` (interfejs / inline tip) = zatečeni dug. Repo ih ima mnogo, pa se meri
 *    prema `body-validation-baseline.json` i pada samo kad broj **poraste**. Isti
 *    princip kao `scripts/audit-code.mjs` — v. `docs/REVIEW_SISTEM.md`.
 */

type Ctor = new (...args: unknown[]) => unknown;

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BASELINE_FILE = path.join(__dirname, "body-validation-baseline.json");

interface BodyParam {
  controller: string;
  handler: string;
  httpMethod: string;
  fullPath: string;
  /** Ime tipa iz `design:paramtypes`, ili `null` kad metapodatka nema. */
  typeName: string | null;
  /** `@Body("polje")` — parcijalno telo; pipe ga ionako ne validira kao celinu. */
  isKeyed: boolean;
}

/** Rekurzivno pokupi SVE kontrolere iz stabla modula (dinamički moduli + forwardRef). */
function collectControllers(entry: unknown, seen = new Set<unknown>()): Ctor[] {
  if (!entry) return [];
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
    (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, mod as object) as Ctor[]) ??
    [];
  const metaImports =
    (Reflect.getMetadata(MODULE_METADATA.IMPORTS, mod as object) as unknown[]) ??
    [];
  let out: Ctor[] = [
    ...metaControllers,
    ...((asObj.controllers as Ctor[]) ?? []),
  ];
  for (const imp of [...metaImports, ...((asObj.imports as unknown[]) ?? [])]) {
    out = out.concat(collectControllers(imp, seen));
  }
  return out;
}

/**
 * Nađi `@Body()` parametre jedne rute.
 *
 * Nest čuva argumente rute u `ROUTE_ARGS_METADATA` na KONSTRUKTORU kontrolera, pod
 * ključem `"<paramtype>:<index>"` (npr. `"3:0"` za `@Body()` na nultom mestu).
 * `data` je ime polja kod `@Body("polje")`, ili `undefined` za celo telo.
 */
function bodyParamsOf(ctrl: Ctor): BodyParam[] {
  const basePathRaw = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? "";
  const basePath = Array.isArray(basePathRaw) ? basePathRaw[0] : basePathRaw;
  const proto = (ctrl as { prototype: Record<string, unknown> }).prototype;
  const out: BodyParam[] = [];

  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const handler = proto[name];
    const method = Reflect.getMetadata(METHOD_METADATA, handler as object);
    if (method === undefined || method === null) continue;
    const httpMethod = RequestMethod[method as number] ?? String(method);

    const args =
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) as Record<
        string,
        { index: number; data?: unknown }
      >) ?? {};
    const paramTypes =
      (Reflect.getMetadata("design:paramtypes", proto, name) as
        | Array<{ name?: string } | undefined>
        | undefined) ?? [];

    const subPathRaw =
      (Reflect.getMetadata(PATH_METADATA, handler as object) as string) ?? "";
    const subPath = Array.isArray(subPathRaw) ? subPathRaw[0] : subPathRaw;
    const clean = (s: string) => s.replace(/^\/+|\/+$/g, "");
    const fullPath = "/" + [clean(basePath), clean(subPath)].filter(Boolean).join("/");

    for (const [key, meta] of Object.entries(args)) {
      const [paramTypeStr] = key.split(":");
      if (Number(paramTypeStr) !== RouteParamtypes.BODY) continue;
      const t = paramTypes[meta.index];
      out.push({
        controller: (ctrl as { name: string }).name,
        handler: name,
        httpMethod,
        fullPath,
        typeName: t?.name ?? null,
        isKeyed: meta.data !== undefined && meta.data !== null,
      });
    }
  }
  return out;
}

describe("BODY → VALIDATION coverage", () => {
  let bodies: BodyParam[] = [];

  beforeAll(() => {
    // SEC-01: import AppModule-a okida `requireJwtSecret()` na učitavanju.
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.trim() === "") {
      process.env.JWT_SECRET = "body-audit-ci-secret-not-real-value";
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require("../src/app.module") as { AppModule: unknown };
    const controllers = Array.from(new Set(collectControllers(AppModule)));
    bodies = controllers.flatMap((c) => bodyParamsOf(c));
  });

  it("uopšte je našao rute sa telom (sanity — inače test ništa ne meri)", () => {
    expect(bodies.length).toBeGreaterThan(50);
  });

  /**
   * TVRDA KAPIJA. `Function` u `design:paramtypes` znači da je DTO klasa uvezena sa
   * `import type` — dekoratori postoje, ali se nikad ne izvršavaju, i `whitelist`
   * obriše celo telo. Ruta tada tiho ne radi. Nikad nema opravdanja.
   */
  it("nijedno telo nije tipovano kao `Function` (znak `import type` na DTO klasi)", () => {
    const broken = bodies.filter((b) => b.typeName === "Function");
    const detail = broken
      .map(
        (b) =>
          `  ${b.httpMethod} ${b.fullPath}  (${b.controller}.${b.handler})\n` +
          `      → DTO je uvezen sa \`import type\`. Prebaci na vrednosni import.`,
      )
      .join("\n");
    expect(
      broken.length === 0 ? "" : `\nRuta čije telo ValidationPipe BRIŠE:\n${detail}\n`,
    ).toBe("");
  });

  /**
   * MEKA KAPIJA (baseline). Interfejs ili inline tip → `Object` → pipe preskoči telo.
   * Repo ima zatečene; meri se da broj ne raste. Kad popraviš grupu, spusti prag:
   *   UPDATE_BODY_BASELINE=1 npx jest --config ./test/jest-e2e.json body-validation
   */
  it("broj nevalidiranih tela mutirajućih ruta ne raste (baseline)", () => {
    const unvalidated = bodies.filter(
      (b) =>
        MUTATION_METHODS.has(b.httpMethod) &&
        !b.isKeyed &&
        (b.typeName === "Object" || b.typeName === null),
    );
    const current = unvalidated.length;

    if (process.env.UPDATE_BODY_BASELINE === "1") {
      fs.writeFileSync(
        BASELINE_FILE,
        `${JSON.stringify(
          {
            note: "Zatečena nevalidirana tela mutirajućih ruta. Sme samo da opada.",
            unvalidatedBodies: current,
            routes: unvalidated
              .map((b) => `${b.httpMethod} ${b.fullPath}`)
              .sort(),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    expect(fs.existsSync(BASELINE_FILE)).toBe(true);
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as {
      unvalidatedBodies: number;
    };
    const worse = current > baseline.unvalidatedBodies;
    const msg = worse
      ? `\nNevalidiranih tela: ${baseline.unvalidatedBodies} → ${current}.\n` +
        `Novo telo mutirajuće rute mora biti KLASA sa class-validator dekoratorima\n` +
        `(v. docs/REVIEW_SISTEM.md §1 Pravilo 2). Ako je porast namerно:\n` +
        `  UPDATE_BODY_BASELINE=1 npx jest --config ./test/jest-e2e.json body-validation\n`
      : "";
    expect(msg).toBe("");
  });
});
