import { Prisma } from "@prisma/client";
import type { Column, Content, TableLayout } from "pdfmake/interfaces";
import { exemptionCaseFor, exemptionFor, NEMA_TEXT } from "../../vat-exemption";
import { taxTreatmentOf } from "../../service-revenue-type";
import { formatAmount, formatDateDomestic, formatInvoiceNumber } from "../format";
import type { InvoiceTemplate, PrintCtx } from "./ctx";
import {
  advanceTotal,
  discountFromLines,
  lineGross,
  payableAfterAdvance,
  printableAdvanceDeductions,
  vatSummaryRows,
} from "./totals";

/**
 * IFUSL — domaća faktura za USLUGU (korak 5 iz `docs/STAMPA_FAKTURA_GAP.md` §4).
 * Izvor istine je doneti papir `docs/zahtevi/fakture-obrasci-2026-08/IFUSL.pdf`
 * (račun 653/25, zakup poslovnog prostora), a razlike prema robi su popisane u
 * `docs/STAMPA_IZLAZNIH_FAKTURA.md` §3.
 *
 * ZAŠTO ZASEBAN ŠABLON, A NE PREKIDAČ NAD ROBNIM: razlike nisu kozmetičke —
 * drugačiji naslov (dva reda, podvučen broj), drugi desni blok (rok za plaćanje i
 * datum prometa umesto valute), NEMA trake uslova (usluga nema FCO ni otpremu),
 * druga tabela (bez `Kat. br.`, kolona se zove `O P I S`, poslednja `I Z N O S`),
 * drugi zbir (pet UOKVIRENIH redova sa zasebnim „Ukupno vrednost bez PDV"),
 * drugi tekst reklamacije, DRUGI NADLEŽNI SUD i jedan potpis umesto četiri.
 * Sve to kroz `if (usluga)` grane u robnom šablonu značilo bi da svaka kasnija
 * izmena robe mora da se testira i na usluzi (i obrnuto) — a to su dva papira
 * koja se menjaju iz sasvim različitih razloga. Vlasnik je istom logikom presudio
 * i da je unos usluge poseban ekran (PLAN_UNOS_DOKUMENATA.md §8, O1–O4).
 *
 * ⚠️ Šablon NE ČITA BAZU (ugovor iz `ctx.ts`): sve stiže kroz `PrintCtx`, pa se
 * papir može proveriti testom bez Prisma konteksta.
 *
 * ⚠️ Odluka O-F3 (`docs/STAMPA_FAKTURA_ODLUKE.md`): iako original nosi
 * `Br. l.k.:008165163`, broj lične karte se NE štampa i NE čuva. Linija ispod
 * imena ostaje prazna — tačno kao što već jeste na fakturama za robu.
 */

/** pdfmake `margin` traži četvorku; bez ovoga TS izvede `number[]` i pukne. */
type Margin = [number, number, number, number];

/** Širina uokvirenog polja sa iznosom u zbirnom bloku (pt). */
const TOTALS_BOX_WIDTH = 82;

/**
 * Ugovorne napomene sa papira, doslovno. Dve su namerno drugačije nego na robi:
 *  - reklamacije BEZ „po prijemu robe" (usluga se ne prima kao roba),
 *  - `Trgovinski sud u Beogradu` umesto `Privredni sud`.
 * Naziv „Trgovinski sud" je u pravu zastareo, ali stoji na obrascu koji je izašao
 * kupcu; ispravka je otvoreno pitanje za vlasnika (GAP §5 t.10), a do odluke se
 * papir prati doslovno (STAMPA_IZLAZNIH_FAKTURA.md §6 t.2).
 *
 * ⚠️ Poreska napomena NIJE u ovom spisku: ona je PODATAK o računu, ne konstanta
 * obrasca — v. `exemptionNote` niže.
 */
const NOTES: string[] = [
  "Reklamacije primamo u roku od 5 dana.",
  "Za sve sporove nadležan je Trgovinski sud u Beogradu.",
  "U slučaju prekoračenja roka za plaćanje obračunavamo zakonom propisanu zateznu kamatu.",
];

