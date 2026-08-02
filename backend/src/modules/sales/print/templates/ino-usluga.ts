import type { Column, Content } from "pdfmake/interfaces";
import { exemptionCaseFor, exemptionFor, NEMA_TEXT } from "../../vat-exemption";
import {
  formatAmount,
  formatDateForeign,
  formatDeliveryDate,
  formatInvoiceNumber,
  formatWeightKg,
} from "../format";
import type { InvoiceTemplate, PrintCtx } from "./ctx";

/**
 * IZVUS — ino faktura za USLUGU, višestrana (korak 7 iz STAMPA_FAKTURA_GAP.md §4).
 *
 * Izvor istine: `docs/zahtevi/fakture-obrasci-2026-08/INOUslugaFaktura 060-26.pdf` —
 * pravi papir koji je izašao kupcu, tri strane. Sve što ovde piše doslovno (uključujući
 * `Invoice  No.` sa dva razmaka, `IBAN :` sa razmakom pred dvotačkom i `Ukupna brutto:`
 * malim „b" naspram `Ukupna Netto:` velikim „N") prepisano je sa njega. To NIJE nemar —
 * papir je jedini dokaz koji imamo, pa se lektura radi tek kad je vlasnik naruči.
 *
 * ⚠️ `www.BigBit.rs` iz podnožja originala se NE prepisuje — to je vodeni žig tuđeg
 * programa, ne deo Servotehovog memoranduma.
 *
 * Tri stvari koje nijedan drugi obrazac nema:
 *   1. kolone BEZ `Catalog No.` i BEZ `Stat. goods No.` — usluga nema carinsku tarifu;
 *   2. `Date of delivery:` nosi DATUM I MESTO zajedno (`06-03-26 ,  Beograd`);
 *   3. otpremni blok (paritet / kolete / dimenzije / težine / mesto istovara / špediter),
 *      u kom je kilaža formatirana SRPSKI (`1.720,00 kg`) iako su iznosi na istoj strani
 *      engleski (`10,530.75`) — v. `formatWeightKg` u `../format.ts`.
 *
 * ⚠️ POREZ: usluga se oslobađa po **članu 24. stav 2**, roba po **članu 24. stav 1 tačka 2**.
 * Pogrešan član na izvoznoj fakturi je poreski problem, ne kozmetika — zato tekst od
 * 02.08.2026. NIJE konstanta u ovom fajlu nego dolazi iz `../../vat-exemption.ts`, odakle
 * ga uzima i SEF builder: papir i XML fizički ne mogu da se raziđu.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * VEZIVANJE U SERVIS (obavezno pročitati — ovaj šablon SAM ZA SEBE nije dovoljan)
 * ────────────────────────────────────────────────────────────────────────────────
 * `InvoiceTemplate` po ugovoru (`ctx.ts`) vraća SAMO telo dokumenta, a ovaj obrazac traži
 * da se zaglavlje računa (`Invoice No.`, `Date`, `Customer`, `Address`, `Date of delivery`,
 * `Payment terms`) i zaglavlje tabele PONOVE NA SVAKOJ STRANI — i na poslednjoj, gde je
 * samo blok banke (tako je i na originalu). To telo ne može da izrazi, a `ctx.ts` se ne dira
 * (dele ga sva četiri obrasca). Zato ovaj fajl izvozi JOŠ DVE stvari koje pozivalac mora da
 * uveže sam:
 *
 *   - `inoUslugaPageHeader(ctx)` → sadržaj koji ide ISPOD memorandum-zaglavlja, u pdfmake
 *     `header:` funkciju;
 *   - `INO_USLUGA_PAGE_MARGINS` → margine strane koje ostavljaju mesta za taj (visok) header
 *     i za memorandum-podnožje.
 *
 * Pozivalac tada gradi dokument ovako:
 *
 * ```ts
 * const dd: TDocumentDefinitions = {
 *   pageSize: "A4",
 *   pageMargins: INO_USLUGA_PAGE_MARGINS,
 *   // Zaglavlje strane = memorandum + zaglavlje računa + zaglavlje tabele.
 *   // Leva/desna margina MORA biti ista kao u `pageMargins`, inače se kolone
 *   // zaglavlja tabele razidu sa kolonama tela (obe računaju „*" iz iste širine).
 *   header: () => ({
 *     margin: [32, 20, 32, 0],
 *     stack: [memorandumHeader(issuer, 531), inoUslugaPageHeader(ctx)],
 *   }),
 *   // Podnožje strane nosi „Strana X od Y" — jedini obrazac koji ga traži.
 *   footer: (currentPage, pageCount) => ({
 *     margin: [32, 0, 32, 0],
 *     stack: [
 *       memorandumFooter(issuer, {
 *         qrSvg,
 *         pageText: `Strana ${currentPage} od ${pageCount}`,
 *       }, 531),
 *     ],
 *   }),
 *   content: inoUslugaTemplate(ctx),
 *   styles: { ...MEMORANDUM_STYLES },
 *   defaultStyle: { font: "Roboto", fontSize: 9 },
 * };
 * ```
 *
 * Telo NE traži nijedan registrovan `style` — sve je inline (fontSize/bold/alignment), da
 * vezivanje ne zavisi od toga koje je stilove pozivalac ubacio u `styles`.
 */

