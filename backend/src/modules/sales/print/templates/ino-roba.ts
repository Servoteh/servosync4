import { Prisma } from "@prisma/client";
import type { Content, TableCell } from "pdfmake/interfaces";
import { companyAddressLine } from "../../../../common/company-address";
import { exemptionCaseFor, exemptionFor, NEMA_TEXT } from "../../vat-exemption";
import {
  formatAmount,
  formatDateForeign,
  formatDeliveryDate,
  formatInvoiceNumber,
} from "../format";
import type { InvoiceTemplate, PrintCtx } from "./ctx";
import {
  advanceTotal,
  assertExportWithoutVat,
  discountFromLines,
  lineGross,
  payableAfterAdvance,
  printableAdvanceDeductions,
} from "./totals";

/**
 * IZVOZNA FAKTURA ZA ROBU (IZVRO / IZVGP) — korak 6 iz STAMPA_FAKTURA_GAP.md §4.
 *
 * Izvor istine je jedan jedini papir: `docs/zahtevi/fakture-obrasci-2026-08/
 * InoFaktura GP 228-25.pdf` — račun koji je stvarno izašao kupcu. Sve što ovde piše
 * prepisano je sa njega, a ne izmišljeno; opis obrasca je u STAMPA_IZLAZNIH_FAKTURA.md §4.
 *
 * ŠTA OVAJ OBRAZAC JESTE, A OSTALI NISU:
 *   - ceo je na ENGLESKOM, ali VREDNOSTI ostaju na srpskom („magacin kupca", „virmanom")
 *     jer se prepisuju iz šifarnika — prevod bi značio da papir i baza govore različito;
 *   - nema NIJEDAN PDV red (ni kolonu, ni zbir) — izvoz je oslobođen;
 *   - nema potpisne linije (za razliku od domaće robe, koja ih ima četiri);
 *   - jedini nosi blok banke (IBAN/SWIFT); domaći obrasci umesto njega nose tekući račun.
 *     ⚠️ Nikad oboje na istom papiru (STAMPA_IZLAZNIH_FAKTURA.md §6 t.3).
 *
 * ⚠️ POREZ: roba se oslobađa po članu 24. stav 1 TAČKA 2, a USLUGA (IZVUS) po članu 24.
 * STAV 2. Pogrešan član na izvoznoj fakturi je poreski problem, ne kozmetika — zato tekst
 * NE stoji više u ovom fajlu nego u `../../vat-exemption.ts`, odakle isti podatak uzima i
 * SEF builder. Do 02.08.2026. je bio ukucan na pet mesta i papir je za izvoz robe navodio
 * TAČKU 2, a XML TAČKU 5 — za isti posao istom kupcu
 * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §3.1). Brojevi članova nisu menjani; menja se
 * samo to što ih sada ima jedan primerak.
 */

/**
 * Poresko oslobođenje ZA IZVOZ ROBE — tekst dolazi iz `vat-exemption.ts`, ne odavde.
 *
 * `isExport`/`isService` su svojstva SAMOG OBRASCA: obrazac bira vrsta dokumenta
 * (`FORM_BY_DOCUMENT_TYPE` u `invoice-pdf.service.ts`), a ovo je izvozni robni papir.
 * `NEMA_TEXT` je ovde nedostižan (izvoz uvek ima osnov) i stoji samo zato što tip
 * `exemptionFor` dopušta `null` za domaći oporezovan promet.
 */
function exemptionNote(ctx: PrintCtx): string {
  const basis = exemptionFor(
    exemptionCaseFor({
      isExport: true,
      isService: false,
      vatTotalIsZero: ctx.invoice.vatTotal.isZero(),
    }),
  );
  return basis?.paperText ?? NEMA_TEXT;
}

