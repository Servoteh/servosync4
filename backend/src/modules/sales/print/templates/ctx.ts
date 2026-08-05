import type { Content } from "pdfmake/interfaces";
import type { Prisma } from "@prisma/client";
import type { VatExemptionBasisRef } from "../../vat-exemption-basis";

/**
 * ZAJEDNIČKI UGOVOR ZA ČETIRI OBRASCA IZLAZNE FAKTURE (01.08.2026).
 *
 * Pet donetih BigBit papira (v. `docs/STAMPA_IZLAZNIH_FAKTURA.md`) svode se na
 * ČETIRI šablona, jer se IFR i IFGP razlikuju samo po imenu magacina:
 *
 *   domaca-roba.ts    IFR + IFGP   — traka uslova, Kat. br., četiri potpisa
 *   domaca-usluga.ts  IFUSL        — bez Kat. br., Trgovinski sud, jedan potpis
 *   ino-roba.ts       IZVRO/IZVGP  — engleski, EUR, Stat. goods No., blok banke
 *   ino-usluga.ts     IZVUS        — engleski, višestran, otpremni blok
 *
 * Svaki šablon je ZASEBAN FAJL sa istim potpisom (`InvoiceTemplate`), da bi četiri
 * obrasca mogla da se pišu i menjaju nezavisno. Zajedničko im je samo ovo:
 * ulazni podaci (`PrintCtx`) i memorandum (zaglavlje/podnožje strane).
 *
 * ⚠️ Šablon NE SME sam da čita bazu. Sve što mu treba stiže kroz `PrintCtx` —
 * tako se štampa može testirati bez baze, a jedno učitavanje opslužuje sve.
 */

/**
 * ⚠️ ŠIFARNIK VRSTE USLUGE JE DEO OVOG TIPA (05.08.2026), a ne opcion dodatak.
 *
 * `vatSummaryRows` (`templates/totals.ts`) predaje ceo ovaj objekat u
 * `documentVatBreakdown`, koji iz njega izvodi PORESKI TRETMAN. Da relacija nije u
 * tipu, račun za otpad bi se odštampao sa 20 % PDV-a (jer bi tretman ispao `TAXED`)
 * iako zaglavlje i glavna knjiga nose nulu — papir bi tvrdio porez koji nije proknjižen
 * i koji kupac po zakonu obračunava sam. Zato je uključena u `include`, pa je svaki
 * pozivalac koji je izostavi obara na prevođenju.
 */
export type InvoiceWithItems = Prisma.InvoiceGetPayload<{
  include: { items: true; serviceRevenueType: true; vatExemptionBasis: true };
}>;

/** Kupac, već razrešen (šablon ne radi JOIN). */
export interface PrintCustomer {
  name: string;
  address: string | null;
  city: string | null;
  postalCode: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  country: string | null;
}

/** Firma izdavalac — isti oblik koji memorandum očekuje. */
export interface PrintIssuer {
  /**
   * Naziv iz `companies.company_name` i NIŠTA VIŠE (odluka O-F9): ni grad zalepljen uz
   * ime, ni verzija velikim slovima. Kome uz ime treba i mesto — memorandumu — spaja ga
   * sam iz `city`; obrasci naziv štampaju doslovno.
   */
  companyName: string;
  address: string | null;
  city: string | null;
  /** Poštanski broj sedišta (odluka O-F10) — memorandum ga štampa, potpisni blok ne. */
  postalCode: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  bankAccount: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  webAddress: string | null;
  invoiceIssuingPlace: string | null;
  registryNumber: string | null;
  businessActivityCode: string | null;
  aprText: string | null;
  /** Devizni račun — samo ino obrasci; domaći nose `bankAccount` u zaglavlju. */
  iban: string | null;
  swift: string | null;
  bankName: string | null;
  bankAddress: string | null;
}

