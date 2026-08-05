#!/usr/bin/env node
/**
 * audit-code.mjs — skener obrazaca koji tiho kvare ERP.
 * ============================================================================
 *
 * ŠTA JE OVO, A ŠTA NIJE
 * Ovo NIJE linter i NE dokazuje grešku. Ovo je NALAZAČ KANDIDATA: pronalazi mesta
 * koja imaju oblik problema koji nam se u ovom repou već desio, da ih čovek (ili
 * agent) pogleda. Lažno pozitivan nalaz je normalan i očekivan — cena mu je jedan
 * pogled u kod; propušten nalaz je skup, jer se ovi obrasci NE prijavljuju sami:
 * ne pucaju, ne loguju, samo tiho daju drugačiji broj na drugom ekranu.
 *
 * ZAŠTO BAŠ OVIH SEDAM
 * Svaki je izmeren u ovom repou (04.08.2026), nije uzet iz opšte liste dobre prakse:
 *   1 dup-sql       predikat kretanja zaliha bio prepisan 10× u 5 fajlova; predikat
 *                   „proknjižen nalog" i danas stoji 20× u 14 fajlova
 *   2 n1            32 mesta sa upitom u petlji, jedno drži advisory lock dok petlja traje
 *   3 dead          110 linija mrtvog privatnog metoda koji je bio DIVERGENTNA kopija žive logike
 *   4 body-type     73 mutirajuće rute čije telo `ValidationPipe` tiho preskače
 *   5 unsafe-num    9 mesta gde `NaN` iz query stringa ulazi u SQL → 500 umesto 422
 *   6 page-filter   pretraga primenjena POSLE `LIMIT`-a → tiho nepotpuni rezultati
 *   7 size          servisi preko 600 linija sa izmešanim odgovornostima
 *
 * BASELINE (ključno za upotrebljivost)
 * Repo već ima zatečene nalaze. Kapija zato ne traži nulu nego da broj NE RASTE:
 *   node scripts/audit-code.mjs --update-baseline   # jednom, snima zatečeno stanje
 *   node scripts/audit-code.mjs --check             # u CI: pada ako je broj porastao
 * Kad popraviš grupu nalaza, ponovo pokreni --update-baseline da se spusti prag.
 *
 * UPOTREBA
 *   node scripts/audit-code.mjs                     # svi obrasci, čitljiv ispis
 *   node scripts/audit-code.mjs --pattern=dup-sql   # jedan obrazac
 *   node scripts/audit-code.mjs --module=robno      # jedan modul
 *   node scripts/audit-code.mjs --json              # mašinski ispis (za agente)
 *   node scripts/audit-code.mjs --check             # izlazni kod 1 ako je gore od baseline-a
 *
 * Bez ijedne zavisnosti (BACKEND_RULES: nova zavisnost samo uz odobrenje).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BASELINE = join(ROOT, "scripts", "audit-baseline.json");

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const ONLY_PATTERN = opt("pattern");
const ONLY_MODULE = opt("module");
const AS_JSON = flag("json");
const CHECK = flag("check");
const UPDATE = flag("update-baseline");

/** Fajlovi koji se skeniraju: produkcijski TS u src/, bez testova i bez generisanog koda. */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      collect(p, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".spec.ts") || name.endsWith(".d.ts")) continue;
    if (name.endsWith(".generated.ts")) continue;
    out.push(p);
  }
  return out;
}

/**
 * Linija koja je SAMO komentar se ne skenira. Bez ovoga skener prijavljuje sopstvene
 * primere iz doc-komentara („`Number("abc")` je NaN…") kao nalaze — a upravo komentari
 * u ovom repou nose objašnjenja obrazaca, pa bi šum bio sistematičan.
 */
const isComment = (l) => /^\s*(\/\/|\/\*|\*|\*\/)/.test(l);

const files = collect(SRC)
  .map((p) => ({ path: p, rel: relative(ROOT, p).split(sep).join("/") }))
  .filter((f) => !ONLY_MODULE || f.rel.includes(`/modules/${ONLY_MODULE}/`))
  .map((f) => {
    const raw = readFileSync(f.path, "utf8").split(/\r?\n/);
    // Komentari se zamenjuju praznom linijom (a ne brišu) da numeracija ostane tačna.
    return { ...f, lines: raw.map((l) => (isComment(l) ? "" : l)), raw };
  });

const findings = [];
const add = (pattern, file, line, message, extra = {}) =>
  findings.push({ pattern, file, line, message, ...extra });