/** Širina sadržaja A4 strane pri levoj/desnoj margini 32 pt (595 − 32 − 32). */
const CONTENT_WIDTH = 531;

/**
 * Margine strane za ovaj obrazac.
 *
 * Gornja je NAMERNO velika (~200 pt): u njoj se štampa memorandum-zaglavlje + zaglavlje
 * računa + zaglavlje tabele, i to na SVAKOJ strani. Kad bi bila manja, header bi prešao
 * preko prvog reda stavki — pdfmake ne pomera telo automatski.
 * Donja pokriva partnersku traku, registarski red, APR rečenicu i „Strana X od Y".
 */
export const INO_USLUGA_PAGE_MARGINS: [number, number, number, number] = [
  32, 200, 32, 104,
];

/**
 * Poresko oslobođenje ZA USLUGU STRANOM LICU — tekst dolazi iz `../../vat-exemption.ts`,
 * gde isti podatak uzima i SEF builder. Roba ima DRUGI član (`stav 1 tačka 2`) i drugi
 * slučaj u tom modulu, pa se izmena na jednom obrascu i dalje ne preliva na drugi — samo
 * više nema pet ukucanih primeraka istog podatka koji se međusobno ne slažu
 * (`docs/FAKTURE_ZAKONSKA_USKLADJENOST.md` §3.3, M2). Brojevi članova nisu menjani.
 *
 * ⚠️ Otvoreno: provera je otvorila sumnju da usluga stranom licu možda uopšte NIJE
 * „oslobođenje po članu 24" nego promet čije MESTO nije u Srbiji (§3.2). Odgovor je na
 * knjigovođi; kad stigne, menja se JEDAN tekst u `vat-exemption.ts`, ne ovaj obrazac.
 *
 * `isExport`/`isService` su svojstva SAMOG OBRASCA: obrazac bira vrsta dokumenta
 * (`FORM_BY_DOCUMENT_TYPE` u `invoice-pdf.service.ts`), a ovo je izvozni uslužni papir.
 * `NEMA_TEXT` je nedostižan (izvoz uvek ima osnov) i stoji samo zbog tipa.
 */
function exemptionNote(ctx: PrintCtx): string {
  const basis = exemptionFor(
    exemptionCaseFor({
      isExport: true,
      isService: true,
      vatTotalIsZero: ctx.invoice.vatTotal.isZero(),
    }),
  );
  return basis?.paperText ?? NEMA_TEXT;
}

/** Dva reda ispod napomene, doslovno sa papira (usluga → „Trgovinski sud", ne „Privredni"). */
const COMPLAINT_NOTE = "Reklamacije primamo u roku od 5 dana.";
const COURT_NOTE = "Za sve sporove nadležan je Trgovinski sud u Beogradu.";

/**
 * Kolone stavki — BEZ `Catalog No.` i BEZ `Stat. goods No.`.
 * Usluga nema ni kataloški broj ni carinsku tarifu, pa se te dve kolone ne štampaju
 * prazne nego ih uopšte nema (tako je i na originalu 060/26).
 */
