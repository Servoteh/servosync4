/**
 * DOKAZ NA TEST BAZI — probno knjiženje robnih dokumenata po ŠEMAMA ZA KONTIRANJE.
 * ============================================================================
 * Knjigovođa je šeme potvrdio USLOVNO: „potvrditi svih šest, ali tek posle probnog
 * knjiženja po jednog dokumenta svake vrste na test bazi i poređenja sa starim
 * nalogom". Ovaj skript je to probno knjiženje.
 *
 * ŠTA RADI (redom):
 *   0. BRANA — odbija da radi nad bilo kojom bazom osim `servosync_probno` na dev
 *      kontejneru. Produkcija (`servosync-pg`) je READ-ONLY i ovaj skript je ne dodiruje.
 *   1. Veže šest vrsta dokumenata za šeme (`document_types.posting_template`), tačno
 *      onim vrednostima koje predlaže `backend/docs/SEME_KONTIRANJA.md` §4.4:
 *      IFR→33, IFGP→36, IZVRO→24, IZVGP→47, MANJR→50, VISAR→46.
 *   2. Pravi po JEDAN robni dokument svake vrste sa PROSTIM brojevima (1 kom,
 *      nabavna 6.000, VP 10.000, PDV 20 %) — da se svaki red naloga proveri napamet.
 *   3. Knjiži ih PRAVIM motorom (`PostingEngineService.postFromStockDocument`) —
 *      ne ručno sklopljenim SQL-om. Poenta je dokazati motor, ne tabelu.
 *   4. Ispisuje nalog KAKO JE LEGAO U BAZU (čita `journal_entries`/`ledger_entries`,
 *      ne povratnu vrednost funkcije) i poredi ga sa ETALONOM — kontima i stranama
 *      koje stari program (BigBit) stvarno proizvodi, izmerenim nad uvezenom knjigom
 *      2026 na produkciji.
 *   5. Vozi provere koje se lako previde: balans, `document_number`/`due_date` na redu,
 *      analitika (komitent), prazan/nepostojeći dokument, dokument bez stavki,
 *      IFGP sa stavkom na 10 % (šema 36 nema liniju za Q), i zaokruživanje ispod pare.
 *
 * ŠTA NE RADI: ne menja nijednu šemu (to je knjigovođin posao, ne naš) i ne dira
 * produkciju. Razilaženja se SAMO zapisuju.
 *
 * Pokretanje:
 *   npx ts-node --transpile-only scripts/proof-knjizenje-po-semama.ts
 * (Kredencijali se čitaju iz `backend/.env.dev`; ime baze se PRINUDNO menja u
 *  `servosync_probno` — dev baza `servosync` se takođe ne dira.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PostingEngineService } from "../src/modules/gl/posting/posting.service";

// ───────────────────────────────────────────────────────────────────────────────
// 0) BRANA — samo test baza
// ───────────────────────────────────────────────────────────────────────────────
const TEST_DB = "servosync_probno";
const envPath = path.join(__dirname, "..", ".env.dev");
const devUrl = /postgresql:\/\/[^"\s]+/.exec(
  fs.readFileSync(envPath, "utf8"),
)![0];
const url = devUrl
  .replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`)
  .replace("?schema=public", "");
if (!url.includes(`/${TEST_DB}`)) {
  throw new Error(
    `BRANA: URL ne pokazuje na ${TEST_DB} — odbijam da radim. URL=${url}`,
  );
}
if (/servosync-pg|:5435|api\.servosync/.test(url)) {
  throw new Error("BRANA: URL miriše na PRODUKCIJU — odbijam da radim.");
}

const prisma = new PrismaClient({ datasources: { db: { url } } });
const engine = new PostingEngineService(prisma as never);

const D = Prisma.Decimal;
const MARK = "ZZ-PROBA-SEME";
let fail = 0;
const log = (s = "") => console.log(s);
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) fail += 1;
  log(`  ${ok ? "OK  " : "PAO "} ${name} — ${detail}`);
};

/** Iznos u srpskom formatu, 2 decimale (1.234,50). Za ispis u izveštaju. */
function fmt(v: Prisma.Decimal | number | string, dec = 2): string {
  const n = new D(v);
  const s = n.abs().toFixed(dec);
  const [cel, dc] = s.split(".");
  const grupisano = cel.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n.isNegative() ? "-" : ""}${grupisano},${dc}`;
}
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
const padL = (s: string, n: number) =>
  " ".repeat(Math.max(0, n - s.length)) + s;

// ───────────────────────────────────────────────────────────────────────────────
// ETALON — šta STARI PROGRAM (BigBit) stvarno proizvodi.
// Izmereno nad uvezenom knjigom 2026 na produkciji (samo SELECT):
//   select je.order_type_code, le.account_code, sum(le.debit), sum(le.credit)
//   from ledger_entries le join journal_entries je on je.id = le.journal_entry_id
//   group by 1,2;
// „—" = vrsta nema nijedan proknjižen dokument u 2026, pa se poredi samo sa šemom.
// ───────────────────────────────────────────────────────────────────────────────
type Strana = "DUG" | "POT";
interface Etalon {
  konta: Array<{ konto: string; strana: Strana }>;
  izvor: string;
}
const ETALON: Record<string, Etalon> = {
  IFR: {
    izvor: "BigBit, 167 dokumenata u 2026 (nalozi vrste IFR)",
    konta: [
      { konto: "2040", strana: "DUG" },
      { konto: "4702", strana: "POT" },
      { konto: "6040", strana: "POT" },
      { konto: "1320", strana: "POT" },
      { konto: "5010", strana: "DUG" },
    ],
  },
  IFGP: {
    izvor: "BigBit, 26 dokumenata u 2026 (nalozi vrste IFGP)",
    konta: [
      { konto: "2040", strana: "DUG" },
      { konto: "4701", strana: "POT" },
      { konto: "6141", strana: "POT" },
      { konto: "9600", strana: "POT" },
      { konto: "9800", strana: "DUG" },
    ],
  },
  IZVRO: {
    izvor:
      "NEMA ETALONA — u 2026 nijedan izvoz robe nije knjižen; poredi se sa šemom 24",
    konta: [],
  },
  IZVGP: {
    izvor:
      "NEMA ETALONA — u 2026 nijedan izvoz proizvoda nije knjižen; poredi se sa šemom 47",
    konta: [],
  },
  MANJR: {
    izvor:
      "NEMA ETALONA — u 2026 nijedan manjak robe nije knjižen; poredi se sa šemom 50",
    konta: [],
  },
  VISAR: {
    izvor:
      "BigBit, 1 dokument u 2026 (nalog vrste VISAK — v. §6/P6, vrsta VISAR ne postoji u registru)",
    konta: [
      { konto: "1320", strana: "DUG" },
      { konto: "6740", strana: "POT" },
    ],
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// Prosti brojevi — svaki red naloga mora da se proveri napamet.
// ───────────────────────────────────────────────────────────────────────────────
const KOL = new D(1); //     1 komad
const NABAVNA = new D(6000); // nabavna neto cena / JM  → slot A = 6.000
const VP = new D(10000); //   veleprodajna cena / JM    → slot O = 10.000
const TARIFA_20 = "3"; //     20 % (VISA)               → slot P = 2.000
const TARIFA_0 = "1"; //      0 % (BEZPDV, izvoz)       → slot P = 0

const KUPAC_DOMACI = 11568; // FMB d.o.o. (kopiran sa produkcije)
const KUPAC_INO = 11570; //    9. septembar — Tissue Converting d.o.o. (koristi se kao inostrani kupac)
const ARTIKAL = 2; //          „Razvodni blok, 4-položajni, CD01", Kom.
const MAG_ROBA = 1; //         Magacin robe (konto 1320)
const MAG_GP = 44; //          Gotovi proizvodi (konto 9600)
const GODINA = 2026;
const DATUM = new Date("2026-08-05T10:00:00.000Z");

interface Proba {
  vrsta: string;
  semaId: number;
  naziv: string;
  kind: string;
  magacin: number;
  kupac: number | null;
  tarifa: string;
  /** Očekivani nalog izračunat NAPAMET iz formula šeme — kontrola motora. */
  ocekivano: Array<{ konto: string; dug: number; pot: number; kako: string }>;
}

const PROBE: Proba[] = [
  {
    vrsta: "IFR",
    semaId: 33,
    naziv: "Izlazna faktura — roba (izdatnica)",
    kind: "IZ",
    magacin: MAG_ROBA,
    kupac: KUPAC_DOMACI,
    tarifa: TARIFA_20,
    ocekivano: [
      { konto: "2040", dug: 12000, pot: 0, kako: "O+P+Q = 10.000 + 2.000 + 0" },
      { konto: "4702", dug: 0, pot: 2000, kako: "P = 20 % od 10.000" },
      { konto: "6040", dug: 0, pot: 10000, kako: "O" },
      { konto: "1320", dug: 0, pot: 6000, kako: "A" },
      { konto: "5010", dug: 6000, pot: 0, kako: "A" },
    ],
  },
  {
    vrsta: "IFGP",
    semaId: 36,
    naziv: "Izlazna faktura — gotov proizvod",
    kind: "IZ",
    magacin: MAG_GP,
    kupac: KUPAC_DOMACI,
    tarifa: TARIFA_20,
    ocekivano: [
      { konto: "2040", dug: 12000, pot: 0, kako: "O+P = 10.000 + 2.000" },
      { konto: "6141", dug: 0, pot: 10000, kako: "O" },
      { konto: "4701", dug: 0, pot: 2000, kako: "P" },
      { konto: "9600", dug: 0, pot: 6000, kako: "A" },
      { konto: "9800", dug: 6000, pot: 0, kako: "A" },
    ],
  },
  {
    vrsta: "IZVRO",
    semaId: 24,
    naziv: "Izvozna faktura — roba",
    kind: "IZ",
    magacin: MAG_ROBA,
    kupac: KUPAC_INO,
    tarifa: TARIFA_0,
    ocekivano: [
      { konto: "2050", dug: 10000, pot: 0, kako: "O (izvoz je bez PDV-a)" },
      { konto: "6050", dug: 0, pot: 10000, kako: "O" },
      { konto: "1320", dug: 0, pot: 6000, kako: "A" },
      { konto: "5013", dug: 6000, pot: 0, kako: "A" },
    ],
  },
  {
    vrsta: "IZVGP",
    semaId: 47,
    naziv: "Izvozna faktura — gotov proizvod",
    kind: "IZ",
    magacin: MAG_GP,
    kupac: KUPAC_INO,
    tarifa: TARIFA_0,
    ocekivano: [
      { konto: "2050", dug: 10000, pot: 0, kako: "O" },
      { konto: "6150", dug: 0, pot: 10000, kako: "O" },
      { konto: "9800", dug: 6000, pot: 0, kako: "A" },
      { konto: "9600", dug: 0, pot: 6000, kako: "A" },
    ],
  },
  {
    vrsta: "MANJR",
    semaId: 50,
    naziv: "Manjak robe (popis)",
    kind: "MANJAK",
    magacin: MAG_ROBA,
    kupac: null, // popis nema komitenta — namerno, da se vidi šta se upiše u analitiku
    tarifa: TARIFA_20,
    ocekivano: [
      { konto: "1320", dug: 0, pot: 6000, kako: "A" },
      {
        konto: "4700",
        dug: 0,
        pot: 2000,
        kako: "P = 20 % od VP cene sa dokumenta",
      },
      { konto: "6040", dug: 0, pot: 6000, kako: "A (ne O!)" },
      { konto: "5010", dug: 6000, pot: 0, kako: "A" },
      { konto: "5741", dug: 8000, pot: 0, kako: "A+P = 6.000 + 2.000" },
    ],
  },
  {
    vrsta: "VISAR",
    semaId: 46,
    naziv: "Višak robe (popis)",
    kind: "VISAK",
    magacin: MAG_ROBA,
    kupac: null,
    tarifa: TARIFA_20,
    ocekivano: [
      { konto: "1320", dug: 6000, pot: 0, kako: "A" },
      { konto: "6740", dug: 0, pot: 6000, kako: "A" },
    ],
  },
];

// ───────────────────────────────────────────────────────────────────────────────
// Pomoćne
// ───────────────────────────────────────────────────────────────────────────────

/** Očisti sve što je skript ikad napravio (ponovljivost). */
async function ocisti() {
  const dokumenti = await prisma.stockDocument.findMany({
    where: { note: MARK },
    select: { id: true },
  });
  const ids = dokumenti.map((d) => d.id);
  if (ids.length) {
    await prisma.journalEntry.deleteMany({
      where: { sourceGoodsDocId: { in: ids } },
    });
    // Okidač `POSTED_DELETE_FORBIDDEN` brani brisanje proknjiženog robnog dokumenta
    // (ista brana koja štiti produkciju) — probne dokumente zato prvo vrati u DRAFT.
    await prisma.stockDocument.updateMany({
      where: { id: { in: ids } },
      data: { status: "DRAFT", journalEntryId: null },
    });
    await prisma.stockDocument.deleteMany({ where: { id: { in: ids } } });
  }
  return ids.length;
}

let brojac = 9000;
/** Napravi robni dokument sa JEDNOM stavkom po zadatim cenama. */
async function napraviDokument(p: {
  vrsta: string;
  kind: string;
  magacin: number;
  kupac: number | null;
  kolicina?: Prisma.Decimal;
  nabavna?: Prisma.Decimal;
  vp?: Prisma.Decimal;
  tarifa: string;
  bezStavki?: boolean;
}): Promise<number> {
  brojac += 1;
  const doc = await prisma.stockDocument.create({
    data: {
      companyId: 0,
      kind: p.kind,
      documentTypeCode: p.vrsta,
      documentNumber: `${brojac}/${GODINA}`,
      year: GODINA,
      warehouseId: p.magacin,
      customerId: p.kupac,
      documentDate: DATUM,
      postingDate: DATUM,
      status: "DRAFT",
      note: MARK,
      items: p.bezStavki
        ? undefined
        : {
            create: [
              {
                itemId: ARTIKAL,
                warehouseId: p.magacin,
                lineNo: 1,
                quantity: p.kolicina ?? KOL,
                purchasePriceNet: p.nabavna ?? NABAVNA,
                calculatedWholesalePrice: p.vp ?? VP,
                actualWholesalePrice: p.vp ?? VP,
                goodsTaxRateCode: p.tarifa,
              },
            ],
          },
    },
  });
  return doc.id;
}

interface Red {
  konto: string;
  dug: Prisma.Decimal;
  pot: Prisma.Decimal;
  analitika: number | null;
  opis: string | null;
  brojDokumenta: string | null;
  valuta: string | null;
  dospece: Date | null;
  izvorniDok: number | null;
}

/** Pročitaj nalog KAKO JE LEGAO U BAZU (ne povratnu vrednost motora). */
async function procitajNalog(docId: number) {
  const nalog = await prisma.journalEntry.findFirst({
    where: { sourceGoodsDocId: docId },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!nalog) return null;
  const redovi: Red[] = nalog.lines.map((l) => ({
    konto: l.accountCode,
    dug: l.debit,
    pot: l.credit,
    analitika: l.analyticalCode,
    opis: l.description,
    brojDokumenta: l.documentNumber,
    valuta: l.currency,
    dospece: l.dueDate,
    izvorniDok: l.sourceGoodsDocId,
  }));
  return { nalog, redovi };
}

// ───────────────────────────────────────────────────────────────────────────────
// GLAVNI TOK
// ───────────────────────────────────────────────────────────────────────────────
async function main() {
  log("═".repeat(100));
  log("PROBNO KNJIŽENJE PO ŠEMAMA ZA KONTIRANJE — test baza servosync_probno");
  log(`Baza: ${url.replace(/:[^:@]*@/, ":***@")}`);
  log("═".repeat(100));

  const obrisano = await ocisti();
  if (obrisano) log(`(očišćeno ${obrisano} zatečenih probnih dokumenata)`);

  // ── KORAK 1: veži vrste dokumenata za šeme ───────────────────────────────────
  log("");
  log(
    "KORAK 1 — VEZIVANJE VRSTA DOKUMENATA ZA ŠEME (document_types.posting_template)",
  );
  log("─".repeat(100));
  for (const p of PROBE) {
    await prisma.documentType.updateMany({
      where: { code: p.vrsta },
      data: { postingTemplate: p.semaId },
    });
  }
  const vezano = await prisma.documentType.findMany({
    where: { code: { in: PROBE.map((p) => p.vrsta) } },
    orderBy: { code: "asc" },
  });
  for (const dt of vezano) {
    const sema = await prisma.accountingScheme.findUnique({
      where: { id: dt.postingTemplate ?? 0 },
    });
    check(
      `${pad(dt.code, 6)}→ šema ${dt.postingTemplate}`,
      sema != null,
      sema
        ? `„${sema.description}" (vrsta naloga ${sema.orderType})${
            sema.orderType === dt.code
              ? ""
              : "  ⚠ vrsta naloga ≠ vrsta dokumenta"
          }`
        : "ŠEMA NE POSTOJI",
    );
  }

  // ── KORAK 2+3+4: napravi, proknjiži, uporedi ─────────────────────────────────
  const rezime: Array<{ vrsta: string; ocena: string; napomena: string }> = [];

  for (const p of PROBE) {
    log("");
    log("═".repeat(100));
    log(`${p.vrsta} — ${p.naziv}`);
    log("═".repeat(100));

    const semaLinije = await prisma.accountingSchemeLine.findMany({
      where: { schemeId: p.semaId },
      orderBy: [{ lineNo: "asc" }, { id: "asc" }],
    });
    const sema = await prisma.accountingScheme.findUniqueOrThrow({
      where: { id: p.semaId },
    });

    log(
      `Šema ${p.semaId} „${sema.description}", vrsta naloga ${sema.orderType}`,
    );
    log("Linije šeme (formule nad slotovima):");
    for (const l of semaLinije) {
      log(
        `   ${pad(l.accountCode, 6)} dug=${pad(l.defDebit ?? "", 8)} pot=${pad(
          l.defCredit ?? "",
          8,
        )} analitika=${l.postsAnalytics ? "DA" : "NE"}${
          l.description ? `  opis=„${l.description}"` : ""
        }`,
      );
    }

    const docId = await napraviDokument(p);
    const stopa = p.tarifa === TARIFA_20 ? "20 %" : "0 %";
    const pdv = p.tarifa === TARIFA_20 ? VP.mul("0.20") : new D(0);
    log("");
    log(
      `Robni dokument #${docId}: 1 kom × nabavna ${fmt(NABAVNA)} · VP ${fmt(
        VP,
      )} · tarifa ${p.tarifa} (${stopa}) · komitent ${p.kupac ?? "—(popis)"}`,
    );
    log(
      `Slotovi:  A (nabavna) = ${fmt(NABAVNA)}   O (prodajna osnovica) = ${fmt(
        VP,
      )}   P (izlazni PDV 20 %) = ${fmt(pdv)}   Q (10 %) = 0,00`,
    );

    let procitano: Awaited<ReturnType<typeof procitajNalog>> = null;
    try {
      await engine.postFromStockDocument(docId);
      procitano = await procitajNalog(docId);
    } catch (e) {
      fail += 1;
      log(`  PAO  knjiženje — ${(e as Error).name}: ${(e as Error).message}`);
      rezime.push({
        vrsta: p.vrsta,
        ocena: "PAO",
        napomena: (e as Error).message,
      });
      continue;
    }
    if (!procitano) {
      fail += 1;
      log("  PAO  motor nije napravio nalog");
      rezime.push({ vrsta: p.vrsta, ocena: "PAO", napomena: "nema naloga" });
      continue;
    }
    const { nalog, redovi } = procitano;

    // ── Nalog kako je legao u bazu ──────────────────────────────────────────────
    log("");
    log(
      `NALOG ${nalog.number} · vrsta ${nalog.orderTypeCode} · godina ${nalog.year} · status ${nalog.status}`,
    );
    log(
      `  ${pad("konto", 7)}${pad("strana", 8)}${padL("iznos", 14)}   ${pad(
        "kako se dobija",
        34,
      )}${pad("analitika", 11)}opis`,
    );
    log("  " + "─".repeat(96));
    let sDug = new D(0);
    let sPot = new D(0);
    for (const r of redovi) {
      sDug = sDug.add(r.dug);
      sPot = sPot.add(r.pot);
      const strana = r.dug.gt(0) ? "DUG" : r.pot.gt(0) ? "POT" : "—";
      const iznos = r.dug.gt(0) ? r.dug : r.pot;
      const ocek = p.ocekivano.find((o) => o.konto === r.konto);
      log(
        `  ${pad(r.konto, 7)}${pad(strana, 8)}${padL(fmt(iznos), 14)}   ${pad(
          ocek?.kako ?? "?",
          34,
        )}${pad(r.analitika === null ? "—" : String(r.analitika), 11)}${
          r.opis === null ? "—" : `„${r.opis}"`
        }`,
      );
    }
    log("  " + "─".repeat(96));
    log(`  ${pad("", 7)}${pad("ΣDug", 8)}${padL(fmt(sDug), 14)}`);
    log(`  ${pad("", 7)}${pad("ΣPot", 8)}${padL(fmt(sPot), 14)}`);

    // ── Provere ─────────────────────────────────────────────────────────────────
    log("");
    log("  Provere:");
    check(
      "balans u BAZI (ΣDug = ΣPot)",
      sDug.equals(sPot),
      `${fmt(sDug)} : ${fmt(sPot)}`,
    );

    // iznosi red po red naspram ručnog računa
    let iznosiOk = true;
    for (const o of p.ocekivano) {
      const r = redovi.find((x) => x.konto === o.konto);
      const ok =
        r != null && r.dug.equals(new D(o.dug)) && r.pot.equals(new D(o.pot));
      if (!ok) iznosiOk = false;
      if (!ok) {
        log(
          `    razilaženje na ${o.konto}: očekivano dug=${fmt(o.dug)} pot=${fmt(
            o.pot,
          )}, dobijeno ${r ? `dug=${fmt(r.dug)} pot=${fmt(r.pot)}` : "REDA NEMA"}`,
        );
      }
    }
    check(
      "iznosi red po red = ručni račun",
      iznosiOk,
      `${p.ocekivano.length} očekivanih redova`,
    );

    const viskovi = redovi.filter(
      (r) => !p.ocekivano.some((o) => o.konto === r.konto),
    );
    check(
      "nema neočekivanih redova",
      viskovi.length === 0,
      viskovi.map((v) => v.konto).join(", ") || "—",
    );

    // nula-redovi iz šeme koji su odbačeni
    const odbaceni = semaLinije
      .map((l) => l.accountCode)
      .filter((k) => !redovi.some((r) => r.konto === k));
    if (odbaceni.length) {
      log(
        `    napomena: linije šeme sa nula-iznosom su odbačene (legacy „2Korak"): ${odbaceni.join(", ")}`,
      );
    }

    const saAnalitikom = redovi.filter((r) => r.analitika !== null).length;
    check(
      "analitika (komitent) na redovima",
      p.kupac === null ? saAnalitikom === 0 : saAnalitikom === redovi.length,
      p.kupac === null
        ? `dokument nema komitenta (popis) → svih ${redovi.length} redova ima praznu analitiku`
        : `${saAnalitikom}/${redovi.length} redova nosi šifru ${p.kupac}`,
    );

    const saBrojem = redovi.filter((r) => r.brojDokumenta !== null).length;
    check(
      "document_number na redovima",
      saBrojem === redovi.length,
      saBrojem === 0
        ? `NIJEDAN red nema broj dokumenta (svi NULL) — otvorene stavke se slepe u jednu (§3.6a)`
        : `${saBrojem}/${redovi.length}`,
    );
    const saDospecem = redovi.filter((r) => r.dospece !== null).length;
    check(
      "due_date (valuta/dospeće) na redovima",
      saDospecem === redovi.length,
      saDospecem === 0
        ? "NIJEDAN red nema dospeće (svi NULL) — aging sve baca u 0–30 dana"
        : `${saDospecem}/${redovi.length}`,
    );
    check(
      "traceback source_goods_doc_id",
      redovi.every((r) => r.izvorniDok === docId),
      `svi redovi pokazuju na robni dokument ${docId}`,
    );

    const doc = await prisma.stockDocument.findUniqueOrThrow({
      where: { id: docId },
    });
    check(
      "robni dokument zatvoren",
      doc.status === "POSTED" && doc.journalEntryId === nalog.id,
      `status=${doc.status}, journal_entry_id=${doc.journalEntryId}`,
    );

    // Vrsta naloga: motor je uzima iz ŠEME (scheme.orderType), a BigBit sa DOKUMENTA.
    // Ako te šifre nema u registru `order_types`, nalog dobija visišta šifru — na
    // `journal_entries.order_type_code` NEMA stranog ključa pa to ne pukne glasno (§6/P6).
    const vrstaNaloga = await prisma.orderType.findUnique({
      where: { code: nalog.orderTypeCode },
    });
    check(
      "vrsta naloga postoji u registru order_types",
      vrstaNaloga != null,
      vrstaNaloga
        ? `„${vrstaNaloga.description}"`
        : `šifre „${nalog.orderTypeCode}" NEMA u registru od 117 vrsta — nalog nosi nepostojeću vrstu`,
    );

    // ── Poređenje sa ETALONOM ───────────────────────────────────────────────────
    const et = ETALON[p.vrsta];
    log("");
    log(`  POREĐENJE SA STARIM PROGRAMOM — ${et.izvor}`);
    if (et.konta.length === 0) {
      log(
        "    (nema etalona; nalog je gore proveren protiv linija šeme i ručnog računa)",
      );
      rezime.push({
        vrsta: p.vrsta,
        ocena:
          iznosiOk && sDug.equals(sPot)
            ? "POKLAPA SE SA ŠEMOM"
            : "RAZLIKUJE SE",
        napomena: "bez etalona u 2026",
      });
    } else {
      log(
        `    ${pad("konto", 8)}${pad("naše (strana)", 16)}${pad("BigBit (strana)", 18)}ocena`,
      );
      log("    " + "─".repeat(60));
      const svaKonta = [
        ...new Set([
          ...et.konta.map((k) => k.konto),
          ...redovi.map((r) => r.konto),
        ]),
      ].sort();
      let etalonOk = true;
      for (const k of svaKonta) {
        const nase = redovi.find((r) => r.konto === k);
        const naseStrana: string = nase
          ? nase.dug.gt(0)
            ? "DUG"
            : "POT"
          : "—";
        const bb = et.konta.find((x) => x.konto === k);
        const bbStrana: string = bb ? bb.strana : "—";
        const ok = naseStrana === bbStrana;
        if (!ok) etalonOk = false;
        log(
          `    ${pad(k, 8)}${pad(naseStrana, 16)}${pad(bbStrana, 18)}${ok ? "poklapa se" : "RAZLIKA"}`,
        );
      }
      check(
        "konta i strane = BigBit etalon",
        etalonOk,
        etalonOk ? "svih redova" : "vidi tabelu",
      );
      rezime.push({
        vrsta: p.vrsta,
        ocena:
          etalonOk && iznosiOk && sDug.equals(sPot)
            ? "POKLAPA SE"
            : "RAZLIKUJE SE",
        napomena: et.izvor,
      });
    }
  }

  // ── KORAK 5: ono što se lako previdi ─────────────────────────────────────────
  log("");
  log("═".repeat(100));
  log("KORAK 5 — PROVERE KOJE SE LAKO PREVIDE");
  log("═".repeat(100));

  // 5.1 nepostojeći robni dokument
  log("");
  log("5.1 — knjiženje NEPOSTOJEĆEG robnog dokumenta (id 999999)");
  try {
    await engine.postFromStockDocument(999999);
    check(
      "nepostojeći dokument je odbijen",
      false,
      "motor je PROŠAO bez greške",
    );
  } catch (e) {
    const err = e as Error & { code?: string };
    const poruka = String(err.message)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    check(
      "nepostojeći dokument je odbijen",
      true,
      `${err.name}${err.code ? ` (${err.code})` : ""}`,
    );
    log(`    poruka koju motor vraća: „${poruka}"`);
    log(
      "    ⚠ poruka je Prismina i na engleskom, i NIJE HttpException → globalni filter je pretvara",
    );
    log(
      `      u HTTP 500 (poruka „Neočekivana greška na serveru…"), a ne u 404 (§4.2).`,
    );
  }

  // 5.2 vrsta bez šeme (posting_template = 0)
  log("");
  log(
    "5.2 — vrsta dokumenta BEZ šeme (posting_template = 0, kao danas na produkciji)",
  );
  const bezSemeId = await napraviDokument({
    vrsta: "REV",
    kind: "IZ",
    magacin: MAG_ROBA,
    kupac: KUPAC_DOMACI,
    tarifa: TARIFA_20,
  });
  try {
    await engine.postFromStockDocument(bezSemeId);
    check("dokument bez šeme je odbijen", false, "motor je PROŠAO bez greške");
  } catch (e) {
    const err = e as Error & { code?: string };
    check(
      "dokument bez šeme je odbijen",
      err.code === "GL_NO_SCHEME",
      `${err.name} / ${err.code ?? "—"}`,
    );
    log(`    poruka: ${err.message}`);
  }

  // 5.3 dokument BEZ STAVKI
  log("");
  log("5.3 — dokument vrste IFR ali BEZ IJEDNE STAVKE (prazan robni dokument)");
  const prazanId = await napraviDokument({
    vrsta: "IFR",
    kind: "IZ",
    magacin: MAG_ROBA,
    kupac: KUPAC_DOMACI,
    tarifa: TARIFA_20,
    bezStavki: true,
  });
  try {
    const linije = await engine.postFromStockDocument(prazanId);
    const p = await procitajNalog(prazanId);
    const docPosle = await prisma.stockDocument.findUniqueOrThrow({
      where: { id: prazanId },
    });
    check(
      "prazan dokument NE pravi nalog bez stavki",
      false,
      `motor je prošao: vratio ${linije.length} linija, nalog ${
        p ? `${p.nalog.number} sa ${p.redovi.length} redova` : "nije napravljen"
      }, dokument je sad status=${docPosle.status}`,
    );
    log(
      "    🔴 TIHA RUPA: prazan dokument balansira (0 = 0), dobija broj naloga i prelazi u POSTED,",
    );
    log(
      "       posle čega je nepromenjiv — a u glavnoj knjizi nema nijedan red.",
    );
  } catch (e) {
    check(
      "prazan dokument je odbijen",
      true,
      `${(e as Error).name}: ${(e as Error).message}`,
    );
  }

  // 5.4 ponovno knjiženje (idempotencija) — motor NE sme napraviti dupli nalog
  log("");
  log("5.4 — ponovno knjiženje istog dokumenta (idempotencija)");
  const ifrDoc = await prisma.stockDocument.findFirstOrThrow({
    where: { note: MARK, documentTypeCode: "IFR", items: { some: {} } },
  });
  const preNalog = await prisma.journalEntry.findFirstOrThrow({
    where: { sourceGoodsDocId: ifrDoc.id },
  });
  let ponovoPoruka: string;
  try {
    await engine.postFromStockDocument(ifrDoc.id);
    ponovoPoruka = "motor je prošao (re-post preko DRAFT naloga)";
  } catch (e) {
    const err = e as Error & { code?: string };
    ponovoPoruka = `odbijeno: ${err.name} / ${err.code ?? "—"}`;
  }
  const posleBroj = await prisma.journalEntry.count({
    where: { sourceGoodsDocId: ifrDoc.id },
  });
  check(
    "NEMA duplog naloga posle ponovnog knjiženja",
    posleBroj === 1,
    `${ponovoPoruka}; naloga za dokument ${ifrDoc.id}: ${posleBroj}`,
  );
  const posleNalog = await prisma.journalEntry.findFirstOrThrow({
    where: { sourceGoodsDocId: ifrDoc.id },
  });
  log(
    `    stari nalog ${preNalog.number} (id ${preNalog.id}) → novi ${posleNalog.number} (id ${posleNalog.id}); ` +
      `status je DRAFT pa motor stari nalog OBRIŠE i proknjiži ponovo.`,
  );
  log(
    "    ⚠ `AlreadyPostedException` čuva SAMO naloge u statusu POSTED/LOCKED. Robna grana uvek",
  );
  log(
    "      pravi DRAFT, pa je auto-knjiženje ponovljivo dok knjigovođa ne potvrdi nalog — to je namera,",
  );
  log("      ali znači i da se broj naloga u međuvremenu menja.");

  // 5.5 IFGP sa stavkom na 10 % — šema 36 nema liniju za slot Q
  log("");
  log("5.5 — IFGP sa stavkom na 10 % (šema 36 NEMA liniju za slot Q)");
  const ifgp10 = await napraviDokument({
    vrsta: "IFGP",
    kind: "IZ",
    magacin: MAG_GP,
    kupac: KUPAC_DOMACI,
    tarifa: "4", // NIZA = 10 %
  });
  await engine.postFromStockDocument(ifgp10);
  const p10 = await procitajNalog(ifgp10);
  if (p10) {
    let d = new D(0);
    let c = new D(0);
    for (const r of p10.redovi) {
      d = d.add(r.dug);
      c = c.add(r.pot);
    }
    const kupacRed = p10.redovi.find((r) => r.konto === "2040");
    const pdvRed = p10.redovi.find(
      (r) => r.konto === "4710" || r.konto === "4701",
    );
    log(
      `    2040 duguje = ${fmt(kupacRed?.dug ?? 0)} (= samo osnovica; PDV 10 % = ${fmt(
        VP.mul("0.10"),
      )} nigde ne postoji)`,
    );
    log(
      `    red za PDV: ${pdvRed ? `${pdvRed.konto} = ${fmt(pdvRed.pot)}` : "NEMA GA"}`,
    );
    check(
      "PDV 10 % je izgubljen a nalog balansira",
      d.equals(c) && !p10.redovi.some((r) => r.konto === "4710"),
      `ΣDug=${fmt(d)} ΣPot=${fmt(c)} — kontrola ravnoteže ovo NE hvata (§3.4)`,
    );
  }

  // 5.6 zaokruživanje ispod pare — balans u memoriji vs u bazi
  log("");
  log(
    "5.6 — zaokruživanje: motor ne zaokružuje liniju, a kolona je numeric(19,4)",
  );
  const sitanId = await napraviDokument({
    vrsta: "IFR",
    kind: "IZ",
    magacin: MAG_ROBA,
    kupac: KUPAC_DOMACI,
    tarifa: TARIFA_20,
    kolicina: new D("0.0005"),
    nabavna: new D("0.5"),
    vp: new D("0.5"),
  });
  const uMemoriji = await engine.postFromStockDocument(sitanId);
  let memDug = new D(0);
  let memPot = new D(0);
  for (const l of uMemoriji) {
    memDug = memDug.add(l.debit);
    memPot = memPot.add(l.credit);
  }
  const sitan = await procitajNalog(sitanId);
  if (sitan) {
    let dbDug = new D(0);
    let dbPot = new D(0);
    for (const r of sitan.redovi) {
      dbDug = dbDug.add(r.dug);
      dbPot = dbPot.add(r.pot);
    }
    log(
      `    u memoriji:  ΣDug = ${memDug.toFixed(8)}   ΣPot = ${memPot.toFixed(8)}`,
    );
    log(
      `    u bazi:      ΣDug = ${dbDug.toFixed(4)}       ΣPot = ${dbPot.toFixed(4)}`,
    );
    check(
      "nalog balansira i POSLE upisa u bazu",
      dbDug.equals(dbPot),
      dbDug.equals(dbPot)
        ? "isto"
        : `razlika ${fmt(dbDug.sub(dbPot), 4)} — svaka linija se u bazi zaokruži nezavisno (§3.6b)`,
    );
  }

  // ── ZBIRNA TABELA ────────────────────────────────────────────────────────────
  log("");
  log("═".repeat(100));
  log("ZBIRNO");
  log("═".repeat(100));
  log(`  ${pad("vrsta", 8)}${pad("ocena", 24)}etalon`);
  log("  " + "─".repeat(96));
  for (const r of rezime)
    log(`  ${pad(r.vrsta, 8)}${pad(r.ocena, 24)}${r.napomena}`);
  log("");
  log(fail === 0 ? "🟢 SVE PROVERE PROŠLE" : `🔴 PALO PROVERA: ${fail}`);

  log("");
  log("Čišćenje…");
  const n = await ocisti();
  // vrati prekidače na nulu — test baza ostaje u zatečenom stanju
  await prisma.documentType.updateMany({
    where: { code: { in: [...PROBE.map((p) => p.vrsta), "REV"] } },
    data: { postingTemplate: 0 },
  });
  log(`  obrisano ${n} probnih dokumenata, posting_template vraćen na 0`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
