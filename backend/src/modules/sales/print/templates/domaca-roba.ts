import { Prisma } from "@prisma/client";
import type { Column, Content, TableCell } from "pdfmake/interfaces";
import {
  exemptionCaseFor,
  exemptionFor,
  NEMA_TEXT,
} from "../../vat-exemption";
import {
  formatAmount,
  formatDateDomestic,
  formatInvoiceNumber,
} from "../format";
import type { InvoiceTemplate, PrintCtx, PrintLine } from "./ctx";

/**
 * DOMAĆA FAKTURA ZA ROBU — obrasci **IFR** i **IFGP**.
 * Izvor istine: `docs/zahtevi/fakture-obrasci-2026-08/IFR.pdf` (657/25) i `IFGP.pdf` (650/25),
 * opis u `backend/docs/STAMPA_IZLAZNIH_FAKTURA.md` §2, korak 4 iz `STAMPA_FAKTURA_GAP.md` §4.
 *
 * ZAŠTO JEDAN FAJL ZA DVA OBRASCA: IFR i IFGP su ISTI papir — jedina razlika je naziv
 * magacina u potpisnom bloku („Magacin robe“ vs „Gotovi proizvodi“), a to je podatak
 * (`ctx.warehouseName`), ne obrazac. Dva fajla bi značila dve kopije koje se s vremenom
 * raziđu, pa bi se ispravka radila na jednom a zaboravila na drugom.
 *
 * ŠTA OVDE NAMERNO NEMA:
 *  - memorandum (zaglavlje i podnožje strane) — dodaje ga pozivalac kroz `memorandum.ts`,
 *    da svih pet obrazaca ima identičnu prvu i poslednju traku bez prepisivanja;
 *  - pristup bazi — sve stiže kroz `PrintCtx` (v. `ctx.ts`), pa se šablon testira bez baze;
 *  - imenovani `styles` — svaki čvor nosi svoju veličinu slova, tako da šablon daje isti
 *    papir bez obzira na to kakvu `styles` mapu pozivalac postavi na dokument;
 *  - broj lične karte — **odluka O-F3**: ne štampa se i ne čuva. Do 02.08.2026. je ostajao
 *    natpis `Broj l.k.:______` kao prazna linija; i on je skinut, jer traženje podatka o
 *    ličnosti bez pravnog osnova ne postaje bezopasno time što je polje prazno
 *    (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §2.2, P3). Potpisne linije OSTAJU sve
 *    četiri — one nisu potpis računa nego dokaz o isporuci (§5.2).
 */

// ───────────────────────────────────────────────────────── natpisi sa papira

/**
 * Razmaknuta slova NISU greška u kucanju — tako piše na donetim BigBit papirima
 * (`K u p a c:`, `N A Z I V   R O B E`, `C E N A`). Stoje kao konstante da bi bilo
 * očigledno da su namerna i da ih „sređivanje razmaka“ ne pojede.
 */
const LBL_CUSTOMER = "K u p a c:";
const COL_ITEM_NAME = "N A Z I V   R O B E";
const COL_PRICE = "C E N A";

/** Zaglavlje trake uslova — četiri kolone, doslovno sa obrasca. */
const CONDITION_HEADERS = [
  "Roba je FCO",
  "Način plaćanja",
  "Način otpreme robe",
  "Datum prometa dobara",
];

/**
 * Tri ugovorne napomene ispod zbira, doslovno sa papira.
 * Sud je ovde **Privredni** — na usluzi (IFUSL) piše „Trgovinski sud u Beogradu“
 * (STAMPA_IZLAZNIH_FAKTURA.md §6 t.2). Ne ujednačavati bez odluke vlasnika.
 *
 * ⚠️ Poreska napomena NIJE ovde: ona je PODATAK o samom računu, ne konstanta obrasca —
 * v. `exemptionNote` niže.
 */
const NOTES = [
  "Reklamacije primamo u roku od 5 dana po prijemu robe.",
  "Za sve sporove nadležan je Privredni sud.",
  "U slučaju prekoračenja roka za plaćanje obračunavamo zakonom propisanu zateznu kamatu.",
];

/** Naslovi četiri kolone potpisa. */
const SIGN_RECEIVED = "Robu primio";
const SIGN_CARRIER = "Preuzeo za prevoz";
const SIGN_ISSUED = "Robu izdao";
const SIGN_RESPONSIBLE = "Odgovorno lice";

