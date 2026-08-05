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
 *   + ukupno(15,left-pad"0",*100) + brSlogova(5,left-pad"0") + oznakaValute(3; „YUM"=RSD)
 *   + kontakt(27" ") + tel1(11" ") + tel2(11" ") + fax(11" ") + email(22" ") + "3" + "9"
 *
 * DETALJNI slog (po nalogu):
 *   banka(3) + racunPrimaoca(15,left-pad"0") + nazivPrimaoca(35,right-pad" ")
 *   + mestoPrimaoca(20,right-pad" ") + " " + "  " + 20*" " + sifraPlacanja(3,right-pad" ")
 *   + svrhaDoznake(35,right-pad" ") + iznos(13 = 11 cifara + 2 pare, bez tačke)
 *   + PNBOdobModel(2,right-pad" ") + PNBOdobBroj(20,right-pad" ")
 *   + datum(ddmmyyyy,8) + " " + "3" + "1"
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { isValidAccountNumber } from "./mod97.util";

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

    // Guard: izvoze se SAMO potpisani nalozi (BigBit — nepotpisan virman ne ide u banku).
    const notSigned = orders.filter((o) => o.status !== "SIGNED");
    if (notSigned.length > 0) {
      throw new ConflictException(
        `Izvoz dozvoljen samo za potpisane naloge (SIGNED). Nisu potpisani: ` +
          notSigned.map((o) => `${o.orderNumber}(${o.status})`).join(", "),
      );
    }

    // Guard: ZAKLJUČAN nalog (Zakljucano) ne ulazi u izvoz — zamrznut je (B3). Odbij ceo
    // izvoz ako je makar jedan zaključan (ne šalji parcijalno u banku bez znanja korisnika).
    const locked = orders.filter((o) => o.isLocked);
    if (locked.length > 0) {
      throw new ConflictException(
        `Izvoz prekinut — zaključani nalozi ne mogu u banku: ` +
          locked.map((o) => o.orderNumber).join(", ") +
          `. Otključajte ih ili izuzmite iz izbora.`,
      );
    }

    // Odbrana u dubini (DobarTR): iako se TR validira pri kreiranju, nalog je mogao biti unet
    // drugim putem — pre gradnje sloga ponovo proveri žiro račun (banka(3)-partija-KK(2)+MOD97).
    // Validiramo samo prisutan račun (prazan = poseban tok). Sporne agregiramo u jednu poruku.
    const badAccounts = orders
      .filter((o) => {
        const acct = o.supplierAccount?.trim();
        return acct != null && acct !== "" && !isValidAccountNumber(acct);
      })
      .map((o) => `${o.orderNumber}: žiro račun ${o.supplierAccount}`);
    if (badAccounts.length > 0) {
      throw new BadRequestException(
        `Izvoz prekinut — neispravan tekući račun (DobarTR): ${badAccounts.join("; ")}.`,
      );
    }

    const orderDate = leader.orderDate ?? new Date();

    // ── D2: JEDNA VALUTA PO PAKETU + oznaka izvedena iz nje (nalaz 04.08.2026) ──
    // ŠTA SE DEŠAVALO PRE POPRAVKE: kontrolni zbir zaglavlja sabirao je `o.amount` preko
    // SVIH naloga bez obzira na valutu i uz to tvrdo pisao „YUM", pa je paket sa 100.000 RSD
    // i 1.000 EUR banci prijavljivao „101.000 YUM" — zbir koji ne postoji ni u jednoj valuti,
    // a fajl je i dalje prolazio kao dinarski.
    // Zato: valuta se PROVERAVA pre građenja fajla, a oznaka se IZVODI iz nje (nikad literal).
    const currencies = [
      ...new Set(orders.map((o) => normalizeCurrency(o.currency))),
    ].sort();
    if (currencies.length > 1) {
      throw new BadRequestException(
        `Izvoz prekinut — izbor meša valute (${currencies.join(", ")}). Jedan FX fajl nosi ` +
          `JEDAN kontrolni zbir i JEDNU oznaku valute u vodećem slogu, pa se nalozi izvoze ` +
          `po valuti odvojeno.`,
      );
    }
    const packCurrency = currencies[0];
    const currencyTag = FX_CURRENCY_TAG.get(packCurrency);
    if (!currencyTag) {
      throw new BadRequestException(
        `Izvoz prekinut — valuta ${packCurrency} nema poznatu oznaku u FX obrascu. ` +
          `Podržan je samo dinar; naloge u drugim valutama obradite kroz aplikaciju banke.`,
      );
    }

    // ── D3: naziv primaoca — JEDAN upit za ceo paket (nalaz 04.08.2026) ─────────
    // ŠTA SE DEŠAVALO PRE POPRAVKE: `supplierName()` je vraćao "" pa je polje naziva
    // primaoca (35 znakova) u SVAKOM detaljnom slogu izlazilo kao 35 praznih znakova —
    // banka je dobijala nalog za prenos bez imena primaoca (samo račun).
    // Jedan `findMany` po celom paketu (ne upit po nalogu — izvoz ide i za desetine naloga).
    const supplierIds = [...new Set(orders.map((o) => o.supplierId))];
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true },
    });
    const supplierNames = new Map<number, string>();
    for (const c of customers) {
      const name = (c.name ?? "").trim();
      if (name !== "") supplierNames.set(c.id, name);
    }
    // Naziv se NE izmišlja i ne ostaje prazan: fajl bez imena primaoca banka ili odbija,
    // ili izvrši kao neidentifikovan nalog — oba su neprihvatljiva, pa pada ceo izvoz.
    const missingNames = orders
      .filter((o) => !supplierNames.has(o.supplierId))
      .map((o) => `${o.orderNumber}: komitent ${o.supplierId}`);
    if (missingNames.length > 0) {
      throw new BadRequestException(
        `Izvoz prekinut — primalac nema naziv u šifarniku komitenata: ` +
          `${missingNames.join("; ")}. Nalog za banku bez naziva primaoca ne sme da izađe.`,
      );
    }

    // ── VODEĆI slog ──────────────────────────────────────────────────────────
    // totalzaisplatu = Round(Σ Iznos, 2) * 100  (pare, bez decimalne tačke)
    // Zbir je smislen samo zato što je iznad potvrđeno da je paket JEDNOVALUTAN.
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
    leaderRec += currencyTag; // oznaka valute (3) — izvedena iz valute paketa (D2)
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
      rec += padRight(left(supplierName(o, supplierNames), 35), 35, " "); // naziv primaoca
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

    // Compare-and-swap: označi PLAĆENIM SAMO naloge koji su još SIGNED (OznaciPlaceneVirmane).
    // Ako je paralelni izvoz već prebacio neki u PAID, count < orders.length → prekini
    // BEZ vraćanja TXT-a, da se isti virman ne izveze/pošalje u banku dvaput (review VISOK).
    const marked = await this.prisma.paymentOrder.updateMany({
      where: { id: { in: orders.map((o) => o.id) }, status: "SIGNED", isLocked: false },
      data: { exportedAt: new Date(), status: "PAID" },
    });
    if (marked.count !== orders.length) {
      throw new ConflictException(
        `Izvoz prekinut: ${orders.length - marked.count} nalog(a) je već izvezeno/plaćeno (dvostruki izvoz sprečen). Osveži listu.`,
      );
    }

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
 * Naziv primaoca za detaljni slog (legacy `UKoristNaziv`). `PaymentOrder` ne nosi
 * denormalizovan naziv (samo `supplierId`, meki ref), pa se čita iz šifarnika komitenata
 * JEDNIM upitom za ceo paket i predaje ovde kao mapa. Prazno se NE vraća — poziv u
 * `exportFx` je pre građenja sloga odbio ceo izvoz ako naziv fali, tako da je vrednost
 * ovde uvek prisutna; `?? ""` je samo tipska brana. Širinu (35) i sečenje (`left` =
 * VBA `Left$`) radi pozivalac, kao i za sva ostala polja obrasca.
 */
