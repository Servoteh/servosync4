/**
 * Pravila unosa MATIČNIH podataka (artikal i komitent) — čiste funkcije, bez React-a
 * i bez ijednog import-a, da se mogu pokrenuti pod `node --test` (frontend nema jest).
 *
 * Sadrži tri stvari koje oba ekrana dele:
 *   1. BRANA — da li je upis uopšte dozvoljen i ŠTA korisnik treba da uradi umesto toga;
 *   2. VALIDATORI — verni portovi BigBit provera (`DobarPIB`, `DobarGLN`, `DobarTR`),
 *      u obliku „stanje dok se kuca", ne samo true/false;
 *   3. UNOS BROJA — decimalni zarez se prihvata kao i tačka (odluka vlasnika,
 *      `docs/PLAN_UNOS_DOKUMENATA.md` §2.7/B3).
 *
 * ⚠️ Zašto ovo živi pod `app/artikli/_forma/` a ne u `src/lib/`: granica ovog posla je
 * `app/artikli/**`, `app/komitenti/**` i `api/masters.ts`. Kad se brana otvori, fajl se
 * seli u `src/lib/maticni-unos.ts` — tada i komitenti prestaju da ga uvoze preko
 * `@/app/artikli/_forma/pravila`. Folder je `_forma` (Next „private folder") pa NIJE ruta.
 */

/* ────────────────────────────────────────────────────────── 1. BRANA (upis) */

/** Jedan tehnički uslov koji mora biti ispunjen PRE nego što se brana otvori. */
export interface UslovBrane {
  /** Šta nedostaje, rečeno tako da razume i vlasnik, ne samo programer. */
  tekst: string;
  /** Gde se to vidi u kodu (fajl:linija) — da nalaz ne mora ponovo da se traži. */
  izvor: string;
}

export interface Brana {
  entitet: "artikal" | "komitent";
  /** `false` = ekran sme da prikaže formu, ali NE sme ništa da pošalje. */
  otvorena: boolean;
  naslov: string;
  /** Poruka korisniku: šta se desilo + šta da uradi (DESIGN_SYSTEM §9). */
  poruka: string;
  uslovi: UslovBrane[];
}

/**
 * KOMITENT — odluka vlasnika 26.07.2026: `customers` je read-only za celu aplikaciju,
 * jedini pisac je sync modul. Tekst je PRESLIKAN iz backend-a
 * (`backend/src/modules/directory/bigbit-owned.ts:40-43`,
 * `BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE`) — to je izvor istine i za backend i za ekrane.
 * Frontend ne može da uveze backend modul, pa kopija stoji ovde; menja se ISTIM PR-om
 * kao original (prijavljeno kao nalaz — nema deljenog paketa za poruke).
 */
export const BRANA_KOMITENT: Brana = {
  entitet: "komitent",
  otvorena: false,
  naslov: "Unos i izmena komitenta su zatvoreni — komitente vodi BigBit",
  poruka:
    "Komitente vodi BigBit — u ServoSync-u se ne unose ni ne menjaju (odluka 26.07.2026). " +
    "Novog komitenta unesite u BigBit, pa pokrenite uvoz (Sinhronizacije → Pokreni sync) " +
    "ili to zatražite od tehnologa/planera/administratora; tek tada se komitent vidi ovde.",
  uslovi: [
    {
      tekst:
        "Vlasnik mora povući odluku od 26.07.2026 („customers i projects su read-only za celu aplikaciju“).",
      izvor: "backend/src/modules/directory/bigbit-owned.ts:4-24",
    },
    {
      tekst:
        "Sve upisne rute nad komitentom danas namerno vraćaju 409 BIGBIT_OWNED_READ_ONLY: i POST/PATCH /api/v1/directory/customers i novije POST /api/v1/komitenti i PATCH /api/v1/komitenti/:id (prekidač CUSTOMERS_WRITE_OPEN).",
      izvor: "backend/src/modules/masters/customers.service.ts:84-89",
    },
    {
      tekst:
        "CustomerSyncer u delta prolazu prepisuje svih 56 mapiranih polja — ispravka u 4.0 „radi“ nedeljama pa tiho nestane kad neko u BigBitu takne tog komitenta.",
      izvor: "backend/src/modules/sync/syncers/customer.syncer.ts:101-183",
    },
    {
      tekst:
        "Sekvenca customers_id_seq nije klampovana iznad BigBit prostora ključeva — prvi 4.0-native unos ili pukne na PK ili sedne na tuđu šifru koju sledeći sync prepiše.",
      izvor: "backend/prisma/schema.prisma (model Customer, @default(autoincrement()))",
    },
    {
      tekst:
        "Nema markera porekla: Customer.id JESTE BigBit šifra, pa se 4.0-native red ne može prepoznati običnim upitom.",
      izvor: "backend/docs/migration/BIGBIT_KOMITENTI.md:376-379",
    },
    {
      tekst:
        "Dupli PIB nije presuđen: BigBit ga TOLERIŠE (ima samo izveštaj 00_FirmeSaDuplimPIBovima, ne branu), pa tvrd UNIQUE ne sme da se uvede jednostrano.",
      izvor: "backend/docs/migration/BIGBIT_KOMITENTI.md:238-253",
    },
  ],
};