// ────────────────────────────────────────────────────────── sitni pomoćnici

/** Spaja delove reda i preskače prazne, da nigde ne ostane viseći separator. */
function joinParts(parts: (string | null | undefined)[], sep: string): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(sep);
}

/**
 * Količina se na obrascu štampa BEZ suvišnih nula („5“, a ne „5.000“), pa se broj
 * decimala uzima sa same vrednosti. Gornja granica su tri decimale — toliko nosi
 * `InvoiceItem.quantity` u bazi.
 */
function formatQuantity(value: Prisma.Decimal): string {
  return formatAmount(value, Math.min(Math.max(value.decimalPlaces(), 0), 3));
}

/**
 * Kolona `R%` na papiru pokazuje `0` (ne `0.00` i ne prazno) — rabat se štampa i kad
 * ga nema, isto kao red „Rabat:“ u zbiru (STAMPA_IZLAZNIH_FAKTURA.md §6 t.4).
 */
function formatDiscountPercent(value: Prisma.Decimal): string {
  return formatAmount(value, Math.min(Math.max(value.decimalPlaces(), 0), 2));
}

/** Jedan red PDV-a u zbiru: stopa, osnovica na koju se primenjuje i iznos poreza. */
interface VatSummaryRow {
  rate: number;
  base: Prisma.Decimal;
  vat: Prisma.Decimal;
}

/**
 * Redovi PDV-a za zbirni blok.
 *
 * Kad je na računu JEDNA stopa (tako je na oba donete papira, i tako je u praksi),
 * uzimaju se zbirovi sa samog dokumenta (`netTotal`/`vatTotal`) — jer papir mora da
 * pokaže ono što je i proknjiženo, do pare. Tek kad se na istom računu nađu dve stope,
 * osnovice se moraju razdvojiti po stavkama, pošto zaglavlje nosi samo ukupan PDV.
 */
function vatSummaryRows(ctx: PrintCtx): VatSummaryRow[] {
  const rates = [
    ...new Set(
      ctx.lines
        .map((l) => l.vatRatePercent)
        .filter((r): r is number => r != null),
    ),
  ];

  if (rates.length <= 1) {
    return [
      {
        // Bez ijedne poznate stope (stara stavka bez `vatRateCode`) red i dalje mora
        // da postoji — obrazac ga ima uvek — pa se stopa prikaže kao 0.
        rate: rates[0] ?? 0,
        base: ctx.invoice.netTotal,
        vat: ctx.invoice.vatTotal,
      },
    ];
  }

  return rates
    .slice()
    .sort((a, b) => a - b)
    .map((rate) => {
      const base = ctx.lines
        .filter((l) => l.vatRatePercent === rate)
        .reduce((sum, l) => sum.add(l.lineTotal), new Prisma.Decimal(0));
      return { rate, base, vat: base.mul(rate).div(100).toDecimalPlaces(2) };
    });
}

/**
 * Bruto zbir stavki (prvi red zbirnog bloka) = Σ količina × cena, zaokruženo po stavci
 * isto kao što se i štampa u koloni VREDNOST. Rabat je onda razlika do osnovice, pa
 * kolona na papiru mora da se slaže: **bruto − rabat = osnovica**.
 */
function grossLinesTotal(lines: PrintLine[]): Prisma.Decimal {
  return lines.reduce(
    (sum, l) => sum.add(l.quantity.mul(l.unitPrice).toDecimalPlaces(2)),
    new Prisma.Decimal(0),
  );
}

// ─────────────────────────────────────────────────────────────── delovi tela

/** Centrirani red „Tekući račun: 160-110610-83“ — samo domaći obrasci ga imaju. */
function bankAccountLine(ctx: PrintCtx): Content[] {
  const account = ctx.issuer.bankAccount?.trim();
  if (!account) return [];
  return [
    {
      text: `Tekući račun: ${account}`,
      bold: true,
      fontSize: 9,
      alignment: "center",
      margin: [0, 0, 0, 12],
    },
  ];
}

