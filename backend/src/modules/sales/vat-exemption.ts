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
import type { VatExemptionBasisRef } from "./vat-exemption-basis";

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
      // 🔴 ISPRAVKA ŽIVOG KVARA (05.08.2026): do danas je papir ovde citirao TAČKU 2, a
      // SEF šifra i razlog TAČKU 5 — dva različita člana za isti posao istom kupcu.
      // Knjigovođa je presudio (odgovor 8): „Za izvoz robe koristimo član 24.1.2… Član
      // 24.1.5 je vezan za robu koja se izdaje kod unosa dobara u slobodnu zonu."
      // Dakle papir je bio tačan, a SEF šifra pogrešna — ispravlja se šifra, ne tekst.
      // Slobodna zona nije nestala: dobila je SVOJ red u šifarniku osnova
      // (`VAT_EXEMPTION_BASIS_CODES.FREE_ZONE`), jer se od izvoza ne razlikuje nijednim
      // podatkom dokumenta pa se ne može izvesti — mora da se bira.
      return {
        paperText:
          "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
        sefReason: "Izvoz dobara (čl. 24 st. 1 tač. 2 ZPDV)",
        sefCode: "PDV-RS-24-1-2",
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
      //
      // 🔴 TEKST JE 07.08.2026. DOBIO ODOBREN OBLIK (pitanje P-F(b)). Ovo je REZERVA za
      // dokument bez izabranog osnova, a odobrena rečenica živi u šifarniku
      // (`USLUGA-VAN-RS`) — ali obe se štampaju na papiru kao ISTA tvrdnja o istom članu,
      // pa ne smeju da se razlikuju u formulaciji. Kad bi rezerva ostala na staroj
      // varijanti, ista izvozna uslužna faktura bi nosila jednu rečenicu sa izabranim
      // osnovom, a drugu bez njega. Menja se SAMO tekst; `sefReason` i `sefCode` (null)
      // ostaju, jer o njima knjigovođa nije govorio.
      return {
        paperText:
          "PDV nije obračunat u skladu sa članom 12. stav 3 Zakona o PDV — " +
          "mesto prometa usluge je van teritorije Republike Srbije.",
        sefReason:
          "Mesto prometa usluge je van teritorije RS (čl. 12 st. 3 ZPDV)",
        sefCode: null,
      };
  }
}

/** Šta se štampa kad oslobođenja nema — doslovno kako je na donetim papirima. */
export const NEMA_TEXT = "Napomena o poreskom oslobodjenju: NEMA";

/**
 * OSNOV JEDNOG DOKUMENTA — JEDINA FUNKCIJA KROZ KOJU PROLAZE I PAPIR I E-FAKTURA.
 * =============================================================================
 *
 * 🔴 OVO JE POPRAVKA KVARA ZBOG KOG JE CEO OVAJ POSAO I RAĐEN. Do 05.08.2026. su papir i
 * SEF za IZVOZ ROBE navodili RAZLIČIT član (papir „24. stav 1 tačka 2", SEF šifra
 * `PDV-RS-24-1-5`) — dva pravna osnova za isti posao istom kupcu, na dva dokumenta koja
 * su oba original. Razlog je bio to što su papir i UBL uzimali RAZLIČITA POLJA iste
 * strukture, pa nesaglasnost nije mogla da padne ni na jednom testu.
 *
 * Od sada oba pozivaoca dobijaju JEDAN objekat iz JEDNOG poziva: papir uzima
 * `paperText`, UBL uzima `sefCode`/`sefReason`, i sva tri polja dolaze sa ISTOG reda.
 * Neslaganje je time strukturno nemoguće — ne zato što ga test hvata, nego zato što
 * nema dva izvora između kojih bi se razišlo.
 *
 * ── REDOSLED IZVORA (od najjačeg) ───────────────────────────────────────────
 *  1. `basis` — OSNOV IZABRAN NA DOKUMENTU (`invoices.vat_exemption_basis_id`). Jači je
 *     od svega jer je jedini koji razlikuje tri situacije koje se iz podataka ne mogu
 *     razlikovati (izvoz 24.1.2 / slobodna zona 24.1.5 / oplemenjivanje 24.1.7).
 *  2. `serviceRevenueNote` — napomena sa izabrane VRSTE USLUGE
 *     (`service_revenue_types.paper_note`, potvrđena 05.08.2026). Nju uređuje isti
 *     knjigovođa; deluje samo na papir, jer razlog za SEF nosi poreski tretman
 *     (kategorije `AE`/`O`), ne ovaj tekst.
 *  3. `fallbackCase` — zatečeno IZVOĐENJE iz dokumenta. Ostaje isključivo kao rezerva za
 *     dokument BEZ izbora, da papir nikad ne izađe bez poreske napomene (v. odeljak
 *     „PODRAZUMEVANA VREDNOST" u migraciji). Zatečeni računi se time ne menjaju.
 */
export interface ResolvedExemption {
  /** Tekst za papir — nikad prazan (najgore što može je `NEMA_TEXT`). */
  paperText: string;
  /** Razlog za SEF (BT-120); `null` samo kad oslobođenja uopšte nema. */
  sefReason: string | null;
  /** Šifra za SEF (BT-121); `null` = za taj osnov šifra nije utvrđena. */
  sefCode: string | null;
  /** Odakle je odgovor došao — za log i za test, ne za odluku. */
  source: "basis" | "service-revenue-type" | "derived" | "none";
}

export function resolveExemption(args: {
  /** Osnov izabran na dokumentu; `null` = nije izabran. */
  basis?: VatExemptionBasisRef | null;
  /** Napomena sa vrste usluge (samo papir). */
  serviceRevenueNote?: string | null;
  /** Zatečeno izvođenje — rezerva za dokument bez izbora. */
  fallbackCase: ExemptionCase;
}): ResolvedExemption {
  if (args.basis) {
    return {
      paperText: args.basis.paperText,
      sefReason: args.basis.sefReason,
      sefCode: args.basis.sefCode,
      source: "basis",
    };
  }

  const derived = exemptionFor(args.fallbackCase);

  const note = args.serviceRevenueNote?.trim();
  if (note) {
    // Papir uzima napomenu vrste usluge, a SEF i dalje IZVEDEN razlog. To NIJE
    // nesaglasnost kakvu ovaj modul sprečava: za `OTPAD`/`USL-INO` oba teksta govore
    // istu stvar (čl. 10 st. 2 t. 1 odn. čl. 12 st. 3), samo je jedan formulacija za
    // kupca a drugi za mašinu. Prava nesaglasnost — različit ČLAN — moguća je samo
    // između `paperText` i `sefCode` istog reda, a njih ovde uvek uzimamo zajedno.
    return {
      paperText: note,
      sefReason: derived?.sefReason ?? null,
      sefCode: derived?.sefCode ?? null,
      source: "service-revenue-type",
    };
  }

  if (!derived) {
    return {
      paperText: NEMA_TEXT,
      sefReason: null,
      sefCode: null,
      source: "none",
    };
  }

  return {
    paperText: derived.paperText,
    sefReason: derived.sefReason,
    sefCode: derived.sefCode,
    source: "derived",
  };
}

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