/**
 * ARTIKAL — nema odluke vlasnika kao kod komitenta, ali je tehnički gore: `items` ide
 * kroz `full_refresh` sa `watermark: null`, tj. `deleteMany({})` + `createMany`. Red
 * nastao u 4.0 se briše bez greške i bez traga, a deca u `price_list_entries` i
 * `work_order_item_components` ostaju kao siročad (brisanje ide pod
 * `session_replication_role='replica'`, gde FK trigeri ne rade).
 */
export const BRANA_ARTIKAL: Brana = {
  entitet: "artikal",
  otvorena: false,
  naslov: "Unos i izmena artikla su zatvoreni — artikle vodi BigBit",
  poruka:
    "Artikle vodi BigBit — u ServoSync-u se ne unose ni ne menjaju. Nov artikal unesite u " +
    "BigBit, pa pokrenite uvoz (Sinhronizacije → Pokreni sync) ili to zatražite od " +
    "tehnologa/planera/administratora; tek tada se artikal vidi ovde.",
  uslovi: [
    {
      tekst:
        "items mora ući u zaštićeni skup: danas je watermark: null, pa svaki full refresh radi deleteMany({}) + createMany — 4.0-native artikal nestaje bez greške i bez traga.",
      izvor: "backend/src/modules/sync/sync-map.generated.ts:1709-1716",
    },
    {
      tekst:
        "Brisanje ide pod SET LOCAL session_replication_role='replica' (FK trigeri ne rade) — price_list_entries.item_id i work_order_item_components.item_id ostaju kao siročad koja se ne restore-uju čisto.",
      izvor: "backend/src/modules/sync/generic.syncer.ts:312-329",
    },
    {
      tekst:
        "Sekvenca items_id_seq nije klampovana iznad BigBit prostora ključeva (bumpIdSequence radi samo za aditivne tabele).",
      izvor: "backend/src/modules/sync/generic.syncer.ts:330-336",
    },
    {
      tekst:
        "Rute POST /v1/artikli i PATCH /v1/artikli/:id postoje, ali su zatvorene branom assertItemWritesAllowed() i vraćaju 409 BIGBIT_OWNED_READ_ONLY — brana se sama otvori tek kad items uđe u zaštićeni skup.",
      izvor: "backend/src/modules/masters/items.controller.ts:64-75",
    },
    {
      tekst:
        "Od 04.08.2026 (061/26) i ručni POST /api/v1/sync/run podrazumevano preskače items (isti skup kao noćni posao); eksplicitni items sme samo admin — ali kad ga admin pokrene, i dalje je pun deleteMany.",
      izvor: "backend/src/modules/sync/sync.controller.ts (run) + table-ownership.ts (NIGHTLY_SYNC_EXCLUDED)",
    },
  ],
};

/* ─────────────────────────────────────────────── 2. Unos broja (zarez=tačka) */

export interface ParsiranBroj {
  ok: boolean;
  /** `null` = polje je prazno (legitimno), ne 0. */
  vrednost: number | null;
  /** Poruka koja kaže ŠTA da se uradi; `null` kad je sve u redu. */
  greska: string | null;
}