/** Okvir „K u p a c:“ levo + blok broja/datuma desno. */
function customerAndTitle(ctx: PrintCtx): Content {
  const c = ctx.customer;
  const idLine = joinParts(
    [
      c?.taxId ? `PIB: ${c.taxId}` : null,
      c?.registrationNumber ? `MB: ${c.registrationNumber}` : null,
    ],
    "  -  ",
  );

  const customerLines: Content[] = c
    ? [
        { text: c.name, bold: true, fontSize: 10 },
        // Razmak između naziva i adrese je na papiru ceo prazan red.
        {
          text: joinParts([c.postalCode, c.city], "  "),
          fontSize: 9,
          margin: [0, 10, 0, 0],
        },
        { text: c.address ?? "", fontSize: 9 },
        { text: idLine, fontSize: 9 },
      ]
    : [{ text: "—", fontSize: 10 }];

  const rightBlock: Content[] = [
    {
      text: `Račun br. ${formatInvoiceNumber(ctx.invoice.documentNumber)}`,
      bold: true,
      fontSize: 16,
      alignment: "right",
    },
    {
      text: `Datum izdavanja računa: ${formatDateDomestic(ctx.invoice.documentDate)}`,
      fontSize: 10,
      alignment: "right",
      margin: [0, 10, 0, 0],
    },
    {
      text: `Valuta za plaćanje: ${formatDateDomestic(ctx.invoice.dueDate)}`,
      fontSize: 10,
      alignment: "right",
    },
  ];
  const place = ctx.issuer.invoiceIssuingPlace?.trim();
  if (place)
    rightBlock.push({
      text: `Mesto izdavanja računa:  ${place}`,
      fontSize: 10,
      alignment: "right",
      margin: [0, 10, 0, 0],
    });

  return {
    columns: [
      {
        width: 264,
        stack: [
          // Naslov je IZNAD okvira, ne u njemu — tako je na obrascu.
          { text: LBL_CUSTOMER, bold: true, fontSize: 9, margin: [4, 0, 0, 2] },
          {
            table: { widths: ["*"], body: [[{ stack: customerLines }]] },
            layout: {
              hLineWidth: () => 0.8,
              vLineWidth: () => 0.8,
              hLineColor: () => "#000000",
              vLineColor: () => "#000000",
              paddingLeft: () => 5,
              paddingRight: () => 5,
              paddingTop: () => 4,
              paddingBottom: () => 5,
            },
          },
        ],
      },
      { width: "*", stack: rightBlock },
    ],
    columnGap: 10,
    margin: [0, 0, 0, 10],
  };
}

/**
 * Traka uslova — četiri kolone (FCO / način plaćanja / način otpreme / datum prometa).
 *
 * Štampa se UVEK, i kad su polja prazna: na obrascu je to deo okvira, a ne uslovni blok
 * (otvoreno pitanje STAMPA_FAKTURA_GAP.md §5 t.4 — do odluke se papir prati doslovno,
 * a prazna traka je bezopasna dok stari računi nemaju popunjena polja iz odluke O-F4).
 */
function conditionsStrip(ctx: PrintCtx): Content {
  const values = [
    ctx.invoice.fco ?? "",
    ctx.invoice.paymentMethod ?? "",
    ctx.invoice.shipmentMethod ?? "",
    formatDateDomestic(ctx.invoice.supplyDate),
  ];

  const body: TableCell[][] = [
    // Prazna siva traka iznad zaglavlja — postoji na oba donesena papira.
    [{ text: "", colSpan: 4, fillColor: "#e6e6e6", fontSize: 4 }, {}, {}, {}],
    CONDITION_HEADERS.map((text) => ({
      text,
      bold: true,
      fontSize: 8,
      alignment: "center" as const,
    })),
    values.map((text) => ({
      text,
      fontSize: 8,
      alignment: "center" as const,
    })),
  ];

  return {
    table: { widths: ["*", "*", "*", "*"], body },
    layout: {
      hLineWidth: (i: number) => (i === 1 || i === 2 ? 0.9 : 0.6),
      vLineWidth: () => 0.6,
      hLineColor: () => "#000000",
      vLineColor: () => "#000000",
      paddingTop: () => 2,
      paddingBottom: () => 2,
    },
    margin: [0, 0, 0, 0],
  };
}

/**
 * Tabela stavki:
 * `R.br. | PDV | Kat. br. | N A Z I V   R O B E | j.m. | Količina | C E N A | R% | VREDNOST`
 *
 * Na otpremnici (`ctx.withoutPrices`) tri novčane kolone otpadaju; PDV stopa ostaje,
 * jer ona nije iznos nego oznaka poreskog tretmana stavke.
 */
