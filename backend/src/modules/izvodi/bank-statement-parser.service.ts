import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * PARSER BANKOVNOG IZVODA — FX Import Specification (fiksne kolone).
 * =========================================================================
 * Rekonstrukcija 1:1 iz `MSysIMEXColumns` (doc 21 §A, tabela "FX Import Specification",
 * fixed / cp1252 / dec `.` / 4-cifreni datum). Access kolone koriste 1-baziran `Start`
 * i `Width`; ovde ih preslikavamo u JS 0-bazirane `substring(start-1, start-1+width)`.
 *
 * KOLONE (Start,Width) — koristimo relevantne za BankStatementLine:
 *   MatTR(1,18)  NazivKomitenta(19,35)  MestoIAdresa(54,43)  SifraPlacanja(97,3)
 *   Opis(100,35) Iznos(135,13)  DugPotInd(148,1)  TRKomitenta(149,18)  Model(167,2)
 *   PozivNaBroj(169,20)  DatumDok(189,8)  BrojZaReklamaciju(197,19)  Field14(216,4)  TipStavke(220,1)
 *
 * IZNOS (doc 21 §A `IznosIgnorZgSep2Dec`, Module__FX_HALCOM.txt:58-77): iz polja
 *   Iznos(135,13) se izbace SVE ne-cifre, a poslednje 2 cifre su pare (podeli sa 100).
 *   PRETPOSTAVKA (dokumentovana): FX izvod NEMA decimalnu tačku u iznosu — ceo string je
 *   celobrojni broj para (npr. "0000012345" → 123.45). Ako se u praksi pojavi tačka,
 *   `IznosIgnorZgSep2Dec` je i dalje korektan (tačka je ne-cifra → izbačena, pa /100).
 *
 * SMER (doc 21 §A): `DugPotInd(148,1)` → DEBIT/CREDIT. Legacy koristi klasu konta za stranu
 *   knjiženja, ali indikator na stavci izvoda je Dug/Pot flag ("D"/"C" ili "1"/"2").
 *   Mapiranje: "C"/"K"/"P"/"2" = CREDIT (priliv, potražuje se banka),
 *              "D"/"1" = DEBIT (odliv). Nepoznato → CREDIT (priliv je default izvoda naplate)
 *              uz warn log.
 *
 * DATUM (189,8): 4-cifrena godina (dec spec). Format `ddmmyyyy` (FX export koristi ddmmyyyy,
 *   doc 21 §B) → parsiramo `DDMMYYYY`; ako je 8 cifara ali očito `YYYYMMDD`, detektujemo.
 */

const D = Prisma.Decimal;

/** Jedna sirova (draft) stavka izvoda, spremna za upis u BankStatementLine. */
export interface ParsedStatementLine {
  lineNo: number;
  partnerAccount: string | null; // TRKomitenta (149,18)
  partnerName: string | null; // NazivKomitenta (19,35)
  amount: Prisma.Decimal; // Iznos (135,13) /100
  direction: "DEBIT" | "CREDIT"; // DugPotInd (148,1)
  referenceNumber: string | null; // PozivNaBroj (169,20)
  documentDate: Date | null; // DatumDok (189,8)
}

@Injectable()
export class BankStatementParserService {
  private readonly logger = new Logger(BankStatementParserService.name);

  /** Minimalna dužina reda da bi imao sva relevantna polja (do DatumDok kraj = 189+8-1 = 196). */
  private static readonly MIN_LINE_LENGTH = 196;

  // Access Start je 1-baziran; helper vraća 0-bazirani slice [start-1, start-1+width).
  private field(line: string, start: number, width: number): string {
    return line.substring(start - 1, start - 1 + width).trim();
  }