/**
 * Broj iz polja u broj. Zarez i tačka su OBA decimalni separator (odluka vlasnika),
 * a razmaci se ignorišu (i običan, i NBSP koji upadne kad se vrednost nalepi iz Excela).
 *
 * Razrešenje dvosmislenosti „1.234" (hiljadu ili 1,234?):
 *   • ima zareza  → zarez je decimalni, sve tačke su hiljade („1.234,50" = 1234,5);
 *   • jedna tačka → tačka je DECIMALNA („1.234" = 1,234);
 *   • više tačaka → sve su hiljade („1.234.567" = 1234567).
 * Zato polje uz sebe UVEK ispisuje pročitanu vrednost („= 1,234") — dvosmislenost se
 * vidi u trenutku kucanja, a ne posle snimanja.
 */
export function parsirajBroj(unos: string): ParsiranBroj {
  const sirovo = (unos ?? "").replace(/[\s\u00A0\u202F]/g, "");
  if (sirovo === "") return { ok: true, vrednost: null, greska: null };

  if (!/^[+-]?[\d.,]+$/.test(sirovo)) {
    return {
      ok: false,
      vrednost: null,
      greska: `„${unos.trim()}“ nije broj. Unesi samo cifre, a decimale odvoji zarezom (npr. 12,5).`,
    };
  }

  const negativan = sirovo.startsWith("-");
  const telo = sirovo.replace(/^[+-]/, "");
  const brojZareza = (telo.match(/,/g) ?? []).length;
  const brojTacaka = (telo.match(/\./g) ?? []).length;

  if (brojZareza > 1) {
    return {
      ok: false,
      vrednost: null,
      greska: "Ima više zareza. Ostavi samo jedan decimalni zarez (npr. 1.234,50).",
    };
  }

  let normalizovano: string;
  if (brojZareza === 1) {
    // Zarez je u srpskom UVEK decimalni znak; tačke uz njega su hiljade.
    normalizovano = telo.replace(/\./g, "").replace(",", ".");
  } else if (brojTacaka === 0) {
    normalizovano = telo;
  } else if (brojTacaka === 1 && /\.\d{3}$/.test(telo)) {
    // JEDNA tačka i TAČNO tri cifre iza nje → HILJADE, ne decimale.
    //
    // Bez ovog pravila polje nije moglo da pročita ono što samo ispisuje:
    // `formatirajBroj` koristi `Intl.NumberFormat('sr-RS')`, koji 500000 prikaže
    // kao „500.000" — a parser je tu jednu tačku čitao kao decimalnu i vraćao
    // 500. Kreditni limit od pola miliona postajao bi 500 dinara čim neko otvori
    // karticu, ispravi telefon i snimi. Pogođen je bio ceo opseg 1.000–999.999
    // bez decimala, dakle skoro svaka cena u dinarima. (Nalaz adversarnog
    // pregleda 28.07.2026, KRITIČNO — u režimu „Proba unosa" već vidljivo.)
    //
    // Grupa od tačno tri cifre je jedini oblik koji `Intl` proizvodi, pa je i
    // jedini koji se sme tumačiti kao hiljade. Sve ostalo ostaje decimala, da
    // navika sa engleske tastature („12.5") i dalje radi:
    //   „1.234" → 1234      „500.000" → 500000     (round-trip našeg ispisa)
    //   „12.5"  → 12,5      „12.45"   → 12,45      „1.2345" → 1,2345
    // Ko stvarno misli „jedan zarez dva tri četiri" u srpskom to i kuca sa
    // zarezom; uz to polje ispod sebe ispisuje pročitanu vrednost, pa se izbor
    // vidi pre snimanja.
    normalizovano = telo.replace(".", "");
  } else if (brojTacaka === 1) {
    normalizovano = telo;
  } else {
    normalizovano = telo.replace(/\./g, "");
  }

  if (!/^\d*\.?\d*$/.test(normalizovano) || /^\.?$/.test(normalizovano)) {
    return {
      ok: false,
      vrednost: null,
      greska: `„${unos.trim()}“ nije broj. Unesi samo cifre, a decimale odvoji zarezom (npr. 12,5).`,
    };
  }

  const n = Number(normalizovano);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      vrednost: null,
      greska: `„${unos.trim()}“ nije broj. Unesi samo cifre, a decimale odvoji zarezom (npr. 12,5).`,
    };
  }
  return { ok: true, vrednost: negativan ? -n : n, greska: null };
}

/** 1234.5 → „1.234,5" (srpski format, bez repova nula). Prazno → "". */
export function formatirajBroj(n: number | null, maxFrac = 3): string {
  if (n === null || !Number.isFinite(n)) return "";
  return new Intl.NumberFormat("sr-RS", { maximumFractionDigits: maxFrac }).format(n);
}