function itemsTable(ctx: PrintCtx): Content {
  const money = !ctx.withoutPrices;

  const headers: TableCell[] = [
    { text: "R.br.", bold: true, fontSize: 7.5, alignment: "center" },
    { text: "PDV", bold: true, fontSize: 7.5, alignment: "center" },
    { text: "Kat. br.", bold: true, fontSize: 7.5, alignment: "center" },
    { text: COL_ITEM_NAME, bold: true, fontSize: 7.5, alignment: "center" },
    { text: "j.m.", bold: true, fontSize: 7.5, alignment: "center" },
    { text: "Količina", bold: true, fontSize: 7.5, alignment: "center" },
  ];
  const widths: (string | number)[] = [16, 20, 52, "*", 20, 32];
  if (money) {
    headers.push(
      { text: COL_PRICE, bold: true, fontSize: 7.5, alignment: "center" },
      { text: "R%", bold: true, fontSize: 7.5, alignment: "right" },
      { text: "VREDNOST", bold: true, fontSize: 7.5, alignment: "right" },
    );
    widths.push(46, 14, 52);
  }

  const rows: TableCell[][] = ctx.lines.map((l) => {
    const cells: TableCell[] = [
      { text: String(l.ordinal), fontSize: 7.5, alignment: "center" },
      {
        text: l.vatRatePercent != null ? `${l.vatRatePercent}%` : "",
        fontSize: 7.5,
        alignment: "center",
      },
      { text: l.catalogNumber ?? "", fontSize: 7.5, alignment: "center" },
      { text: l.name, fontSize: 7.5 },
      { text: l.unit ?? "", fontSize: 7.5 },
      { text: formatQuantity(l.quantity), fontSize: 7.5, alignment: "center" },
    ];
    if (money) {
      cells.push(
        {
          text: formatAmount(l.unitPrice, 2),
          fontSize: 7.5,
          alignment: "right",
        },
        {
          text: formatDiscountPercent(l.discountPercent),
          fontSize: 7.5,
          alignment: "right",
        },
        {
          text: formatAmount(l.lineTotal, 2),
          fontSize: 7.5,
          alignment: "right",
        },
      );
    }
    return cells;
  });

  return {
    table: { headerRows: 1, widths, body: [headers, ...rows] },
    layout: {
      // Deblja linija iznad i ispod zaglavlja, tanje između stavki — kao na papiru.
      hLineWidth: (i: number) => (i <= 1 ? 0.9 : 0.5),
      vLineWidth: () => 0.5,
      hLineColor: () => "#000000",
      vLineColor: () => "#000000",
      paddingTop: () => 1.5,
      paddingBottom: () => 1.5,
      paddingLeft: () => 3,
      paddingRight: () => 3,
    },
  };
}

/**
 * Petoredni zbir desno:
 *   1. bruto zbir stavki (bez labele)
 *   2. `Rabat:`
 *   3. `Vrednost bez PDV (osnovica):`
 *   4. `PDV po stopi 20% X <osnovica> =`   ← osnovica je U TEKSTU reda, ne samo iznos
 *   5. `Umanjenje za primljeni avans:`     ← samo kad avansa ima
 *   6. `Za uplatu (RSD):`                  ← uokvireno i podebljano, UMANJENO za avans
 *
 * Red rabata OSTAJE i kad je nula (`Rabat: 0.00`) — STAMPA_IZLAZNIH_FAKTURA.md §6 t.4.
 * Nije to dekoracija: kupac po istom papiru proverava da li mu je odobren rabat, a
 * izostavljen red se čita kao „nije ni bilo mesta za rabat“.
 */