/**
 * Poreska napomena — JEDAN izvor za papir i za SEF (`../../vat-exemption.ts`).
 *
 * Do 02.08.2026. je i ovde bilo tvrdo ukucano „…oslobodjenju: NEMA", pa je i usluga sa
 * domaćim oslobođenjem (0 % PDV-a, SEF kategorija E) tvrdila da oslobođenja nema —
 * netačan OBAVEZAN element računa (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §1.3 N3, M2).
 *
 * `isExport`/`isService` su svojstva SAMOG OBRASCA, ne dokumenta: obrazac bira vrsta
 * dokumenta (`FORM_BY_DOCUMENT_TYPE` u `invoice-pdf.service.ts`), a četiri obrasca su
 * matrica domaći/ino × roba/usluga. Sa dokumenta se čita samo ono što obrazac ne zna —
 * da li je PDV uopšte obračunat.
 */
function exemptionNote(ctx: PrintCtx): string {
  // ⚠️ ŠIFARNIK VRSTE USLUGE IMA PREDNOST (05.08.2026). Tekst za otpad i za uslugu
  // stranom kupcu je poresku formulaciju potvrdio vlasnik, a knjigovođa je uređuje —
  // kod ne sme da je nadglasa. `null` = vrsta nije izabrana ili je bez napomene, pa
  // ostaje zatečeno ponašanje ispod (nepromenjeno za sve dosadašnje račune).
  if (ctx.serviceRevenueNote) return ctx.serviceRevenueNote;
  const basis = exemptionFor(
    exemptionCaseFor({
      isExport: false,
      isService: true,
      vatTotalIsZero: ctx.invoice.vatTotal.isZero(),
      taxTreatment: taxTreatmentOf(ctx.invoice),
    }),
  );
  return basis?.paperText ?? NEMA_TEXT;
}

/** Pun okvir (linije i unutar tabele) — koristi tabela stavki. */
const GRID_LAYOUT: TableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.4),
  vLineWidth: () => 0.4,
  hLineColor: () => "#000000",
  vLineColor: () => "#000000",
  paddingTop: () => 2,
  paddingBottom: () => 2,
  paddingLeft: () => 3,
  paddingRight: () => 3,
};

/** Okvir oko bloka kupca. */
const CUSTOMER_BOX_LAYOUT: TableLayout = {
  hLineWidth: () => 0.8,
  vLineWidth: () => 0.8,
  hLineColor: () => "#000000",
  vLineColor: () => "#000000",
  paddingTop: () => 6,
  paddingBottom: () => 8,
  paddingLeft: () => 10,
  paddingRight: () => 10,
};