/**
 * Reklamacije / nadležni sud / zatezna kamata — takođe doslovno sa papira.
 *
 * ⚠️ U ORIGINALU JE OVAJ BLOK ODŠTAMPAN DVAPUT, jedan ispod drugog. To je greška BigBita
 * (isti tekst dva puta na istom računu) i NE prepisuje se — štampa se jednom.
 * Sud je „Privredni" jer je ovo robna faktura; uslužni obrasci pišu „Trgovinski sud u
 * Beogradu" (STAMPA_IZLAZNIH_FAKTURA.md §6 t.2).
 */
const LEGAL_NOTES = [
  "Reklamacije primamo u roku od 5 dana po prijemu robe.",
  "Za sve sporove nadležan je Privredni sud.",
  "U slučaju prekoračenja roka za plaćanje obračunavamo zakonom propisanu zateznu kamatu.",
];

/** Osnovna veličina slova na obrascu; naslov i „TOTAL AMOUNT" su krupniji. */
const FS = 9;
/** Tabela stavki je sitnija od ostatka strane — kao na papiru. */
const FS_TABLE = 8;

// ------------------------------------------------------------------ pomoćne

/** Spaja delove i preskače prazne, da nigde ne ostane viseći separator. */
function join(parts: (string | null | undefined)[], sep: string): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(sep);
}