function totalsBlock(ctx: PrintCtx): Content[] {
  if (ctx.withoutPrices) return [];

  const gross = grossLinesTotal(ctx.lines);
  const base = ctx.invoice.netTotal;
  const discount = gross.sub(base);
  const currency = ctx.currency || "RSD";

  const label = (text: string): TableCell => ({
    text,
    fontSize: 8.5,
    alignment: "right",
  });
  const value = (text: string): TableCell => ({
    text,
    fontSize: 8.5,
    alignment: "right",
  });

  const body: TableCell[][] = [
    [label(""), value(formatAmount(gross))],
    [label("Rabat:"), value(formatAmount(discount))],
    // Prazan red — na papiru zbir ima vidljiv razmak pre osnovice.
    [
      { text: " ", fontSize: 5 },
      { text: " ", fontSize: 5 },
    ],
    [label("Vrednost bez PDV (osnovica):"), value(formatAmount(base))],
  ];

  for (const row of vatSummaryRows(ctx)) {
    body.push([
      label(`PDV po stopi ${row.rate}% X ${formatAmount(row.base)} =`),
      value(formatAmount(row.vat)),
    ]);
  }

  /**
   * ODBIJEN AVANS — isto kao na uslužnom obrascu (`domaca-usluga.ts`).
   *
   * Doneti robni papiri ovaj red nemaju, pa se do 02.08.2026. nije ni štampao. Posledica
   * je bila da za ISTU poslovnu situaciju kupac dobije dva različita iznosa „za uplatu“,
   * zavisno od toga da li mu je prodata roba ili usluga — a na robnom papiru je uz to
   * nedostajao i obavezan podatak o visini avansnih plaćanja
   * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3 N4, M4). Vernost donetom obrascu ne
   * može da nadjača tačan iznos koji kupac treba da plati.
   *
   * Avans umanjuje SAMO iznos za uplatu — ne osnovicu ni PDV (oni su već obračunati na
   * avansnom računu). Zato red ide POSLE PDV-a, a poslednji ostaje „Za uplatu“.
   */
  const advance = ctx.invoice.advanceAppliedAmount;
  let payable = ctx.invoice.grossTotal;
  if (advance.greaterThan(0)) {
    body.push([
      label(
        ctx.advanceInvoiceNumber
          ? `Umanjenje za primljeni avans (br. ${ctx.advanceInvoiceNumber}):`
          : "Umanjenje za primljeni avans:",
      ),
      value(`− ${formatAmount(advance)}`),
    ]);
    const rest = payable.sub(advance);
    // Avans veći od računa ne sme da da negativan „za uplatu“ — preplata se rešava
    // odobrenjem, ne minusom na fakturi.
    payable = rest.greaterThan(0) ? rest : new Prisma.Decimal(0);
  }

  body.push([
    {
      text: `Za uplatu (${currency}):`,
      bold: true,
      fontSize: 9.5,
      alignment: "right",
      margin: [0, 2, 0, 0],
    },
    {
      text: formatAmount(payable),
      bold: true,
      fontSize: 9.5,
      alignment: "right",
      // Uokviren je SAMO iznos, ne i labela — tako je na oba papira.
      border: [true, true, true, true],
    },
  ]);

  return [
    {
      table: { widths: ["*", 56], body },
      layout: {
        defaultBorder: false,
        hLineWidth: () => 0.9,
        vLineWidth: () => 0.9,
        hLineColor: () => "#000000",
        vLineColor: () => "#000000",
        paddingTop: () => 1,
        paddingBottom: () => 1,
      },
      margin: [0, 3, 0, 0],
    },
  ];
}

/**
 * Poreska napomena — JEDAN izvor za papir i za SEF (`../../vat-exemption.ts`).
 *
 * Do 02.08.2026. je ovde stajalo tvrdo ukucano „…oslobodjenju: NEMA", pa je i račun sa
 * domaćim oslobođenjem (0 % PDV-a, SEF kategorija E) tvrdio da oslobođenja nema. To nije
 * kozmetika nego netačan OBAVEZAN element računa: napomena o odredbi po kojoj PDV nije
 * obračunat (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3 N3, M2).
 *
 * ZAŠTO SE `isExport`/`isService` ZADAJU OVDE, A NE ČITAJU SA DOKUMENTA: obrazac je već
 * izabran po vrsti dokumenta (`FORM_BY_DOCUMENT_TYPE` u `invoice-pdf.service.ts`), i
 * četiri obrasca SU matrica domaći/ino × roba/usluga. Ovo je domaći robni papir — druga
 * vrednost bi značila da je izabran pogrešan obrazac, a ne da je napomena druga.
 * Jedino što se čita sa dokumenta je ono što obrazac ne zna: da li je PDV obračunat.
 */
function exemptionNote(ctx: PrintCtx): string {
  const basis = exemptionFor(
    exemptionCaseFor({
      isExport: false,
      isService: false,
      vatTotalIsZero: ctx.invoice.vatTotal.isZero(),
    }),
  );
  return basis?.paperText ?? NEMA_TEXT;
}

