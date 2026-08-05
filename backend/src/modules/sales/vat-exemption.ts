/**
 * OSNOV PORESKOG OSLOBOĐENJA — JEDNO MESTO ZA PAPIR I ZA SEF (02.08.2026).
 *
 * Do sada je isti podatak stajao UKUCAN na pet mesta, i ta mesta se nisu slagala:
 *
 *   ubl-builder.service.ts:44   „Izvoz dobara (čl. 24 st. 1 tač. 5 ZPDV)"   ← SEF
 *   templates/ino-roba.ts:31    „…člana 24. stav 1 tačka 2 Zakona o PDV."   ← papir
 *   templates/ino-usluga.ts:102 „…člana 24. stav 2 Zakona o pdv."           ← papir
 *   templates/domaca-roba.ts:58   „Napomena o poreskom oslobodjenju: NEMA"  ← uvek, bez izuzetka
 *   templates/domaca-usluga.ts:46 isto
 *
 * Za IZVOZ ROBE papir i SEF navode RAZLIČIT član — bar jedno nije tačno, a oba idu
 * istom kupcu za isti posao. Zato osnov od sada postoji na jednom mestu, pa je
 * neslaganje nemoguće; ispravka teksta je jedna izmena, ne pet.
 *
 * ⚠️ TEKSTOVI ISPOD SU PREPISANI IZ ZATEČENOG KODA I PAPIRA, NISU PRAVNO POTVRĐENI.
 *    Tačan član po vrsti prometa mora da potvrdi knjigovođa — v.
 *    `docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §7. Do potvrde se NE menjaju brojevi
 *    članova; menja se samo to što ih sada ima jedan primerak umesto pet.
 *
 * ⚠️ SUMNJA KOJU JE PROVERA OTVORILA: usluga stranom licu možda uopšte NIJE
 *    „oslobođenje po članu 24" nego promet čije MESTO nije u Srbiji (pa se PDV ne
 *    obračunava iz drugog razloga). To bi značilo drugu napomenu na papiru i drugu
 *    poresku kategoriju u SEF-u. Dok knjigovođa ne presudi, ostaje zatečeni tekst.
 */

import {
  DEFAULT_TAX_TREATMENT,
  type DocumentTaxTreatment,
} from "./service-revenue-type";

/** Vrsta prometa koja određuje osnov oslobođenja. */
export type ExemptionCase =
  /** Domaći promet sa obračunatim PDV-om — nema oslobođenja. */
  | "domestic-taxed"
  /** Domaći promet bez PDV-a (kategorija E) — osnov MORA postojati. */
  | "domestic-exempt"
  /** Izvoz dobara. */
  | "export-goods"
  /** Usluga stranom licu. */
  | "export-service"
  /**
   * DOMAĆI promet na kom PDV obračunava KUPAC (poreski dužnik je primalac, čl. 10 st. 2
   * t. 1 ZPDV) — prodaja otpada. Kategorija `AE`, ne `E`: promet nije oslobođen nego
   * oporeziv, samo ga oporezuje druga strana.
   */
  | "domestic-reverse-charge"
  /**
   * Usluga čije MESTO PROMETA nije u Srbiji (čl. 12 st. 3 ZPDV) — kategorija `O`
   * („outside scope"). Nije oslobođenje po čl. 24 nego promet van polja primene.
   */
  | "outside-scope-service";

export interface ExemptionBasis {
  /** Tekst koji ide na PAPIR, doslovno kako se štampa. */
  paperText: string;
  /** Tekst razloga za SEF (EN16931 BT-120). */
  sefReason: string;
  /** Šifra razloga za SEF (BT-121); `null` = šifra još nije utvrđena. */
  sefCode: string | null;
}

/**
 * `null` znači „nema oslobođenja" — na papiru se štampa `NEMA_TEXT`, a u SEF ne ide
 * nikakav razlog (kategorija S sa stvarnom stopom).
 */