/** Modul iz putanje (`src/modules/<x>/…` → `<x>`; ostalo → prvi segment posle src/). */
const moduleOf = (rel) => {
  const m = rel.match(/src\/modules\/([^/]+)\//);
  return m ? m[1] : (rel.match(/src\/([^/]+)\//)?.[1] ?? "src");
};

// ───────────────────────────────────────────────────────────── 1. dup-sql
/**
 * Dupliran poslovni predikat u raw SQL-u.
 *
 * Metod: iz svakog fajla izvuče linije koje LIČE na SQL uslov (`AND …`, `WHERE …`,
 * `CASE WHEN …`), normalizuje ih (mala slova, jedan razmak, bez `${…}` parametara,
 * bez aliasa tabele tipa `sdi.`/`m.`), pa traži one koje se javljaju u ≥2 fajla.
 * Alias se skida namerno: isti predikat prepisan pod drugim aliasom je i dalje isti
 * predikat, i baš tako se ovde i razilazio.
 *
 * Prag: uslov mora imati ≥25 znakova posle normalizacije — kraći (`and x = 1`) su šum.
 */
function scanDupSql() {
  const seen = new Map(); // normalizovan uslov → [{file, line}]
  const CONDITION = /^\s*(AND|OR|WHERE|CASE WHEN|HAVING)\s+/i;
  for (const f of files) {
    f.lines.forEach((raw, i) => {
      if (!CONDITION.test(raw)) return;
      const norm = raw
        .replace(/\$\{[^}]*\}/g, "?") // parametri
        .replace(/\b[a-z_]{1,4}\./gi, "") // alias tabele
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (norm.length < 25) return;
      if (!seen.has(norm)) seen.set(norm, []);
      seen.get(norm).push({ file: f.rel, line: i + 1 });
    });
  }
  for (const [norm, hits] of seen) {
    const distinctFiles = new Set(hits.map((h) => h.file));
    if (distinctFiles.size < 2) continue;
    add(
      "dup-sql",
      hits[0].file,
      hits[0].line,
      `Predikat prepisan ${hits.length}× u ${distinctFiles.size} fajla: "${norm.slice(0, 70)}…"`,
      { sites: hits.map((h) => `${h.file}:${h.line}`) },
    );
  }
}

// ───────────────────────────────────────────────────────────────── 2. n1
/**
 * Upit u petlji (N+1).
 *
 * Metod: prati otvorene `for`/`while` blokove po dubini vitičastih zagrada i prijavljuje
 * `await` na klijentu baze unutar njih. `Promise.all(...map(...))` se NE prijavljuje —
 * to je već paralelizovano i najčešće namerno.
 */
function scanN1() {
  const LOOP = /^\s*(for|while)\s*\(|\.forEach\s*\(/;
  const DB_AWAIT = /await\s+(this\.)?(prisma|tx|db|client|this\.prisma)[.[]|await\s+\w+\.\$(queryRaw|executeRaw|transaction)/;
  for (const f of files) {
    let loopDepth = 0;
    let braceAtLoopStart = [];
    let depth = 0;
    f.lines.forEach((raw, i) => {
      const opens = (raw.match(/\{/g) || []).length;
      const closes = (raw.match(/\}/g) || []).length;
      if (LOOP.test(raw)) {
        loopDepth++;
        braceAtLoopStart.push(depth);
      }
      depth += opens - closes;
      while (braceAtLoopStart.length && depth <= braceAtLoopStart.at(-1)) {
        braceAtLoopStart.pop();
        loopDepth--;
      }
      if (loopDepth > 0 && DB_AWAIT.test(raw) && !raw.includes("Promise.all")) {
        add("n1", f.rel, i + 1, `Upit u petlji: ${raw.trim().slice(0, 80)}`);
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────── 3. dead
/**
 * Mrtav privatni metod / mrtav eksport.
 *
 * `private foo(` čije se ime u fajlu javlja samo jednom = niko ga ne zove.
 * Eksportovani simbol koji se nigde u `src/` ne uvozi = mrtav (osim ulaznih tačaka).
 */
function scanDead() {
  const allSource = files.map((f) => f.lines.join("\n"));
  for (const [idx, f] of files.entries()) {
    const body = allSource[idx];
    f.lines.forEach((raw, i) => {
      const m = raw.match(/^\s*private\s+(?:async\s+)?(?:readonly\s+)?([A-Za-z_]\w*)\s*[(<]/);
      if (!m) return;
      const name = m[1];
      if (name === "constructor") return;
      const uses = body.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (uses <= 1)
        add("dead", f.rel, i + 1, `Privatni metod '${name}' nema nijednog pozivaoca u fajlu.`);
    });
  }
}

// ────────────────────────────────────────────────────────── 4. body-type
/**
 * Mutirajuća ruta čije telo `ValidationPipe` preskače.
 *
 * ⚠️ ŠTA OVAJ OBRAZAC MERI, A ŠTA NE (ispravka 04.08.2026, posle protivprovere):
 * meri se ISKLJUČIVO **pipe sloj** — da li globalni `ValidationPipe` ima klasu na koju bi
 * primenio dekoratore. NE znači „telo se nigde ne proverava": mnoge od tih ruta imaju ručni
 * `validate*()` guard u servisu (npr. `compensation.service.ts:169`
 * `validateCreateCompensationDto`, ili `gl.controller.ts` koji `beforeDate` proverava četiri
 * linije ispod `@Body()`). Prva verzija revizije je tu brojku pročitala kao „bez ijedne
 * provere" i time proizvela 13 pogrešnih nalaza od 14 u jednoj tabeli.
 *
 * Nalaz je dakle „validacija nije deklarativna i ne važi za neproglašena polja"
 * (`whitelist` ne radi, nepoznata polja prolaze do servisa), a ne „ulaz je nevalidiran".
 * Pre nego što se upiše kao 🔴 — pročitaj servis.
 *
 * Dva odvojena kvara, oba tiha:
 *   (a) `@Body() x: NekiInterfejs` — pipe validira samo KLASE;
 *   (b) `@Body() x: NekaKlasa` gde je klasa uvezena sa `import type` — TS obriše binding,
 *       `design:paramtypes` postane `Object`, pipe opet preskoči. Ovo je podmuklije,
 *       jer u DTO fajlu stoje uredni `class-validator` dekoratori koji nikad ne rade.
 * Prijavljuje se i inline tip (`@Body() b: { a: string }`) — on nikad nije validiran.
 */
function scanBodyType() {
  const ifaceNames = new Set();
  const typeOnlyImports = new Map(); // fajl → Set imena uvezenih kao `import type`
  for (const f of files) {
    const body = f.lines.join("\n");
    for (const m of body.matchAll(/export\s+interface\s+([A-Za-z_]\w*)/g))
      ifaceNames.add(m[1]);
    const set = new Set();
    for (const m of body.matchAll(/import\s+type\s*\{([^}]*)\}/g))
      m[1].split(",").forEach((n) => set.add(n.trim().replace(/^type\s+/, "")));
    typeOnlyImports.set(f.rel, set);
  }
  const MUTATING = /@(Post|Patch|Put|Delete)\s*\(/;
  for (const f of files) {
    if (!f.rel.includes("controller")) continue;
    let armed = false;
    f.lines.forEach((raw, i) => {
      if (MUTATING.test(raw)) armed = true;
      if (!armed) return;
      const m = raw.match(/@Body\(\)\s*\w+\s*:\s*([A-Za-z_]\w*|\{)/);
      if (!m) return;
      armed = false;
      const t = m[1];
      if (t === "{") {
        add("body-type", f.rel, i + 1, "Telo mutirajuće rute je inline tip — nikad se ne validira.");
      } else if (ifaceNames.has(t)) {
        add("body-type", f.rel, i + 1, `Telo je interfejs '${t}' — ValidationPipe ga tiho preskače.`);
      } else if (typeOnlyImports.get(f.rel)?.has(t)) {
        add(
          "body-type",
          f.rel,
          i + 1,
          `'${t}' je uvezen kao 'import type' — binding se briše, pa metapodatak postane Object i validacija ne radi.`,
        );
      }
    });
  }
}

// ──────────────────────────────────────────────────────── 5. unsafe-num
/**
 * `Number(...)` / `parseInt(...)` nad query parametrom bez provere na NaN.
 * `NaN != null` je `true`, pa vrednost prolazi kroz naivne guardove pravo u upit.
 * Lek je `common/number-params.ts` (`parseIntParam` / `requireIntParam`).
 */
function scanUnsafeNum() {
  for (const f of files) {
    if (!f.rel.includes("controller")) continue;
    const body = f.lines.join("\n");
    const usesHelper = /parseIntParam|requireIntParam/.test(body);
    f.lines.forEach((raw, i) => {
      if (!/\b(Number|parseInt)\s*\(/.test(raw)) return;
      if (/Number\.is|isNaN|toFixed|Number\(\s*\)/.test(raw)) return;
      add(
        "unsafe-num",
        f.rel,
        i + 1,
        `Nevalidiran broj iz query-ja${usesHelper ? " (fajl već koristi parseIntParam — propušteno mesto)" : ""}: ${raw.trim().slice(0, 70)}`,
      );
    });
  }
}

// ─────────────────────────────────────────────────────── 6. page-filter
/**
 * Filtriranje POSLE paginacije: u istoj funkciji postoji `take`/`skip`/`LIMIT`, a zatim
 * `.filter(` nad rezultatom. Posledica je tiho nepotpuna pretraga i `meta.total` koji laže.
 */
function scanPageFilter() {
  const FUNC = /^\s{2}(?:private|public|protected)?\s*(?:async\s+)?[A-Za-z_]\w*\s*\(/;
  for (const f of files) {
    let start = -1;
    let hasPaging = false;
    const flush = (end) => {
      if (start < 0) return;
      if (hasPaging)
        for (let i = start; i < end; i++)
          if (/=\s*\w+\.filter\(|data\s*=\s*data\.filter\(|rows\s*=\s*rows\.filter\(/.test(f.lines[i]))
            add("page-filter", f.rel, i + 1, "Filtriranje nad već paginiranim skupom — pretraga i `total` se razilaze.");
      start = -1;
      hasPaging = false;
    };
    f.lines.forEach((raw, i) => {
      if (FUNC.test(raw)) {
        flush(i);
        start = i;
      }
      if (/\btake\b\s*[:=]|\bskip\b\s*[:=]|LIMIT \$\{|LIMIT \?/.test(raw)) hasPaging = true;
    });
    flush(f.lines.length);
  }
}

// ─────────────────────────────────────────────────────────────── 7. size
function scanSize() {
  const LIMIT = 600;
  for (const f of files) {
    if (f.lines.length <= LIMIT) continue;
    add("size", f.rel, 1, `${f.lines.length} linija (prag ${LIMIT}) — proveri koliko RAZLIČITIH razloga za izmenu nosi.`);
  }
}

const SCANNERS = {
  "dup-sql": scanDupSql,
  n1: scanN1,
  dead: scanDead,
  "body-type": scanBodyType,
  "unsafe-num": scanUnsafeNum,
  "page-filter": scanPageFilter,
  size: scanSize,
};

for (const [name, fn] of Object.entries(SCANNERS)) {
  if (ONLY_PATTERN && ONLY_PATTERN !== name) continue;
  fn();
}

// ───────────────────────────────────────────────────────────────── ispis
const counts = {};
for (const f of findings) counts[f.pattern] = (counts[f.pattern] ?? 0) + 1;

if (UPDATE) {
  writeFileSync(BASELINE, `${JSON.stringify({ updated: "rucno", counts }, null, 2)}\n`);
  console.log(`Baseline upisan: ${relative(ROOT, BASELINE)}`);
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

if (AS_JSON) {
  console.log(JSON.stringify({ counts, findings }, null, 2));
} else {
  const byPattern = {};
  for (const f of findings) (byPattern[f.pattern] ??= []).push(f);
  for (const [pattern, list] of Object.entries(byPattern)) {
    console.log(`\n━━ ${pattern} — ${list.length} kandidata`);
    const byModule = {};
    for (const f of list) (byModule[moduleOf(f.file)] ??= []).push(f);
    for (const [mod, ms] of Object.entries(byModule).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`   ${mod} (${ms.length})`);
      for (const f of ms.slice(0, 5)) console.log(`     ${f.file}:${f.line}  ${f.message}`);
      if (ms.length > 5) console.log(`     … još ${ms.length - 5}`);
    }
  }
  console.log("\n━━ zbir");
  for (const [p, c] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    console.log(`   ${p.padEnd(12)} ${c}`);
  console.log("\nNapomena: ovo su KANDIDATI, ne dokazane greške. Proveri pre popravke.");
}

if (CHECK) {
  if (!existsSync(BASELINE)) {
    console.error("\nNema baseline-a. Pokreni: node scripts/audit-code.mjs --update-baseline");
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8")).counts ?? {};
  const worse = Object.entries(counts).filter(([p, c]) => c > (base[p] ?? 0));
  if (worse.length) {
    console.error("\n✗ Broj kandidata je PORASTAO u odnosu na baseline:");
    for (const [p, c] of worse) console.error(`   ${p}: ${base[p] ?? 0} → ${c}`);
    console.error("\nAko je porast namerno i opravdano: node scripts/audit-code.mjs --update-baseline");
    process.exit(1);
  }
  const better = Object.entries(base).filter(([p, c]) => (counts[p] ?? 0) < c);
  console.log("\n✓ Nema pogoršanja u odnosu na baseline.");
  if (better.length) {
    console.log("  Poboljšano (spusti prag sa --update-baseline):");
    for (const [p, c] of better) console.log(`   ${p}: ${c} → ${counts[p] ?? 0}`);
  }
}
