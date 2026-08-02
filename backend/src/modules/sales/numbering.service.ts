import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DocumentNumberSequenceService — brojači izlaznih dokumenata.
 * ZAMENJUJE „crvenu svesku" (WorkParameter per-username).
 *
 * Broj se rezerviše tek pri knjiženju (level 0), UNUTAR transakcije knjiženja:
 *   • SELECT … FOR UPDATE reda sekvence (ako postoji) ILI upsert (kreiraj sa 0),
 *   • increment lastNumber,
 *   • format = seq + '/' + dvocifrena godina.
 * Ako knjiženje padne, rollback transakcije poništava i rezervaciju broja (bez rupa).
 *
 * ── FORMAT: `NNN/GG` (odluka O-F1, `docs/STAMPA_FAKTURA_ODLUKE.md`) ─────────────
 * Broj je BigBit oblik `657/25`: redni broj BEZ vodećih nula, kosa crta, dvocifrena
 * godina. Nema prefiksa vrste dokumenta.
 *
 * ZAŠTO baš ovde, a ne skraćivanje u štampi: isti broj mora da stoji na papiru koji
 * dobija kupac, u UBL-u koji ide na SEF (`ubl-builder.service.ts` → `cbc:ID`), u
 * glavnoj knjizi (`LedgerEntry.documentNumber`) i u saldakontima (otvorene stavke se
 * grupišu po broju dokumenta). Kad bi se broj skraćivao samo pri štampi, kupac i
 * Poreska uprava bi za isti račun videli jedan broj, a naša knjiga i SEF drugi — a
 * uparivanje uplate sa fakturom (poziv na broj) radi nad brojem iz knjige.
 *
 * ── JEDAN ZAJEDNIČKI NIZ ZA SVE IZLAZNE FAKTURE ────────────────────────────────
 * DOKAZ SA DONETIH PAPIRA (tri stvarne BigBit fakture, tri RAZLIČITE vrste):
 *
 *     IFGP   650/25   22-12-25   (gotovi proizvodi)
 *     IFUSL  653/25   24-12-25   (usluga)
 *     IFR    657/25   25-12-25   (roba)
 *
 * Brojevi su isprepletani i rastu HRONOLOŠKI preko vrsta. Da je brojač po vrsti,
 * tri različite vrste ne bi mogle da daju 650 → 653 → 657 poređane po datumu —
 * svaka bi imala svoj niz i brojevi bi se ponavljali. Dakle BigBit vodi JEDAN niz
 * za sve izlazne fakture, po firmi i godini. Poklapa se i sa ranijom odlukom
 * vlasnika: usluga je poseban EKRAN, ali numeracija je jedan zajednički niz.
 *
 * NE VRAĆATI na brojač po vrsti. Posledica bi bila da IFR i IFUSL oba stignu do
 * 657 u istoj godini i daju DVA dokumenta sa brojem `657/25`.
 *
 * ZAŠTO JE TO VAŽNO NIZVODNO: potrošači broja grupišu po broju dokumenta BEZ
 * vrste — `saldakonti/open-items.service.ts` (`GROUP BY account_code,
 * analytical_code, document_number`), `kamata/kamata.service.ts`,
 * `placanja/payment-preparation.service.ts` i `izvodi/bank-statement.service.ts`
 * (uparivanje uplate po pozivu na broj). Sa jednim nizom je takvo grupisanje
 * BEZBEDNO: broj je jedinstven po firmi i godini, pa dva različita dokumenta ne
 * mogu da se netuju u jednu otvorenu stavku, da se skupe u isti nalog za plaćanje
 * niti da uplata zatvori pogrešnu fakturu. (Sa brojačem po vrsti to bi se dešavalo
 * tiho — bez ijedne greške u bazi, jer unique nad `invoices` uključuje i vrstu.)
 *
 * ── ŠTA NIJE U ZAJEDNIČKOM NIZU ────────────────────────────────────────────────
 * Samo izlazne fakture su u njemu. Avansni račun (AVR), predračun (PROF), ponuda
 * (PON), revers (REV) i svaka druga vrsta ZADRŽAVAJU svoj niz po vrsti — za njih
 * nemamo papir koji pokazuje šta BigBit radi, a avansi imaju i zaseban zakonski niz.
 * Dok se to ne utvrdi, ne uvlače se u niz faktura. Uz sopstveni niz IDE I SOPSTVENI
 * PREFIKS (v. `DOCUMENT_SERIES`, odluka O-F7) — razdvojen brojač bez prefiksa ne
 * razdvaja ništa, jer dva nezavisna niza oba kreću od 1 i oba daju `1/26`.
 *
 * ── AVANSNI RAČUN NOSI PREFIKS `A-` (odluka O-F6) ──────────────────────────────
 * Naš izlazni avansni račun se ne numeriše samo iz drugog BROJAČA nego i u drugom
 * OBLIKU: `A-1/26`, ne `1/26`.
 *
 * SCENARIO IZ KOG JE ODLUKA DOŠLA (dva odvojena kvara, isti uzrok):
 *
 *   1) SUDAR SA DOBAVLJAČEM. Ulazni avansi dobavljača upisuju se u ISTU tabelu
 *      `invoices`, sa ISTOM vrstom `AVR`, a broj se KUCA RUČNO
 *      (`pdv/advance-vat.service.ts` → `recordIncomingAdvance`). Srpski dobavljači
 *      svoje avanse broje isto kao mi — `1/26`. `companyId` sa obe strane pada na
 *      default 0, a `@@unique([companyId, documentType, documentNumber])` ne
 *      razlikuje SMER (`advanceDirection`). Pošto po O-F1 naš broj više ne nosi
 *      slovni prefiks, ishod je: mi izdamo AVR `1/26` → knjigovođa ne može da unese
 *      dobavljačev avans `1/26` (409), ili obrnutim redosledom nama padne izdavanje
 *      avansa usred posla. Prefiks `A-` čini sudar nemogućim bez diranja tabele u
 *      koju se upisuju dobavljačevi avansi.
 *
 *   2) SPAJANJE SA FAKTUROM U GLAVNOJ KNJIZI. Dugovna strana avansnog računa ide na
 *      ISTI kupčev konto kao i faktura (2040/2041 — `advance-invoice.service.ts`),
 *      a otvorene stavke, kamata, priprema plaćanja i uparivanje izvoda grupišu po
 *      (konto, komitent, BROJ DOKUMENTA) — bez vrste. Kupac sa nenaplaćenim AVR
 *      `7/26` (12.000, dospeće 10.02) i fakturom IFR `7/26` (12.000, dospeće 30.06)
 *      bi dao JEDNU otvorenu stavku od 24.000 sa RANIJIM dospećem — i obračun
 *      kamate na duplo veći iznos, mesecima predugo. Sa `A-7/26` i `7/26` to su dva
 *      različita stringa i dve različite grupe.
 *
 * ZAŠTO PREFIKS, A NE VRSTA U GRUPNOM KLJUČU: `ledger_entries` NEMA kolonu vrste
 * dokumenta, a i da je ima, uvođenje vrste u grupni ključ bi RASKINULO netiranje —
 * uplata sa izvoda, ručna korekcija knjigovođe i uvezeni BigBit red nose broj
 * dokumenta ALI NE i vrstu, pa bi faktura i njena uplata pale u dve grupe. Time bi
 * se vratio već zatvoren nalaz VISOK („kamata se računa na već plaćeni deo
 * fakture", v. `kamata.service.ts`). Jedini bezbedan nivo za razdvajanje serija je
 * zato SAM BROJ — grupni ključ ostaje netiranju veran, a serije su po konstrukciji
 * disjunktne. Brana je test „serije su međusobno disjunktne" u
 * `numbering.service.spec.ts`.
 *
 * ── ODNOS PREMA VEĆ POSTOJEĆIM (STARIM) BROJEVIMA ──────────────────────────────
 * Zatečeni dokumenti u obliku `IFR0043/2026` se NE migriraju i NE preimenuju.
 * Sudar je nemoguć iz dva razloga:
 *   1) OBLIK: stari broj uvek nosi slovni prefiks i četvorocifrenu godinu, novi je
 *      samo cifre + '/' + dve cifre — `IFR0043/2026` i `43/26` nikad nisu isti
 *      string, pa jedinstveni indeks `uq_invoices_company_type_number` ne može da
 *      pukne zbog nasleđenog reda.
 *   2) BROJAČ: `document_number_sequences.last_number` se NE resetuje. Redovi po
 *      vrsti zatečeni od ranije se ne diraju i ne migriraju — oni su brojali
 *      dokumente izdate u STAROM obliku, pa nov (zajednički) red može mirno da
 *      krene od 1: nijedan `N/GG` string time ne postaje dvostruk.
 * „Kreće od 1" iz odluke O-F1 tako važi tamo gde reda sekvence još nema (nova
 * godina / nova firma), što je i stvarni slučaj jer se na softver prelazi od nove
 * godine.
 */

