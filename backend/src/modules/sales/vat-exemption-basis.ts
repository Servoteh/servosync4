/**
 * OSNOV PORESKOG OSLOBOĐENJA — ŠIFARNIK, JER SE VIŠE NE MOŽE IZVESTI (05.08.2026).
 * =============================================================================
 *
 * Potvrdio knjigovođa 05.08.2026, odgovori 8, 9 i 10 (`backend/docs/ODGOVORI_38_UTICAJ.md`
 * §1.3). Doslovno:
 *
 *   „Za izvoz robe koristimo član 24.1.2. Takva faktura ne ide na sef.
 *    Član 24.1.5 je vezan za robu koja se izdaje kod unosa dobara u slobodnu zonu.
 *    Takva faktura se šalje na SEF, i ručno unosimo poreska oslobođenja."
 *
 *   „Za ino fakture koristimo oslobođenje 24.1.7 — za robu koja je nabavljena od strane
 *    ino primaoca a kasnije se njemu i vraća (oplemenjivanje). Za usluge koje su izvršene
 *    u inostranstvu pozivamo se na član 12 stav 3 … Ovo se odnosi i na uslugu izvršenu u
 *    Srbiji za lice koje je strani poreski obveznik, samo se tada ne navodi VAN TERITORIJE
 *    REPUBLIKE SRBIJE."
 *
 *   „IMAMO. (Napomena o poreskom oslobođenju: Oslobođeno PDV-a na osnovu člana 24 stav 1
 *    tačka 5 o PDV-u)"  ← domaći promet bez PDV-a
 *
 * ── ZAŠTO ŠIFARNIK, A NE IZVOĐENJE IZ DOKUMENTA ─────────────────────────────
 * `vat-exemption.ts` je do danas osnov IZVODIO iz dokumenta i u komentaru izričito
 * pisalo da „namerno ne gleda `documentType` nego suštinu". To više ne radi: ista
 * situacija „izvoz robe" po odgovorima daje TRI osnova —
 *
 *     24.1.2  redovan izvoz            → NE ide na SEF
 *     24.1.5  unos u slobodnu zonu     → IDE na SEF
 *     24.1.7  oplemenjivanje (povraćaj ino primaocu)
 *
 * — a iz podataka o dokumentu (vrsta, `is_export`, ima li PDV-a) sve tri izgledaju
 * IDENTIČNO. Koji je od tri, zna samo onaj ko dokument pravi. Zato se BIRA.
 *
 * ── ZAŠTO OSNOV NOSI I KAPIJU „IDE / NE IDE NA SEF" ─────────────────────────
 * Odgovor 8 uz osnov vezuje i TOK, i to dva suprotna toka za dva osnova koja se na
 * dokumentu ne razlikuju ničim drugim. Do danas je o tome odlučivala zastavica
 * `is_export` (`sef/sef.service.ts` je odbijao SVAKI izvoz), pa faktura za slobodnu
 * zonu — koja MORA na SEF — ne bi mogla da se pošalje, a razlog bi glasio
 * „izvozna faktura ne ide na domaći SEF". Kapija zato pita OSNOV.
 *
 * ── ŠTA JE OVDE, A ŠTA U BAZI ───────────────────────────────────────────────
 * Ovde stoji samo ono što KOD mora da razume: oblik reda i pravilo kapije. Šifre,
 * nazivi, tekstovi za papir i SEF šifre su PODACI koje uređuje knjigovođa
 * (`vat_exemption_bases`) — nov osnov je nov red u šifarniku, bez izmene ijedne linije
 * koda. Isti odnos kao kod `service-revenue-type.ts`.
 */

import type { Prisma } from "@prisma/client";

/**
 * Minimum reda šifarnika koji kod stvarno koristi. Namerno NIJE ceo Prisma model:
 * i papir i UBL moraju da se mere bez baze.
 */