/**
 * „Odgovorno lice" u dnu računa (odluka O-F2: komercijalista SA RAČUNA).
 * Broj lične karte se namerno NE prenosi — odluka O-F3.
 */
export interface PrintSignatory {
  name: string;
}

/** Podaci stavke koje šablon prikazuje; brojevi ostaju `Decimal` do formatiranja. */
export interface PrintLine {
  ordinal: number;
  /** Kataloški broj — domaća roba i ino roba; usluga ga nema. */
  catalogNumber: string | null;
  name: string;
  /** Jedinica mere: sa stavke, pa sa artikla ako stavka nema svoju. */
  unit: string | null;
  /** Carinska tarifa = `Stat. goods No.` na ino robi. */
  customsTariff: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  /**
   * Cena PRE rabata po jedinici, na ISTOJ razmeri kao `unitPrice` (dakle već pomnožena
   * koeficijentom dokumenta). Iz nje se dobija bruto: `količina × ova cena`.
   *
   * `null` = stavka je starija od kolone `invoice_items.unit_price_before_discount` ili
   * dolazi iz uvoza; tada `totals.ts` rabat vraća unazad iz neto iznosa. Polje je NAMERNO
   * obavezno (a ne opciono) iako sme da bude `null`: štampa je i nastala kao kvar zato što
   * je jedan podatak tiho izostao iz učitavanja, pa svako novo mesto koje pravi `PrintLine`
   * mora da se izjasni šta sa punom cenom.
   */
  unitPriceBeforeDiscount: Prisma.Decimal | null;
  discountPercent: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Poreska stopa u procentima (20), za kolonu „PDV". `null` = ino. */
  vatRatePercent: number | null;
}

/**
 * JEDNA PRIMENA ODBIJENOG AVANSA — broj avansnog računa i BRUTO iznos BAŠ TE primene.
 *
 * ⚠️ ZAŠTO LISTA, A NE JEDAN BROJ (ispravka 02.08.2026): veza avans↔račun je N:M od
 * migracije `20260726120000` (`invoice_advance_applications`) — jedan račun sme da
 * zatvara više avansa. Do ove izmene je `PrintCtx` nosio SAMO `advanceInvoiceNumber`
 * (broj iz kolone `invoice.advance_invoice_id`, koja se upisuje jedino pri PRVOJ
 * primeni — `advance-invoice.service.ts`, `isFirstApplication`), a uz njega se štampao
 * `invoice.advanceAppliedAmount` = ZBIR SVIH primena.
 *
 * IZMEREN SCENARIO: račun na 10.000,00 zatvara `A-1/26` (3.000,00) i `A-2/26` (2.000,00).
 * Papir je izlazio kao `Umanjenje za primljeni avans (br. A-1/26): − 5,000.00` — jedan
 * broj uz tuđ zbir, dakle poreski dokument koji tvrdi da je po avansnom računu A-1/26
 * odbijeno 5.000,00, iako je taj račun glasio na 3.000,00. Opšti renderer (AVR/KO/KZ)
 * je istu grešku već ispravio (`loadAdvanceDeductions`, „revizija, VISOK") — četiri
 * obrasca su je zaobišla samo zato što `PrintCtx` listu nije prenosio.
 */
export interface PrintAdvanceDeduction {
  /** Broj avansnog računa; `null` kad je AVR u međuvremenu obrisan (meki ref). */
  documentNumber: string | null;
  /** Iznos BAŠ TE primene (bruto) — nikad zbir svih. */
  amount: Prisma.Decimal;
}