const COLUMN_LABELS = {
  no: "No.",
  description: "Description",
  unit: "Unit",
  quantity: "Quantity",
  price: "Price",
  total: "Total",
} as const;

/**
 * Širine kolona. Novčane dve otpadaju na otpremnici bez cena (`ctx.withoutPrices`), pa
 * širine i zaglavlje moraju da se računaju iz istog mesta — inače bi se zaglavlje strane
 * i telo razišli za tačno te dve kolone.
 */
function columnWidths(withoutPrices: boolean): (string | number)[] {
  const base: (string | number)[] = [20, "*", 32, 52];
  return withoutPrices ? base : [...base, 62, 74];
}

/** Zaglavlje tabele; centrirano nad kolonama, kao na papiru. */
function tableHeadCells(withoutPrices: boolean): Content[] {
  const cells: Content[] = [
    headCell(COLUMN_LABELS.no),
    headCell(COLUMN_LABELS.description),
    headCell(COLUMN_LABELS.unit),
    headCell(COLUMN_LABELS.quantity),
  ];
  if (!withoutPrices)
    cells.push(headCell(COLUMN_LABELS.price), headCell(COLUMN_LABELS.total));
  return cells;
}

function headCell(text: string): Content {
  return { text, fontSize: 9, bold: true, alignment: "center" };
}

/**
 * Zajednički izgled tabele: tanke vodoravne linije, bez vertikala — kao na originalu.
 * Isti objekat koriste i zaglavlje strane i telo, da red zaglavlja i redovi stavki imaju
 * identičnu unutrašnju marginu (inače se kolone optički razidu za par tačaka).
 */
const TABLE_LAYOUT = {
  hLineWidth: (): number => 0.5,
  vLineWidth: (): number => 0,
  hLineColor: (): string => "#000000",
  paddingTop: (): number => 3,
  paddingBottom: (): number => 3,
  paddingLeft: (): number => 3,
  paddingRight: (): number => 3,
};

/**
 * Količina se na 060/26 štampa BEZ suvišnih nula (`40.8`, `1`, `2` — ne `40.800`).
 * Iznosi zadržavaju obe decimale (`590.00`, `30.10`), pa se ovo ne može svesti na
 * `formatAmount(x, 2)`. Rezanje je čisto prikazno: računa se i dalje nad `Decimal`-om,
 * a separator hiljada je zarez pa ga rez decimala ne može dohvatiti.
 */
function formatQuantity(value: Parameters<typeof formatAmount>[0]): string {
  const s = formatAmount(value, 3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Spaja neprazne delove; prazno polje ne sme da ostavi visoki separator. */
function join(parts: (string | null | undefined)[], sep: string): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(sep);
}

/** Slobodan višered iz baze (`unloadingPlace`, `forwarderContact`) → redovi za štampu. */
function splitLines(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !!l);
}

// ─────────────────────────────────────────────────────── zaglavlje strane (ponavlja se)

/**
 * Zaglavlje računa + zaglavlje tabele — deo koji se PONAVLJA NA SVAKOJ STRANI.
 *
 * Ne uključuje memorandum: memorandum je zajednički za sva četiri obrasca i pozivalac ga
 * već ima (`memorandumHeader`). Ovde je samo ono što je specifično za IZVUS.
 *
 * Zaglavlje TABELE je namerno ovde a ne u telu: na originalu se ono štampa i na trećoj
 * strani, gde ispod njega nema nijedne stavke nego blok banke. Da je vezano za tabelu
 * (`headerRows: 1`), na toj strani ga ne bi bilo.
 */
