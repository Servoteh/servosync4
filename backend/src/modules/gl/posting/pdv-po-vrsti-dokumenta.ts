import { Prisma } from "@prisma/client";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * NOSI LI VRSTA ROBNOG DOKUMENTA PDV — JEDAN IZVOR ISTINE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ POVOD (izmereno probnim knjiženjem 08.08.2026)
 * ─────────────────────────────────────────────────────────────────────────────
 * Prekidač knjiženja (`document_types.posting_template`) je 07.08.2026. upaljen za
 * više vrsta, ali je `VISAR` (višak robe sa popisa) ISTOG DANA vraćen na nulu jer
 * bi prvi popis sa viškom bio ODBIJEN. Poruka motora:
 *
 *   „Robni dokument (vrsta VISAR) ima stavku oporezovanu opštom stopom (20 %), a
 *    šema za kontiranje 46 (VISAK) NEMA red za tu stopu. Pretporez od 1200.00 ne bi
 *    legao ni na jedan konto…"
 *
 * 🔴 KOREN NIJE NI U ŠEMI NI U BRANI. Višak sa popisa **nije poreski događaj**:
 * ništa nije kupljeno, zatečena je roba koja je već bila u imovini firme. Motor mu
 * je ipak računao pretporez, jer artikal nosi tarifu 20 % — a tarifa je svojstvo
 * **robe**, ne ovog dokumenta. Brana (`assertSchemeCoversVat`) je RADILA ISPRAVNO i
 * ostaje: ona je i otkrila kvar. Ispravka je da PDV **ni ne nastane** tamo gde ne
 * postoji, a ne da se brana ućutka niti da se šema dopuni redom za porez koji nema
 * poresku osnovu. Prekidač je istog dana vraćen na nulu —
 * `prisma/seed/prekidac-visar-nazad-na-nulu-2026-08-08.sql`, gde stoji i doslovna poruka;
 * vraćanje `VISAR` na šemu 46 je ZASEBNA odluka i ovaj kod je ne donosi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZAŠTO OVDE, A NE `document_types.post_in_vat_ledger`
 * ─────────────────────────────────────────────────────────────────────────────
 * Kolona POSTOJI u šemi (`post_in_vat_ledger`, BigBit `KnjizitiUPDVEvidenciju`), ali
 * je na produkciji IZMERENA kao NEUPOTREBLJIVA za ovu odluku (08.08.2026,
 * `servosync-pg`, svih 15 redova `document_types`):
 *
 *   • `VISAR` ima `post_in_vat_ledger = true` — dakle upravo suprotno od merenja
 *     nad šemom i nad knjigom (v. dokaze uz svaku vrstu niže). Kolona nije došla iz
 *     BigBita nego iz 4.0 seed-a (`20260724160000_seed_document_types_popis`), a
 *     `DEFAULT` joj je `true`;
 *   • `NIV` ima `true`, a u BigBit-u je `KnjizitiUPDVEvidenciju = 0` (izmereno nad
 *     `R_Vrste dokumenata` u BB_T_25 i BB_T_26 —
 *     `docs/migration/BIGBIT_KONTA_I_SEME_KNJIZENJA.md` §6.9). Kolona dakle NE PRATI
 *     izvor ni tamo gde izvor ima jasan odgovor;
 *   • `PON`/`PROF` imaju `false`, a njihov PDV STVARNO POSTOJI (štampa se na
 *     predračunu) — oni prosto nikad ne stižu do glavne knjige. Znači kolona ne meri
 *     ni isto pitanje koje se ovde postavlja.
 *
 * Uz to, MSSQL sync koji bi kolonu punio iz BigBita je MRTAV (`items`/`customers`/…
 * su u `FROZEN_MSSQL_EXCLUDED`), a `document_types` je aditivna tabela sa 4.0-seed
 * redovima koje BigBit uopšte ne poznaje (`VISAR`, `MANJR`, `NIV`, `PREUL`, `PREIZ`).
 * Naslanjanje motora na tu kolonu bilo bi naslanjanje na podatak koji NIKO ne održava
 * — tačno oblik tihog zastarevanja koji je repo već platio kod minimalne količine
 * (`masters/items.write-policy.ts`, `VLASNIK_MINIMALNE_KOLICINE`).
 *
 * Zato je odluka OVDE, u kodu, uz merenje iza svake vrste — po istom obrascu kao
 * `VLASNIK_MINIMALNE_KOLICINE` i `sync/table-ownership.ts`: jedno mesto, izvedene
 * posledice, i brana koja pada glasno ako se dva opisa iste stvari raziđu
 * (`razilazenjeVrsteISeme`).
 */

