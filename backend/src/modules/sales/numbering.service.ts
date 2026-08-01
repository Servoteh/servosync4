import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DocumentNumberSequenceService — jedna DB sekvenca po (documentType, year, companyId).
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
 * ── ODNOS PREMA VEĆ POSTOJEĆIM (STARIM) BROJEVIMA ──────────────────────────────
 * Zatečeni dokumenti u obliku `IFR0043/2026` se NE migriraju i NE preimenuju.
 * Sudar je nemoguć iz dva razloga:
 *   1) OBLIK: stari broj uvek nosi slovni prefiks i četvorocifrenu godinu, novi je
 *      samo cifre + '/' + dve cifre — `IFR0043/2026` i `43/26` nikad nisu isti
 *      string, pa jedinstveni indeks `uq_invoices_company_type_number` ne može da
 *      pukne zbog nasleđenog reda.
 *   2) BROJAČ: `document_number_sequences.last_number` se NE resetuje ovom izmenom.
 *      Ako je IFR u 2026. već stigao do 43 (kao `IFR0043/2026`), sledeći izdat broj
 *      je `44/26`, a ne `1/26` — dakle isti redni broj se ne troši dvaput ni
 *      suštinski, ne samo kao string. „Kreće od 1" iz odluke O-F1 važi tamo gde reda
 *      sekvence još nema (nova vrsta dokumenta / nova godina), što je i stvarni
 *      slučaj jer se na softver prelazi od nove godine.
 */

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
    // 1) Zaključaj / kreiraj red sekvence. Row-lock (FOR UPDATE) serijalizuje
    //    konkurentne knjiženja iste vrste/godine/firme (bez dupliranih brojeva).
    const rows = await tx.$queryRaw<Array<{ id: number; last_number: number }>>`
      SELECT id, last_number
      FROM document_number_sequences
      WHERE document_type = ${documentType}
        AND year = ${year}
        AND company_id = ${companyId}
      FOR UPDATE
    `;

    let seq: number;
    if (rows.length === 0) {
      // Nema reda — kreiraj sa lastNumber=1 (prvi broj). Jedinstveni ključ štiti
      // od trke: ako drugi commit stigne prvi, ovaj bacia P2002 → tx rollback/retry.
      await tx.documentNumberSequence.create({
        data: { documentType, year, companyId, lastNumber: 1 },
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
    // prefiksa vrste — vrsta dokumenta ostaje ključ SEKVENCE, ali se ne štampa.
    // `DocumentType.documentNumberPrefix` (BigBit sync kolona) se namerno više NE
    // čita: da je ostala u formatu, prod redovi sa popunjenim prefiksom bi i dalje
    // davali `IFR657/25` i odluka O-F1 bi tiho ostala nesprovedena.
    return `${seq}/${twoDigitYear(year)}`;
  }
}

/** Godina u dvocifrenom obliku: 2026 → „26", 2005 → „05" (uvek dve cifre). */
function twoDigitYear(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}