/**
 * Ključ zajedničkog niza u `document_number_sequences.document_type`.
 * Počinje znakom `@` koji nijedna BigBit šifra vrste dokumenta ne koristi — tako
 * red zajedničkog niza ne može da se sudari sa redom neke stvarne vrste (ni sa
 * onima zatečenim od ranije). Kolona je VarChar(10), ključ staje.
 */
export const INVOICE_SEQUENCE_KEY = "@FAKTURA";

/**
 * REGISTAR SERIJA — JEDAN izvor istine za oba pravila numeracije.
 * ═══════════════════════════════════════════════════════════════════════════════
 * `vrsta → PREFIKS`, gde prazan prefiks znači „zajednički niz izlaznih faktura".
 * Iz iste mape se izvode i brojač (`sequenceKeyFor`) i oblik broja
 * (`seriesPrefixFor`), pa se to dvoje ne mogu razići: **bez prefiksa se izdaje samo
 * ono što je u nizu faktura, i obrnuto.** Ta ekvivalencija je cela odbrana od
 * spajanja dva dokumenta u jednu otvorenu stavku.
 *
 * ZAŠTO SU U NJEMU I PROF/PON/REV (nalaz N11, 02.08.2026 — odluka O-F7)
 * ───────────────────────────────────────────────────────────────────────────────
 * O-F6 je razdvojila samo avans, uz obrazloženje da se predračun i ponuda „ne knjiže,
 * pa nemaju otvorenu stavku". To je tačno, ali NIJE dovoljno:
 *
 *   • PREDRAČUN je dokument PO KOME KUPAC PLAĆA. `createProforma` mu odmah dodeljuje
 *     broj, pa `PROF 1/26` i `IFR 1/26` istovremeno postoje kod istog kupca. Kupac u
 *     poziv na broj kuca ono što mu piše na predračunu; u glavnoj knjizi taj isti
 *     string nosi FAKTURA — i uplata je zatvarala nju. Predračuna u knjizi nema, pa
 *     goli broj nije mogao da pogodi ništa drugo nego pogrešan dokument.
 *   • REVERS (`REV`) je level-0 vrsta koju `carry-over.service.ts` sme da napravi, a
 *     `postInvoice` nema filtar vrste — proknjižen revers upisuje svoj `N/GG` u
 *     `ledger_entries`, gde se stavke grupišu SAMO po broju dokumenta.
 *
 * NEUPISANA VRSTA (`documentType` van ove mape) NE pada na goli `N/GG` — dobija
 * prefiks iz sopstvene šifre (`XYZ-1/26`) i svoj brojač. Time je disjunktnost
 * STRUKTURNA, a ne stvar pamćenja: nijedna vrsta ne može tiho da se poklopi sa
 * fakturom zato što ju je neko zaboravio da upiše. Cena zaborava je kozmetička
 * (ružniji broj na papiru), a ne pogrešno zatvorena stavka.
 *
 * ⚠️ Nova vrsta se upisuje OVDE: ili sa praznim prefiksom (ulazi u niz faktura — samo
 * ako je zaista izlazna faktura, v. O-F5), ili sa svojim prefiksom. Prefiks mora biti
 * jedinstven; brana je test „serije su međusobno disjunktne" u `numbering.service.spec.ts`,
 * koji vrste nabraja IZ OVE MAPE. Prefiks mora znati i parser poziva na broj
 * (`izvodi/reference-parser.util.ts` → `SERIES`), inače uplata pozvana na tu seriju
 * i dalje proizvodi goli broj fakture — brana je test tamo.
 */