// ─────────────────────────────────────────────────────────────────────────────
// PDV SLOTOVI PO SMERU DOKUMENTA
// ─────────────────────────────────────────────────────────────────────────────
//
// Slova agregata A–Z koja nose STVARAN POREZ (onaj koji ulazi u knjigu i u PDV
// prijavu), razdvojena po smeru dokumenta. NE ulaze J/K/V (PDV na kalkulativnu VP
// cenu): to je međurezultat maloprodajne kalkulacije, ne poreska obaveza ni pretporez.
//
// Smer se bira po `DocumentType.isInbound` jer `aggregateDocAmounts` računa i ulazni i
// izlazni PDV — na izlaznoj fakturi je i `D` ne-nulto (osnovica × stopa nad nabavnom
// cenom), a nijedna izlazna šema ga ne referiše. Provera bez razdvajanja po smeru bi
// zato odbila SVAKI izlazni dokument.
//
// ⚠️ STOJE OVDE, A NE U MOTORU: isti spisak slova odgovara na DVA pitanja — „koji slot
// brana čuva" i „koji slot se ne sme ni izračunati na neporeskoj vrsti". Dva prepisa
// istog spiska raziđu se tiho (slot dodat brani, zaboravljen u potiskivanju = porez
// koji nastane pa nestane).

/** Slovo agregata A–Z koje nosi stvaran porez. */
export type VatSlotLetter = "D" | "E" | "U" | "P" | "Q" | "W";

export interface VatSlot {
  readonly letter: VatSlotLetter;
  readonly label: string;
}

export const VAT_SLOTS_OUTBOUND: readonly VatSlot[] = [
  { letter: "P", label: "opštom stopom (20 %)" },
  { letter: "Q", label: "sniženom stopom (10 %)" },
  { letter: "W", label: "poljoprivrednom stopom (8 %)" },
];

export const VAT_SLOTS_INBOUND: readonly VatSlot[] = [
  { letter: "D", label: "opštom stopom (20 %)" },
  { letter: "E", label: "sniženom stopom (10 %)" },
  { letter: "U", label: "poljoprivrednom stopom (8 %)" },
];