export function exemptionFor(kind: ExemptionCase): ExemptionBasis | null {
  switch (kind) {
    case "domestic-taxed":
      return null;

    case "domestic-exempt":
      // EN16931 BR-E-10: kategorija E MORA nositi razlog (BT-120) ILI šifru (BT-121),
      // inače SEF odbija dokument. Tačan osnov čeka knjigovođu — dotle opis situacije,
      // ne izmišljen član.
      return {
        paperText:
          "Napomena o poreskom oslobodjenju: promet oslobođen PDV-a — osnov se utvrđuje po dokumentu.",
        sefReason: "Oslobođen promet — osnov se utvrđuje po dokumentu",
        sefCode: null,
      };

    case "export-goods":
      return {
        paperText:
          "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
        sefReason: "Izvoz dobara (čl. 24 st. 1 tač. 5 ZPDV)",
        sefCode: "PDV-RS-24-1-5",
      };

    case "export-service":
      return {
        paperText:
          "Napomena: Oslobodjeno PDV-a na osnovu člana 24. stav 2 Zakona o pdv.",
        sefReason: "Usluga stranom licu (čl. 24 ZPDV)",
        sefCode: null,
      };

    // ── REZERVA, NE DRUGI PRIMERAK ────────────────────────────────────────────
    // Za dve vrste ispod je MERODAVAN tekst iz šifarnika vrsta usluge
    // (`service_revenue_types.paper_note`), koji je 05.08.2026. potvrdio vlasnik i koji
    // uređuje knjigovođa. Papir ga uzima odatle (`PrintCtx.serviceRevenueNote`), a ovde
    // stoji samo ono što se štampa ako knjigovođa napomenu OBRIŠE — prazan red na
    // poreskom dokumentu bi bio gori od skraćene formulacije. Za SEF (BT-120) je ovo
    // ujedno i tekst razloga, jer razlog tamo mora da postoji.
    case "domestic-reverse-charge":
      return {
        paperText:
          "PDV nije obračunat — poreski dužnik je primalac dobara, član 10. stav 2. " +
          "tačka 1. Zakona o PDV-u",
        sefReason:
          "Obveznik PDV-a je primalac dobara (čl. 10 st. 2 t. 1 ZPDV)",
        sefCode: null,
      };

    case "outside-scope-service":
      // ⚠️ OVO ZATVARA SUMNJU IZ UVODA FAJLA. Tamo je 02.08.2026. zapisano da usluga
      // stranom licu možda uopšte nije „oslobođenje po članu 24" nego promet čije mesto
      // nije u Srbiji. Vlasnik i knjigovođa su 05.08.2026. potvrdili baš to — za vrstu
      // `USL-INO` (konto 6151). Zatečeni `export-service` tekst se NE menja: on i dalje
      // važi za izvozni uslužni račun kod kog vrsta usluge nije izabrana, pa se stara
      // formulacija ne gubi dok knjigovođa ne prevede zatečene dokumente.
      return {
        paperText:
          "PDV nije obračunat u skladu sa članom 12. stav 3. Zakona o PDV-u " +
          "(mesto prometa usluge je van teritorije Republike Srbije)",
        sefReason:
          "Mesto prometa usluge je van teritorije RS (čl. 12 st. 3 ZPDV)",
        sefCode: null,
      };
  }
}

/** Šta se štampa kad oslobođenja nema — doslovno kako je na donetim papirima. */
export const NEMA_TEXT = "Napomena o poreskom oslobodjenju: NEMA";

/**
 * Izvedi slučaj iz samog dokumenta. Namerno ne gleda `documentType` nego SUŠTINU
 * (izvoz? ima li obračunatog PDV-a?) — nova vrsta dokumenta ne sme tiho da promeni
 * poresku napomenu.
 */
export function exemptionCaseFor(args: {
  isExport: boolean;
  isService: boolean;
  /** Ukupan obračunat PDV na dokumentu. */
  vatTotalIsZero: boolean;
  /**
   * Poreski tretman iz šifarnika vrsta usluge (05.08.2026). Kad ga nema, ponašanje je
   * zatečeno — `TAXED`.
   *
   * ⚠️ TRETMAN IMA PREDNOST NAD „ima li PDV-a": nula poreza je POSLEDICA, ne razlog.
   * Faktura za otpad i faktura oslobođena po nekom drugom osnovu izgledaju isto u
   * `vatTotal` (obe nula), a na papiru moraju da nose različitu — i pravno različitu —
   * rečenicu. Dok je jedini ulaz bio `vatTotalIsZero`, obe su izlazile kao
   * „domestic-exempt", tj. kao promet oslobođen PDV-a; kupac otpada iz toga nije mogao
   * da zna da PDV mora da obračuna sam.
   */
  taxTreatment?: DocumentTaxTreatment;
}): ExemptionCase {
  const treatment = args.taxTreatment ?? DEFAULT_TAX_TREATMENT;
  if (treatment === "REVERSE_CHARGE") return "domestic-reverse-charge";
  if (treatment === "OUTSIDE_SCOPE") return "outside-scope-service";
  if (args.isExport) return args.isService ? "export-service" : "export-goods";
  return args.vatTotalIsZero ? "domestic-exempt" : "domestic-taxed";
}