export const DOCUMENT_SERIES: ReadonlyMap<string, string> = new Map([
  // Izlazne fakture — jedan zajednički niz, bez prefiksa (O-F1/O-F5). Domaće
  // (roba/gotovi proizvodi/usluga) i ino parnjaci; isti skup ciljnih level-0 vrsta
  // koji vodi `carry-over.service.ts`.
  ["IFR", ""],
  ["IFGP", ""],
  ["IFUSL", ""],
  ["IZVRO", ""],
  ["IZVGP", ""],
  ["IZVUS", ""],
  // Sopstvene serije — svoj brojač I svoj prefiks (O-F6/O-F7).
  ["AVR", "A-"], // avansni račun (O-F6)
  ["PROF", "PROF-"], // predračun
  ["PON", "PON-"], // ponuda
  ["REV", "REV-"], // revers
]);

/**
 * Prefiks serije za datu vrstu dokumenta (`""` = niz faktura, bez prefiksa).
 *
 * ZAŠTO ŠIFRA VRSTE, A NE JEDNO SLOVO (`P-`, `R-`) ZA NOVE SERIJE: prefiks je ujedno
 * i oznaka koju parser poziva na broj mora da prepozna u tuđem tekstu
 * (`izvodi/reference-parser.util.ts`). Jedno slovo ispred cifara je u pozivu na broj
 * običan šum („P 657/25"), pa bi svaka nova jednoslovna serija pojela po jedan oblik
 * legitimnog poziva na fakturu — kod `A-` je to već plaćeno jednom i namerno
 * (v. „svesno odstupanje" u parseru), i ne umnožava se. Višeslovna šifra (`PROF`,
 * `PON`, `REV`) kao šum se praktično ne pojavljuje. `A-` ostaje kakav jeste jer je
 * odluka O-F6 već doneta i zapisana.
 */