/** Slotovi koji važe za dati smer dokumenta. */
export function vatSlotsFor(isInbound: boolean): readonly VatSlot[] {
  return isInbound ? VAT_SLOTS_INBOUND : VAT_SLOTS_OUTBOUND;
}

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 SPISAK VRSTA KOD KOJIH PDV NE POSTOJI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VRSTE ROBNIH DOKUMENATA KOD KOJIH PDV NE POSTOJI KAO POJAVA.
 *
 * Ključ je `document_types.code` — ista šifra koju motor vidi kao
 * `stock_documents.document_type_code`. (NIJE `accounting_schemes.order_type`: to su
 * dva različita imenika i za popis se STVARNO razlikuju — vrsta je `VISAR`, a šema 46
 * nosi vrstu naloga `VISAK`.)
 *
 * ⚠️ MERENJE IZA SVAKE ŠIFRE (produkcija `servosync-pg`, 08.08.2026) — ništa nije
 * izvedeno iz pretpostavke:
 *
 *   `VISAR` — Višak robe (popis). POSTOJI u registru.
 *     • šema 46 (`VISAK`) ima TAČNO DVA reda: `1320 DefDug=A` i `6740 DefPot=A`;
 *       nijedno slovo osim `A` se ne pominje;
 *     • uvezena knjiga 2026 ima jedan STVARAN nalog vrste `VISAK`: `1320` duguje
 *       190.168,91 i `6740` potražuje 190.168,91 — dva reda, NIJEDAN PDV konto;
 *     • poreski: višak nije promet. Ništa nije nabavljeno (nema pretporeza) i ništa
 *       nije isporučeno (nema izlaznog poreza) — samo je utvrđeno da je roba koja je
 *       već bila u imovini bila nezavedena.
 *
 *   `VISAK`, `VISAM` — Višak (roba / materijal) po legacy šifri vrste naloga.
 *     Registar `document_types` ih DANAS NEMA (v. `VRSTE_BEZ_PDV_JOS_NE_POSTOJE`), ali
 *     su u skupu jer su im šeme izmerene i identične po obliku: šema 46 (`VISAK`)
 *     `1320 A / 6740 A` i šema 41 (`VISAM`) `1010 A / 6740 A` — ista dva reda, samo
 *     drugi konto zaliha (roba vs. materijal). Popis materijala je isti poslovni
 *     događaj kao popis robe, pa bi bez ovih šifara prvi višak materijala ponovio
 *     tačno kvar od 07.08.
 *
 *   `PREUL`, `PREIZ` — Prenos između magacina (ulaz / izlaz).
 *     • `is_internal_document = true`, `post_in_vat_ledger = false`,
 *       `posting_template = 0` (izmereno na sve tri kolone);
 *     • uvezena knjiga 2026, vrsta naloga `MMP`: 6 stavki, sve na `1010`/`1320`,
 *       NIJEDAN PDV konto;
 *     • poreski: premeštanje robe unutar iste firme nije promet — nema ni isporuke ni
 *       nabavke, pa nema ni osnovice.
 *
 *   `REV` — Revers (roba data na privremeno korišćenje).
 *     • `post_in_vat_ledger = false`, `posting_template = 0` (izmereno);
 *     • u uvezenoj knjizi NEMA nijednog naloga te vrste ni u jednoj godini;
 *     • poreski: revers ne prenosi pravo raspolaganja — roba ostaje u imovini
 *       izdavaoca, pa isporuke (a time ni poreske obaveze) nema. Dokaz iz knjige je
 *       ovde SLABIJI nego kod viška (nema nijednog zatečenog naloga), pa je to i
 *       zapisano — ako se ikad pojavi šema sa PDV redom, `razilazenjeVrsteISeme` pada
 *       glasno i odluka se preispituje nad podatkom, ne nad sećanjem.
 *
 *   `NIV` — Nivelacija (revalorizacija zaliha).
 *     • BigBit `R_Vrste dokumenata` za `NIV`: `Sema za kontiranje = 0`,
 *       `KnjizitiUPDVEvidenciju = 0`, `UticeNaZalihe = 1` — identično u BB_T_25 i
 *       BB_T_26 (`docs/migration/BIGBIT_KONTA_I_SEME_KNJIZENJA.md` §6.9);
 *     • među 30 BigBit šema NIJEDNA nema vrstu naloga `NIV`, a u knjizi 2025/2026 ne
 *       postoji nijedan nalog iz nivelacije;
 *     • ⚠️ danas NEDOSTIŽNO: `postFromStockDocument` grana NIV pre agregacije
 *       (`postNivLeveling`), pa ovaj red ne menja ništa. Stoji svesno — kad bi se
 *       grananje ikad pomerilo, nivelacija bi kroz opšti put dobila izmišljen porez.
 *
 * ⚠️ NAMERNO IZOSTAVLJENE, IAKO IZGLEDAJU KAO ISTA PORODICA — MERENJE KAŽE SUPROTNO:
 *
 *   `MANJR` (manjak robe) i `MANJM` (manjak materijala) **NOSE PDV**. Šeme 50 i 49
 *   imaju red `4700 DefPot = P` (izlazni PDV 20 %) uz `6040`/`5741`/`5740` — izmereno
 *   na `accounting_scheme_lines`. Isto važi za `OTPIR`/`OTPIM` (šeme 53/52, `4700 P`)
 *   i `DONAC` (šema 42, `4700 P`). To NIJE greška u šemama nego zakon: manjak preko
 *   normativa, otpis i donacija su rashodovanje/upotreba za vansistemske svrhe, na
 *   koje se obračunava izlazni PDV.
 *
 *   ⚠️ `MANJR` ima ZASEBAN, NEZAVISAN kvar i zato mu je prekidač i dalje na nuli
 *   (`prisma/seed/prekidac-knjizenja-2026-08-07.sql`): šema 50 računa `P` iz VELEPRODAJNE
 *   cene sa popisnog dokumenta umesto iz nabavne vrednosti (probom: 2.000 umesto 1.200), a
 *   knjiži ga na konto `4700` koji u CELOJ uvezenoj knjizi 2026 ima NULA stavki. To je
 *   pitanje OSNOVICE I KONTA, ne pitanje postoji li porez — pa se ovde NE rešava, i `MANJR`
 *   ne sme da uđe u `VRSTE_BEZ_PDV` kao prečica do upaljenog prekidača.
 *
 *   Manjak je dakle ASIMETRIČAN VIŠKU i tako mora ostati —
 *   ko ih „izjednači" iz simetrije, izbrisaće porez koji država potražuje.
 *
 *   `PON`, `PROF` (ponuda, predračun) imaju `post_in_vat_ledger = false`, ali njihov
 *   PDV POSTOJI — štampa se na dokumentu i prelazi na fakturu. Oni prosto nikad ne
 *   stižu do glavne knjige (`posting_template = 0` → `NoPostingSchemeException`).
 *   Upis ovde bi bio tačan ishod iz netačnog razloga.
 *
 *   `IZVRO`, `IZVGP`, `IZVUS` (izvoz) NISU ovde: kod njih PDV POSTOJI kao pojam, samo
 *   je stopa 0 (poresko oslobođenje sa pravom na odbitak). Slotovi im ispadnu nula sami
 *   od sebe, kroz tarifu stavke — i tako i treba, jer promet se PRIJAVLJUJE u POPDV.
 */
