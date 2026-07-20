/**
 * PAYMENT EXPORT SERVICE — izvoz naloga u banku, FIKSNI TXT FX / Banca Intesa.
 * =========================================================================
 * 1:1 iz legacy `PrebaciUFX` (`Module__ExportTXTCSVXML.txt:764-898`, doc 21 §B).
 * NEMA ISO 20022 / pain.001 / camt / XML — proprietarni fiksno-širinski TXT koji
 * već radi sa FX klijentom; za 4.0 zadržan IDENTIČAN format (Nenad, doc 21).
 *
 * ⚠️ Širine kolona su DOSLOVNE iz legacy `DoChLeft`/`DoChRight`/`Left`/`Right` —
 *    ne izmišljaju se. Semantika helpera (Module__Globalni modul.txt:276-295):
 *      DoChRight(st,N,ch) = LEVO poravnanje, dopuni `ch` DESNO do dužine N (bez sečenja)
 *      DoChLeft(st,N,ch)  = DESNO poravnanje, dopuni `ch` LEVO do dužine N (bez sečenja)
 *    Sečenje na max radi POZIVALAC preko Left()/Right() PRE pada u DoCh*.
 *
 * VODEĆI slog (leader):
 *   banka(3) + racun(15,left-pad"0") + naziv(35,right-pad" ") + mesto(20,right-pad" ")
 *   + ukupno(15,left-pad"0",*100) + brSlogova(5,left-pad"0") + "YUM"
 *   + kontakt(27" ") + tel1(11" ") + tel2(11" ") + fax(11" ") + email(22" ") + "3" + "9"
 *
 * DETALJNI slog (po nalogu):
 *   banka(3) + racunPrimaoca(15,left-pad"0") + nazivPrimaoca(35,right-pad" ")
 *   + mestoPrimaoca(20,right-pad" ") + " " + "  " + 20*" " + sifraPlacanja(3,right-pad" ")
 *   + svrhaDoznake(35,right-pad" ") + iznos(13 = 11 cifara + 2 pare, bez tačke)
 *   + PNBOdobModel(2,right-pad" ") + PNBOdobBroj(20,right-pad" ")
 *   + datum(ddmmyyyy,8) + " " + "3" + "1"
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

const D = Prisma.Decimal;

@Injectable()
export class PaymentExportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generiši FX TXT za date naloge i označi ih `exportedAt` (legacy
   * `OznaciPlaceneVirmane` posle izvoza). @returns kompletan TXT string
   * (CRLF-terminisani slogovi, kao Access `Print #`).
   *
   * @param orderIds   nalozi za izvoz
   * @param leader     podaci platioca za VODEĆI slog (na teret)
   */
  async exportFx(
    orderIds: number[],
    leader: {
      debitAccount: string;
      debitName: string;
      debitPlace?: string;
      orderDate?: Date;
    },
  ): Promise<{ txt: string; exportedCount: number }> {
    const orders = await this.prisma.paymentOrder.findMany({
      where: { id: { in: orderIds } },
      orderBy: { id: "asc" },
    });
    if (orders.length === 0) {
      throw new NotFoundException("Nijedan nalog nije pronađen za izvoz.");
    }

    const orderDate = leader.orderDate ?? new Date();

    // ── VODEĆI slog ──────────────────────────────────────────────────────────
    // totalzaisplatu = Round(Σ Iznos, 2) * 100  (pare, bez decimalne tačke)
    let total = new D(0);
    for (const o of orders) total = total.add(o.amount);
    const totalCents = total.toDecimalPlaces(2).mul(100).toFixed(0); // celobrojne pare

    const dAccountDigits = digitsOnly(leader.debitAccount);
    const dBank = dAccountDigits.slice(0, 3); // banka(3)
    const dNum = dAccountDigits.slice(3); // ostatak računa

    const recordCount = String(orders.length);

    let leaderRec = "";
    leaderRec += dBank.slice(0, 3); // Left(partijast,3)
    leaderRec += padLeft(dNum, 15, "0"); // DoChLeft(...,15,"0")
    leaderRec += padRight(right(leader.debitName, 35), 35, " "); // naziv
    leaderRec += padRight(right(leader.debitPlace ?? "", 20), 20, " "); // mesto
    leaderRec += padLeft(totalCents, 15, "0"); // ukupno *100
    leaderRec += padLeft(recordCount, 5, "0"); // broj naloga (slogova)
    leaderRec += "YUM";
    leaderRec += padRight("", 27, " "); // kontakt osoba
    leaderRec += padRight("", 11, " "); // telefon 1
    leaderRec += padRight("", 11, " "); // telefon 2
    leaderRec += padRight("", 11, " "); // fax
    leaderRec += padRight("", 22, " "); // e-mail
    leaderRec += "3";
    leaderRec += "9";

    const lines: string[] = [leaderRec];

    // ── DETALJNI slogovi ─────────────────────────────────────────────────────
    const dateStr = formatDdMmYyyy(orderDate);
    for (const o of orders) {
      const recvDigits = digitsOnly(o.supplierAccount ?? "");
      const rBank = recvDigits.slice(0, 3);
      const rNum = recvDigits.slice(3);

      let rec = "";
      rec += rBank.slice(0, 3); // Left(partijast,3)
      rec += padLeft(rNum, 15, "0"); // racun primaoca
      rec += padRight(left(supplierName(o), 35), 35, " "); // naziv primaoca
      rec += padRight(left("", 20), 20, " "); // mesto primaoca (nema u nalogu → prazno)
      rec += " "; // " "
      rec += "  "; // "  "
      rec += padRight("", 20, " "); // DoChRight("",20," ")
      rec += padRight(right("", 3), 3, " "); // sifra placanja (nema kolonu → prazno)
      rec += padRight(left(o.purpose ?? "", 35), 35, " "); // svrha doznake
      rec += formatAmount13(o.amount); // iznos 11+2 (bez tačke)
      rec += padRight(right("", 2), 2, " "); // PNBOdobModel (model se ne čuva zasebno → prazno)
      rec += padRight(right(o.referenceNumberCredit ?? "", 20), 20, " "); // PNBOdobBroj
      rec += padRight(dateStr, 8, " "); // datum ddmmyyyy
      rec += " ";
      rec += "3";
      rec += "1";

      lines.push(rec);
    }

    // Access `Print #` završava svaki red CRLF-om.
    const txt = lines.join("\r\n") + "\r\n";

    // Označi izvezene naloge (OznaciPlaceneVirmane) — exportedAt.
    await this.prisma.paymentOrder.updateMany({
      where: { id: { in: orders.map((o) => o.id) } },
      data: { exportedAt: new Date() },
    });

    return { txt, exportedCount: orders.length };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fiksno-širinski helperi — 1:1 legacy semantika (Globalni modul.txt:276-295).
// ─────────────────────────────────────────────────────────────────────────────

/** DoChRight: levo poravnanje, dopuni `ch` DESNO do dužine N (ne seče). */
function padRight(st: string, n: number, ch: string): string {
  let s = st ?? "";
  while (s.length < n) s = s + ch;
  return s;
}

/** DoChLeft: desno poravnanje, dopuni `ch` LEVO do dužine N (ne seče). */
function padLeft(st: string, n: number, ch: string): string {
  let s = st ?? "";
  while (s.length < n) s = ch + s;
  return s;
}

/** VBA Left$(st,n) — prvih n znakova. */
function left(st: string, n: number): string {
  return (st ?? "").slice(0, n);
}

/** VBA Right$(st,n) — poslednjih n znakova. */
function right(st: string, n: number): string {
  const s = st ?? "";
  return s.length <= n ? s : s.slice(s.length - n);
}

/** Samo cifre (legacy IzbaciIzStCh za crtice + generalno čišćenje računa). */
function digitsOnly(input: string): string {
  return (input ?? "").replace(/\D+/g, "");
}

/**
 * Iznos → 13 znakova: Format$(x,"00000000000.00") = 11 cifara + "." + 2 pare,
 * pa Left$(...,11) & Right$(...,2) = 13 (tačka izbačena). Legacy množi/deli
 * implicitno kroz Format; mi zaokružujemo na 2 decimale i sklapamo string.
 */
function formatAmount13(amount: Prisma.Decimal): string {
  const fixed = amount.toDecimalPlaces(2).abs().toFixed(2); // "N.NN"
  const [intPart, fracPart] = fixed.split(".");
  const int11 = intPart.padStart(11, "0").slice(-11); // 11 cifara (00000000000)
  const frac2 = (fracPart ?? "00").padStart(2, "0").slice(0, 2); // 2 pare
  return int11 + frac2; // 13 znakova, bez tačke
}

/** ddmmyyyy (8 znakova). */
function formatDdMmYyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

/**
 * Naziv primaoca za detaljni slog. PaymentOrder ne nosi denormalizovan naziv
 * (samo supplierId, meki ref); dok se ne uveže Customer join, koristi se prazno
 * (legacy je vukao UKoristNaziv iz upita — ostavljeno kao proširenje kad servis
 * dobije customers čitanje). Ne izmišlja se sadržaj — samo se ispoštuje širina.
 */
function supplierName(_o: { supplierId: number }): string {
  return "";
}