export function seriesPrefixFor(documentType: string): string {
  return DOCUMENT_SERIES.get(documentType) ?? `${documentType}-`;
}

/**
 * Ključ brojača za datu vrstu dokumenta: sve izlazne fakture dele `@FAKTURA`, sve
 * ostalo (AVR/PROF/PON/REV/nepoznato) zadržava svoj niz po vrsti.
 *
 * Izvedeno iz PREFIKSA, ne iz drugog spiska — „bez prefiksa" i „u nizu faktura" su
 * jedna te ista činjenica, pa se ne mogu razići ni greškom pri dopuni registra.
 */
export function sequenceKeyFor(documentType: string): string {
  return seriesPrefixFor(documentType) === ""
    ? INVOICE_SEQUENCE_KEY
    : documentType;
}

@Injectable()
export class DocumentNumberSequenceService {
  /**
   * Rezerviši sledeći broj dokumenta u transakciji `tx`.
   * @returns npr. `657/25` (format `NNN/GG`, v. O-F1) — za vrstu sa sopstvenom serijom
   *          njen prefiks + isti format: `A-657/25` (avans, O-F6), `PROF-12/26`
   *          (predračun), `PON-5/26`, `REV-8/26` (O-F7)
   */
  async next(
    tx: Prisma.TransactionClient,
    documentType: string,
    year: number,
    companyId: number,
  ): Promise<string> {
    // Izlazne fakture dele jedan niz (dokaz sa papira u zaglavlju); ostale vrste idu
    // po svojoj šifri. Vrsta dokumenta i dalje stoji na samom dokumentu — samo više
    // ne segmentira brojač.
    const seqKey = sequenceKeyFor(documentType);

    // 1) Zaključaj / kreiraj red sekvence. Row-lock (FOR UPDATE) serijalizuje
    //    konkurentna knjiženja istog niza/godine/firme (bez dupliranih brojeva).
    //    Pošto sve izlazne fakture dele red, brava sada serijalizuje i knjiženja
    //    RAZLIČITIH vrsta — što je i cilj: dva komercijalista koja istovremeno
    //    knjiže IFR i IFUSL ne smeju da dobiju isti broj.
    const rows = await tx.$queryRaw<Array<{ id: number; last_number: number }>>`
      SELECT id, last_number
      FROM document_number_sequences
      WHERE document_type = ${seqKey}
        AND year = ${year}
        AND company_id = ${companyId}
      FOR UPDATE
    `;

    let seq: number;
    if (rows.length === 0) {
      // Nema reda — kreiraj sa lastNumber=1 (prvi broj). Jedinstveni ključ štiti
      // od trke: ako drugi commit stigne prvi, ovaj bacia P2002 → tx rollback/retry.
      await tx.documentNumberSequence.create({
        data: { documentType: seqKey, year, companyId, lastNumber: 1 },
      });
      seq = 1;
    } else {
      seq = rows[0].last_number + 1;
      await tx.documentNumberSequence.update({
        where: { id: rows[0].id },
        data: { lastNumber: seq },
      });
    }

    // Bez vodećih nula na rednom broju (BigBit `657/25`, ne `0657/25`) i bez
    // prefiksa VRSTE. `DocumentType.documentNumberPrefix` (BigBit sync kolona) se
    // namerno više NE čita: da je ostala u formatu, prod redovi sa popunjenim
    // prefiksom bi i dalje davali `IFR657/25` i odluka O-F1 bi tiho ostala
    // nesprovedena.
    //
    // Prefiks SERIJE (`A-` avans, `PROF-` predračun, …) je nešto sasvim drugo i JESTE
    // deo broja: brojač je već razdvojen (`seqKey` = „AVR", ne „@FAKTURA"), ali
    // razdvojen brojač sam po sebi ne pomaže — dva nezavisna niza oba počinju od 1 i
    // oba daju `1/26`. Tek prefiks čini da se serije ne mogu preklopiti ni kao STRING
    // (O-F6/O-F7). Zato prefiks i brojač dolaze iz ISTE mape (`DOCUMENT_SERIES`).
    return `${seriesPrefixFor(documentType)}${seq}/${twoDigitYear(year)}`;
  }
}

/** Godina u dvocifrenom obliku: 2026 → „26", 2005 → „05" (uvek dve cifre). */
function twoDigitYear(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}