export const VRSTE_BEZ_PDV: ReadonlySet<string> = new Set([
  "VISAR",
  "VISAK",
  "VISAM",
  "PREUL",
  "PREIZ",
  "REV",
  "NIV",
]);

/**
 * Šifre iz `VRSTE_BEZ_PDV` koje registar `document_types` DANAS NEMA (izmereno
 * 08.08.2026: registar ima 15 vrsta — AVR, IFGP, IFR, IFUSL, IZVGP, IZVRO, IZVUS,
 * MANJR, NIV, PON, PREIZ, PREUL, PROF, REV, VISAR).
 *
 * Stoje u skupu unapred SAMO zato što im je šema izmerena (41/46) i identična po
 * obliku onoj koja je već dokazana. Spisak postoji da bi „zašto je ovde šifra koje
 * nema" imalo odgovor bez ponovnog merenja.
 */
export const VRSTE_BEZ_PDV_JOS_NE_POSTOJE: ReadonlySet<string> = new Set([
  "VISAK",
  "VISAM",
]);

/**
 * VRSTE NALOGA IZMERENE KAO BEZ PDV-a, ALI BEZ VRSTE DOKUMENTA — NE ULAZE U SKUP.
 *
 * Izmereno nad uvezenom knjigom 2026 (`journal_entries` × `ledger_entries`, filter na
 * konta 4700–4712 / 2700–2704): svaka od ovih vrsta ima stavke, a NIJEDNU na PDV kontu.
 *
 *   `TREB`  (trebovanje materijala) — 40 stavki, samo `1010`/`5110`/`022xx`
 *   `TREB1` (trebovanje robe)       — 42 stavki, samo `1320`/`51100`
 *   `ULGP`  (ulaz gotovih proizvoda)— 69 stavki, samo `1200`/`9020`/`9600`
 *   `USLMA` (utrošak materijala)    —  2 stavke, `1010`/`5110`
 *   `USLRO` (utrošak robe)          —  2 stavke, `1320`/`5012`
 *   `MMP`   (međumagacinski prenos) —  6 stavki, `1010`/`1320`
 *
 * NE upisuju se u `VRSTE_BEZ_PDV` jer im u `document_types` ne postoji šifra, pa se
 * robni dokument te vrste danas ne može ni napraviti — upis bi bio nagađanje o imenu
 * buduće šifre. Ako se vrsta ikad zavede, zatečeno ponašanje GREŠI U BEZBEDNOM SMERU:
 * šema nema PDV red, pa brana `assertSchemeCoversVat` odbije dokument sa 422 i traži
 * odluku — nikad ne izgubi porez ćutke. Tada se ovde doda red sa merenjem.
 */
