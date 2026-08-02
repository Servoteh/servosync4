import type { CustomerDetail } from '@/api/masters';
import type { NepokrivenoPolje } from '@/app/artikli/_forma/polja';
import {
  formatirajBroj,
  formatirajTekuciRacun,
  proveriBroj,
  proveriGln,
  proveriObavezno,
  proveriPib,
  proveriTekuciRacun,
  type SekcijaDef,
} from '@/app/artikli/_forma/pravila';

/**
 * KOMITENT — raspored polja za pun ekran unosa/izmene.
 *
 * Redosled prati BigBit formu „Unos komitenata“ (`Doc__Form_Unos komitenata.txt`) i ono
 * što se vidi/štampa, ne redosled kolona: prvo NAZIV (BigBit fokusira `Naziv`, ne šifru —
 * šifra je auto-increment), pa adresa/kontakt, pa PIB i SEF, pa računi, pa komercijala.
 * Polja i tipovi: `backend/docs/migration/BIGBIT_KOMITENTI.md` §1 (57 kolona), §3, §4.
 *
 * ⚠️ `_forma` blokovi žive pod `app/artikli/` jer je granica ovog posla
 * `app/artikli/**` + `app/komitenti/**` + `api/masters.ts` (v. komentar u `polja.tsx`).
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

/** Datum iz ISO stringa u vrednost `<input type="date">`. */
function datum(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

const procenat = (v: string) => proveriBroj(v, { min: 0, max: 100 });
const nenegativan = (v: string) => proveriBroj(v, { min: 0 });

export const SEKCIJE_KOMITENT: SekcijaDef[] = [
  {
    naslov: 'Osnovno',
    opis: 'Šifru dodeljuje baza — u BigBitu se prvo kuca naziv, zato je fokus ovde.',
    polja: [
      { id: 'name', labela: 'Naziv', tip: 'tekst', obavezno: true, maxDuzina: 50, raspon: 2, proveri: (v) => proveriObavezno(v, 'Naziv') },
      { id: 'shortName', labela: 'Skraćeni naziv', tip: 'tekst', maxDuzina: 30 },
      { id: 'branch', labela: 'Poslovnica', tip: 'tekst', maxDuzina: 50 },
      {
        id: 'codeTypeCode',
        labela: 'Vrsta šifre',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 10,
        proveri: (v) => proveriObavezno(v, 'Vrsta šifre'),
        napomena: 'Kupac / dobavljač / oboje (KUPDOB). Padajuća lista traži šifarnik „Vrste sifara“ na ekranu.',
      },
      { id: 'hideInOverview', labela: 'Sakriven u pregledu', tip: 'da-ne' },
    ],
  },
  {
    naslov: 'Adresa i kontakt',
    polja: [
      { id: 'address', labela: 'Adresa', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      { id: 'city', labela: 'Mesto', tip: 'tekst', maxDuzina: 30 },
      { id: 'postalCode', labela: 'Poštanski broj', tip: 'tekst', maxDuzina: 20 },
      { id: 'country', labela: 'Država', tip: 'tekst', maxDuzina: 30 },
      { id: 'phone', labela: 'Telefon', tip: 'tekst', maxDuzina: 20 },
      { id: 'mobile', labela: 'Mobilni', tip: 'tekst', maxDuzina: 20 },
      { id: 'fax', labela: 'Faks', tip: 'tekst', maxDuzina: 20 },
      { id: 'email', labela: 'Email', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      { id: 'webAddress', labela: 'Web adresa', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      {
        id: 'contact',
        labela: 'Kontakt osoba',
        tip: 'tekst',
        maxDuzina: 50,
        raspon: 2,
        napomena: 'Jedno polje. BigBit ima i 1:N tabelu KomitentiKontaktOsobe (nabavka, knjigovodstvo…) koja u 4.0 ne postoji.',
      },
      { id: 'birthDate', labela: 'Datum rođenja', tip: 'datum', napomena: 'Za fizička lica.' },
      { id: 'mailToDifferentAddress', labela: 'Pošta na drugu adresu', tip: 'da-ne' },
      { id: 'newsletter', labela: 'Newsletter', tip: 'da-ne' },
    ],
  },
  {
    naslov: 'Porezi i SEF',
    opis: 'PIB se proverava dok se kuca (kontrolna cifra mod 11,10) — isto što BigBit prikazuje kolonom DobarPIB.',
    polja: [
      {
        id: 'taxId',
        labela: 'PIB',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 20,
        raspon: 2,
        proveri: (v, sve) => proveriPib(v, sve.skipTaxIdValidation === 'da'),
      },
      {
        id: 'skipTaxIdValidation',
        labela: 'Ne proveravaj PIB',
        tip: 'da-ne',
        napomena: 'Svestan izuzetak za strane komitente i fizička lica (BigBit NeProveravajPIB).',
      },
      { id: 'registrationNumber', labela: 'Matični broj', tip: 'tekst', maxDuzina: 20 },
      { id: 'gln', labela: 'GLN', tip: 'tekst', maxDuzina: 30, proveri: proveriGln },
      { id: 'publicSectorId', labela: 'JBKJS (javni sektor)', tip: 'tekst', maxDuzina: 10 },
      { id: 'vatStatus', labela: 'PDV status', tip: 'broj', proveri: nenegativan, napomena: 'Kodna vrednost; šifarnik nije lociran, zato broj a ne lista.' },
      { id: 'centralInvoiceRegistry', labela: 'CRF (centralni registar faktura)', tip: 'da-ne' },
      { id: 'einvoiceXmlPerItemDiscount', labela: 'e-Faktura: popust po stavci', tip: 'da-ne' },
      { id: 'invoicePerDeliveryAddress', labela: 'Fakturisanje po mestima isporuke', tip: 'da-ne', napomena: 'Sam spisak mesta isporuke (sa svojim GLN-om) u 4.0 ne postoji.' },
    ],
  },
  {
    naslov: 'Računi',
    opis: 'Kontrolni broj računa se proverava po mod-97 (BigBit DobarTR). Unesi 18 cifara — crtice se dodaju same.',
    polja: [
      { id: 'bankAccount1', labela: 'Žiro račun 1', tip: 'tekst', maxDuzina: 30, raspon: 2, proveri: proveriTekuciRacun, normalizuj: formatirajTekuciRacun },
      { id: 'bankAccount2', labela: 'Žiro račun 2', tip: 'tekst', maxDuzina: 30, raspon: 2, proveri: proveriTekuciRacun, normalizuj: formatirajTekuciRacun },
      { id: 'bankAccount3', labela: 'Žiro račun 3', tip: 'tekst', maxDuzina: 30, raspon: 2, proveri: proveriTekuciRacun, normalizuj: formatirajTekuciRacun },
    ],
  },
  {
    naslov: 'Komercijala',
    polja: [
      { id: 'customerDiscount', labela: 'Rabat komitenta (%)', tip: 'broj', proveri: procenat },
      { id: 'fictitiousDiscount', labela: 'Fiktivni rabat (%)', tip: 'broj', proveri: procenat },
      { id: 'commissionPercent', labela: 'Provizija (%)', tip: 'broj', proveri: procenat },
      { id: 'manualMarkupPercent', labela: 'Ručna marža (%)', tip: 'broj', proveri: procenat },
      { id: 'priceListCode', labela: 'Cenovnik', tip: 'tekst', maxDuzina: 5 },
      { id: 'paymentTermDays', labela: 'Valuta plaćanja (dana)', tip: 'broj', proveri: (v) => proveriBroj(v, { min: 0, max: 365 }) },
      {
        id: 'paymentMethod',
        labela: 'Način plaćanja',
        tip: 'tekst',
        maxDuzina: 50,
        zakljucano:
          'U BigBitu ovo polje otključava samo grupa KomAvPlacanje (avansni uslovi). Ekvivalent permisije u 4.0 nije presuđen, pa polje stoji zaključano.',
      },
      { id: 'creditLimit', labela: 'Kreditni limit', tip: 'broj', proveri: nenegativan },
      { id: 'checkDebt', labela: 'Provera duga', tip: 'da-ne' },
      { id: 'externalCode', labela: 'Eksterna šifra', tip: 'tekst', maxDuzina: 10 },
      { id: 'pantheonId', labela: 'Pantheon ID', tip: 'tekst', maxDuzina: 30 },
      { id: 'buyerProtectionCode', labela: 'Zaštitni kod kupca', tip: 'tekst', maxDuzina: 50 },
    ],
  },
  {
    naslov: 'Napomene',
    polja: [
      { id: 'note', labela: 'Napomena', tip: 'memo', maxDuzina: 255, raspon: 2 },
      { id: 'balanceNote', labela: 'Napomena za salda', tip: 'memo', maxDuzina: 255, raspon: 2 },
    ],
  },
];

export const NEPOKRIVENO_KOMITENT: NepokrivenoPolje[] = [
  { labela: 'Šifra (customers.id)', razlog: 'Dodeljuje baza. Customer.id JESTE BigBit šifra, a sekvenca nije klampovana — v. uslove brane.' },
  { labela: 'Prodavac (Sifra prodavca)', razlog: 'Traži birač iz šifarnika prodavaca; uz to BigBit transfer novom komitentu UVEK upisuje 0 pa se prodavac dodeljuje naknadno.' },
  { labela: 'Uplatni račun (IDUplatniRacun)', razlog: 'Šifarnik UplatniRacuni nije izložen kao lista za biranje — bez nje bi se kucao goli interni id.' },
  { labela: 'Ruta i vozač (IDRuta, IDVozac)', razlog: 'Rute se ne sinkuju; vozač je self-FK na komitenta. Kucanje golog id-a je zamka.' },
  { labela: 'Region', razlog: 'Kodna vrednost bez šifarnika u 4.0.' },
  { labela: 'Kontakt osobe (KomitentiKontaktOsobe, 1:N)', razlog: 'Više kontakata po komitentu nije modelovano — ostaje jedno polje „Kontakt osoba“.' },
  { labela: 'Mesta isporuke (MestaIsporuke, 1:N)', razlog: 'Svako mesto ima svoj GLN, uplatni račun, rutu i prodavca; u 4.0 postoji samo prekidač na komitentu.' },
  { labela: 'KoristiPNBZadModel', razlog: 'Kolona je dodata u BigBit posle snapshot-a — u 4.0 modelu je nema.' },
  { labela: 'Prvi unos / Poslednja izmena / Potpis', razlog: 'Audit — upisuje server, ne operater.' },
  { labela: 'Provera PIB-a kod NBS', razlog: 'Korisnik pamti da postoji u BigBitu, ali kod nije pronađen ni u jednom izvučenom VBA exportu (verovatno u VBA tekućeg APL.MDB). Dok se ne nađe, ekran je ne izmišlja.' },
];

export function prazanKomitent(): Record<string, string> {
  const v: Record<string, string> = {};
  for (const s of SEKCIJE_KOMITENT) for (const p of s.polja) v[p.id] = '';
  v.codeTypeCode = 'KUPDOB';
  v.skipTaxIdValidation = 'ne';
  return v;
}

export function vrednostiIzKomitenta(k: CustomerDetail): Record<string, string> {
  return {
    name: tekst(k.name),
    shortName: tekst(k.shortName),
    branch: tekst(k.branch),
    codeTypeCode: tekst(k.codeTypeCode),
    hideInOverview: daNe(k.hideInOverview),
    address: tekst(k.address),
    city: tekst(k.city),
    postalCode: tekst(k.postalCode),
    country: tekst(k.country),
    phone: tekst(k.phone),
    mobile: tekst(k.mobile),
    fax: tekst(k.fax),
    email: tekst(k.email),
    webAddress: tekst(k.webAddress),
    contact: tekst(k.contact),
    birthDate: datum(k.birthDate),
    mailToDifferentAddress: daNe(k.mailToDifferentAddress),
    newsletter: daNe(k.newsletter),
    taxId: tekst(k.taxId),
    skipTaxIdValidation: daNe(k.skipTaxIdValidation),
    registrationNumber: tekst(k.registrationNumber),
    gln: tekst(k.gln),
    publicSectorId: tekst(k.publicSectorId),
    vatStatus: broj(k.vatStatus),
    centralInvoiceRegistry: daNe(k.centralInvoiceRegistry),
    einvoiceXmlPerItemDiscount: daNe(k.einvoiceXmlPerItemDiscount),
    invoicePerDeliveryAddress: daNe(k.invoicePerDeliveryAddress),
    bankAccount1: tekst(k.bankAccount1),
    bankAccount2: tekst(k.bankAccount2),
    bankAccount3: tekst(k.bankAccount3),
    customerDiscount: broj(k.customerDiscount),
    fictitiousDiscount: broj(k.fictitiousDiscount),
    commissionPercent: broj(k.commissionPercent),
    manualMarkupPercent: broj(k.manualMarkupPercent),
    priceListCode: tekst(k.priceListCode),
    paymentTermDays: broj(k.paymentTermDays),
    paymentMethod: tekst(k.paymentMethod),
    creditLimit: broj(k.creditLimit),
    checkDebt: daNe(k.checkDebt),
    externalCode: tekst(k.externalCode),
    pantheonId: tekst(k.pantheonId),
    buyerProtectionCode: tekst(k.buyerProtectionCode),
    note: tekst(k.note),
    balanceNote: tekst(k.balanceNote),
  };
}