/* ────────────────────────────────────────── 3. Validatori (portovi BigBita) */

export type TonProvere = "neutralno" | "u-toku" | "ok" | "upozorenje" | "greska";

export interface Provera {
  ton: TonProvere;
  /** `null` = nema šta da se kaže (prazno polje ili uredna vrednost bez komentara). */
  poruka: string | null;
}

const PRAZNO: Provera = { ton: "neutralno", poruka: null };

/**
 * PIB — kontrolna cifra (mod 11,10), veran port `DobarPIB` iz `LIB_PIB.bas`.
 * Isti algoritam kao `backend/src/common/validation/pib.util.ts` (koji je izvor istine
 * na serveru); ovde postoji zato što se provera traži DOK SE KUCA, a to se ne može
 * uraditi mrežnim pozivom po pritisku tastera. Server MORA da proveri ponovo.
 *
 * BigBit-ova forma ima izračunatu kolonu `DobarPIB` i pri snimanju pita
 * „PIB nije dobar!!! Da li nastavljate unos?" (default „No") — dakle polu-tvrda brana
 * sa svesnim override-om, uz izuzetak `NeProveravajPIB` za ino komitente
 * (BIGBIT_KOMITENTI.md §3.1, §4).
 */
export function ispravanPib(pib: string): boolean {
  if (typeof pib !== "string") return false;
  let vrednost = pib.trim();
  if (vrednost.slice(0, 2).toUpperCase() === "SR") vrednost = vrednost.slice(2).trim();

  const kontrolni = vrednost.slice(-1);
  const osnova = vrednost.slice(0, 8);
  if (osnova.length !== 8) return false;
  if (!/^\d{8}$/.test(osnova) || !/^\d$/.test(kontrolni)) return false;

  let c = 10;
  for (let i = 0; i < 8; i += 1) {
    c = (Number(osnova[i]) + c) % 10;
    if (c === 0) c = 10;
    c = (c * 2) % 11;
  }
  return (11 - c) % 10 === Number(kontrolni);
}

/**
 * Stanje PIB polja dok se kuca: dok nema 9 cifara ne sme da bude crveno (inače polje
 * svetli crveno od prve otkucane cifre i korisnik prestane da gleda indikator).
 * `XX_<šifra>` je BigBit placeholder za komitenta BEZ PIB-a — nije greška podatka
 * (BIGBIT_KOMITENTI.md §5.1).
 */
export function proveriPib(unos: string, neProveravaj = false): Provera {
  const sirovo = (unos ?? "").trim();
  if (sirovo === "") {
    return {
      ton: "upozorenje",
      poruka: "PIB je obavezan. Ako komitent nema PIB, uključi „Ne proveravaj PIB“.",
    };
  }
  if (sirovo.toUpperCase().startsWith("XX_")) {
    return { ton: "neutralno", poruka: "Placeholder za komitenta bez PIB-a (BigBit konvencija)." };
  }
  if (neProveravaj) {
    return { ton: "neutralno", poruka: "Provera je isključena za ovog komitenta (ino / fizičko lice)." };
  }

  const cifre = sirovo.toUpperCase().replace(/^SR/, "");
  if (!/^\d+$/.test(cifre)) {
    return { ton: "greska", poruka: "PIB su samo cifre (9), uz opcioni prefiks SR. Obriši ostale znakove." };
  }
  if (cifre.length < 9) {
    return { ton: "u-toku", poruka: `Uneto ${cifre.length} od 9 cifara.` };
  }
  if (cifre.length > 9) {
    return { ton: "greska", poruka: "PIB ima tačno 9 cifara — obriši višak." };
  }
  return ispravanPib(sirovo)
    ? { ton: "ok", poruka: "Kontrolna cifra se slaže." }
    : {
        ton: "greska",
        poruka:
          "Kontrolna cifra se ne slaže — proveri PIB kod komitenta. Ako je PIB stvarno takav (strano lice), uključi „Ne proveravaj PIB“.",
      };
}

/**
 * GLN — veran port `DobarGLN`: 6–14 cifara, BEZ GS1 kontrolne cifre (legacy je nema;
 * dodavanje bi oborilo zatečene podatke — `gln.util.ts` isto upozorava).
 */
