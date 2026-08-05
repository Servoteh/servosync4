/**
 * VRSTA USLUGE — JEDNO MESTO ZA „ŠTA SE PRODAJE" (05.08.2026).
 * =============================================================================
 *
 * Potvrdili vlasnik i knjigovođa 05.08.2026. na predlog
 * `backend/docs/USLUGE_KONTA_PREDLOG.md`. Suština: **komercijala ne bira konto, nego
 * bira ŠTA PRODAJE** — a konto prihoda, poreski tretman i napomena na papiru slede iz
 * tog jednog izbora.
 *
 * ZAŠTO TO NIJE MOGLO DA OSTANE „slobodan izbor konta". Uz konto ide i poreski tretman:
 *
 *   šifra      naziv                      konto   PDV
 *   USL        Usluga (domaće tržište)     6140    20 % → konto 4703
 *   USL-INO    Usluga stranom kupcu        6151    bez PDV-a (čl. 12 st. 3 — mesto
 *                                                  prometa je van RS)
 *   OTPAD      Prodaja otpada              6796    MI NE OBRAČUNAVAMO — poreski dužnik
 *                                                  je PRIMALAC (čl. 10 st. 2 t. 1)
 *   ZAKUP      Zakup poslovnog prostora    6501    20 % → konto 4703
 *
 * Da se bira samo konto, neko bi pre ili kasnije izabrao `6796` a sistem bi svejedno
 * obračunao PDV — i faktura za otpad bi izašla sa porezom koji po zakonu obračunava
 * kupac. Vezivanjem u JEDAN izbor ta greška postaje nemoguća.
 *
 * IZMERENO (glavna knjiga 2026, potražna strana): `6140` 45 stavki / 18.273.557,50 ·
 * `6151` 2 / 2.490.465,79 · `6796` 10 / 1.222.645,05 · `6501` 0 stavki (zakup postoji
 * na papiru `IFUSL 653/25` iz 2025, koji nije u uvezenoj knjizi). Dakle zatečena
 * konstanta `6140` je bila tačna za 45 od 57 stavki.
 *
 * ⚠️ SPISAK VREDNOSTI JE OVDE, A PODACI SU U BAZI (`service_revenue_types`). Ovde stoji
 * samo ono što KOD mora da razume — tri poreska tretmana i njihovo značenje. Šifre,
 * nazivi, konta i tekstovi napomena su podaci koje uređuje knjigovođa; nova vrsta usluge
 * je novi red u šifarniku, bez izmene ijedne linije koda.
 */

import type { Prisma } from "@prisma/client";

/**
 * VRSTE DOKUMENTA KOJE SU USLUŽNE. Jedan spisak za ceo modul prodaje.
 *
 * ⚠️ Do 05.08.2026. je ovaj `Set` živeo kao privatna konstanta u
 * `fakturisanje.service.ts` (knjiženje), pa ga je svako drugo mesto koje treba isto
 * pitanje moralo da prepiše. Sada ga uvoze i knjiženje, i poreski tretman, i validacija
 * — jedan spisak znači da vrsta ne može da bude „uslužna za konto, a robna za porez".
 */
export const SERVICE_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "IFUSL",
  "IZVUS",
]);

/** Da li je dokument uslužni (`IFUSL` / `IZVUS`) — normalizovano, kao svuda. */
export function isServiceDocument(documentType: string | null | undefined): boolean {
  return SERVICE_DOCUMENT_TYPES.has((documentType ?? "").trim().toUpperCase());
}

/**
 * KO OBRAČUNAVA PDV NA OVOM DOKUMENTU.
 *
 *   `TAXED`          mi, po stopi stavke — podrazumevano i za svu robu;
 *   `REVERSE_CHARGE` KUPAC: poreski dužnik je primalac dobara (čl. 10 st. 2 t. 1 ZPDV);
 *   `OUTSIDE_SCOPE`  niko: mesto prometa usluge je van teritorije RS (čl. 12 st. 3).
 *
 * ⚠️ POSLEDNJA DVA NISU IZVOZ, i to je najvažnija razlika u celom ovom modulu.
 * `isExport` je zaseban podatak (konto kupca `2050`, strana valuta, ino obrazac,
 * oslobođenje po čl. 24, dokument van domaćeg SEF-a). Kod otpada je promet DOMAĆI —
 * kupac je domaći, konto kupca je `2040`, dokument ide na SEF — samo porez obračunava
 * kupac umesto nas. Zato se tretman NE sme svesti na `isExport`, iako oba završavaju
 * time da na našoj fakturi nema poreza.
 *
 * IZMERENO nad svih 10 dokumenata sa kontom `6796` u knjizi 2026: kupčev DUG na `2040`
 * je TAČNO jednak prihodu na `6796`, a nijedan nema nijedan red na kontima izlaznog
 * PDV-a (`47xx`). Npr. `042/26`: `2040` DUG 123.552,00 / `6796` POT 123.552,00.
 */
export type DocumentTaxTreatment = "TAXED" | "REVERSE_CHARGE" | "OUTSIDE_SCOPE";

/** Podrazumevani tretman — mi obračunavamo PDV. Sve što nije uslužno je ovo. */
export const DEFAULT_TAX_TREATMENT: DocumentTaxTreatment = "TAXED";

/**
 * Dozvoljene vrednosti — ogledalo DB CHECK-a `chk_service_revenue_types_vat_treatment`.
 * Postoji zato da red unet mimo aplikacije (ručno u bazi, budući uvoz) ne bi tiho
 * prošao kao `TAXED` i obračunao PDV na prometu na kom ga ne sme biti — v.
 * `taxTreatmentOfValue`, koji nepoznatu vrednost ODBIJA umesto da je pretpostavi.
 */