/** Okvir oko JEDNOG iznosa u zbiru; poslednji red je deblji, kao na papiru. */
function amountBoxLayout(lineWidth: number): TableLayout {
  return {
    hLineWidth: () => lineWidth,
    vLineWidth: () => lineWidth,
    hLineColor: () => "#000000",
    vLineColor: () => "#000000",
    paddingTop: () => 1.5,
    paddingBottom: () => 1.5,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

/**
 * Količina se na papiru štampa `1`, a ne `1.000` — zato se broj decimala bira
 * prema samoj vrednosti (ceo broj → bez decimala, inače tri). Formatiranje i dalje
 * radi zajednički `formatAmount` (separator hiljada je isti kao kod iznosa), ovde
 * se bira samo koliko decimala ima smisla prikazati.
 */
function formatQuantity(value: Prisma.Decimal): string {
  return formatAmount(value, value.isInteger() ? 0 : 3);
}

/** Rabat je na papiru `0`, ne `0.00`; isto pravilo kao za količinu, ali 2 decimale. */
function formatPercentCell(value: Prisma.Decimal): string {
  return formatAmount(value, value.isInteger() ? 0 : 2);
}

/** `20%` u koloni PDV; prazno kad stopa nije poznata (ne štampa se „null%"). */
function formatVatRate(rate: number | null): string {
  return rate == null ? "" : `${rate}%`;
}

/**
 * Redovi PDV-a u zbiru — račun je u `totals.ts` (`vatSummaryRows`), jer isti mora da važi
 * i na robnom obrascu; ovde je samo REDOSLED PRIKAZA.
 *
 * Papir 653/25 ima tačno jedan red (`PDV po stopi 20% X 16,000.00 = 3,200.00`) jer sve
 * stavke nose istu stopu — normalan slučaj domaće usluge. Kad se stope razlikuju, štampa
 * se red po stopi (pogrešna stopa na računu je poreska greška, ne kozmetika), i to
 * OPADAJUĆE (20 % pa 10 %) — kako je uslužni obrazac oduvek prikazivao.
 */
function buildVatGroups(ctx: PrintCtx): ReturnType<typeof vatSummaryRows> {
  return vatSummaryRows(ctx)
    .slice()
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
}

/** Centriran, podebljan red `Tekući račun: 160-110610-83` iznad kupca. */
function bankAccountLine(ctx: PrintCtx): Content[] {
  const account = ctx.issuer.bankAccount?.trim();
  if (!account) return [];
  return [
    {
      text: `Tekući račun: ${account}`,
      alignment: "center",
      bold: true,
      fontSize: 9,
      margin: [0, 0, 0, 10] as Margin,
    },
  ];
}

/**
 * Levo blok kupca (naslov razmaknutim slovima IZNAD okvira), desno naslov računa
 * i datumi.
 *
 * Redosled u okviru kupca je sa papira: naziv, pa **poštanski broj + mesto**, pa
 * tek onda ulica, pa `PIB: … - MB: …`. Država se ne štampa — domaći obrazac.
 */
function partiesAndTitle(ctx: PrintCtx): Content {
  const c = ctx.customer;
  const customerLines: Content[] = [];
  if (c) {
    customerLines.push({ text: c.name, bold: true, fontSize: 10 });
    const cityLine = [c.postalCode, c.city].filter(Boolean).join("   ");
    if (cityLine)
      customerLines.push({
        text: cityLine,
        fontSize: 9,
        margin: [0, 8, 0, 0] as Margin,
      });
    if (c.address?.trim())
      customerLines.push({ text: c.address.trim(), fontSize: 9 });
    const ids = [
      c.taxId ? `PIB: ${c.taxId}` : "",
      c.registrationNumber ? `MB: ${c.registrationNumber}` : "",
    ].filter(Boolean);
    if (ids.length) customerLines.push({ text: ids.join("  -  "), fontSize: 9 });
  } else {
    customerLines.push({ text: "—", fontSize: 10 });
  }

  // Desni blok: NEMA „Valuta za plaćanje" (to je robni obrazac) — usluga nosi
  // „Rok za plaćanje" i „Datum prometa". Red se izostavlja kad podatka nema,
  // da ne ostane visiti prazna labela.
  const rightRows: [string, string][] = [
    ["Datum izdavanja računa:", formatDateDomestic(ctx.invoice.documentDate)],
    ["Mesto izdavanja računa:", ctx.issuer.invoiceIssuingPlace?.trim() ?? ""],
    ["Rok za plaćanje:", formatDateDomestic(ctx.invoice.dueDate)],
    ["Datum prometa:", formatDateDomestic(ctx.invoice.supplyDate)],
  ];

  return {
    columns: [
      {
        width: "*",
        stack: [
          {
            text: "K u p a c:",
            bold: true,
            fontSize: 9,
            margin: [4, 0, 0, 3] as Margin,
          },
          {
            table: { widths: ["*"], body: [[{ stack: customerLines }]] },
            layout: CUSTOMER_BOX_LAYOUT,
          },
        ],
      },
      {
        width: 210,
        stack: [
          // Naslov u DVA reda; broj računa je podvučen — oba sa papira.
          { text: "Račun", alignment: "right", bold: true, fontSize: 20 },
          {
            text: `br. ${formatInvoiceNumber(ctx.invoice.documentNumber)}`,
            alignment: "right",
            bold: true,
            fontSize: 13,
            decoration: "underline",
            margin: [0, 2, 0, 10] as Margin,
          },
          ...rightRows
            .filter(([, value]) => value !== "")
            .map<Content>(([label, value]) => ({
              text: `${label} ${value}`,
              alignment: "right",
              fontSize: 9.5,
              margin: [0, 1, 0, 0] as Margin,
            })),
        ],
      },
    ],
    columnGap: 16,
    margin: [0, 0, 0, 12] as Margin,
  };
}

/**
 * Tabela stavki: `R.br. | PDV | O P I S | j.m. | Količina | C E N A | Rab% | I Z N O S`.
 *
 * Razlike prema robi su u samim naslovima kolona i moraju ostati doslovne:
 * NEMA `Kat. br.` (usluga nema artikal), opisna kolona je `O P I S` (ne
 * `N A Z I V   R O B E`), rabat je `Rab%` (ne `R%`), a poslednja kolona
 * `I Z N O S` (ne `VREDNOST`). Razmaknuta slova su deo obrasca, ne greška.
 */
function itemsTable(ctx: PrintCtx): Content {
  const money = !ctx.withoutPrices;

  const head: [string, string][] = money
    ? [
        ["R.br.", "center"],
        ["PDV", "center"],
        ["O P I S", "center"],
        ["j.m.", "center"],
        ["Količina", "center"],
        ["C E N A", "center"],
        ["Rab%", "center"],
        ["I Z N O S", "center"],
      ]
    : // Otpremnica bez cena (`ctx.withoutPrices`) — obrazac za nju NIJE donet
      // (GAP §5 t.11), pa se štampa isti papir bez novčanih kolona. Stopa PDV-a
      // odlazi sa njima: bez ijednog iznosa ona nema šta da opiše.
      [
        ["R.br.", "center"],
        ["O P I S", "center"],
        ["j.m.", "center"],
        ["Količina", "center"],
      ];

  const widths: (string | number)[] = money
    ? [24, 30, "*", 26, 44, 58, 28, 62]
    : [24, "*", 30, 60];

  const body: Content[][] = [
    head.map(([text, alignment]) => ({
      text,
      alignment: alignment as "center",
      bold: true,
      fontSize: 8.5,
    })),
  ];

  for (const line of ctx.lines) {
    // `C E N A` i `I Z N O S` su PRE rabata — v. `lineGross` u `totals.ts`. Zbir kolone
    // `I Z N O S` je prvi red zbirnog bloka („Vrednost bez PDV:"), od kog se tek oduzima
    // „Odobren rabat:" — tako je na donetom papiru IFUSL 653/25, gde ta tri reda stoje
    // jedan ispod drugog. Do 02.08.2026. je kolona nosila cenu POSLE rabata, pa se prvi
    // red zbira nije mogao dobiti sabiranjem kolone čim je rabat bio ≠ 0.
    const gross = lineGross(line);
    const cells: Content[] = [
      { text: String(line.ordinal), alignment: "center", fontSize: 8.5 },
    ];
    if (money)
      cells.push({
        text: formatVatRate(line.vatRatePercent),
        alignment: "center",
        fontSize: 8.5,
      });
    cells.push(
      { text: line.name, fontSize: 8.5 },
      { text: line.unit ?? "", alignment: "center", fontSize: 8.5 },
      { text: formatQuantity(line.quantity), alignment: "center", fontSize: 8.5 },
    );
    if (money)
      cells.push(
        { text: formatAmount(gross.unitPrice), alignment: "right", fontSize: 8.5 },
        {
          text: formatPercentCell(line.discountPercent),
          alignment: "center",
          fontSize: 8.5,
        },
        { text: formatAmount(gross.total), alignment: "right", fontSize: 8.5 },
      );
    body.push(cells);
  }

  return {
    table: { headerRows: 1, widths, body },
    layout: GRID_LAYOUT,
  };
}

/**
 * Jedan red zbira: labela levo, iznos desno u istoj koloni.
 *
 * `boxed` = da li iznos ide U OKVIR. NIJE ukras: na donetom papiru IFUSL 653/25 uokvirena
 * su ČETIRI reda („Vrednost bez PDV", „Odobren rabat", „Ukupno vrednost bez PDV
 * (osnovica)" i „Ukupno za uplatu"), a red PDV-a (`PDV po stopi 20% X 16,000.00 =
 * 3,200.00`) NIJE. Do 02.08.2026. je kod uokvirivao svaki red, pa je papir imao jedan
 * okvir viška — a on je na obrascu razlika između iznosa koji ULAZE u zbir i poreza koji
 * se na osnovicu tek obračunava. Neuokviren iznos zadržava istu širinu i desnu ivicu
 * (`TOTALS_BOX_WIDTH` + margina umesto okvira), da kolona brojeva ostane poravnata.
 */
function totalsRow(
  label: string,
  value: string,
  opts: { strong?: boolean; boxed?: boolean } = {},
): Content {
  const strong = opts.strong === true;
  const boxed = opts.boxed !== false;
  const amount: Column = boxed
    ? {
        width: TOTALS_BOX_WIDTH,
        table: {
          widths: ["*"],
          body: [[{ text: value, alignment: "right", bold: strong, fontSize: 9 }]],
        },
        layout: amountBoxLayout(strong ? 1.2 : 0.6),
      }
    : {
        width: TOTALS_BOX_WIDTH,
        text: value,
        alignment: "right",
        bold: strong,
        fontSize: 9,
        // Ista unutrašnja margina kao u okviru (paddingRight 4 + linija), da se iznos
        // poklopi sa uokvirenim iznosima iznad i ispod.
        margin: [0, 1.5, 4, 0] as Margin,
      };

  return {
    columns: [
      {
        width: "*",
        text: label,
        alignment: "right",
        bold: strong,
        fontSize: 9,
        margin: [0, 2, 6, 0] as Margin,
      },
      amount,
    ],
    margin: [0, 1.5, 0, 0] as Margin,
  };
}

/**
 * Zbir: PET redova, od kojih su uokvirena ČETIRI — sva osim reda PDV-a (na robi okvir
 * ima samo poslednji). Usluga ima i zaseban red `Ukupno vrednost bez PDV (osnovica)`, pa
 * poslednji red glasi `Ukupno za uplatu (RSD):` — a ne `Za uplatu (RSD):` kao na robi.
 *
 * ⚠️ RED PDV-a BEZ OKVIRA (ispravka 02.08.2026): doneti papir IFUSL 653/25 ga jedinog
 * nema uokvirenog, a kod je uokvirivao svih pet. Zašto to nije kozmetika: okvir na tom
 * obrascu izdvaja iznose koji ULAZE u zbir od poreza koji se na osnovicu tek obračunava.
 *
 * Odnos redova se drži sam od sebe: red 3 je `netTotal` sa dokumenta, red 2 je
 * zbir rabata sa stavki, a red 1 njihov zbir — tako odobren rabat uvek zatvara
 * račun (**bruto − rabat = osnovica**), ma kako bio raspoređen po stavkama.
 *
 * ⚠️ ISPRAVKA 02.08.2026: red 1 je do tada bio Σ(količina × `unitPrice`), a rabat
 * razlika do osnovice. Pošto je `unitPrice` u bazi cena POSLE rabata
 * (`pricing.service.ts`), taj zbir je uvek bio JEDNAK osnovici, pa je „Odobren
 * rabat" strukturno bio `0.00` i kad je u koloni `Rab%` pisalo 20. Sada se rabat
 * izvodi po stavci (`totals.ts`), a bruto je osnovica uvećana za njega.
 *
 * ⚠️ NATPIS REDA 1 (dopuna 02.08.2026): više NE nosi „(osnovica)“. Otkad se rabat
 * zaista računa, red 1 je vrednost PRE rabata, pa je dokument u tri reda tvrdio
 * `osnovica = 20.000,00`, `rabat = 4.000,00`, `osnovica = 16.000,00` — dva različita
 * iznosa pod istim imenom, a prvi nije poreska osnovica. Doneti papir IFUSL 653/25
 * ima rabat 0,00, pa su mu oba reda ista i razlika se na njemu ne vidi; sam BigBit taj
 * red u formi za unos zove „Vrednost bez poreza“, ne „osnovica“
 * (`backend/docs/migration/12-bigbit-uputstvo-master.md`, image17). Zagrada ostaje SAMO
 * na redu posle rabata, koji jeste poreska osnovica. Robni obrazac je ovim nedirnut —
 * tamo je red 1 bez natpisa (`domaca-roba.ts`, `label("")`), kao na papiru IFR.
 */
function totalsBlock(ctx: PrintCtx): Content[] {
  if (ctx.withoutPrices) return [];

  const net = ctx.invoice.netTotal;
  const discount = discountFromLines(ctx.lines);
  const gross = net.add(discount);
  const rows: Content[] = [
    totalsRow("Vrednost bez PDV:", formatAmount(gross)),
    totalsRow("Odobren rabat:", formatAmount(discount)),
    totalsRow("Ukupno vrednost bez PDV (osnovica):", formatAmount(net)),
  ];

  // Red PDV-a nosi i stopu i OSNOVICU u samom tekstu: „PDV po stopi 20% X 16,000.00 =".
  // BEZ OKVIRA — na papiru 653/25 je jedini takav red u zbiru (v. `totalsRow`).
  for (const g of buildVatGroups(ctx)) {
    const label =
      g.rate == null
        ? `PDV X ${formatAmount(g.base)} =`
        : `PDV po stopi ${g.rate}% X ${formatAmount(g.base)} =`;
    rows.push(totalsRow(label, formatAmount(g.vat), { boxed: false }));
  }

  // Odbijen avans (Batch C §C1a) ne postoji na donetom papiru, ali se NE sme
  // prećutati: umanjuje iznos za uplatu, a ne osnovicu ni PDV. Zato ulazi kao
  // red neposredno pre završnog — koji i dalje ostaje `Ukupno za uplatu`.
  //
  // JEDAN RED PO PRIMENI (N:M, ispravka 02.08.2026): račun na 10.000,00 koji zatvara
  // `A-1/26` (3.000,00) i `A-2/26` (2.000,00) daje DVA reda sa svojim iznosima. Ranije
  // je izlazio jedan red — broj prvog avansa uz zbir svih (− 5.000,00).
  const deductions = printableAdvanceDeductions(ctx);
  const advance = advanceTotal(deductions);
  let payable = ctx.invoice.grossTotal;
  if (advance.greaterThan(0)) {
    for (const deduction of deductions) {
      const label = deduction.documentNumber
        ? `Umanjenje za primljeni avans (br. ${deduction.documentNumber}):`
        : "Umanjenje za primljeni avans:";
      rows.push(totalsRow(label, `− ${formatAmount(deduction.amount)}`));
    }
    payable = payableAfterAdvance(payable, advance);
  }

  rows.push(
    totalsRow(`Ukupno za uplatu (${ctx.currency}):`, formatAmount(payable), {
      strong: true,
    }),
  );

  return [{ stack: rows, margin: [0, 3, 0, 0] as Margin }];
}

/**
 * Potpis: SAMO „Odgovorno lice" (roba ima četiri kolone — „Robu primio",
 * „Preuzeo za prevoz", „Robu izdao", „Odgovorno lice"). Ime je komercijalista sa
 * računa (odluka O-F2).
 *
 * Ispod imena na papiru stoji `Br. l.k.:008165163` — TO SE NE ŠTAMPA (O-F3).
 * Podatak o ličnosti bez poslovne potrebe ne ide na dokument koji putuje kupcu;
 * linija ostaje prazna, isto kao na fakturama za robu.
 */
function signatureBlock(ctx: PrintCtx): Content {
  return {
    columns: [
      { width: "*", text: "" },
      {
        width: 190,
        stack: [
          { text: "Odgovorno lice", alignment: "center", fontSize: 9 },
          {
            canvas: [
              {
                type: "line",
                x1: 10,
                y1: 0,
                x2: 180,
                y2: 0,
                lineWidth: 0.6,
                lineColor: "#000000",
              },
            ],
            margin: [0, 3, 0, 0] as Margin,
          },
          {
            text: ctx.signatory?.name ?? "",
            alignment: "center",
            fontSize: 8,
            margin: [0, 3, 0, 0] as Margin,
          },
        ],
      },
    ],
    margin: [0, 70, 0, 0] as Margin,
  };
}

/**
 * Telo IFUSL računa — sve između memorandum-zaglavlja i memorandum-podnožja
 * (zaglavlje/podnožje strane dodaje pozivalac, v. `ctx.ts`).
 *
 * Stilovi su namerno INLINE (`fontSize`/`bold`/`alignment`), a ne imena iz
 * `styles` rečnika: šablon tako ne zavisi od toga šta je pozivalac registrovao,
 * pa se testira i renderuje sam za sebe.
 *
 * `ctx.warehouseName` se NE koristi — usluga nema magacin (magacin se štampa samo
 * na robi, u koloni „Robu izdao"). Isto tako se ne štampa ni `invoice.note`:
 * generičke napomene na ovom obrascu nema (GAP §2.1).
 */
export const domacaUslugaTemplate: InvoiceTemplate = (ctx: PrintCtx): Content[] => [
  ...bankAccountLine(ctx),
  partiesAndTitle(ctx),
  // NAPOMENA: između kupca i tabele NEMA trake uslova (FCO / način plaćanja /
  // način otpreme / datum prometa dobara) — to je robni obrazac. Usluga se ne
  // otprema, pa bi prazna traka bila izmišljotina, a puna netačna.
  itemsTable(ctx),
  ...totalsBlock(ctx),
  {
    // Prvi red je poreska napomena (podatak), pa tri ugovorne (konstante obrasca).
    stack: [exemptionNote(ctx), ...NOTES].map<Content>((text) => ({
      text,
      fontSize: 8,
    })),
    margin: [0, 12, 0, 0] as Margin,
  },
  signatureBlock(ctx),
];

export default domacaUslugaTemplate;