export function ispravanGln(gln: string): boolean {
  const vrednost = gln ?? "";
  if (vrednost === "") return false;
  if (vrednost.length <= 5 || vrednost.length > 14) return false;
  return /^\d+$/.test(vrednost);
}

export function proveriGln(unos: string): Provera {
  const sirovo = (unos ?? "").trim();
  if (sirovo === "") return PRAZNO;
  if (!/^\d+$/.test(sirovo)) {
    return { ton: "greska", poruka: "GLN su samo cifre — obriši razmake i crtice." };
  }
  if (sirovo.length < 6) return { ton: "u-toku", poruka: `Uneto ${sirovo.length} cifara (najmanje 6).` };
  if (sirovo.length > 14) return { ton: "greska", poruka: "GLN ima najviše 14 cifara — obriši višak." };
  return { ton: "ok", poruka: "Dužina je u redu (GS1 kontrolna cifra se ne proverava)." };
}

/**
 * MOD97 kontrolni broj — port `KBroj97` (isti rezultat kao `placanja/mod97.util.ts`).
 *
 * Broj računa prebacuje `Number.MAX_SAFE_INTEGER`, pa se ostatak računa cifru po cifru
 * (`(ostatak*10 + cifra) % 97`) umesto nad celim brojem. Legacy je za isto koristio
 * `CDec`, backend `BigInt`; ovde ni jedno ni drugo — `target` frontenda je ES2017,
 * gde BigInt literali ne postoje.
 */
export function kbroj97(broj: string): string {
  const cifre = (broj ?? "").replace(/\D+/g, "");
  if (cifre.length === 0) return "";
  let ostatak = 0;
  for (const c of cifre) ostatak = (ostatak * 10 + Number(c)) % 97;
  ostatak = (ostatak * 100) % 97; // (n × 100) mod 97
  return String(98 - ostatak).padStart(2, "0");
}

/**
 * Tekući račun — port `DobarTR` (`KontrolniBrojevi.bas:127`), isti algoritam kao
 * `isValidAccountNumber` u `backend/src/modules/placanja/mod97.util.ts`, koji ostaje
 * izvor istine na serveru. Format `bbb-sredina-kk`; sredina se dopuni nulama na 13.
 */
export function ispravanTekuciRacun(tr: string): boolean {
  if (!tr || tr.indexOf("-") < 0) return false;
  const banka = tr.slice(0, 3);
  const crtica = tr.indexOf("-");
  const sredina = tr.slice(crtica + 1, tr.length - 3);
  const kontrola = tr.slice(-2);
  const struktura = tr === `${banka}-${sredina}-${kontrola}`;
  return struktura && kbroj97(banka + sredina.padStart(13, "0")) === kontrola;
}

/** 18 golih cifara → „bbb-sredina13-kk". Sve ostalo vraća netaknuto. */
export function formatirajTekuciRacun(unos: string): string {
  const sirovo = (unos ?? "").trim();
  if (!/^\d{18}$/.test(sirovo)) return sirovo;
  return `${sirovo.slice(0, 3)}-${sirovo.slice(3, 16)}-${sirovo.slice(16)}`;
}

export function proveriTekuciRacun(unos: string): Provera {
  const sirovo = (unos ?? "").trim();
  if (sirovo === "") return PRAZNO;
  if (/^\d+$/.test(sirovo)) {
    return sirovo.length === 18
      ? { ton: "u-toku", poruka: "Pritisni Enter — račun se formatira u bbb-…-kk." }
      : { ton: "u-toku", poruka: `Uneto ${sirovo.length} cifara; račun se piše sa crticama (bbb-…-kk).` };
  }
  if (!/^\d{3}-\d+-\d{2}$/.test(sirovo)) {
    return { ton: "greska", poruka: "Račun se piše kao 3 cifre banke, crtica, broj, crtica, 2 kontrolne (npr. 160-0000000000000-16)." };
  }
  return ispravanTekuciRacun(sirovo)
    ? { ton: "ok", poruka: "Kontrolni broj (mod 97) se slaže." }
    : { ton: "greska", poruka: "Kontrolni broj se ne slaže — proveri poslednje dve cifre računa." };
}

/**
 * Kataloški broj — BigBit ga auto-dodeljuje kao `DMax(numerički deo) + 1` popunjen
 * nulama na 5 cifara, a pri snimanju TVRDO blokira duplikat („Već postoji artikal sa
 * istim kataloškim brojem!", `Doc__Form_Unos artikala.txt:271-295`). U 4.0 duplikat
 * hvata i DB brana `guard_catalog_unique`; ekran je samo prvo sito.
 */
