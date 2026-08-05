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
 *              "D"/"1" = DEBIT (odliv). NEPOZNAT kod = GREŠKA reda, ne pretpostavka.
 *
 * DATUM (189,8): 4-cifrena godina (dec spec). Format `ddmmyyyy` (FX export koristi ddmmyyyy,
 *   doc 21 §B) → parsiramo `DDMMYYYY`; ako je 8 cifara ali očito `YYYYMMDD`, detektujemo.
 *
 * 🔴 NEPROČITAN RED SE PRIJAVLJUJE, NE PRESKAČE (defekt D1, 04.08.2026).
 * ─────────────────────────────────────────────────────────────────────────
 * ŠTA SE DEŠAVALO PRE POPRAVKE: red kraći od `MIN_LINE_LENGTH`, red bez `DatumDok` i red sa
 * neparsabilnim iznosom su se preskakali sa `logger.debug`/`logger.warn` i `continue`, a
 * NEPOZNAT `DugPotInd` se tumačio kao priliv — pa je uplata koja je stigla na račun mogla da
 * ne postoji u sistemu (ili da uđe sa pogrešnim smerom), bez ijednog vidljivog znaka.
 * Sada `parse` vraća `{ lines, skipped }`, a uvoz (`BankStatementService.importStatement`) ODBIJA
 * izvod ako `skipped` nije prazan — izvod je jedan celovit dokument banke i ne sme se uvesti
 * delimično. `previewParse` iste redove samo PRIKAŽE (dry-run pre uvoza), da korisnik zna šta
 * da ispravi. Ni jedan razlog ne ostaje samo u logu.
 *
 * ⚠️ `Opis(100,35)` SE NE ČITA (nalaz S7, 02.08.2026). Kolona je gore popisana, ali se
 *   nigde ne vadi iz reda niti se prosleđuje dalje — `BankStatementLine` nema polje za
 *   nju. Posledica za uparivanje: parser poziva na broj
 *   (`reference-parser.util.ts`) dobija ISKLJUČIVO `PozivNaBroj(169,20)`, a slobodan
 *   tekst kojim platilac imenuje dokument („avans", „predračun", „po ponudi") u praksi
 *   stiže baš u `Opis`. Reč-alijasi zato danas rade samo na onome što stane u 20 znakova
 *   PNB-a (`AVANS BR 1/26` staje, „uplata po avansu A-1/26" ne). Uvođenje `Opis`-a u
 *   uparivanje je otvorena stavka — v. `backend/docs/PREOSTALE_FAZE.md`, „🔶 OTVORENO", S7.
 */

const D = Prisma.Decimal;

/** Jedna sirova (draft) stavka izvoda, spremna za upis u BankStatementLine. */
export interface ParsedStatementLine {
  lineNo: number;
  partnerAccount: string | null; // TRKomitenta (149,18)
  partnerName: string | null; // NazivKomitenta (19,35)
  amount: Prisma.Decimal; // Iznos (135,13) /100
  direction: "DEBIT" | "CREDIT"; // DugPotInd (148,1)
  referenceNumber: string | null; // PozivNaBroj (169,20) — SIROV PNB (ne dira se)
  // Model (167,2): "97" | "11" | "99". BankStatementLine NEMA kolonu za model, pa se
  // NE persistuje — nosi se kroz parse rezultat i koristi samo u parsiranju PNB-a
  // (reference-parser.util.parseReference) za skidanje modela 97 kontrolnog broja.
  model: string | null;
  documentDate: Date | null; // DatumDok (189,8)
}

/**
 * Red TXT-a koji NIJE postao stavka izvoda, sa razlogom (D1). Ovo NIJE log — ide korisniku
 * i obara uvoz, jer nepročitan red može biti uplata koja je stigla na račun.
 */
export interface SkippedStatementLine {
  /** Broj reda u FAJLU (1-baziran) — po njemu korisnik nalazi red u TXT-u. */
  fileLineNo: number;
  /** Svi razlozi za taj red, spojeni sa " · " (srpski, za prikaz). */
  reason: string;
  /** Početak sirovog reda (sečen) — da se problem vidi bez otvaranja fajla. */
  excerpt: string;
}

/** Rezultat parsiranja: pročitane stavke + redovi koje parser NIJE mogao da pročita. */
export interface ParseStatementResult {
  lines: ParsedStatementLine[];
  skipped: SkippedStatementLine[];
}

@Injectable()
export class BankStatementParserService {
  private readonly logger = new Logger(BankStatementParserService.name);

  /** Minimalna dužina reda da bi imao sva relevantna polja (do DatumDok kraj = 189+8-1 = 196). */
  private static readonly MIN_LINE_LENGTH = 196;
  /** Koliko znakova sirovog reda ide korisniku u izveštaj o nepročitanom redu. */
  private static readonly EXCERPT_LENGTH = 120;

  // Access Start je 1-baziran; helper vraća 0-bazirani slice [start-1, start-1+width).
  private field(line: string, start: number, width: number): string {
    return line.substring(start - 1, start - 1 + width).trim();
  }

  /**
   * Parsira ceo TXT sadržaj (jedan izvod, više redova) → `{ lines, skipped }`.
   *
   * PRAZAN red je jedino što se preskače bez prijave (završni prelaz reda / razmaknica nije
   * zapis). SVE ostalo što se ne pročita ide u `skipped` sa brojem reda i razlogom, pa uvoz
   * može da ga odbije — v. blok „NEPROČITAN RED SE PRIJAVLJUJE" u zaglavlju fajla.
   */
  parse(txtContent: string): ParseStatementResult {
    const rawLines = txtContent.split(/\r\n|\r|\n/);
    const result: ParsedStatementLine[] = [];
    const skipped: SkippedStatementLine[] = [];
    let lineNo = 0;

    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (raw == null) continue;
      const line = raw.replace(/\s+$/u, ""); // trim samo desno (fiksne kolone drže levu poziciju)
      if (line.trim().length === 0) continue; // prazan red — nije zapis

      const fileLineNo = i + 1;

      if (line.length < BankStatementParserService.MIN_LINE_LENGTH) {
        // Kraći red: polja se ne mogu ni izvaditi, pa nema smisla tražiti dalje razloge.
        skipped.push({
          fileLineNo,
          reason: `dužina ${line.length} < ${BankStatementParserService.MIN_LINE_LENGTH} znakova (nije puna FX stavka)`,
          excerpt: this.excerpt(line),
        });
        continue;
      }

      const partnerName = this.field(line, 19, 35) || null;
      const amountRaw = this.field(line, 135, 13);
      const dugPotInd = this.field(line, 148, 1);
      const partnerAccount = this.field(line, 149, 18) || null;
      const model = this.field(line, 167, 2) || null; // Model PNB-a (97/11/99)
      const referenceNumber = this.field(line, 169, 20) || null;
      const datumRaw = this.field(line, 189, 8);

      // Svi razlozi za JEDAN red se skupljaju zajedno — korisnik popravlja red jednom,
      // a ne u onoliko krugova uvoza koliko polja u njemu ne štima.
      const problems: string[] = [];

      const amount = this.parseAmount(amountRaw);
      if (amount === null) problems.push(`neparsabilan iznos "${amountRaw}"`);

      const direction = this.parseDirection(dugPotInd);
      if (direction === null)
        problems.push(
          `nepoznat indikator smera (DugPotInd) "${dugPotInd}" — smer se ne sme pretpostaviti`,
        );

      const documentDate = this.parseDate(datumRaw);
      if (documentDate === null)
        problems.push(`neparsabilan datum dokumenta (DatumDok) "${datumRaw}"`);

      if (problems.length > 0 || amount === null || direction === null) {
        skipped.push({
          fileLineNo,
          reason: problems.join(" · "),
          excerpt: this.excerpt(line),
        });
        continue;
      }

      lineNo += 1;
      result.push({
        lineNo,
        partnerAccount,
        partnerName,
        amount,
        direction,
        referenceNumber,
        model,
        documentDate,
      });
    }

    // Log ostaje, ali NIJE jedini kanal — `skipped` ide pozivaocu (i korisniku).
    this.logger.log(
      `Isparsirano ${result.length} stavki izvoda (od ${rawLines.length} redova); nepročitanih redova: ${skipped.length}.`,
    );
    return { lines: result, skipped };
  }

  /** Početak sirovog reda za izveštaj o nepročitanom redu (bez desnih razmaka). */
  private excerpt(line: string): string {
    return line.slice(0, BankStatementParserService.EXCERPT_LENGTH).trimEnd();
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

  /**
   * DugPotInd → DEBIT/CREDIT (doc 21 §A). Nepoznat/prazan kod → `null` = GREŠKA reda.
   * Pre popravke se nepoznat kod tumačio kao CREDIT (priliv) uz warn log — pogrešan smer je
   * pogrešan novac (odliv proknjižen kao naplata zatvara dug koji nije plaćen), pa se smer
   * više ne pretpostavlja.
   */
  private parseDirection(ind: string): "DEBIT" | "CREDIT" | null {
    const c = ind.trim().toUpperCase();
    if (c === "D" || c === "1") return "DEBIT";
    if (c === "C" || c === "K" || c === "P" || c === "2") return "CREDIT";
    return null;
  }

  /**
   * DatumDok (189,8), 4-cifrena godina. Podržava `DDMMYYYY` (FX default, doc 21 §B) i
   * `YYYYMMDD`. Nevalidan/prazan → `null` = GREŠKA reda: red pune dužine NOSI ovu kolonu po
   * FX specifikaciji, pa je nečitljiv datum znak da red nije ono što mislimo da je (pre
   * popravke se stavka uvozila sa `documentDate = null`, bez ijednog znaka korisniku).
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