export const TAX_TREATMENTS: ReadonlySet<string> = new Set<DocumentTaxTreatment>([
  "TAXED",
  "REVERSE_CHARGE",
  "OUTSIDE_SCOPE",
]);

/** Šifra vrste koja se predlaže pri unosu — 45 od 57 izmerenih stavki je domaća usluga. */
export const DEFAULT_SERVICE_REVENUE_TYPE_CODE = "USL";

/**
 * Minimum reda šifarnika koji kod stvarno koristi. Namerno NIJE ceo Prisma model:
 * čista računica (knjiženje, poreski zbirovi, štampa) mora da se meri bez baze.
 */
export interface ServiceRevenueTypeRef {
  code: string;
  /** Konto prihoda (meki ref `accounts.code`). */
  revenueAccountCode: string;
  /** Sirova vrednost iz baze — proverava je `taxTreatmentOfValue`. */
  vatTreatment: string;
  /** Napomena za papir; `null` = nema napomene (`USL`, `ZAKUP`). */
  paperNote?: string | null;
}

/**
 * Oblik zaglavlja koji je dovoljan da se odredi poreski tretman.
 *
 * Traži se I `documentType` I šifarnik, a ne samo šifarnik — v. `taxTreatmentOf`.
 */
export interface TaxTreatmentSource {
  documentType?: string | null;
  serviceRevenueType?: ServiceRevenueTypeRef | null;
}

/**
 * Sirova vrednost iz baze → tretman. Nepoznata vrednost se ODBIJA (izuzetak), ne
 * pretpostavlja.
 *
 * ⚠️ ZAŠTO IZUZETAK, A NE `?? "TAXED"`: tiho svođenje na `TAXED` znači da bi red sa
 * greškom u kucanju („REVERSE-CHARGE", „reverse_charge") obračunao 20 % PDV-a na
 * fakturi za otpad — dakle porez koji po zakonu obračunava kupac, na dokumentu koji
 * balansira i koji nijedna kontrola ne bi prijavila. Ista logika kao brana za PDV stopu
 * bez konta u `buildSalesLedgerLines`: bolje odbiti sa objašnjenjem nego proknjižiti
 * poresku tvrdnju koju niko nije izabrao.
 */
export function taxTreatmentOfValue(value: string): DocumentTaxTreatment {
  const normalized = (value ?? "").trim().toUpperCase();
  if (!TAX_TREATMENTS.has(normalized)) {
    throw new Error(
      `Vrsta usluge ima nepoznat poreski tretman „${value}". Dozvoljeno je: ` +
        `${[...TAX_TREATMENTS].join(", ")}. Ispravi red u šifarniku vrsta usluge ` +
        `(tabela service_revenue_types).`,
    );
  }
  return normalized as DocumentTaxTreatment;
}

/**
 * PORESKI TRETMAN DOKUMENTA — jedina funkcija koja na to pitanje odgovara.
 *
 * ⚠️ TRAŽI SE I VRSTA DOKUMENTA: vrsta usluge se sme naći i na predračunu (`PON`/`PROF`)
 * koji tek treba da se prepiše u račun, ali dok dokument nije uslužan, tretman NE SME da
 * deluje. Bez tog uslova bi predračun koji se prepiše u robnu fakturu (`IFR`) zadržao
 * `REVERSE_CHARGE` iz zaglavlja, pa bi robni promet izašao bez PDV-a a prihod svejedno
 * otišao na robni konto `6040` — kombinacija koja ne postoji ni u jednom propisu.
 *
 * Zbog toga se OVDE, a ne u pozivaocu, spajaju oba uslova: svaki računar PDV-a u sistemu
 * (zaglavlje, glavna knjiga, papir, e-faktura) prolazi kroz ovu funkciju, pa ne postoji
 * put kojim se tretman može primeniti na dokument kom ne pripada.
 */
export function taxTreatmentOf(header: TaxTreatmentSource): DocumentTaxTreatment {
  if (!isServiceDocument(header.documentType)) return DEFAULT_TAX_TREATMENT;
  const raw = header.serviceRevenueType?.vatTreatment;
  if (raw == null) return DEFAULT_TAX_TREATMENT;
  return taxTreatmentOfValue(raw);
}

/**
 * Da li na NAŠOJ fakturi uopšte ima obračunatog PDV-a po ovom tretmanu.
 * `REVERSE_CHARGE` i `OUTSIDE_SCOPE` obaraju sve stavke na 0 % — v. `vat-totals.ts`.
 */
export function treatmentChargesVat(treatment: DocumentTaxTreatment): boolean {
  return treatment === "TAXED";
}

/**
 * Napomena za papir sa izabrane vrste usluge; `null` = vrsta je nema (ili nije izabrana),
 * pa obrazac pada na zatečeni tekst iz `vat-exemption.ts`.
 *
 * Prazan/space-only tekst se namerno svodi na `null`: knjigovođa koji obriše napomenu
 * dobija rezervni tekst, a ne prazan red na poreskom dokumentu.
 */
export function paperNoteOf(header: TaxTreatmentSource): string | null {
  if (!isServiceDocument(header.documentType)) return null;
  const note = header.serviceRevenueType?.paperNote;
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `select` za Prismu — jedan oblik za sve pozivaoce.
 *
 * Postoji zato što tretman mora da stigne do SVAKOG računara PDV-a: ko učita račun bez
 * ovog dela, tiho dobija `TAXED`. Sa jednim imenom se bar vidi ko ga je propustio.
 */
export const SERVICE_REVENUE_TYPE_SELECT = {
  select: {
    code: true,
    revenueAccountCode: true,
    vatTreatment: true,
    paperNote: true,
  },
} satisfies Prisma.Invoice$serviceRevenueTypeArgs;