/** Četiri napomene ispod zbira, sitno i levo (prva je poreska, v. `exemptionNote`). */
function notesBlock(ctx: PrintCtx): Content {
  return {
    stack: [exemptionNote(ctx), ...NOTES].map((text) => ({
      text,
      fontSize: 7.5,
    })),
    margin: [0, 14, 0, 0],
  };
}

/** Jedna kolona potpisa: naslov, linija za potpis, pa tekst ispod linije. */
function signatureColumn(title: string, under: Content[]): Column {
  return {
    width: "*",
    stack: [
      { text: title, fontSize: 8, alignment: "center" },
      {
        canvas: [
          { type: "line", x1: 0, y1: 0, x2: 118, y2: 0, lineWidth: 0.6 },
        ],
        margin: [4, 20, 0, 3],
      },
      ...under,
    ],
  };
}

/**
 * Četiri kolone potpisa. Kolona „Robu izdao“ nosi magacin (`iz magacina <naziv>`) —
 * to je i JEDINA razlika između IFR („Magacin robe“) i IFGP („Gotovi proizvodi“).
 *
 * ⚠️ SVE ČETIRI KOLONE OSTAJU. One nisu potpis računa (račun je punovažan i bez potpisa)
 * nego dokaz o izvršenoj isporuci: kod spora je potpis primaoca jedini dokaz, a kod
 * izvoznog oslobođenja poreska traži dokaz da je roba stvarno otišla
 * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §5.2). Ne skraćivati ih.
 *
 * Adresa magacina se uzima sa firme izdavaoca: `PrintCtx` nosi samo naziv magacina
 * (`warehouseName`), a na oba papira je to ista adresa kao sedište. Kad magacini dobiju
 * svoje adrese u štampi, prvo se proširuje `PrintCtx`, pa tek onda ovaj red.
 */
function signaturesBlock(ctx: PrintCtx): Content {
  const issuer = ctx.issuer;
  const small = (text: string): Content => ({
    text,
    fontSize: 7,
    alignment: "center",
  });
  const issuerAddress = joinParts([issuer.city, issuer.address], ", ");
  const issuerIds = joinParts(
    [
      issuer.taxId ? `PIB: ${issuer.taxId}` : null,
      issuer.registrationNumber ? `MB: ${issuer.registrationNumber}` : null,
    ],
    " ",
  );

  const carrier: Content[] = [small(issuer.companyName)];
  if (issuerAddress) carrier.push(small(issuerAddress));
  if (issuerIds) carrier.push(small(issuerIds));

  // NEMA natpisa „Broj l.k.“ — odluka O-F3 (ne štampa se i ne čuva). Prazna linija sa tim
  // natpisom je i dalje tražila podatak o ličnosti bez pravnog osnova, pa je skinuta i ona.
  const issued: Content[] = [];
  if (ctx.warehouseName?.trim())
    issued.push(small(`iz magacina ${ctx.warehouseName.trim()}`));
  const warehouseAddress = joinParts([issuer.address, issuer.city], ", ");
  if (warehouseAddress) issued.push(small(warehouseAddress));

  const responsible: Content[] = ctx.signatory?.name?.trim()
    ? [small(ctx.signatory.name.trim())]
    : [];

  return {
    columns: [
      signatureColumn(SIGN_RECEIVED, []),
      signatureColumn(SIGN_CARRIER, carrier),
      signatureColumn(SIGN_ISSUED, issued),
      signatureColumn(SIGN_RESPONSIBLE, responsible),
    ],
    columnGap: 8,
    margin: [0, 22, 0, 0],
  };
}

// ──────────────────────────────────────────────────────────────────── šablon

/**
 * Telo domaće robne fakture (IFR/IFGP), redom odozgo kako stoji na papiru.
 * Zaglavlje i podnožje strane dodaje pozivalac (`memorandum.ts`).
 */
export const domacaRobaTemplate: InvoiceTemplate = (
  ctx: PrintCtx,
): Content[] => [
  ...bankAccountLine(ctx),
  customerAndTitle(ctx),
  conditionsStrip(ctx),
  itemsTable(ctx),
  ...totalsBlock(ctx),
  notesBlock(ctx),
  signaturesBlock(ctx),
];