/** Deli višeredno polje iz baze na redove i baca prazne. */
function lines(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Količina na papiru stoji kao `2`, a ne `2.000` — BigBit joj ne dopunjava nule (za
 * razliku od cene i iznosa, koji su uvek na dve decimale). Zato se broj decimala bira
 * po samoj vrednosti: ceo broj bez decimala, razlomak sa onoliko koliko nosi.
 * Gornja granica je 3, koliko i kolona `Količina` na obrascu ume da prikaže.
 */
function formatQuantity(value: Prisma.Decimal): string {
  const rounded = value.toDecimalPlaces(3);
  const decimals = Math.min(3, Math.max(0, rounded.decimalPlaces()));
  return formatAmount(rounded, decimals);
}

// ------------------------------------------------------------------ blokovi

/** Naslov desno, krupno: `Invoice No. 228/25`. */
function titleBlock(ctx: PrintCtx): Content {
  return {
    text: `Invoice No. ${formatInvoiceNumber(ctx.invoice.documentNumber)}`,
    alignment: "right",
    fontSize: 14,
    bold: true,
    margin: [0, 6, 0, 10],
  };
}

/**
 * Gornji levi blok: parovi labela/vrednost (`Date:` `Customer:` `Address:`
 * `Date of delivery:` `Delivery term:` `Payment terms:`), labela desno poravnata uz vrednost.
 *
 * Par se izostavlja kad vrednosti nema — prazna labela na računu izgleda kao propušten
 * podatak, a zatečeni računi ova polja uglavnom nemaju (uvedena su tek zbog štampe).
 *
 * ⚠️ `Date of delivery:` (DATUM PROMETA) je dodat 02.08.2026. Papir 228/25 ga nema, ali
 * datum prometa je OBAVEZAN element računa po Zakonu o PDV
 * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3 N1) — a od spajanja u `supplyDate` polje
 * se i popunjava pri knjiženju, pa nema više razloga da ostane neodštampano. Ino USLUGA
 * ga je štampala sve vreme; robna nije, pa su dva izvozna papira istom kupcu nosila
 * različit skup obaveznih podataka.
 */
function partiesBlock(ctx: PrintCtx): Content {
  const c = ctx.customer;
  // „Podgradačka broj 11 - Bratunac 75420" — adresa, pa mesto sa poštanskim brojem.
  // Država se NE štampa: papir 228/25 je nema iako je kupac stranac.
  const address = join([c?.address, join([c?.city, c?.postalCode], " ")], " - ");

  const rows: TableCell[][] = [];
  const add = (labelText: string, value: string, bold = false) => {
    if (!value.trim()) return;
    rows.push([
      { text: labelText, fontSize: FS, alignment: "right" },
      { text: value, fontSize: bold ? 11 : FS, bold },
    ]);
  };

  add("Date:", formatDateForeign(ctx.invoice.documentDate));
  add("Customer:", c?.name ?? "", true);
  add("Address:", address);
  // DATUM PROMETA. Oblik je `DD-MM-YY` (`formatDeliveryDate`), isti kao `Date of delivery:`
  // na ino USLUZI — ona je jedini doneti dokaz kako BigBit štampa taj datum na engleskom
  // obrascu, i tamo je namerno drugačiji od `Date:` (`DD.MM.GGGG.`) na istoj strani.
  // Mesto se NE lepi uz datum (to radi samo obrazac usluge): na robi mesto izdavanja nije
  // deo datuma prometa, a papir 228/25 ga u tom bloku uopšte nema.
  add("Date of delivery:", formatDeliveryDate(ctx.invoice.supplyDate));
  // „Delivery term:" nosi FCO sa dokumenta („magacin kupca") — NE `deliveryTerm`, koji je
  // Incoterms paritet i pojavljuje se samo u otpremnom bloku ino USLUGE (drugi šifarnik).
  add("Delivery term:", ctx.invoice.fco ?? "");
  // JEDINI red o plaćanju na obrascu (v. `freeTextBlock` — dupli srpski red je skinut).
  // Vrednosti ostaju srpske („virmanom") — v. uvodni komentar.
  add("Payment terms:", ctx.invoice.paymentMethod ?? "");

  return {
    table: { widths: [88, "*"], body: rows },
    layout: "noBorders",
    margin: [0, 0, 0, 10],
  };
}

/**
 * Tabela stavki:
 * `No. | Catalog No. | Description | Unit | Stat. goods No. | Quantity | Price | Total ( EUR)`
 *
 * ⚠️ `Stat. goods No.` (carinska tarifa) se štampa I KAD JE PRAZNA — na papiru 228/25 je
 * prazna u obe stavke, ali kolona postoji. Izostavljanje kolone kad nema podatka pomerilo
 * bi ceo raspored i obrazac više ne bi bio isti papir.
 *
 * Razmak u `Total ( EUR)` je iz originala i prepisuje se doslovno.
 */
function itemsTable(ctx: PrintCtx): Content {
  const showPrices = !ctx.withoutPrices;

  const head: { text: string; align: "left" | "center" | "right" }[] = [
    { text: "No.", align: "left" },
    { text: "Catalog No.", align: "left" },
    { text: "Description", align: "left" },
    { text: "Unit", align: "center" },
    { text: "Stat. goods No.", align: "center" },
    { text: "Quantity", align: "center" },
  ];
  const widths: (string | number)[] = [18, 60, "*", 26, 64, 46];
  if (showPrices) {
    head.push({ text: "Price", align: "right" });
    head.push({ text: `Total ( ${ctx.currency})`, align: "right" });
    widths.push(50, 58);
  }

  const headerRow: TableCell[] = head.map((h) => ({
    text: h.text,
    fontSize: FS_TABLE,
    bold: true,
    alignment: h.align,
  }));

  const bodyRows: TableCell[][] = ctx.lines.map((l) => {
    // `Price` i `Total` su PRE rabata (v. `lineGross` u `totals.ts`): na papiru 228/25
    // `TOTAL` stoji neposredno ispod kolone `Total ( EUR)` i od njega se tek oduzima
    // `DISCOUNT:`, pa je `TOTAL` zbir te kolone. Dok je kolona nosila cenu POSLE rabata,
    // sa rabatom ≠ 0 nijedan od tri reda zbira nije mogao da se dobije njenim sabiranjem.
    const gross = lineGross(l);
    const cells: TableCell[] = [
      { text: String(l.ordinal), fontSize: FS_TABLE },
      { text: l.catalogNumber ?? "", fontSize: FS_TABLE },
      { text: l.name, fontSize: FS_TABLE },
      { text: l.unit ?? "", fontSize: FS_TABLE, alignment: "center" },
      // Prazan string, ne izostavljena ćelija — kolona mora da ostane vidljiva.
      { text: l.customsTariff ?? "", fontSize: FS_TABLE, alignment: "center" },
      { text: formatQuantity(l.quantity), fontSize: FS_TABLE, alignment: "right" },
    ];
    if (showPrices) {
      cells.push({
        text: formatAmount(gross.unitPrice),
        fontSize: FS_TABLE,
        alignment: "right",
      });
      cells.push({
        text: formatAmount(gross.total),
        fontSize: FS_TABLE,
        alignment: "right",
      });
    }
    return cells;
  });

  return {
    table: { headerRows: 1, widths, body: [headerRow, ...bodyRows] },
    layout: {
      // Pun okvir sa vertikalama; deblje iznad i ispod zaglavlja, kao na papiru.
      hLineWidth: (i: number, node) =>
        i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5,
      vLineWidth: () => 0.5,
      paddingTop: () => 2,
      paddingBottom: () => 2,
      paddingLeft: () => 3,
      paddingRight: () => 3,
    },
  };
}

/**
 * Zbir desno: `TOTAL`, `DISCOUNT:`, `TOTAL AMOUNT ( EUR)`, pa — kad je odbijen avans —
 * `Less prepayment received (no. …):` i UOKVIRENO `Amount payable ( EUR)`.
 *
 * `DISCOUNT` se štampa i kad je nula (`0.00`) — red se ne izostavlja
 * (STAMPA_IZLAZNIH_FAKTURA.md §6 t.4).
 *
 * ARITMETIKA (ispravka 02.08.2026, v. `totals.ts`): `TOTAL AMOUNT` je `invoice.grossTotal`
 * (isti iznos koji ide u glavnu knjigu i saldakonta), `DISCOUNT` je zbir rabata sa stavki,
 * a `TOTAL` njihov zbir — dakle vrednost PRE rabata. Ranije je bilo obrnuto
 * (`TOTAL` = Σ količina × cena, `DISCOUNT` = razlika), pa je red `DISCOUNT` bio strukturno
 * `0.00`: `unitPrice` je u bazi cena POSLE rabata, pa je taj zbir jednak osnovici.
 *
 * PDV se nigde ne pojavljuje: izvoz je oslobođen, pa je `grossTotal` ujedno i osnovica —
 * a `assertExportWithoutVat` to više ne ostavlja na veru (v. tamo, i komentar u telu).
 *
 * ⚠️ ODBIJEN AVANS (ispravka 02.08.2026, nalaz „papir traži više nego što kupac duguje"):
 * do tada ino obrasci avans NISU odbijali, iako `Invoice.advanceAppliedAmount` postoji i
 * `fakturisanje.service.ts` iz njega računa `payableAmount`. Stranom kupcu naplaćen avans
 * od 3.000 EUR i izdata izvozna faktura na 10.000 EUR dali su papir sa
 * `TOTAL AMOUNT ( EUR) 10,000.00` i bez ijednog reda o avansu — a izvozna faktura NE ide
 * na SEF (`sef.service.ts` je odbija), pa je taj papir JEDINI dokument koji kupac dobija.
 * Natpisi su engleski, iz zatečenog rečnika izvozne štampe („Less prepayment received",
 * „no.", „Amount payable"); `( EUR)` uz poslednji red prati oblik `TOTAL AMOUNT ( EUR)`.
 * Avans umanjuje SAMO iznos za uplatu — `TOTAL AMOUNT` ostaje pun iznos fakture.
 *
 * ⚠️ JEDAN RED PO PRIMENI (dopuna 02.08.2026): veza avans↔račun je N:M, pa se štampa red
 * po odbijenom avansu — broj i iznos su uvek iz ISTE primene. Ranije je izlazio jedan red
 * sa brojem prvog avansa i zbirom svih (10.000,00 EUR uz `A-1/26` 3.000 i `A-2/26` 2.000
 * dalo je „Less prepayment received (no. A-1/26): − 5,000.00").
 */
function totalsBlock(ctx: PrintCtx): Content {
  // Brana pre svakog računa: izvozni papir sa PDV-om ne sme da izađe (v. `totals.ts`).
  assertExportWithoutVat(ctx.invoice);

  const totalAmount = ctx.invoice.grossTotal;
  const discount = discountFromLines(ctx.lines);
  const total = totalAmount.add(discount);
  const deductions = printableAdvanceDeductions(ctx);
  const advance = advanceTotal(deductions);
  const hasAdvance = advance.greaterThan(0);

  const row = (
    labelText: string,
    value: string,
    opts: { boxed?: boolean; big?: boolean } = {},
  ): TableCell[] => [
    {
      text: labelText,
      fontSize: opts.big ? 11 : FS,
      bold: true,
      alignment: "right",
      border: [false, false, false, false],
    },
    {
      text: value,
      fontSize: opts.big ? 11 : FS,
      bold: !!opts.big,
      alignment: "right",
      border: opts.boxed
        ? [true, true, true, true]
        : [false, false, false, false],
    },
  ];

  const body: TableCell[][] = [
    // ⚠️ `TOTAL` JE UOKVIREN, `DISCOUNT:` NIJE — tako je na papiru 228/25 (ispravka
    // 02.08.2026: kod je uokvirivao samo `TOTAL AMOUNT`). Okvir na tom obrascu nosi
    // iznose koji SU zbir, a rabat je iznos koji se od njega oduzima.
    row("TOTAL", formatAmount(total), { boxed: true }),
    row("DISCOUNT:", formatAmount(discount)),
    // Bez avansa je `TOTAL AMOUNT` ujedno i iznos za uplatu, pa nosi okvir — tako je na
    // papiru 228/25. Sa avansom okvir seli na `Amount payable`: uokviren je uvek red koji
    // kaže koliko kupac TREBA DA PLATI, kao „Za uplatu" na domaćim obrascima.
    row(`TOTAL AMOUNT ( ${ctx.currency})`, formatAmount(totalAmount), {
      boxed: !hasAdvance,
      big: true,
    }),
  ];

  if (hasAdvance) {
    for (const deduction of deductions)
      body.push(
        row(
          deduction.documentNumber
            ? `Less prepayment received (no. ${deduction.documentNumber}):`
            : "Less prepayment received:",
          `− ${formatAmount(deduction.amount)}`,
        ),
      );
    body.push(
      row(
        `Amount payable ( ${ctx.currency})`,
        formatAmount(payableAfterAdvance(totalAmount, advance)),
        { boxed: true, big: true },
      ),
    );
  }

  return {
    margin: [0, 4, 0, 12],
    columns: [
      { width: "*", text: "" },
      {
        width: "auto",
        table: {
          widths: ["auto", 62],
          body,
        },
        layout: {
          defaultBorder: false,
          hLineWidth: () => 1,
          vLineWidth: () => 1,
          paddingTop: () => 2,
          paddingBottom: () => 2,
        },
      },
    ],
  };
}

/**
 * Slobodan tekst ispod zbira: poziv na ponudu i broj izvozne deklaracije.
 *
 * ZAŠTO POZIV NA PONUDU IDE IZ `note`: rečenica „Fakturisanje je izvršeno na osnovu ponude
 * 0206-25" nema namensko polje ni u modelu ni u `PrintCtx` (GAP §3 t.14 ga tek predlaže kao
 * `Invoice.offerReference`). Dok ga nema, jedini nosilac je `Invoice.note` — a ovo je i
 * jedino mesto na svih pet obrazaca gde slobodan tekst uopšte sme da izađe (GAP §2.1:
 * generičke „Napomene" na obrascu nema).
 *
 * ⚠️ ODAVDE JE 02.08.2026. SKINUT RED `Način plaćanja:`. On i gornji `Payment terms:`
 * (v. `partiesBlock`) čitali su ISTO polje `Invoice.paymentMethod`, pa su na svakoj našoj
 * fakturi ispisivali istu reč dva puta — jednom na srpskom usred engleskog dokumenta.
 * BigBit je imao dve kolone (`payment_terms` + `payment_method`) i na 228/25 nose različite
 * vrednosti („virmanom" gore, „avansno" dole); 4.0 model ima samo jedno polje, pa druga
 * vrednost ni ne postoji da bi se odštampala.
 *
 * Vlasnikova odluka (`docs/STAMPA_FAKTURA_ODLUKE.md`, „ČEKA · Način plaćanja na ino
 * fakturi", presuđeno po nalazu `FAKTURE_ZAKONSKA_USKLADJENOST.md` §2.1 / P1): način
 * plaćanja NIJE obavezan element računa i suvišan je — veleprodaja se ionako uvek plaća
 * virmanom. Ostaje JEDAN red, i to gornji `Payment terms:`, jer je on nosilac USLOVA
 * plaćanja („avansno", „30 dana") i jedini je na jeziku obrasca.
 */
function freeTextBlock(ctx: PrintCtx): Content[] {
  const out: Content[] = [];

  const noteLines = [
    ...lines(ctx.invoice.note),
    ...lines(ctx.invoice.customsDeclarationNo),
  ];
  if (noteLines.length)
    out.push({ text: noteLines.join("\n"), fontSize: FS, margin: [0, 0, 0, 8] });

  return out;
}

/** Poresko oslobođenje + reklamacije/sud/kamata — JEDNOM (v. `LEGAL_NOTES`). */
function legalBlock(ctx: PrintCtx): Content {
  return {
    stack: [exemptionNote(ctx), ...LEGAL_NOTES].map((text) => ({
      text,
      fontSize: FS,
    })),
    margin: [0, 0, 0, 12],
  };
}

/**
 * Blok banke u dve kolone — `Beneficiary Customer:` (IBAN, naziv, adresa) i
 * `Bank of beneficiary:` (SWIFT, banka + valuta, adresa banke, država).
 *
 * ZAŠTO SE OVO POSEBNO ISTIČE: u zatečenom kodu je grana za IBAN/SWIFT postojala, ali su
 * polja bila MRTVA — `loadIssuer` ih nikad nije popunjavao, pa su ino fakture godinama
 * izlazile bez ijedne bankarske instrukcije (GAP §2.4). Polja su tek dodata u model, i
 * `ino-roba.spec.ts` drži regresioni test da IBAN i SWIFT zaista izađu na papir.
 *
 * Ceo blok se izostavlja kad nema BROJA RAČUNA (IBAN-a) — prazne labele
 * „Beneficiary Customer:" bez broja računa kupcu ne znače ništa.
 *
 * ⚠️ IZMEREN KVAR (treći krug, 02.08.2026): uslov je gledao i naziv/adresu banke, pa je
 * `IZVRO 228/25` u RSD, sa običnim dinarskim redom u `payment_accounts` (iban/swift
 * `null`, `bankName` popunjen), odštampao zaglavlja „Beneficiary Customer:" i „Bank of
 * beneficiary:" i naziv banke — a NIJEDAN broj računa: IBAN i SWIFT su prazni, a domaći
 * `bankAccount` ino obrazac nikad ne štampa (STAMPA_IZLAZNIH_FAKTURA.md §6 t.3). To je
 * baš artefakt zbog kog je brana i pisana: papir izgleda ispravno, a kupac nema gde da
 * uplati. Naziv banke bez broja računa NIJE upotrebljiv podatak, pa blok izostaje u
 * celini — dinarski dokument uplatu prima na domaći račun, koji ovde nema šta da traži.
 *
 * `Banca Intesa a.d. EUR` (naziv + valuta, kako stoji na papiru) stiže GOTOV iz
 * `composeBankName` — obrazac ga štampa doslovno i ne dopisuje ništa (v. dole).
 * `bankAddress` je višered — „Republic of Serbia" na papiru je drugi red te adrese.
 */
function bankBlock(ctx: PrintCtx): Content[] {
  const i = ctx.issuer;
  const iban = i.iban?.trim();
  const swift = i.swift?.trim();
  const bankName = i.bankName?.trim();
  const bankAddress = lines(i.bankAddress);
  // ⚠️ MERILO JE IBAN, I SAMO IBAN (ispravka 02.08.2026). Uslov je do tada glasio
  // `!iban && !swift`, pa je SWIFT sam otvarao ceo blok — a SWIFT je oznaka BANKE, ne broj
  // računa: „Bank of beneficiary: SWIFT: DBDBRSBG" bez IBAN-a je papir sa imenom banke i
  // bez ijednog broja na koji se uplaćuje, tačno onaj artefakt zbog kog je brana pisana.
  // Do takvog stanja se stiže svuda gde `requireBankDetails` ne važi i zato ne traži oba
  // podatka: IZVRO/IZVUS u dinarima, otpremnica, revers (`invoice-pdf.service.ts`).
  if (!iban) return [];

  const beneficiary: Content[] = [
    { text: "Beneficiary Customer:", fontSize: FS },
    // Razmak pre dvotačke u „IBAN : " je iz originala; SWIFT ga nema.
    { text: `IBAN : ${iban}`, fontSize: FS, bold: true },
  ];
  if (i.companyName.trim())
    beneficiary.push({ text: i.companyName.trim(), fontSize: FS });
  // SA poštanskim brojem (O-F10): ovo je adresa primaoca u međunarodnoj uplati — banka
  // je nosi u nalogu, pa je tu poštanski broj deo podatka, za razliku od potpisnog bloka
  // domaće robne fakture.
  const issuerAddress = companyAddressLine(i.address, i.postalCode, i.city);
  if (issuerAddress) beneficiary.push({ text: issuerAddress, fontSize: FS });

  const bank: Content[] = [{ text: "Bank of beneficiary:", fontSize: FS }];
  if (swift) bank.push({ text: `SWIFT: ${swift}`, fontSize: FS });
  // ⚠️ VALUTA SE OVDE NE LEPI (ispravka 02.08.2026). Naziv sa papira („Banca Intesa a.d.
  // EUR") sklapa `composeBankName` u `invoice-pdf.service.ts` — i to NAMERNO samo kad je
  // devizni račun baš u valuti fakture. Ovaj obrazac je posle toga lepio valutu ponovo i
  // bez tog uslova, pa je USD faktura koja pada na EUR račun (drugi krug izbora u
  // `loadForeignAccount`) dobijala red „Citibank EUR" uz USD IBAN — dve tvrdnje o istom
  // računu. Ino USLUGA valutu nije lepila uopšte, pa su isti podaci davali dva različita
  // reda na dva obrasca. Sada oba štampaju naziv doslovno, onakav kakav im stigne.
  if (bankName) bank.push({ text: bankName, fontSize: FS });
  for (const line of bankAddress) bank.push({ text: line, fontSize: FS });

  return [
    {
      columns: [
        { width: "*", stack: beneficiary },
        { width: "*", stack: bank },
      ],
      columnGap: 12,
    },
  ];
}

// ------------------------------------------------------------------ šablon

/**
 * Telo izvozne fakture za robu. Memorandum (zaglavlje i podnožje strane) dodaje pozivalac —
 * v. `InvoiceTemplate` u `ctx.ts`.
 *
 * NEMA POTPISNIH LINIJA: papir 228/25 ih nema nijednu, ni „Potpis i pečat" ni potpisni blok
 * domaće robne fakture. `ctx.signatory` i `ctx.warehouseName` se ovde namerno ne koriste —
 * odgovorno lice i magacin su stvar domaćih obrazaca.
 */
export const inoRobaTemplate: InvoiceTemplate = (ctx: PrintCtx): Content[] => [
  titleBlock(ctx),
  partiesBlock(ctx),
  itemsTable(ctx),
  ...(ctx.withoutPrices ? [] : [totalsBlock(ctx)]),
  ...freeTextBlock(ctx),
  legalBlock(ctx),
  ...bankBlock(ctx),
];