  /**
   * Parsira ceo TXT sadržaj (jedan izvod, više redova) → niz draft stavki.
   * Robustno: prazne/prekratke redove preskače uz debug log (ne obara ceo import).
   */
  parse(txtContent: string): ParsedStatementLine[] {
    const lines = txtContent.split(/\r\n|\r|\n/);
    const result: ParsedStatementLine[] = [];
    let lineNo = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw == null) continue;
      const line = raw.replace(/\s+$/u, ""); // trim samo desno (fiksne kolone drže levu poziciju)
      if (line.trim().length === 0) continue; // prazan red

      if (line.length < BankStatementParserService.MIN_LINE_LENGTH) {
        this.logger.debug(
          `Preskačem red ${i + 1}: dužina ${line.length} < ${BankStatementParserService.MIN_LINE_LENGTH} (nije puna FX stavka).`,
        );
        continue;
      }

      const partnerName = this.field(line, 19, 35) || null;
      const amountRaw = this.field(line, 135, 13);
      const dugPotInd = this.field(line, 148, 1);
      const partnerAccount = this.field(line, 149, 18) || null;
      const referenceNumber = this.field(line, 169, 20) || null;
      const datumRaw = this.field(line, 189, 8);

      const amount = this.parseAmount(amountRaw);
      if (amount === null) {
        this.logger.warn(
          `Red ${i + 1}: neparsabilan iznos "${amountRaw}" — preskačem stavku.`,
        );
        continue;
      }

      lineNo += 1;
      result.push({
        lineNo,
        partnerAccount,
        partnerName,
        amount,
        direction: this.parseDirection(dugPotInd, i + 1),
        referenceNumber,
        documentDate: this.parseDate(datumRaw),
      });
    }

    this.logger.log(
      `Isparsirano ${result.length} stavki izvoda (od ${lines.length} redova).`,
    );
    return result;
  }

  /**
   * IznosIgnorZgSep2Dec: izbaci sve ne-cifre, poslednje 2 cifre = pare (/100).
   * @returns Decimal ili null ako u polju nema nijedne cifre.
   */
  private parseAmount(raw: string): Prisma.Decimal | null {
    const digits = raw.replace(/\D/gu, "");
    if (digits.length === 0) return null;
    // Poslednje 2 cifre su pare; ostatak su dinari. Padd na min 3 cifre da /100 uvek radi.
    const padded = digits.padStart(3, "0");
    const dinari = padded.slice(0, -2);
    const pare = padded.slice(-2);
    return new D(`${dinari}.${pare}`);
  }

  /** DugPotInd → DEBIT/CREDIT (doc 21 §A). Nepoznat kod → CREDIT (priliv) uz warn. */
  private parseDirection(ind: string, lineNumber: number): "DEBIT" | "CREDIT" {
    const c = ind.trim().toUpperCase();
    if (c === "D" || c === "1") return "DEBIT";
    if (c === "C" || c === "K" || c === "P" || c === "2") return "CREDIT";
    this.logger.warn(
      `Red ${lineNumber}: nepoznat DugPotInd "${ind}" → tumačim kao CREDIT (priliv).`,
    );
    return "CREDIT";
  }

  /**
   * DatumDok (189,8), 4-cifrena godina. Podržava `DDMMYYYY` (FX default, doc 21 §B) i
   * `YYYYMMDD`. Nevalidan/prazan → null (stavka se i dalje uvozi).
   */
  private parseDate(raw: string): Date | null {
    const s = raw.replace(/\D/gu, "");
    if (s.length !== 8) return null;

    let year: number;
    let month: number;
    let day: number;

    // YYYYMMDD ako prve 4 cifre liče na godinu (19xx/20xx), inače DDMMYYYY.
    const firstFour = Number(s.slice(0, 4));
    if (firstFour >= 1900 && firstFour <= 2100) {
      year = firstFour;
      month = Number(s.slice(4, 6));
      day = Number(s.slice(6, 8));
    } else {
      day = Number(s.slice(0, 2));
      month = Number(s.slice(2, 4));
      year = Number(s.slice(4, 8));
    }

    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // UTC ponoć — izbegava pomeranje datuma po vremenskoj zoni.
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }
}