export interface VatExemptionBasisRef {
  /** Šifra koju vidi korisnik (`IZVOZ-DOBARA`, `SLOBODNA-ZONA`…). */
  code: string;
  /** Naziv sa padajuće liste. */
  name: string;
  /** DOSLOVAN tekst koji izlazi na papir. Jedini izvor za štampu. */
  paperText: string;
  /**
   * Šifra razloga za SEF (EN16931 BT-121), oblik `PDV-RS-24-1-2`. `null` = za taj osnov
   * šifra nije utvrđena (čl. 12 st. 3 nije oslobođenje po čl. 24 nego promet van polja
   * primene), pa u UBL ide samo tekst razloga (BT-120) — što EN16931 dozvoljava.
   */
  sefCode: string | null;
  /** Tekst razloga za SEF (BT-120). Uvek postoji: bez njega SEF odbija dokument. */
  sefReason: string;
  /**
   * DA LI DOKUMENT SA OVIM OSNOVOM IDE NA SEF. Nije izvedeno iz `is_export` — v. uvod.
   */
  goesToSef: boolean;
}

/**
 * `select` za Prismu — jedan oblik za sve pozivaoce (papir, e-faktura, ekran).
 *
 * Postoji iz istog razloga kao `SERVICE_REVENUE_TYPE_SELECT`: ko učita račun bez ovog
 * dela, tiho dobija „osnov nije izabran" i odštampa REZERVNI tekst umesto izabranog —
 * dakle drugu pravnu tvrdnju, bez ijedne greške. Sa jednim imenom se bar vidi ko ga je
 * propustio.
 */
export const VAT_EXEMPTION_BASIS_SELECT = {
  select: {
    code: true,
    name: true,
    paperText: true,
    sefCode: true,
    sefReason: true,
    goesToSef: true,
  },
} satisfies Prisma.Invoice$vatExemptionBasisArgs;

/**
 * SME LI DOKUMENT SA OVIM OSNOVOM NA SEF.
 *
 * `null` (osnov nije izabran) NAMERNO vraća `null`, a ne `true`/`false`: „nije izabrano"
 * nije odgovor na to pitanje, i kapija tada mora da padne na zatečeno pravilo
 * (`is_export`) umesto da pretpostavi. Tiho `true` bi na SEF pustilo izvoznu fakturu
 * koja tamo ne ide; tiho `false` bi zaustavilo domaći promet koji ide svaki dan.
 */
export function basisAllowsSef(
  basis: VatExemptionBasisRef | null | undefined,
): boolean | null {
  return basis ? basis.goesToSef : null;
}

/**
 * ŠIFRE SEMENA — kod ih poznaje SAMO da bi mogao da predloži podrazumevani osnov po
 * vrsti dokumenta (`document_types.default_vat_exemption_code`) i da bi ih test mogao
 * da imenuje. Sve ostalo je podatak: knjigovođa sme da doda osnov, ugasi ga i promeni
 * mu tekst, a da ovaj spisak ne dira.
 */
export const VAT_EXEMPTION_BASIS_CODES = {
  /** Redovan izvoz dobara — čl. 24 st. 1 t. 2. NE ide na SEF. */
  EXPORT_GOODS: "IZVOZ-DOBARA",
  /** Unos dobara u slobodnu zonu — čl. 24 st. 1 t. 5. IDE na SEF. */
  FREE_ZONE: "SLOBODNA-ZONA",
  /** Oplemenjivanje (povraćaj robe ino primaocu) — čl. 24 st. 1 t. 7. */
  INWARD_PROCESSING: "OPLEMENJIVANJE",
  /** Domaći oslobođen promet — čl. 24 st. 1 t. 5. IDE na SEF. */
  DOMESTIC_EXEMPT: "DOMACI-OSLOBODJEN",
  /** Usluga izvršena u inostranstvu — čl. 12 st. 3, sa „van teritorije RS". */
  SERVICE_OUTSIDE_RS: "USLUGA-VAN-RS",
  /** Usluga u RS za stranog poreskog obveznika — čl. 12 st. 3, BEZ te odredbe. */
  SERVICE_FOREIGN_TAXPAYER: "USLUGA-STRANO-LICE",
} as const;
