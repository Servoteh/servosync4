import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

/**
 * `@Body() dto: NekiDto` — DTO KLASA MORA BITI VREDNOSNI UVOZ, NE `import type`.
 *
 * ═══ ZAŠTO OVAJ TEST POSTOJI (prijava vlasnika, 05.08.2026) ═══════════════════════════
 * Vlasnik nije mogao da snimi podatke firme: `PUT /admin/firma` je na SVAKO snimanje
 * vraćao 422 „Nijedno polje nije prosleđeno.", a iz koda se uzrok nije video — DTO prima
 * svih 19 polja, servis ih sve obrađuje, ekran ih sve šalje.
 *
 * IZMERENI UZROK: `@Body()` se validira preko `design:paramtypes` metapodatka, a taj
 * metapodatak mora da nosi SAMU KLASU. Kad je klasa uvezena kroz `import type`,
 * TypeScript je u runtime-u ne može referisati, pa u metapodatak upiše globalni
 * `Function`. `ValidationPipe` tada NE preskače validaciju (`Function` nije u njegovoj
 * listi primitivnih tipova) nego pozove `plainToInstance(Function, telo)` — a to vrati
 * FUNKCIJU. Servis dobije objekat u kome je svako polje `undefined` → „nijedno polje".
 *
 * ⚠️ ZAŠTO OBIČAN JEST TEST OVO NE MOŽE DA UHVATI (i zato se gleda IZVOR, ne runtime):
 * `ts-jest` prevodi fajl-po-fajl i za isti kod u metapodatak upiše `Object` — a `Object`
 * `ValidationPipe` PRESKAČE, pa telo prođe netaknuto i sve „radi". Kvar postoji ISKLJUČIVO
 * u produkcijskom prevodu (`tsc -p tsconfig.build.json`). Izmereno na istom fajlu:
 *
 *   ts-jest                → design:paramtypes = [Object, Object]        (telo prolazi)
 *   tsc -p tsconfig.build  → design:paramtypes = [Number, Function]      (telo se UNIŠTAVA)
 *
 * Zato ovaj spec radi STATIČKU analizu izvora (TypeScript AST): za svaki `@Body()`
 * parametar nađe kako je njegov tip uvezen i da li je u svom fajlu deklarisan kao
 * `export class`. Klasa + `import type` = kvar, bez obzira čime je fajl preveden.
 *
 * INTERFEJSI SU IZUZETI: interfejs se NE MOŽE uvesti kao vrednost, a `ValidationPipe` za
 * njega dobije `Object` i preskoči validaciju. To je odvojen (stariji, širi) nalaz — telo
 * prolazi nevalidirano, ali PROLAZI. Ovaj test ne meša dve različite stvari.
 */

const SRC = path.join(__dirname, "..");

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) controllerFiles(p, out);
    else if (e.name.endsWith(".controller.ts")) out.push(p);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );
}

/** Ime → putanja modula, samo za imena uvezena KAO TIP (`import type` ili `{ type X }`). */
function typeOnlyImports(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const spec = st.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const bindings = st.importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if (st.importClause.isTypeOnly || el.isTypeOnly)
        out.set(el.name.text, spec.text);
    }
  }
  return out;
}

/** Korenski identifikator tipa: `X`, `X[]`, `X | null` → `X`. */
function rootTypeName(node: ts.TypeNode | undefined): string | null {
  if (!node) return null;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName))
    return node.typeName.text;
  if (ts.isArrayTypeNode(node)) return rootTypeName(node.elementType);
  if (ts.isUnionTypeNode(node)) {
    for (const t of node.types) {
      const n = rootTypeName(t);
      if (n) return n;
    }
  }
  return null;
}

/** Da li modul deklariše `export class <name>` (dakle postoji i kao vrednost u runtime-u). */
function declaresClass(fromFile: string, moduleSpec: string, name: string): boolean {
  if (!moduleSpec.startsWith(".")) return false; // paket, ne naš DTO
  const base = path.resolve(path.dirname(fromFile), moduleSpec);
  const candidates = [`${base}.ts`, path.join(base, "index.ts")];
  const file = candidates.find((c) => fs.existsSync(c));
  if (!file) return false;
  const sf = parse(file);
  return sf.statements.some(
    (st) =>
      ts.isClassDeclaration(st) &&
      st.name?.text === name &&
      !!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
}

/** Svi `@Body()` parametri u fajlu: `{ metoda, tip }`. */
function bodyParams(sf: ts.SourceFile): { method: string; type: string | null }[] {
  const out: { method: string; type: string | null }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node)) {
      const method = ts.isIdentifier(node.name) ? node.name.text : "(?)";
      for (const p of node.parameters) {
        const hasBody = ts
          .getDecorators(p)
          ?.some(
            (d) =>
              ts.isCallExpression(d.expression) &&
              ts.isIdentifier(d.expression.expression) &&
              d.expression.expression.text === "Body",
          );
        if (hasBody) out.push({ method, type: rootTypeName(p.type) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("@Body() DTO klasa mora biti vrednosni uvoz (inače produkcijski build uništi telo)", () => {
  const files = controllerFiles(SRC);

  it("uopšte nalazi kontrolere i @Body parametre (da test ne bi ćutao uprazno)", () => {
    expect(files.length).toBeGreaterThan(10);
    const ukupno = files.reduce((n, f) => n + bodyParams(parse(f)).length, 0);
    expect(ukupno).toBeGreaterThan(50);
  });

  it("nijedan @Body() ne pokazuje na KLASU uvezenu kroz `import type`", () => {
    const prekršaji: string[] = [];
    for (const f of files) {
      const sf = parse(f);
      const typeOnly = typeOnlyImports(sf);
      for (const { method, type } of bodyParams(sf)) {
        if (!type) continue;
        const spec = typeOnly.get(type);
        if (spec && declaresClass(f, spec, type))
          prekršaji.push(
            `${path.relative(SRC, f)} → ${method}(@Body() : ${type}) ` +
              `— klasa iz „${spec}" uvezena kao TIP; promeni u vrednosni uvoz`,
          );
      }
    }
    expect(prekršaji).toEqual([]);
  });
});