export const VRSTE_NALOGA_BEZ_PDV_BEZ_VRSTE_DOKUMENTA: readonly string[] = [
  "TREB",
  "TREB1",
  "ULGP",
  "USLMA",
  "USLRO",
  "MMP",
];

/**
 * Nosi li vrsta dokumenta PDV. **Jedino mesto na kome se to pita.**
 *
 * Prazna/nepoznata šifra vraća `true` (nosi PDV) — namerno: nepoznata vrsta se
 * ponaša kao i do sada, pa PDV nastane i brana ga uhvati ako šema nema gde da ga
 * stavi. Suprotan default bi tiho gasio porez na svakoj šifri koju neko zaboravi.
 */
export function vrstaNosiPdv(documentTypeCode: string | null | undefined): boolean {
  if (!documentTypeCode) return true;
  return !VRSTE_BEZ_PDV.has(documentTypeCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// SLOVA KOJA ŠEMA REFERIŠE — jedan skener za obe brane
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Skup slova A–Z koja se pominju u `DefDug`/`DefPot` bilo koje linije šeme.
 *
 * Tokenizer parsera prima promenljivu SAMO kao jedno veliko slovo A–Z
 * (`expression-parser.ts`), pa je skeniranje znakova potpuno: nema višeslovnih imena
 * u kojima bi se slovo moglo sakriti.
 *
 * Jedan skener za obe brane (`assertSchemeCoversVat` i `razilazenjeVrsteISeme`) — dva
 * prepisa istog skeniranja raziđu se tiho.
 */
export function slovaKojaSemaReferise(
  lines: ReadonlyArray<{ defDebit: string | null; defCredit: string | null }>,
): Set<string> {
  const referenced = new Set<string>();
  for (const line of lines) {
    for (const expr of [line.defDebit, line.defCredit]) {
      if (!expr) continue;
      for (const ch of expr) {
        if (ch >= "A" && ch <= "Z") referenced.add(ch);
      }
    }
  }
  return referenced;
}

/**
 * BRANA DA SE DVA OPISA ISTE STVARI NE RAZIĐU — vraća opis razilaženja ili `null`.
 *
 * Vrsta je ovde proglašena NEPORESKOM, a šema za kontiranje ima red za PDV slot. To
 * je kontradikcija sa TIHIM ishodom: motor za takvu vrstu ne računa PDV, pa bi red
 * šeme uvek bio nula i `finalizeLedgerLines` bi ga ćutke odbacio. Knjigovođa koji je
 * red dodao mislio bi da porez negde leže — a ne leže nigde.
 *
 * Vraća STRING (a ne baca) da bi test mogao da tvrdi i pozitivan i negativan slučaj,
 * i da poruka kaže ŠTA da se uradi — ne samo da nešto ne štima. Isti obrazac koji već
 * nosi `razilazenjeVlasnistvaMinimalne` (`masters/items.write-policy.ts`).
 */
export function razilazenjeVrsteISeme(params: {
  documentTypeCode: string;
  schemeId: number;
  orderType: string;
  schemeLines: ReadonlyArray<{ defDebit: string | null; defCredit: string | null }>;
  isInbound: boolean;
}): string | null {
  if (vrstaNosiPdv(params.documentTypeCode)) return null;

  const referenced = slovaKojaSemaReferise(params.schemeLines);
  const sudari = vatSlotsFor(params.isInbound).filter((s) =>
    referenced.has(s.letter),
  );
  if (sudari.length === 0) return null;

  const slova = sudari.map((s) => `${s.letter} (${s.label})`).join(", ");
  return (
    `Vrsta dokumenta ${params.documentTypeCode} je u ovom kodu proglašena NEPORESKOM ` +
    `(PDV se za nju ne računa), a šema za kontiranje ${params.schemeId} ` +
    `(${params.orderType}) ima red za PDV slot: ${slova}. Taj red bi UVEK bio nula i ` +
    `tiho bi ispao iz naloga, pa bi izgledalo da je porez proknjižen a ne bi bio. ` +
    `Ili obriši PDV red iz šeme (ako vrsta zaista nije poreska), ili izbaci ` +
    `${params.documentTypeCode} iz VRSTE_BEZ_PDV u ` +
    `gl/posting/pdv-po-vrsti-dokumenta.ts (ako jeste) — uz merenje, kao i ostale.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAG: STAVKA SA PORESKOM STOPOM NA NEPOREZNOJ VRSTI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Šta je motor NE-izračunao zato što vrsta ne nosi PDV.
 *
 * ⚠️ POSTOJI ZATO ŠTO SE NE ODBIJA. Odluka (08.08.2026): dokument se **ne odbija** —
 * višak sa popisa je legitiman i mora da prođe, a tarifa 20 % na artiklu je NORMALNA
 * (svih 92.574 artikla je nosi); odbijanje bi značilo da se popis ne može zaključiti
 * dok se ne izmeni šifarnik. Ali se ni ne prećutkuje: činjenica „na neporeskoj vrsti
 * stoje oporezive stavke" je podatak koji nekome treba da bude vidljiv, pa ide u log
 * kao UPOZORENJE, sa iznosom koji bi porez bio.
 *
 * Sam podatak se pri tom NE GUBI — tarifa ostaje na `stock_document_items.
 * goods_tax_rate_code` i na artiklu, pa se svaki ovakav dokument može naknadno naći
 * upitom. Log je pokazivač, ne jedini primerak.
 */
export interface PotisnutPdv {
  readonly documentTypeCode: string;
  /** Šifre tarifa sa ne-nultom stopom, sortirane (npr. `["3"]`). */
  readonly sifreStopa: readonly string[];
  /** Koliko stavki dokumenta nosi ne-nultu stopu. */
  readonly brojStavki: number;
  /** Osnovica tih stavki u smeru dokumenta (ulaz: nabavna+zavisni; izlaz: stvarna VP). */
  readonly osnovica: Prisma.Decimal;
  /** PDV koji bi nastao da je vrsta poreska. */
  readonly iznos: Prisma.Decimal;
}

/** Tekst upozorenja koje ide u log — jedno mesto, da poruka ne postoji u dva oblika. */
export function porukaPotisnutogPdva(
  docId: number,
  p: PotisnutPdv,
  isInbound: boolean,
): string {
  const strana = isInbound ? "pretporez" : "izlazni PDV";
  return (
    `Robni dokument ${docId} (vrsta ${p.documentTypeCode}): ${p.brojStavki} ` +
    `stavka/e nosi poresku tarifu (šifre ${p.sifreStopa.join(", ")}), osnovica ` +
    `${p.osnovica.toFixed(2)}. PDV NIJE obračunat i to je namerno — kod te vrste ` +
    `dokumenta PDV ne postoji kao poreski događaj, pa bi ${strana} od ` +
    `${p.iznos.toFixed(2)} bio izmišljen porez. Tarifa je svojstvo ARTIKLA, ne ovog ` +
    `dokumenta, i ostaje zapisana na stavci — ovo je trag, ne greška. Ako vrsta ` +
    `${p.documentTypeCode} ipak treba da nosi PDV, izmeni VRSTE_BEZ_PDV u ` +
    `gl/posting/pdv-po-vrsti-dokumenta.ts (uz merenje) i dopuni šemu redom za tu stopu.`
  );
}
