import type { Content } from "pdfmake/interfaces";
import type { Prisma } from "@prisma/client";

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

export type InvoiceWithItems = Prisma.InvoiceGetPayload<{
  include: { items: true };
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
  companyName: string;
  address: string | null;
  city: string | null;
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
  discountPercent: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Poreska stopa u procentima (20), za kolonu „PDV". `null` = ino. */
  vatRatePercent: number | null;
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
  /** Broj odbijenog avansnog računa, kad ga ima. */
  advanceInvoiceNumber: string | null;
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