export function inoUslugaPageHeader(ctx: PrintCtx): Content {
  const { invoice, customer, issuer } = ctx;

  /**
   * Red „labela desno poravnata / vrednost" — kao na papiru (sve labele se završavaju u istoj
   * koloni, vrednosti počinju u istoj). `trailing` popunjava desnu ivicu istog reda; koristi ga
   * samo prvi red, jer je na originalu `Invoice  No.` u istoj liniji sa `Date:`.
   */
  const row = (label: string, value: string, trailing?: Column): Content => ({
    columns: [
      { width: 104, text: label, fontSize: 9, alignment: "right" },
      // 250 pt je taman da adresa kupca sa 060/26 stane u JEDAN red, kao na papiru.
      { width: 250, text: value, fontSize: 9 },
      trailing ?? { width: "*", text: "" },
    ],
    columnGap: 6,
    margin: [0, 0, 0, 2],
  });

  // Adresa kupca na 060/26: „ulica - mesto,država poštanskiBroj". Redosled je čudan, ali je
  // doslovno sa papira; prazni delovi se preskaču da ne ostane „ - ," bez sadržaja.
  const customerAddress = customer
    ? join(
        [
          customer.address,
          join(
            [join([customer.city, customer.country], ","), customer.postalCode],
            " ",
          ),
        ],
        " - ",
      )
    : "";

  // `Date of delivery:` nosi datum I mesto izdavanja u istom redu — jedini obrazac koji tako radi.
  // Razmaci oko zareza (` ,  `) su sa papira.
  const deliveryPlace = issuer.invoiceIssuingPlace?.trim() ?? "";
  const deliveryValue = join(
    [formatDeliveryDate(invoice.supplyDate), deliveryPlace],
    " ,  ",
  );

  // „Invoice  No." ima DVA razmaka na originalu — prepisuje se doslovno (v. uvod fajla).
  // Sam broj prolazi kroz `formatInvoiceNumber` da svih pet obrazaca ima jedno mesto
  // kroz koje se prikaz broja menja (odluka O-F1).
  const invoiceNo: Column = {
    width: "*",
    text: `Invoice  No. ${formatInvoiceNumber(invoice.documentNumber)}`,
    fontSize: 11,
    bold: true,
    alignment: "right",
  };

  return {
    // Odmak od memorandum-zaglavlja koje pozivalac slaže iznad ovog bloka.
    margin: [0, 10, 0, 0],
    stack: [
      row("Date:", formatDateForeign(invoice.documentDate), invoiceNo),
      row("Customer:", customer?.name ?? ""),
      row("Address:", customerAddress),
      row("Date of delivery:", deliveryValue),
      // `Payment terms:` je na ovom obrascu DATUM (valuta plaćanja), ne način plaćanja
      // (GAP §2.5). Kad valute nema, red ostaje prazan umesto da se podmetne datum računa.
      row("Payment terms:", formatDateForeign(invoice.dueDate)),
      {
        margin: [0, 8, 0, 0],
        table: {
          widths: columnWidths(ctx.withoutPrices),
          body: [tableHeadCells(ctx.withoutPrices)],
        },
        layout: TABLE_LAYOUT,
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────────────────── telo

/**
 * Telo dokumenta. Zaglavlje strane NIJE ovde (v. `inoUslugaPageHeader`), jer se ponavlja.
 *
 * Prelom po stranama prati original 060/26:
 *   strana 1 — stavke
 *   strana 2 — zbir + napomene + otpremni blok  (`pageBreak: "before"`)
 *   strana 3 — blok banke                       (`pageBreak: "before"`)
 *
 * ZAŠTO PRELOM I PRE ZBIRA, a ne samo pre banke: na originalu se šest stavki završava na
 * sredini prve strane, a zbir ipak počinje drugu — dakle BigBit taj blok tera na novu stranu,
 * nije ga tamo gurnuo nedostatak mesta. Bez tog preloma bi 060/26 dao DVE strane, a provera
 * koraka 7 (GAP §4) izričito traži TRI. Kad stavki ima više nego što stane, prelom i dalje
 * radi ispravno — zbir prosto počinje stranu posle poslednje strane sa stavkama.
 */
export const inoUslugaTemplate: InvoiceTemplate = (
  ctx: PrintCtx,
): Content[] => {
  const content: Content[] = [itemsTable(ctx)];

  const summary: Content[] = [];
  // Otpremnica bez cena nema šta da sabere — zbir se izostavlja, ostatak strane ostaje isti.
  if (!ctx.withoutPrices) summary.push(totalsBlock(ctx));
  summary.push(notesBlock(ctx));
  const shipping = shippingBlock(ctx);
  if (shipping) summary.push(shipping);

  content.push({ stack: summary, pageBreak: "before" });
  content.push({ stack: bankBlock(ctx), pageBreak: "before" });
  return content;
};

/**
 * Stavke — BEZ reda zaglavlja: on je u zaglavlju strane, da bi se ponovio i tamo gde tabele
 * nema (v. `inoUslugaPageHeader`). Širine su iz istog `columnWidths`, pa se kolone poklapaju.
 */
function itemsTable(ctx: PrintCtx): Content {
  const widths = columnWidths(ctx.withoutPrices);

  if (!ctx.lines.length) {
    // Prazan račun ne sme da obori štampu: tabela bez ijednog reda je pdfmake greška.
    return { text: "", margin: [0, 0, 0, 0] };
  }

  const body: Content[][] = ctx.lines.map((line) => {
    const cells: Content[] = [
      { text: String(line.ordinal), fontSize: 9, alignment: "center" },
      { text: line.name, fontSize: 9 },
      { text: line.unit ?? "", fontSize: 9 },
      { text: formatQuantity(line.quantity), fontSize: 9, alignment: "right" },
    ];
    if (!ctx.withoutPrices)
      cells.push(
        {
          text: formatAmount(line.unitPrice, 2),
          fontSize: 9,
          alignment: "right",
        },
        {
          text: formatAmount(line.lineTotal, 2),
          fontSize: 9,
          alignment: "right",
        },
      );
    return cells;
  });

  return { table: { widths, body }, layout: TABLE_LAYOUT };
}

/**
 * Zbir: `TOTAL` pa uokvireno `TOTAL AMOUNT ( EUR)` — oba desno.
 *
 * Za razliku od ino ROBE, ovaj obrazac NEMA red `DISCOUNT` (na 060/26 ga nema ni sa nulom),
 * pa se ne štampa. Valuta je u zagradi sa razmakom (`( EUR)`) — doslovno sa papira.
 *
 * Vrednosti se uzimaju sa dokumenta (`netTotal`/`grossTotal`), ne sabiranjem stavki:
 * papir mora da pokaže isti iznos koji je proknjižen.
 */
function totalsBlock(ctx: PrintCtx): Content {
  const labelWidth = 150;
  const valueWidth = 84;
  const money = (value: Parameters<typeof formatAmount>[0], bold = false) => ({
    text: formatAmount(value, 2),
    fontSize: 9,
    bold,
    alignment: "right" as const,
  });

  return {
    margin: [0, 0, 0, 14],
    columns: [
      { width: "*", text: "" },
      {
        width: "auto",
        stack: [
          {
            table: {
              widths: [labelWidth, valueWidth],
              body: [
                [
                  {
                    text: "TOTAL",
                    fontSize: 9,
                    bold: true,
                    alignment: "right",
                  },
                  money(ctx.invoice.netTotal),
                ],
              ],
            },
            layout: "noBorders",
          },
          {
            margin: [0, 4, 0, 0],
            table: {
              widths: [labelWidth, valueWidth],
              body: [
                [
                  {
                    text: `TOTAL AMOUNT ( ${ctx.currency})`,
                    fontSize: 9,
                    bold: true,
                    alignment: "right",
                  },
                  money(ctx.invoice.grossTotal, true),
                ],
              ],
            },
            // Jedini uokvireni blok na obrascu — „za uplatu" mora da se vidi iz aviona.
            layout: {
              hLineWidth: () => 0.8,
              vLineWidth: () => 0.8,
              hLineColor: () => "#000000",
              vLineColor: () => "#000000",
            },
          },
        ],
      },
    ],
  };
}

/** Napomena o oslobođenju + reklamacije + nadležni sud (tri reda, kao na papiru). */
function notesBlock(ctx: PrintCtx): Content {
  return {
    margin: [0, 0, 0, 12],
    stack: [
      { text: exemptionNote(ctx), fontSize: 9, margin: [0, 0, 0, 6] },
      { text: COMPLAINT_NOTE, fontSize: 9 },
      { text: COURT_NOTE, fontSize: 9 },
    ],
  };
}

/**
 * Otpremni blok — postoji SAMO na ovom obrascu.
 *
 * Kilaža ide kroz `formatWeightKg`, dakle `1.720,00 kg`: tačka za hiljade, zarez za decimale —
 * TAČNO OBRNUTO od iznosa na istoj strani (`10,530.75`). Nije previd, tako je na papiru.
 *
 * Svaki red se izostavlja kad podatak ne postoji: zatečeni računi nemaju nijedno od ovih polja
 * (dodata su tek uz štampu), a prazna labela na dokumentu koji ide kupcu izgleda kao greška.
 * Kad nema baš ničega, blok se ne štampa uopšte (`null`).
 */
function shippingBlock(ctx: PrintCtx): Content | null {
  const inv = ctx.invoice;
  const lines: Content[] = [];

  const labeled = (label: string, value: string | null | undefined) => {
    const v = value?.trim();
    if (v) lines.push({ text: `${label} ${v}`, fontSize: 9 });
  };

  labeled("Paritet:", inv.deliveryTerm);
  labeled("Količina:", inv.packageDescription);
  labeled("Dimenzije:", inv.packageDimensions);
  // „brutto" malim, „Netto" velikim slovom — doslovno sa 060/26.
  if (inv.grossWeightKg != null)
    lines.push({
      text: `Ukupna brutto: ${formatWeightKg(inv.grossWeightKg)}`,
      fontSize: 9,
    });
  if (inv.netWeightKg != null)
    lines.push({
      text: `Ukupna Netto: ${formatWeightKg(inv.netWeightKg)}`,
      fontSize: 9,
    });

  // Višeredna polja: labela u svom redu, pa slobodan tekst iz baze red po red.
  const unloading = splitLines(inv.unloadingPlace);
  if (unloading.length) {
    lines.push({ text: "Mesto istovara:", fontSize: 9, margin: [0, 4, 0, 0] });
    for (const l of unloading) lines.push({ text: l, fontSize: 9 });
  }
  const forwarder = splitLines(inv.forwarderContact);
  if (forwarder.length) {
    lines.push({
      text: "Kontakt špeditera u uvozu:",
      fontSize: 9,
      margin: [0, 4, 0, 0],
    });
    for (const l of forwarder) lines.push({ text: l, fontSize: 9 });
  }

  return lines.length ? { stack: lines } : null;
}

/**
 * Blok banke — zasebna, poslednja strana (`pageBreak` postavlja `inoUslugaTemplate`).
 *
 * Dve kolone: levo primalac (IBAN + naša firma), desno banka (SWIFT + naziv + adresa).
 * `IBAN :` ima razmak pred dvotačkom — doslovno sa papira. Ništa se ne prepisuje u kod:
 * kad devizni račun nije unet, red se izostavi (bolje prazno nego pogrešan IBAN).
 */
function bankBlock(ctx: PrintCtx): Content[] {
  const { issuer } = ctx;

  const left: Content[] = [
    { text: "Beneficiary Customer:", fontSize: 9, bold: true },
  ];
  if (issuer.iban?.trim())
    left.push({
      text: `IBAN : ${issuer.iban.trim()}`,
      fontSize: 9,
      margin: [0, 4, 0, 0],
    });
  left.push({ text: issuer.companyName, fontSize: 9, margin: [0, 4, 0, 0] });
  const issuerAddress = join([issuer.address, issuer.city], ", ");
  if (issuerAddress) left.push({ text: issuerAddress, fontSize: 9 });

  const right: Content[] = [
    { text: "Bank of beneficiary:", fontSize: 9, bold: true },
  ];
  if (issuer.swift?.trim())
    right.push({
      text: `SWIFT: ${issuer.swift.trim()}`,
      fontSize: 9,
      margin: [0, 4, 0, 0],
    });
  if (issuer.bankName?.trim())
    right.push({
      text: issuer.bankName.trim(),
      fontSize: 9,
      margin: [0, 4, 0, 0],
    });
  for (const l of splitLines(issuer.bankAddress))
    right.push({ text: l, fontSize: 9 });

  // Leva kolona je uža od pola strane — na originalu blok banke počinje na ~43 % širine.
  return [
    {
      columns: [
        { width: Math.round(CONTENT_WIDTH * 0.42), stack: left },
        { width: "*", stack: right },
      ],
      columnGap: 12,
    },
  ];
}