export function predlogKataloskogBroja(najveciNumericki: number): string {
  const sledeci = Math.max(0, Math.floor(najveciNumericki)) + 1;
  return String(sledeci).padStart(5, "0");
}

export function proveriKataloskiBroj(unos: string): Provera {
  const sirovo = (unos ?? "").trim();
  if (sirovo === "") {
    return { ton: "upozorenje", poruka: "Kataloški broj je obavezan — bez njega se artikal ne može snimiti." };
  }
  if (sirovo.length > 20) {
    return { ton: "greska", poruka: "Kataloški broj ima najviše 20 znakova — skrati ga." };
  }
  return { ton: "ok", poruka: null };
}

/** Obavezno tekstualno polje: poruka kaže i ime polja, da se zna gde je fokus. */
export function proveriObavezno(unos: string, labela: string): Provera {
  return (unos ?? "").trim() === ""
    ? { ton: "upozorenje", poruka: `Unesi „${labela}“ — bez toga se zapis ne može snimiti.` }
    : { ton: "ok", poruka: null };
}

/** Broj sa opsegom; `min`/`max` su uključivi. Prazno je legitimno (P — opciono). */
export function proveriBroj(
  unos: string,
  opcije: { min?: number; max?: number; labela?: string } = {},
): Provera {
  const p = parsirajBroj(unos);
  if (!p.ok) return { ton: "greska", poruka: p.greska };
  if (p.vrednost === null) return PRAZNO;
  if (opcije.min !== undefined && p.vrednost < opcije.min) {
    return { ton: "greska", poruka: `Vrednost ne sme biti manja od ${formatirajBroj(opcije.min)} — ispravi je.` };
  }
  if (opcije.max !== undefined && p.vrednost > opcije.max) {
    return { ton: "greska", poruka: `Vrednost ne sme biti veća od ${formatirajBroj(opcije.max)} — ispravi je.` };
  }
  return { ton: "ok", poruka: `= ${formatirajBroj(p.vrednost)}` };
}

/* ─────────────────────────────────────────────────── 4. Definicija polja */

export type TipPolja = "tekst" | "broj" | "da-ne" | "izbor" | "memo" | "datum";

export interface OpcijaPolja {
  value: string;
  label: string;
}

export interface PoljeDef {
  /** Ključ u modelu vrednosti; ujedno i redosled fokusa (Enter). */
  id: string;
  labela: string;
  tip: TipPolja;
  obavezno?: boolean;
  /**
   * Koliko kolona mreže zauzima na širokom ekranu (1 podrazumevano).
   *
   * Vrednosti 1/2/4 su nad ZATEČENOM 4-kolonskom mrežom (komitenti i sve sekcije bez
   * `SekcijaDef.mreza`) i ponašaju se tačno kao pre. Vrednosti 3/6/8/12 imaju smisla
   * samo u gustoj 12-kolonskoj mreži (`SekcijaDef.mreza = 12`), gde jedan BigBit red
   * forme staje u jedan red mreže; u 4-kolonskoj mreži se ponašaju kao „ceo red“.
   */
  raspon?: 1 | 2 | 3 | 4 | 6 | 8 | 12;
  opcije?: OpcijaPolja[];
  /** Pomoćni tekst ispod polja — objašnjenje, ne poruka o grešci. */
  napomena?: string;
  maxDuzina?: number;
  /** Kad je zadato, polje je TRAJNO zaključano i tekst kaže zašto. */
  zakljucano?: string;
  /**
   * BigBit obrazac (`Doc__Form_Unos artikala.txt:382-417`): cene i PLU su zaključani,
   * dupli klik otključava. Svesna gesta pre nego što se cena prekuca.
   */
  otkljucajDvoklikom?: boolean;
  proveri?: (vrednost: string, sve: Record<string, string>) => Provera;
  /** Sređivanje vrednosti pri napuštanju polja (npr. 18 cifara → „bbb-…-kk“). */
  normalizuj?: (vrednost: string) => string;
}