function supplierName(
  o: { supplierId: number },
  names: Map<number, string>,
): string {
  return names.get(o.supplierId) ?? "";
}

/**
 * Valuta naloga → normalizovan ISO kod. Prazno/NULL = RSD: `payment_orders.currency`
 * ima default „RSD", a nalog za prenos je domaći bezgotovinski platni promet.
 */
function normalizeCurrency(currency: string | null | undefined): string {
  const c = (currency ?? "").trim().toUpperCase();
  return c === "" ? "RSD" : c;
}

/**
 * Oznaka valute u VODEĆEM slogu FX obrasca (polje širine 3).
 *
 * ODAKLE ZNAM da je „YUM" legacy oznaka DINARA, a ne greška u prepisu:
 *   1) Izvor obrasca (`PrebaciUFX`, `Module__ExportTXTCSVXML.txt:764-898`, doc 21 §B)
 *      upisuje literal „YUM" BEZUSLOVNO, u fajl koji je čisto dinarski — `payment_orders.
 *      currency` ima default „RSD", a virman/nalog za prenos je instrument DOMAĆEG
 *      platnog prometa (devizna plaćanja idu drugim tokom, kroz aplikaciju banke).
 *   2) „YUM" je ISO 4217 kod jugoslovenskog dinara, zamenjen kodom „RSD" 2003. godine;
 *      obrazac je stariji od te zamene i zadržao je staru oznaku, a FX klijent je nikad
 *      nije menjao (format je zamrznut — Nenad, doc 21).
 * Zato „YUM" stoji ISKLJUČIVO za RSD.
 *
 * ⚠️ NOVE VALUTE SE NE DODAJU „PO ANALOGIJI" (npr. EUR→„EUR"): oznaka mora doći iz
 * specifikacije FX fajla ili od banke. Valuta koja nije u mapi = izvoz PADA (v. D2).
 */
const FX_CURRENCY_TAG: ReadonlyMap<string, string> = new Map([["RSD", "YUM"]]);
