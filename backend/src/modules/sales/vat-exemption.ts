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

/** Vrsta prometa koja određuje osnov oslobođenja. */
export type ExemptionCase =
  /** Domaći promet sa obračunatim PDV-om — nema oslobođenja. */
  | "domestic-taxed"
  /** Domaći promet bez PDV-a (kategorija E) — osnov MORA postojati. */
  | "domestic-exempt"
  /** Izvoz dobara. */
  | "export-goods"
  /** Usluga stranom licu. */
  | "export-service";

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
}): ExemptionCase {
  if (args.isExport) return args.isService ? "export-service" : "export-goods";
  return args.vatTotalIsZero ? "domestic-exempt" : "domestic-taxed";
}