export interface SekcijaDef {
  naslov: string;
  /** Kratko objašnjenje sekcije (npr. odakle vrednosti dolaze). */
  opis?: string;
  polja: PoljeDef[];
  /**
   * Gustina mreže sekcije. IZOSTAVLJENO = zatečeno ponašanje (1 → 2 → 3 → 4 kolone po
   * širini), pa se sekcije komitenta i sve starije sekcije crtaju identično kao pre.
   *
   * `12` uključuje gustu mrežu: BigBit forma „Unos artikala“ ima do 7 polja u jednom
   * redu (npr. Kataloški broj · Bar kod · Naziv · Pakovanje · Jed. mere · Kilograma u
   * komadu · Transp. pakovanje), što se u 4 kolone ne može preslikati bez lomljenja
   * reda — a upravo redosled i susedstvo polja su ono što korisnici pamte. Zbog toga
   * je svojstvo OPCIONO i uvedeno aditivno: nijedna postojeća sekcija ga nema.
   */
  mreza?: 12;
  /** Sekcija se može sklopiti/otvoriti klikom na naslov. Izostavljeno = uvek otvorena. */
  sklopivo?: boolean;
  /**
   * Sklopiva sekcija je pri otvaranju ekrana ZATVORENA. Koristi se za „Dodatna polja
   * (van BigBit forme)“ — ništa se ne briše, ali ne sme da razbija naviku korisnika
   * koji poznaje BigBit raspored. Bez `sklopivo` nema dejstvo.
   */
  podrazumevanoZatvoreno?: boolean;
}

/** Ravan redosled fokusa kroz sve sekcije — Enter ide TAČNO ovim redom. */
export function redosledFokusa(sekcije: SekcijaDef[]): string[] {
  const ids: string[] = [];
  for (const s of sekcije) for (const p of s.polja) ids.push(p.id);
  return ids;
}

/**
 * Sledeće polje za Enter/Tab. Poslednje polje vraća `null` — pozivalac tada fokusira
 * dugme „Snimi" (kod matičnog sloga nema „novog reda"; „Enter otvara nov red" je
 * pravilo mreže STAVKI dokumenta, `PLAN_UNOS_DOKUMENATA.md` §2.5).
 */
export function sledecePolje(redosled: string[], trenutno: string): string | null {
  const i = redosled.indexOf(trenutno);
  if (i < 0 || i === redosled.length - 1) return null;
  return redosled[i + 1];
}

export function prethodnoPolje(redosled: string[], trenutno: string): string | null {
  const i = redosled.indexOf(trenutno);
  if (i <= 0) return null;
  return redosled[i - 1];
}

/**
 * Koja su polja stvarno promenjena u odnosu na polazni (serverski) slog.
 * Brojevi se porede po VREDNOSTI, ne po tekstu — „12,50“ i „12.5“ su isti broj, pa
 * puko poređenje stringova prijavljuje izmenu koje nema (a operater bi kasnije
 * dobio „imate nesnimljene izmene“ na slogu koji nije ni dirao).
 */
export function izmenjenaPolja(
  sekcije: SekcijaDef[],
  polazne: Record<string, string>,
  tekuce: Record<string, string>,
): string[] {
  const brojevi = new Set<string>();
  for (const s of sekcije) for (const p of s.polja) if (p.tip === "broj") brojevi.add(p.id);

  const izmene: string[] = [];
  for (const kljuc of Object.keys(tekuce)) {
    const a = polazne[kljuc] ?? "";
    const b = tekuce[kljuc] ?? "";
    if (a === b) continue;
    if (brojevi.has(kljuc)) {
      const pa = parsirajBroj(a);
      const pb = parsirajBroj(b);
      if (pa.ok && pb.ok && pa.vrednost === pb.vrednost) continue;
    }
    izmene.push(kljuc);
  }
  return izmene;
}

/** Sva polja sa tonom „greska“ ili „upozorenje“ (za traku „ne može da se snimi“). */
export function sporneStavke(
  sekcije: SekcijaDef[],
  vrednosti: Record<string, string>,
): { id: string; labela: string; poruka: string }[] {
  const sporne: { id: string; labela: string; poruka: string }[] = [];
  for (const s of sekcije) {
    for (const p of s.polja) {
      if (!p.proveri) continue;
      const r = p.proveri(vrednosti[p.id] ?? "", vrednosti);
      if ((r.ton === "greska" || r.ton === "upozorenje") && r.poruka) {
        sporne.push({ id: p.id, labela: p.labela, poruka: r.poruka });
      }
    }
  }
  return sporne;
}
