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
 * Samo izlazne fakture (`INVOICE_TYPES`). Avansni račun (AVR), predračun (PROF),
 * ponuda (PON) i ostale vrste ZADRŽAVAJU svoj niz po vrsti — za njih nemamo papir
 * koji pokazuje šta BigBit radi, a avansi imaju i zaseban zakonski niz. Dok se to
 * ne utvrdi, ne uvlače se u niz faktura.
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
 * Vrste IZLAZNIH FAKTURA koje dele jedan niz brojeva — domaće (IFR roba,
 * IFGP gotovi proizvodi, IFUSL usluga) i njihovi ino parnjaci (IZVRO, IZVGP,
 * IZVUS). Isti skup ciljnih level-0 vrsta koji vodi `carry-over.service.ts`.
 */
const INVOICE_TYPES: ReadonlySet<string> = new Set([
  "IFR",
  "IFGP",
  "IFUSL",
  "IZVRO",
  "IZVGP",
  "IZVUS",
]);

/**
 * Ključ zajedničkog niza u `document_number_sequences.document_type`.
 * Počinje znakom `@` koji nijedna BigBit šifra vrste dokumenta ne koristi — tako
 * red zajedničkog niza ne može da se sudari sa redom neke stvarne vrste (ni sa
 * onima zatečenim od ranije). Kolona je VarChar(10), ključ staje.
 */
export const INVOICE_SEQUENCE_KEY = "@FAKTURA";

/**
 * Ključ brojača za datu vrstu dokumenta: sve izlazne fakture dele `@FAKTURA`,
 * sve ostalo (AVR/PROF/PON/…) zadržava svoj niz po vrsti.
 */
export function sequenceKeyFor(documentType: string): string {
  return INVOICE_TYPES.has(documentType) ? INVOICE_SEQUENCE_KEY : documentType;
}

@Injectable()
export class DocumentNumberSequenceService {
  /**
   * Rezerviši sledeći broj dokumenta u transakciji `tx`.
   * @returns npr. `657/25` (format `NNN/GG`, v. O-F1)
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
    // prefiksa vrste. `DocumentType.documentNumberPrefix` (BigBit sync kolona) se
    // namerno više NE čita: da je ostala u formatu, prod redovi sa popunjenim
    // prefiksom bi i dalje davali `IFR657/25` i odluka O-F1 bi tiho ostala
    // nesprovedena.
    return `${seq}/${twoDigitYear(year)}`;
  }
}

/** Godina u dvocifrenom obliku: 2026 → „26", 2005 → „05" (uvek dve cifre). */
function twoDigitYear(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}
