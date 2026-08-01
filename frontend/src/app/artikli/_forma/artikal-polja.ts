import type { ItemDetail } from '@/api/masters';
import type { NepokrivenoPolje } from './polja';
import {
  formatirajBroj,
  proveriBroj,
  proveriKataloskiBroj,
  proveriObavezno,
  type SekcijaDef,
} from './pravila';

/**
 * ARTIKAL — raspored polja za pun ekran unosa/izmene.
 *
 * Redosled prati BigBit formu „Unos artikala“ i karticu artikla, tj. ono što operater
 * VIDI i štampa, a ne redosled kolona u bazi (izričit zahtev):
 *   Identitet → Klasifikacija → Cene → PDV/carina → Dimenzije → Opisi → Ostalo.
 * Izvor polja: `backend/docs/migration/BIGBIT_ARTIKLI.md` §1 (67 kolona) i §4.8–4.10.
 */

function tekst(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

function broj(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? formatirajBroj(n, 6) : String(v);
}

function daNe(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  return v ? 'da' : 'ne';
}

/** Polje sa nenegativnim brojem (BigBit CHECK-ovi: Kutija ≥ 0, Tezina ≥ 0, MPKaloProc ≥ 0). */
const nenegativan = (v: string) => proveriBroj(v, { min: 0 });
/** Procenat 0–100. */
const procenat = (v: string) => proveriBroj(v, { min: 0, max: 100 });

export const SEKCIJE_ARTIKAL: SekcijaDef[] = [
  {
    naslov: 'Identitet',
    opis:
      'BigBit auto-dodeljuje kataloški broj (najveći numerički + 1, 5 cifara sa nulama) i blokira snimanje duplikata.',
    polja: [
      {
        id: 'catalogNumber',
        labela: 'Kataloški broj',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 20,
        proveri: proveriKataloskiBroj,
        napomena: 'Jedinstven — duplikat obara snimanje (BigBit forma i DB brana guard_catalog_unique).',
      },
      { id: 'name', labela: 'Naziv', tip: 'tekst', obavezno: true, maxDuzina: 50, raspon: 2, proveri: (v) => proveriObavezno(v, 'Naziv') },
      { id: 'barCode', labela: 'Barkod', tip: 'tekst', maxDuzina: 20, napomena: 'Primarni barkod. Barkod kutije/ambalaže traži tabelu R_Artikli_BarKod (gap).' },
      { id: 'externalCode', labela: 'Eksterna šifra', tip: 'tekst', maxDuzina: 20 },
      { id: 'unit', labela: 'Jedinica mere', tip: 'tekst', maxDuzina: 5 },
      { id: 'baseUnit', labela: 'Osnovna JM', tip: 'tekst', maxDuzina: 5 },
      { id: 'packaging', labela: 'Pakovanje', tip: 'tekst', maxDuzina: 10 },
      { id: 'quantityInPackage', labela: 'Količina u pakovanju', tip: 'broj', proveri: nenegativan },
      {
        id: 'plu',
        labela: 'PLU',
        tip: 'broj',
        zakljucano: 'BigBit sam dodeljuje sledeći slobodan PLU pri snimanju (SledeciPLU) — ručni unos bi napravio duplikat.',
      },
    ],
  },
  {
    naslov: 'Klasifikacija',
    opis:
      'U BigBitu su ovo kaskadni šifarnici (Grupa → Podgrupa → Poreklo). Ovde su tekstualne šifre jer item_groups / item_subgroups / item_origins u 4.0 stoje PRAZNI (nema sync-a) — bez njih nema padajuće liste.',
    polja: [
      { id: 'groupCode', labela: 'Grupa (šifra)', tip: 'tekst', obavezno: true, maxDuzina: 10, proveri: (v) => proveriObavezno(v, 'Grupa') },
      { id: 'subgroupCode', labela: 'Podgrupa (šifra)', tip: 'tekst', obavezno: true, maxDuzina: 10, proveri: (v) => proveriObavezno(v, 'Podgrupa') },
      { id: 'originCode', labela: 'Poreklo (šifra)', tip: 'tekst', obavezno: true, maxDuzina: 5, proveri: (v) => proveriObavezno(v, 'Poreklo') },
      {
        id: 'hps',
        labela: 'Tip (HPS)',
        tip: 'izbor',
        opcije: [
          { value: 'H', label: 'H' },
          { value: 'P', label: 'P' },
          { value: 'S', label: 'S' },
          { value: 'O', label: 'O' },
        ],
        napomena: 'BigBit CHECK dozvoljava samo H, P, S ili O.',
      },
      { id: 'sortOrder', labela: 'Redosled prikaza', tip: 'broj', proveri: nenegativan },
    ],
  },
  {
    naslov: 'Cene, marže i rabati',
    opis:
      'Cene su zaključane dok se ne otključaju klikom (BigBit: dupli klik na polje) — da se cena ne prekuca slučajno.',
    polja: [
      { id: 'wholesalePrice', labela: 'VP cena', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'retailPrice', labela: 'MP cena', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'fxPurchasePrice', labela: 'Devizna nabavna', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'fxSalePrice', labela: 'Devizna prodajna', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'priceToWritePricelist', labela: 'Cena za upis u cenovnik', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'manualMarkupPercent', labela: 'Ručna marža (%)', tip: 'broj', proveri: procenat },
      {
        id: 'maxDiscountPercent',
        labela: 'Maks. rabat (%)',
        tip: 'broj',
        proveri: procenat,
        napomena: 'Gornja granica rabata na dokumentima; preko nje se rabat na stavci svodi uz poruku.',
      },
      { id: 'promotionDiscount', labela: 'Akcijski rabat (%)', tip: 'broj', proveri: procenat },
      { id: 'finalProcessingCost', labela: 'Zavisni trošak proizvodnje', tip: 'broj', proveri: nenegativan },
      { id: 'wholesaleLossPercent', labela: 'Kalo VP (%)', tip: 'broj', proveri: procenat },
      { id: 'retailLossPercent', labela: 'Kalo MP (%)', tip: 'broj', proveri: procenat },
      { id: 'minQuantity', labela: 'Minimalna količina', tip: 'broj', proveri: nenegativan },
      { id: 'paymentTermDays', labela: 'Valuta plaćanja (dana)', tip: 'broj', proveri: (v) => proveriBroj(v, { min: 0, max: 365 }) },
    ],
  },
  {
    naslov: 'PDV i carina',
    polja: [
      { id: 'goodsTaxRateCode', labela: 'Tarifa robe', tip: 'tekst', obavezno: true, maxDuzina: 5, proveri: (v) => proveriObavezno(v, 'Tarifa robe') },
      { id: 'serviceTaxRateCode', labela: 'Tarifa usluga', tip: 'tekst', obavezno: true, maxDuzina: 5, proveri: (v) => proveriObavezno(v, 'Tarifa usluga') },
      { id: 'alwaysTaxGoods', labela: 'Uvek porez na robu', tip: 'da-ne' },
      { id: 'alwaysTaxServices', labela: 'Uvek porez na usluge', tip: 'da-ne' },
      { id: 'nonTaxablePart', labela: 'Neoporezivi deo', tip: 'broj', proveri: nenegativan },
      { id: 'itemFee', labela: 'Taksa', tip: 'broj', proveri: nenegativan },
      { id: 'itemExcise', labela: 'Akciza', tip: 'broj', proveri: nenegativan },
      { id: 'customsRate', labela: 'Carinska stopa (%)', tip: 'broj', proveri: procenat },
      { id: 'customsTariff', labela: 'Carinska tarifa', tip: 'tekst', maxDuzina: 20 },
      { id: 'originCountry', labela: 'Zemlja porekla', tip: 'tekst', maxDuzina: 20 },
      { id: 'accountingCode', labela: 'Konto (GK)', tip: 'tekst', maxDuzina: 10 },
      {
        id: 'accountingCode2',
        labela: 'Konto 2 / zamenska šifra',
        tip: 'tekst',
        maxDuzina: 10,
        napomena: 'U BigBitu se koristi i kao „zamenska šifra“ (stari artikal pokazuje na novi).',
      },
    ],
  },
  {
    naslov: 'Dimenzije i pakovanje',
    opis: 'Kod Servoteha su ovo dimenzije lima/ploče; BigBit iz njih računa kg po komadu (debljina × raster × 7850).',
    polja: [
      { id: 'box', labela: 'Kutija', tip: 'broj', proveri: nenegativan },
      { id: 'transportPackaging', labela: 'Transportno pakovanje', tip: 'broj', proveri: nenegativan },
      { id: 'weight', labela: 'Težina', tip: 'broj', proveri: nenegativan },
      { id: 'weightKg', labela: 'Težina (kg)', tip: 'broj', proveri: nenegativan },
      { id: 'volume', labela: 'Zapremina', tip: 'broj', proveri: nenegativan },
      { id: 'area', labela: 'Površina', tip: 'broj', proveri: nenegativan },
      { id: 'thickness', labela: 'Debljina', tip: 'broj', proveri: nenegativan },
    ],
  },
  {
    naslov: 'Opisi i prevodi',
    polja: [
      { id: 'itemDescription', labela: 'Opis artikla', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      { id: 'foreignName', labela: 'INO naziv', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      { id: 'foreignUnit', labela: 'INO jedinica mere', tip: 'tekst', maxDuzina: 5 },
      { id: 'webDescription', labela: 'Web opis', tip: 'memo', maxDuzina: 255, raspon: 4 },
      { id: 'memo', labela: 'Memo (interna napomena)', tip: 'memo', maxDuzina: 255, raspon: 2 },
      { id: 'note2', labela: 'Napomena 2', tip: 'memo', maxDuzina: 255, raspon: 2 },
    ],
  },
  {
    naslov: 'Ostalo',
    polja: [
      { id: 'manufacturer', labela: 'Proizvođač', tip: 'tekst', maxDuzina: 50 },
      { id: 'shelf', labela: 'Polica', tip: 'tekst', maxDuzina: 10, napomena: 'QBigTehn kopija je suzila polje na 10 znakova — duže se seče.' },
      { id: 'notStockTracked', labela: 'Ne vodi zalihe', tip: 'da-ne' },
      { id: 'active', labela: 'Aktivan', tip: 'da-ne' },
      { id: 'toDelete', labela: 'Za brisanje', tip: 'da-ne', napomena: 'BigBit meko brisanje — slog ostaje, samo se označi.' },
    ],
  },
];

/** BigBit polja koja ovaj ekran svesno ne nudi — sa razlogom, da se ne traže uzalud. */
export const NEPOKRIVENO_ARTIKAL: NepokrivenoPolje[] = [
  { labela: 'Šifra (items.id)', razlog: 'Dodeljuje baza. Sekvenca items_id_seq nije klampovana iznad BigBit prostora — v. uslove brane.' },
  { labela: 'BigBit šifra (external_item_id)', razlog: 'Marker porekla — upisuje ga isključivo sync, ekran ga ne sme dirati.' },
  { labela: 'Dobavljač (SifDob)', razlog: 'Traži birač komitenata; uz to BigBit ima 1:N DobavljaciZaArtikal (više dobavljača + rok isporuke) koji u 4.0 ne postoji.' },
  { labela: 'Raster (IDRaster) + „Preračunaj težinu u komadu“', razlog: 'RasterDef* tabele nisu sinkovane, pa nema odakle da se uzmu dimenzije ploče za obračun kg/komadu.' },
  { labela: 'Kvalitet artikla (IDKvalitetArtikla)', razlog: 'R_KvalitetArtikla ne postoji ni kao model ni u QBigTehn kopiji — mora direktno iz BigBita.' },
  { labela: 'Mesto izdavanja (IDMestoIzdavanja)', razlog: 'Šifarnik MestaIzdavanja nije sinkovan.' },
  { labela: 'Slika simbola / PDF / Word (linkovi)', razlog: 'BigBit ih puni Windows FileDialog-om kao apsolutne putanje na share; web forma to ne može, a dostupnost share-a sa 4.0 stacka nije potvrđena.' },
  { labela: 'Dodatne slike (ArtikliSlike, 1:N)', razlog: 'Galerija po artiklu nije modelovana u 4.0.' },
  { labela: 'Više barkodova (R_Artikli_BarKod)', razlog: 'Tabela sa MultiFaktor-om (barkod kutije = ×12) nije modelovana — skener bi našao samo primarni barkod.' },
  { labela: 'Prevodi na više jezika (R_Artikli_Ino)', razlog: 'Postoji samo jedan „INO naziv“; prava 1:N tabela nije ni u QBigTehn kopiji.' },
  { labela: 'Potpis i datum unosa', razlog: 'Audit — upisuje server, ne operater.' },
];

/** Ime svakog polja koje forma vodi (za praznu formu i za poređenje sa serverskim slogom). */
export function praznArtikal(): Record<string, string> {
  const v: Record<string, string> = {};
  for (const s of SEKCIJE_ARTIKAL) for (const p of s.polja) v[p.id] = '';
  // Podrazumevane vrednosti koje BigBit takođe nudi na novom slogu.
  v.active = 'da';
  v.toDelete = 'ne';
  return v;
}

/** Serverski slog → vrednosti forme (brojevi u srpskom formatu, boolean kao da/ne). */
export function vrednostiIzArtikla(a: ItemDetail): Record<string, string> {
  return {
    catalogNumber: tekst(a.catalogNumber),
    name: tekst(a.name),
    barCode: tekst(a.barCode),
    externalCode: tekst(a.externalCode),
    unit: tekst(a.unit),
    baseUnit: tekst(a.baseUnit),
    packaging: tekst(a.packaging),
    quantityInPackage: broj(a.quantityInPackage),
    plu: broj(a.plu),
    groupCode: tekst(a.groupCode),
    subgroupCode: tekst(a.subgroupCode),
    originCode: tekst(a.originCode),
    hps: tekst(a.hps),
    sortOrder: broj(a.sortOrder),
    wholesalePrice: broj(a.wholesalePrice),
    retailPrice: broj(a.retailPrice),
    fxPurchasePrice: broj(a.fxPurchasePrice),
    fxSalePrice: broj(a.fxSalePrice),
    priceToWritePricelist: broj(a.priceToWritePricelist),
    manualMarkupPercent: broj(a.manualMarkupPercent),
    maxDiscountPercent: broj(a.maxDiscountPercent),
    promotionDiscount: broj(a.promotionDiscount),
    finalProcessingCost: broj(a.finalProcessingCost),
    wholesaleLossPercent: broj(a.wholesaleLossPercent),
    retailLossPercent: broj(a.retailLossPercent),
    minQuantity: broj(a.minQuantity),
    paymentTermDays: broj(a.paymentTermDays),
    goodsTaxRateCode: tekst(a.goodsTaxRateCode),
    serviceTaxRateCode: tekst(a.serviceTaxRateCode),
    alwaysTaxGoods: daNe(a.alwaysTaxGoods),
    alwaysTaxServices: daNe(a.alwaysTaxServices),
    nonTaxablePart: broj(a.nonTaxablePart),
    itemFee: broj(a.itemFee),
    itemExcise: broj(a.itemExcise),
    customsRate: broj(a.customsRate),
    customsTariff: tekst(a.customsTariff),
    originCountry: tekst(a.originCountry),
    accountingCode: tekst(a.accountingCode),
    accountingCode2: tekst(a.accountingCode2),
    box: broj(a.box),
    transportPackaging: broj(a.transportPackaging),
    weight: broj(a.weight),
    weightKg: broj(a.weightKg),
    volume: broj(a.volume),
    area: broj(a.area),
    thickness: broj(a.thickness),
    itemDescription: tekst(a.itemDescription),
    foreignName: tekst(a.foreignName),
    foreignUnit: tekst(a.foreignUnit),
    webDescription: tekst(a.webDescription),
    memo: tekst(a.memo),
    note2: tekst(a.note2),
    manufacturer: tekst(a.manufacturer),
    shelf: tekst(a.shelf),
    notStockTracked: daNe(a.notStockTracked),
    active: daNe(a.active),
    toDelete: daNe(a.toDelete),
  };
}