/** Sve što šablon sme da zna. Ništa se ne dohvata iz baze unutar šablona. */
export interface PrintCtx {
  invoice: InvoiceWithItems;
  lines: PrintLine[];
  customer: PrintCustomer | null;
  issuer: PrintIssuer;
  signatory: PrintSignatory | null;
  /** Naziv magacina za blok „Robu izdao" — samo roba; usluga je bez magacina. */
  warehouseName: string | null;
  /** Valuta dokumenta (`RSD`, `EUR`…). */
  currency: string;
  /**
   * Odbijeni avansi — JEDAN unos PO PRIMENI, redom nastanka. Prazno = avansa nema.
   *
   * Obrasci iz ove liste izvode i redove umanjenja i ukupan odbijeni iznos
   * (`totals.ts` → `advanceTotal`) — NE iz kolone `invoice.advanceAppliedAmount`.
   * Listu puni `InvoicePdfService.loadAdvanceDeductions`, a ona samo prevodi rezultat
   * JEDINOG pravila u sistemu — `sales/advance-deduction.ts` (UNIJA aktivnih primena i
   * zatečene 1:1 veze koja nema svoj red u spojnoj tabeli).
   *
   * Isto pravilo od 02.08.2026. čitaju i ekran detalja (`fakturisanje.service.ts`,
   * `getInvoice`), e-faktura (`sef/sef.service.ts`), primena avansa
   * (`advance-invoice.service.ts`) i lista avansa (`pdv/advance-vat.service.ts`) —
   * papir i ekran za isti račun više ne mogu da kažu različit iznos. Da se ne raziđu
   * ćutke, `sales/advance-deduction.spec.ts` pita svih pet nad istim scenarijem.
   */
  advanceDeductions: PrintAdvanceDeduction[];
  /**
   * NAPOMENA SA IZABRANE VRSTE USLUGE (`service_revenue_types.paper_note`) — doslovno
   * kako je knjigovođa upisao. `null` = vrsta nije izabrana, nije uslužan dokument, ili
   * vrsta napomenu nema (`USL`, `ZAKUP`); obrazac tada pada na zatečeni tekst iz
   * `sales/vat-exemption.ts`.
   *
   * ⚠️ OVO JE PODATAK O RAČUNU, NE KONSTANTA OBRASCA. Kod otpada je to jedina rečenica
   * iz koje kupac vidi da PDV mora da obračuna SAM (poreski dužnik je primalac,
   * čl. 10 st. 2 t. 1) — bez nje bi papir izgledao kao promet oslobođen PDV-a, što je
   * druga pravna tvrdnja. Zato ga nose i domaći i ino uslužni obrazac.
   */
  serviceRevenueNote: string | null;
  /**
   * OSNOV PORESKOG OSLOBOĐENJA IZABRAN NA DOKUMENTU (`invoices.vat_exemption_basis_id`).
   * `null` = nije izabran, pa obrazac pada na napomenu vrste usluge odn. na zatečeno
   * izvođenje iz `sales/vat-exemption.ts`.
   *
   * ⚠️ PREDAJE SE CEO RED, A NE GOTOV TEKST, I TO JE SUŠTINA POPRAVKE. Papir uzima
   * `paperText`, a e-faktura `sefCode`/`sefReason` — SA ISTOG REDA, kroz isti
   * `resolveExemption`. Dok su tekst i šifra dolazili iz dva izvora, izvoz robe je na
   * papiru citirao čl. 24 st. 1 t. 2 a na SEF-u slao `PDV-RS-24-1-5`: dva pravna osnova
   * za isti posao istom kupcu. Sa jednim redom to više nije moguće.
   */
  vatExemptionBasis: VatExemptionBasisRef | null;
  /**
   * Otpremnica bez cena. Kolone sa novcem se izostavljaju, a zbir se ne štampa.
   * (Obrazac za ovo nije donet — v. GAP §5 t.11 — pa se zasad štampa isti
   * šablon bez novčanih kolona.)
   */
  withoutPrices: boolean;
}

/**
 * Šablon vraća SAMO telo dokumenta — sve između memorandum-zaglavlja i
 * memorandum-podnožja. Zaglavlje/podnožje i prelom po stranama dodaje pozivalac,
 * da bi svaki obrazac imao identičan memorandum bez prepisivanja.
 */
export type InvoiceTemplate = (ctx: PrintCtx) => Content[];
