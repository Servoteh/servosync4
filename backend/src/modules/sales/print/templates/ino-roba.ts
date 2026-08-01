import { Prisma } from "@prisma/client";
import type { Content, TableCell } from "pdfmake/interfaces";
import { formatAmount, formatDateForeign, formatInvoiceNumber } from "../format";
import type { InvoiceTemplate, PrintCtx, PrintLine } from "./ctx";

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
 * STAV 2. Pogrešan član na izvoznoj fakturi je poreski problem, ne kozmetika — zato je
 * tekst konstanta u ovom fajlu i ne deli se sa uslužnim šablonom.
 */

/**
 * Poresko oslobođenje ZA ROBU, doslovno sa papira 228/25.
 * ⚠️ NE koristiti na uslužnoj ino fakturi — ona ima svoj član (stav 2).
 */
const VAT_EXEMPTION_NOTE_GOODS =
  "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.";

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

/**
 * Zbir stavki PRE rabata (`Σ količina × cena`) — to je red `TOTAL` na papiru.
 * Računa se nad Decimal-om, nikad preko Number-a: zbir na fakturi mora da se poklopi
 * sa knjiženjem do pare.
 */
function grossOfLines(items: PrintLine[]): Prisma.Decimal {
  return items.reduce(
    (sum, l) => sum.add(l.quantity.mul(l.unitPrice)),
    new Prisma.Decimal(0),
  );
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
 * `Delivery term:` `Payment terms:`), labela desno poravnata uz vrednost.
 *
 * Par se izostavlja kad vrednosti nema — prazna labela na računu izgleda kao propušten
 * podatak, a zatečeni računi ova polja uglavnom nemaju (uvedena su tek zbog štampe).
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
  // „Delivery term:" nosi FCO sa dokumenta („magacin kupca") — NE `deliveryTerm`, koji je
  // Incoterms paritet i pojavljuje se samo u otpremnom bloku ino USLUGE (drugi šifarnik).
  add("Delivery term:", ctx.invoice.fco ?? "");
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
        text: formatAmount(l.unitPrice),
        fontSize: FS_TABLE,
        alignment: "right",
      });
      cells.push({
        text: formatAmount(l.lineTotal),
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
 * Zbir desno: `TOTAL`, `DISCOUNT:`, pa UOKVIRENO `TOTAL AMOUNT ( EUR)`.
 *
 * `DISCOUNT` se štampa i kad je nula (`0.00`) — red se ne izostavlja
 * (STAMPA_IZLAZNIH_FAKTURA.md §6 t.4).
 *
 * Aritmetika: `TOTAL` je zbir stavki pre rabata, `TOTAL AMOUNT` je `invoice.grossTotal`
 * (isti iznos koji ide u glavnu knjigu i saldakonta), a `DISCOUNT` je razlika ta dva.
 * Time je red ispod uvek jednak redu iznad minus rabat — papir se ne sme „ne zaključati",
 * čak ni kad bi zbir stavki i denormalizovani zbir na dokumentu odstupili.
 * PDV se nigde ne pojavljuje: izvoz je oslobođen, pa je `grossTotal` ujedno i osnovica.
 */
function totalsBlock(ctx: PrintCtx): Content {
  const total = grossOfLines(ctx.lines);
  const totalAmount = ctx.invoice.grossTotal;
  const discount = total.sub(totalAmount);

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

  return {
    margin: [0, 4, 0, 12],
    columns: [
      { width: "*", text: "" },
      {
        width: "auto",
        table: {
          widths: ["auto", 62],
          body: [
            row("TOTAL", formatAmount(total)),
            row("DISCOUNT:", formatAmount(discount)),
            row(`TOTAL AMOUNT ( ${ctx.currency})`, formatAmount(totalAmount), {
              boxed: true,
              big: true,
            }),
          ],
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
 * Slobodan tekst ispod zbira: poziv na ponudu, broj izvozne deklaracije i način plaćanja.
 *
 * ZAŠTO POZIV NA PONUDU IDE IZ `note`: rečenica „Fakturisanje je izvršeno na osnovu ponude
 * 0206-25" nema namensko polje ni u modelu ni u `PrintCtx` (GAP §3 t.14 ga tek predlaže kao
 * `Invoice.offerReference`). Dok ga nema, jedini nosilac je `Invoice.note` — a ovo je i
 * jedino mesto na svih pet obrazaca gde slobodan tekst uopšte sme da izađe (GAP §2.1:
 * generičke „Napomene" na obrascu nema).
 *
 * ⚠️ `Način plaćanja:` i gornji `Payment terms:` čitaju ISTO polje. BigBit je imao dve
 * kolone (`payment_terms` i `payment_method`) i na 228/25 nose različite vrednosti
 * („virmanom" gore, „avansno" dole); 4.0 model je zadržao samo `Invoice.paymentMethod`.
 * Dok se druga ne uvede, ista vrednost stoji na oba mesta — red se ne izostavlja, jer je
 * deo obrasca. (Otvoreno pitanje za vlasnika.)
 */
function freeTextBlock(ctx: PrintCtx): Content[] {
  const out: Content[] = [];

  const noteLines = [
    ...lines(ctx.invoice.note),
    ...lines(ctx.invoice.customsDeclarationNo),
  ];
  if (noteLines.length)
    out.push({ text: noteLines.join("\n"), fontSize: FS, margin: [0, 0, 0, 8] });

  const paymentMethod = ctx.invoice.paymentMethod?.trim();
  if (paymentMethod)
    out.push({
      text: `Način plaćanja: ${paymentMethod}`,
      fontSize: FS,
      margin: [0, 0, 0, 8],
    });

  return out;
}

/** Poresko oslobođenje + reklamacije/sud/kamata — JEDNOM (v. `LEGAL_NOTES`). */
function legalBlock(): Content {
  return {
    stack: [VAT_EXEMPTION_NOTE_GOODS, ...LEGAL_NOTES].map((text) => ({
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
 * Ceo blok se izostavlja kad firma nema nijedan devizni podatak — prazne labele
 * „Beneficiary Customer:" bez broja računa kupcu ne znače ništa.
 *
 * `Banca Intesa a.d. EUR` = naziv banke + valuta dokumenta (na papiru je valuta zalepljena
 * uz naziv). Ako je valuta već u nazivu iz baze, ne udvaja se.
 * `bankAddress` je višered — „Republic of Serbia" na papiru je drugi red te adrese.
 */
function bankBlock(ctx: PrintCtx): Content[] {
  const i = ctx.issuer;
  const iban = i.iban?.trim();
  const swift = i.swift?.trim();
  const bankName = i.bankName?.trim();
  const bankAddress = lines(i.bankAddress);
  if (!iban && !swift && !bankName && !bankAddress.length) return [];

  const beneficiary: Content[] = [
    { text: "Beneficiary Customer:", fontSize: FS },
  ];
  // Razmak pre dvotačke u „IBAN : " je iz originala; SWIFT ga nema.
  if (iban) beneficiary.push({ text: `IBAN : ${iban}`, fontSize: FS, bold: true });
  beneficiary.push({ text: i.companyName, fontSize: FS });
  const issuerAddress = join([i.address, i.city], ", ");
  if (issuerAddress) beneficiary.push({ text: issuerAddress, fontSize: FS });

  const bank: Content[] = [{ text: "Bank of beneficiary:", fontSize: FS }];
  if (swift) bank.push({ text: `SWIFT: ${swift}`, fontSize: FS });
  if (bankName) {
    const withCurrency = bankName.endsWith(ctx.currency)
      ? bankName
      : `${bankName} ${ctx.currency}`;
    bank.push({ text: withCurrency, fontSize: FS });
  }
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
  legalBlock(),
  ...bankBlock(ctx),
];
