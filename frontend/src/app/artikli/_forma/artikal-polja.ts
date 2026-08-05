import type { ItemDetail, ItemLookups } from '@/api/masters';
import { formatDateTime } from '@/lib/format';
import type { NepokrivenoPolje } from './polja';
import {
  formatirajBroj,
  proveriBroj,
  proveriKataloskiBroj,
  proveriObavezno,
  type OpcijaPolja,
  type SekcijaDef,
} from './pravila';

/**
 * ARTIKAL — raspored polja za pun ekran unosa/izmene.
 *
 * ZAHTEV VLASNIKA (04.08.2026): „SVE TREBA DA BUDE KAO U BIGBITU… otvaranje artikala da
 * ima ista polja i isti raspored, što više da bude isto da se ne menja navika korisnika.“
 * Zato ovaj fajl VIŠE NE grupiše polja po logičkim panelima (Identitet / Klasifikacija /
 * Cene / …), nego prati REDOVE BigBit forme „Unos artikala“, red po red, sleva nadesno,
 * i koristi doslovne BigBit labele („Kilograma u komadu“, „VP cena iz posl. KL“,
 * „Grupa za šemu“, „Debljina lima(mm)“…), a ne naša „lepša“ imena.
 *
 * Izvor rasporeda NIJE pretpostavka nego sama Access baza: kontrole forme „Unos artikala“
 * izvučene sa svojim x/y koordinatama (redovi po y, u redu polja po x). Mapiranje
 * BigBit kolona → `Item` polja: `backend/docs/migration/BIGBIT_ARTIKLI.md` §1, ponašanje
 * forme (zaključane cene, kaskadni šifarnici, PDV blok) §4.8–4.10.
 *
 * Redovi BigBit forme, kako se ovde preslikavaju (12-kolonska mreža, `mreza: 12`):
 *   zaglavlje  Šifra artikla
 *   red 1      Kataloški broj · Bar kod · Naziv · Pakovanje · Jed. mere ·
 *              Kilograma u komadu · Transp. pakovanje
 *   red 2      Ext. šifra · Maksimalan rabat % · Grupa · Opis grupe
 *   red 3      Minimalna količina · Odloženo plaćanje (dana) · Podgrupa · Opis podgrupe
 *   red 4      VP cena iz posl. KL · MP cena iz posl. KL · PodPodgrupa · Opis podpodgrupe
 *   red 5      MP devizna cena · PLU · Grupa za šemu
 *   red 6      Stopa carine % · Tarifa carine · INO Naziv
 *   red 7      Zemlja porekla · Akciza · Taksa            (leva traka pored PDV bloka)
 *   red 8      Polica · Težina · Akcijski rabat
 *   blok       P D V: Roba / Usluge × Tarifa · Stopa · Da li se uvek plaća PDV
 *   red 9–12   Web opis · PDF link + Proizvođač · Slika simbola + Word lokacija ·
 *              Napomena 2 ( viskoznost ) · Napomena
 *   desni blok Kng. šifra · Dimenzija (mm) · Potpis · Kvalitet artikla ·
 *              Debljina lima(mm) · Datum i vreme
 *
 * OVO JE JEDINI IZVOR RASPOREDA — i za PREGLED (kartica artikla) i za IZMENU. Kartica
 * ne crta svoju listu polja: `artikli/detalj/page.tsx` u oba režima renderuje ovaj isti
 * niz kroz `MaticniEkran`, samo sa `rezim="pregled"` (sve read-only, bez „Snimi“). Da su
 * dva spiska, jedan bi zaostao — a korisnik vidi upravo karticu.
 *
 * ODLUKA D1 (04.08.2026): UNOS OSTAJE ZAKLJUČAN. Ovde se isporučuje samo paritet
 * IZGLEDA — `BRANA_ARTIKAL` je i dalje zatvorena i „Snimi“ ne prolazi.
 * ODLUKA D2: polja koja 4.0 ima a BigBit forma NE prikazuje se NE BRIŠU — sklopljena su
 * u poslednju sekciju „Dodatna polja (van BigBit forme)“, koja je podrazumevano zatvorena.
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

/**
 * Šifra / ID — BEZ grupisanja hiljada. `broj()` ide kroz `Intl` („sr-RS“) pa bi šifru
 * artikla 58143 ispisao kao „58.143“, a BigBit je svuda prikazuje sirovu (i tako je
 * korisnici čitaju i diktiraju telefonom). Vrednost i dalje prolazi kroz `parsirajBroj`
 * pri poređenju izmena, pa nema razlike u ponašanju — samo u ispisu.
 */
function sifra(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Prazno polje ostaje prazno; `formatDateTime` bi vratio „—“, što u polju nije vrednost. */
function datumVreme(v: string | null | undefined): string {
  return v ? formatDateTime(v) : '';
}

/**
 * BROJČANA ŠIFRA IZ ŠIFARNIKA → ono što BigBit combo PRIKAZUJE.
 *
 * BigBit-ovi combo-i „Dimenzija (mm)“ i „Kvalitet artikla“ imaju vezanu kolonu
 * `IDRaster` / `IDKvalitetArtikla`, ali je ona širine 0 cm — operater vidi NAZIV
 * („1250×2500“, „I klasa“), nikad broj. Ovde se zato ispisuje naziv, a šifra ostaje u
 * zagradi jer se po njoj filtrira lista artikala i diktira telefonom.
 * Kad naziva nema (šifra nije u šifarniku), ostaje gola šifra — bolje nego prazno polje.
 */
function sifarnickaVrednost(naziv: string | null | undefined, id: number | null | undefined): string {
  if (id === null || id === undefined) return naziv ?? '';
  return naziv ? `${naziv} (${id})` : String(id);
}

/** Procenat iz šifarnika tarifa: 20 → „20 %“. `null` = tarife nema u registru. */
function procenatEho(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : `${formatirajBroj(v, 2)} %`;
}

/** Polje sa nenegativnim brojem (BigBit CHECK-ovi: Kutija ≥ 0, Tezina ≥ 0, MPKaloProc ≥ 0). */
const nenegativan = (v: string) => proveriBroj(v, { min: 0 });
/** Procenat 0–100. */
const procenat = (v: string) => proveriBroj(v, { min: 0, max: 100 });

/**
 * Zašto „Opis grupe/podgrupe/podpodgrupe“ postoji kao (zaključano) polje, a ne kao sitan
 * tekst uz šifru: BigBit forma ima TRI široka read-only polja desno od combo-a
 * (`OpisGrupe`, `OpisPodgrupe`, `OpisPorekla`) i operater ih gleda da proveri da je
 * pogodio šifru. Vrednost stiže već razrešena kroz `CodeRef` (`item.group.description`),
 * pa nema dodatnog poziva.
 */
const RAZLOG_OPIS = 'Opis iz šifarnika — čita se uz šifru, ne kuca se.';

/* ─────────────────────────────────── šifarnici za combo-e (Grupa → Podgrupa → PodPodgrupa) */

/** `CodeRef`-oliko → opcija combo-a: „G1 — Limovi“, ili gola šifra kad opisa nema. */
function opcijaKoda(k: { code: string; description: string | null }): OpcijaPolja {
  return { value: k.code, label: k.description ? `${k.code} — ${k.description}` : k.code };
}

/**
 * Zatečena vrednost UVEK ostaje u listi, i kad je šifarnik ne poznaje.
 *
 * Bez ovoga bi prelazak sa slobodnog teksta na combo TIHO POJEO podatak: `<select>` čija
 * lista ne sadrži tekuću vrednost prikazuje prazno polje, pa bi artikal sa šifrom grupe
 * koja je u međuvremenu obrisana iz `item_groups` na kartici izgledao kao da nema grupu.
 * Označava se doslovno, da se vidi da je problem u šifarniku a ne u artiklu.
 */
function saTekucom(opcije: OpcijaPolja[], tekuca: string): OpcijaPolja[] {
  const v = tekuca.trim();
  if (v === '' || opcije.some((o) => o.value === v)) return opcije;
  return [{ value: v, label: `${v} — nije u šifarniku` }, ...opcije];
}

/**
 * OPCIJE ZA COMBO-E KLASIFIKACIJE, sa BigBit kaskadom Grupa → Podgrupa → PodPodgrupa
 * (`FilterZaGrupu_AfterUpdate` na formi pregleda; ista kaskada stoji u filter baru liste,
 * `app/artikli/page.tsx`). Čista funkcija — prima već povučene šifarnike
 * (`useItemLookups()`) i tekuće vrednosti forme, pa je mogu koristiti i kartica i unos.
 *
 * Šifarnici se pune ŽIVIM .mdb uvozom (`backend/src/modules/sync/bigbit-mdb-import.service.ts`,
 * `INSERT … ON CONFLICT DO UPDATE` u `item_groups` / `item_subgroups` / `item_origins`),
 * pa lista nije prazna. Dok podaci nisu stigli (prvi render, pad mreže) vraća se prazna
 * lista, a polje se — po pravilu iz `polja.tsx` — crta kao obično tekstualno, da se šifra
 * i tada vidi i može otkucati.
 */
export function opcijeSifarnikaArtikla(
  sifarnici: ItemLookups | undefined,
  vrednosti: Record<string, string>,
): Record<string, OpcijaPolja[]> {
  const grupa = (vrednosti.groupCode ?? '').trim();
  const podgrupa = (vrednosti.subgroupCode ?? '').trim();
  const podpodgrupa = (vrednosti.originCode ?? '').trim();

  const sveGrupe = sifarnici?.groups ?? [];
  const svePodgrupe = sifarnici?.subgroups ?? [];
  const svePodpodgrupe = sifarnici?.origins ?? [];

  const podgrupe = grupa ? svePodgrupe.filter((s) => s.parentGroup === grupa) : svePodgrupe;
  const podpodgrupe = podgrupa
    ? svePodpodgrupe.filter((o) => o.subgroupCode === podgrupa)
    : svePodpodgrupe;

  return {
    groupCode: saTekucom(sveGrupe.map(opcijaKoda), grupa),
    subgroupCode: saTekucom(podgrupe.map(opcijaKoda), podgrupa),
    originCode: saTekucom(podpodgrupe.map(opcijaKoda), podpodgrupa),
  };
}

export const SEKCIJE_ARTIKAL: SekcijaDef[] = [
  {
    naslov: 'Artikal',
    mreza: 12,
    opis:
      'Redosled i susedstvo polja su isti kao u BigBit formi „Unos artikala“ — prvi red je Kataloški broj · Bar kod · Naziv, kao i tamo. Jedinica mere se u BigBitu ponavlja kao siv eho uz Kilograma u komadu, Transp. pakovanje i Minimalnu količinu; ovde stoji jednom, jer je to isto polje.',
    polja: [
      {
        id: 'externalItemId',
        labela: 'Šifra artikla',
        tip: 'broj',
        raspon: 2,
        zakljucano:
          'BigBit šifra artikla (zaglavlje BigBit forme). Dodeljuje je BigBit i upisuje sync — ekran je ne dira.',
      },
      {
        id: 'catalogNumber',
        labela: 'Kataloški broj',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 20,
        raspon: 2,
        proveri: proveriKataloskiBroj,
        napomena: 'Jedinstven — duplikat obara snimanje (BigBit forma i DB brana guard_catalog_unique).',
      },
      { id: 'barCode', labela: 'Bar kod', tip: 'tekst', maxDuzina: 20, raspon: 2 },
      {
        id: 'name',
        labela: 'Naziv',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 50,
        raspon: 6,
        proveri: (v) => proveriObavezno(v, 'Naziv'),
      },

      { id: 'packaging', labela: 'Pakovanje', tip: 'tekst', maxDuzina: 10, raspon: 2 },
      { id: 'unit', labela: 'Jed. mere', tip: 'tekst', maxDuzina: 5, raspon: 2 },
      {
        id: 'box',
        labela: 'Kilograma u komadu',
        tip: 'broj',
        raspon: 4,
        proveri: nenegativan,
        napomena:
          'BigBit ovo polje puni i dugmetom „Preračunaj težinu jedne ploče“ (Debljina × raster × 7850).',
      },
      { id: 'transportPackaging', labela: 'Transp. pakovanje', tip: 'broj', raspon: 4, proveri: nenegativan },

      { id: 'externalCode', labela: 'Ext. šifra', tip: 'tekst', maxDuzina: 20, raspon: 2 },
      { id: 'maxDiscountPercent', labela: 'Maksimalan rabat %', tip: 'broj', raspon: 2, proveri: procenat },
      {
        id: 'groupCode',
        labela: 'Grupa',
        tip: 'izbor',
        obavezno: true,
        maxDuzina: 10,
        raspon: 2,
        proveri: (v) => proveriObavezno(v, 'Grupa'),
        napomena: 'Bira se iz šifarnika grupa; izbor sužava listu podgrupa (BigBit kaskada).',
      },
      { id: 'groupDescription', labela: 'Opis grupe:', tip: 'tekst', raspon: 6, zakljucano: RAZLOG_OPIS },

      { id: 'minQuantity', labela: 'Minimalna količina', tip: 'broj', raspon: 2, proveri: nenegativan },
      {
        id: 'paymentTermDays',
        labela: 'Odloženo plaćanje (dana)',
        tip: 'broj',
        raspon: 2,
        proveri: (v) => proveriBroj(v, { min: 0, max: 365 }),
      },
      {
        id: 'subgroupCode',
        labela: 'Podgrupa',
        tip: 'izbor',
        obavezno: true,
        maxDuzina: 10,
        raspon: 2,
        proveri: (v) => proveriObavezno(v, 'Podgrupa'),
        napomena: 'Lista je sužena na izabranu grupu; izbor dalje sužava PodPodgrupe.',
      },
      { id: 'subgroupDescription', labela: 'Opis podgrupe:', tip: 'tekst', raspon: 6, zakljucano: RAZLOG_OPIS },

      {
        id: 'wholesalePrice',
        labela: 'VP cena iz posl. KL',
        tip: 'broj',
        raspon: 2,
        otkljucajDvoklikom: true,
        proveri: nenegativan,
      },
      {
        id: 'retailPrice',
        labela: 'MP cena iz posl. KL',
        tip: 'broj',
        raspon: 2,
        otkljucajDvoklikom: true,
        proveri: nenegativan,
      },
      {
        id: 'originCode',
        labela: 'PodPodgrupa',
        tip: 'izbor',
        obavezno: true,
        maxDuzina: 5,
        raspon: 2,
        proveri: (v) => proveriObavezno(v, 'PodPodgrupa'),
        napomena:
          'U bazi se kolona zove Poreklo; BigBit forma i pregled je zovu „PodPodgrupa“. Lista je sužena na izabranu podgrupu.',
      },
      { id: 'originDescription', labela: 'Opis podpodgrupe:', tip: 'tekst', raspon: 6, zakljucano: RAZLOG_OPIS },

      {
        id: 'fxSalePrice',
        labela: 'MP devizna cena',
        tip: 'broj',
        raspon: 2,
        otkljucajDvoklikom: true,
        proveri: nenegativan,
      },
      {
        id: 'plu',
        labela: 'PLU',
        tip: 'broj',
        raspon: 2,
        zakljucano: 'BigBit sam dodeljuje sledeći slobodan PLU pri snimanju (SledeciPLU) — ručni unos bi napravio duplikat.',
      },
      {
        id: 'accountingCode2',
        labela: 'Grupa za šemu',
        tip: 'tekst',
        maxDuzina: 10,
        raspon: 8,
        napomena:
          'KngSifra_2. BigBit pored combo-a ispisuje i „Naziv grupe za šemu za knjiženje“ — KNG_Artikli_2 nije sinkovan, pa tog opisa ovde nema. Isto polje BigBit koristi i kao „zamensku šifru“ (stari artikal pokazuje na novi).',
      },

      { id: 'customsRate', labela: 'Stopa carine %', tip: 'broj', raspon: 2, proveri: procenat },
      { id: 'customsTariff', labela: 'Tarifa carine', tip: 'tekst', maxDuzina: 20, raspon: 2 },
      { id: 'foreignName', labela: 'INO Naziv', tip: 'tekst', maxDuzina: 50, raspon: 8 },

      { id: 'originCountry', labela: 'Zemlja porekla', tip: 'tekst', maxDuzina: 20, raspon: 4 },
      { id: 'itemExcise', labela: 'Akciza', tip: 'broj', raspon: 4, proveri: nenegativan },
      { id: 'itemFee', labela: 'Taksa', tip: 'broj', raspon: 4, proveri: nenegativan },

      {
        id: 'shelf',
        labela: 'Polica:',
        tip: 'tekst',
        // Migracija 20260728170000 proširila kolonu na VARCHAR(20) (v. schema.prisma,
        // model Item, `shelf`) — QBigTehn kopija ju je bila suzila na 10 znakova.
        maxDuzina: 20,
        raspon: 4,
        napomena: 'Oznaka police u magacinu — do 20 znakova.',
      },
      { id: 'weight', labela: 'Težina:', tip: 'broj', raspon: 4, proveri: nenegativan },
      { id: 'promotionDiscount', labela: 'Akcijski rabat:', tip: 'broj', raspon: 4, proveri: procenat },
    ],
  },
  {
    naslov: 'P D V',
    mreza: 12,
    opis:
      'BigBit blok „P D V“: dva reda (Roba i Usluge) × tri kolone (Tarifa · Stopa · Da li se uvek plaća PDV). „Stopa“ je izračunat eho iz šifarnika tarifa (R_Tarife) — ZBIR svih komponenti (osnovna + železnica + gradska + ratna + posebna), tačno kao u BigBit combo-u; prazna je kad tarife nema u registru, jer bi nula značila „stopa je 0 %“.',
    polja: [
      {
        id: 'goodsTaxRateCode',
        labela: 'Roba: Tarifa',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 5,
        raspon: 4,
        proveri: (v) => proveriObavezno(v, 'Tarifa robe'),
      },
      {
        id: 'goodsTaxTotalRate',
        labela: 'Roba: Stopa %',
        tip: 'tekst',
        raspon: 4,
        zakljucano: 'Zbirna stopa iz šifarnika tarifa (RobaZbirnaStopa) — ne kuca se, računa se iz tarife.',
      },
      { id: 'alwaysTaxGoods', labela: 'Roba: da li se uvek plaća PDV', tip: 'da-ne', raspon: 4 },
      {
        id: 'serviceTaxRateCode',
        labela: 'Usluge: Tarifa',
        tip: 'tekst',
        obavezno: true,
        maxDuzina: 5,
        raspon: 4,
        proveri: (v) => proveriObavezno(v, 'Tarifa usluga'),
      },
      {
        id: 'serviceTaxTotalRate',
        labela: 'Usluge: Stopa %',
        tip: 'tekst',
        raspon: 4,
        zakljucano: 'Zbirna stopa iz šifarnika tarifa (UslugeZbirnaStopa) — ne kuca se, računa se iz tarife.',
      },
      { id: 'alwaysTaxServices', labela: 'Usluge: da li se uvek plaća PDV', tip: 'da-ne', raspon: 4 },
    ],
  },
  {
    naslov: 'Opisi, linkovi i napomene',
    mreza: 12,
    opis:
      'Donja polovina BigBit forme. Linkovi su STRING PUTANJE na fajl-server (BigBit ih bira Windows dijalogom) — web forma ne može da otvori taj dijalog, pa ovde stoje samo za čitanje.',
    polja: [
      { id: 'webDescription', labela: 'Web opis', tip: 'memo', maxDuzina: 255, raspon: 12 },

      {
        id: 'pdfLink',
        labela: 'PDF link',
        tip: 'tekst',
        maxDuzina: 255,
        raspon: 8,
        zakljucano: 'Putanja na fajl-serveru — BigBit je bira Windows dijalogom, web forma to ne može.',
      },
      { id: 'manufacturer', labela: 'Proizvođač', tip: 'tekst', maxDuzina: 50, raspon: 4 },

      {
        id: 'symbolImageLink',
        labela: 'Slika simbola (jpg lokacija)',
        tip: 'tekst',
        maxDuzina: 250,
        raspon: 6,
        zakljucano: 'Putanja na fajl-serveru — bira se Windows dijalogom, web forma to ne može.',
      },
      {
        id: 'wordLocation',
        labela: 'Tabela za sliku simbola (Word lokacija)',
        tip: 'tekst',
        maxDuzina: 250,
        raspon: 6,
        zakljucano: 'Putanja na fajl-serveru — bira se Windows dijalogom, web forma to ne može.',
      },

      { id: 'note2', labela: 'Napomena 2 ( viskoznost )', tip: 'memo', maxDuzina: 255, raspon: 12 },
      { id: 'memo', labela: 'Napomena:', tip: 'memo', maxDuzina: 255, raspon: 12 },
    ],
  },
  {
    naslov: 'Knjiženje, dimenzija i kvalitet',
    mreza: 12,
    opis:
      'Desni donji blok BigBit forme. „Dimenzija (mm)“ i „Kvalitet artikla“ su u BigBitu padajuće liste (RasterDefZag, R_KvalitetArtikla) koje prikazuju NAZIV, a upisuju šifru — tako stoje i ovde: naziv, pa šifra u zagradi.',
    polja: [
      {
        id: 'accountingCode',
        labela: 'Kng. šifra',
        tip: 'tekst',
        maxDuzina: 10,
        raspon: 4,
        napomena: 'GK konto artikla. BigBit pored njega ispisuje „KNG naziv artikla“ iz KNG_Artikli — ta tabela nije sinkovana.',
      },
      {
        id: 'rasterId',
        labela: 'Dimenzija (mm)',
        // Naziv + šifra su JEDNA vrednost („1250×2500 (12)“), pa polje nije broj nego
        // eho combo-a — isto što BigBit prikazuje. Šifra se bira iz šifarnika
        // `item_rasters`, ne kuca se.
        tip: 'tekst',
        raspon: 4,
        zakljucano:
          'Bira se iz šifarnika dimenzija (RasterDefZag) — kod Servoteha nosi dimenzije ploče/lima iz kojih BigBit računa kilograme po komadu.',
      },
      {
        id: 'signature',
        labela: 'Potpis',
        tip: 'tekst',
        raspon: 4,
        zakljucano: 'Audit — upisuje ga sistem pri snimanju, ne operater.',
      },

      {
        id: 'qualityTypeId',
        labela: 'Kvalitet artikla',
        // Kao i „Dimenzija (mm)“: naziv iz šifarnika `item_quality_types` + šifra u
        // zagradi. Šifra 0 NIJE prazno — u šifarniku postoji red 0 sa doslovnim BigBit
        // opisom, i BigBit ga prikazuje u combo-u.
        tip: 'tekst',
        raspon: 4,
        zakljucano: 'Bira se iz šifarnika kvaliteta (R_KvalitetArtikla) — ne kuca se.',
      },
      { id: 'thickness', labela: 'Debljina lima(mm)', tip: 'broj', raspon: 4, proveri: nenegativan },
      {
        id: 'createdAt',
        labela: 'Datum i vreme',
        tip: 'tekst',
        raspon: 4,
        zakljucano: 'Audit — upisuje ga sistem, ne operater.',
      },
    ],
  },
  {
    /**
     * D2 (odluka vlasnika 04.08.2026): polja koja 4.0 vodi a BigBit forma „Unos artikala“
     * NE prikazuje se ne brišu, nego se sklapaju. Svako je pre premeštanja provereno u
     * izvučenom rasporedu forme — nijedne od ovih kontrola tamo nema.
     */
    naslov: 'Dodatna polja (van BigBit forme)',
    sklopivo: true,
    podrazumevanoZatvoreno: true,
    opis:
      'Ovo su kolone koje 4.0 vodi, a BigBit forma „Unos artikala“ ih ne prikazuje (pune se sync-om ili drugim BigBit ekranima). Ništa nije obrisano — samo je sklonjeno sa glavnog rasporeda da se ne menja navika korisnika.',
    polja: [
      { id: 'id', labela: 'Šifra (3.0)', tip: 'broj', zakljucano: 'Dodeljuje baza. BigBit šifra artikla stoji gore, u polju „Šifra artikla“.' },
      { id: 'fxPurchasePrice', labela: 'Devizna nabavna (NabDevCena)', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'priceToWritePricelist', labela: 'Cena za upis u cenovnik', tip: 'broj', otkljucajDvoklikom: true, proveri: nenegativan },
      { id: 'manualMarkupPercent', labela: 'Ručna marža (%)', tip: 'broj', proveri: procenat },
      { id: 'finalProcessingCost', labela: 'Zavisni trošak proizvodnje', tip: 'broj', proveri: nenegativan },
      { id: 'wholesaleLossPercent', labela: 'Kalo VP (%)', tip: 'broj', proveri: procenat },
      { id: 'retailLossPercent', labela: 'Kalo MP (%)', tip: 'broj', proveri: procenat },
      { id: 'nonTaxablePart', labela: 'Neoporezivi deo', tip: 'broj', proveri: nenegativan },
      { id: 'baseUnit', labela: 'Osnovna JM', tip: 'tekst', maxDuzina: 5 },
      { id: 'quantityInPackage', labela: 'Količina u pakovanju', tip: 'broj', proveri: nenegativan },
      { id: 'weightKg', labela: 'Težina (kg)', tip: 'broj', proveri: nenegativan },
      { id: 'volume', labela: 'Zapremina', tip: 'broj', proveri: nenegativan },
      { id: 'area', labela: 'Površina', tip: 'broj', proveri: nenegativan },
      { id: 'itemDescription', labela: 'Opis artikla', tip: 'tekst', maxDuzina: 50, raspon: 2 },
      { id: 'foreignUnit', labela: 'INO jedinica mere', tip: 'tekst', maxDuzina: 5 },
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
      {
        id: 'supplierId',
        labela: 'Dobavljač (šifra)',
        tip: 'broj',
        zakljucano: 'Traži birač komitenata; uz to BigBit ima 1:N DobavljaciZaArtikal (više dobavljača + rok isporuke) koji u 4.0 ne postoji.',
      },
      {
        id: 'issuePlaceId',
        labela: 'Mesto izdavanja (ID)',
        tip: 'broj',
        zakljucano: 'Šifarnik MestaIzdavanja nije sinkovan — vidi se samo šifra.',
      },
      { id: 'notStockTracked', labela: 'Ne vodi zalihe', tip: 'da-ne' },
      { id: 'active', labela: 'Aktivan', tip: 'da-ne' },
      { id: 'toDelete', labela: 'Za brisanje', tip: 'da-ne', napomena: 'BigBit meko brisanje — slog ostaje, samo se označi.' },
    ],
  },
];

/**
 * Šta BigBit forma „Unos artikala“ ima a ovaj ekran i dalje NE nudi — sa razlogom, da se
 * ne traži uzalud. (Polja iz same forme su sada sva na ekranu; ovde ostaju samo prateće
 * tabele, izračunati eho-prikazi i dugmad.)
 */
export const NEPOKRIVENO_ARTIKAL: NepokrivenoPolje[] = [
  {
    labela: 'Slika artikla (podforma ArtikliSlike, 1:N)',
    razlog: 'Galerija slika po artiklu nije modelovana u 4.0 — BigBit je drži kao zasebnu podformu desno od polja.',
  },
  {
    labela: '„Naziv grupe za šemu za knjiženje“ i „KNG naziv artikla“',
    razlog: 'Read-only eho iz KNG_Artikli / KNG_Artikli_2 — te tabele nisu sinkovane, pa stoji samo šifra.',
  },
  {
    labela: 'Dugme „Preračunaj težinu jedne ploče“',
    razlog:
      'Računa Kutija = Debljina × VrstaRastera × KolonaRastera × 7850/1e9. Račun postoji na serveru (applyRasterWeight) i radi pri upisu, ali je upis zaključan (D1) — dok se ne otvori, dugme nema šta da snimi.',
  },
  {
    labela: 'Više barkodova (R_Artikli_BarKod)',
    razlog: 'Tabela sa MultiFaktor-om (barkod kutije = ×12) nije modelovana — skener bi našao samo primarni barkod.',
  },
  {
    labela: 'Prevodi na više jezika (R_Artikli_Ino)',
    razlog: 'Postoji samo jedan „INO Naziv“; prava 1:N tabela nije ni u QBigTehn kopiji.',
  },
  {
    labela: 'Dobavljači za artikal (DobavljaciZaArtikal, 1:N + rok isporuke)',
    razlog: 'BigBit vodi više dobavljača po artiklu sa oznakom primarnog; 4.0 ima samo jednu šifru dobavljača.',
  },
  {
    labela: 'Pretraga iz zaglavlja forme (po kat. broju / bar kodu / nazivu)',
    razlog: 'U 4.0 se artikal bira na listi artikala (/artikli) pa se otvara — ista tri kriterijuma stoje u pretrazi liste.',
  },
  {
    labela: 'Dugmad forme (Novi artikal · Kartica artikla · Recept za proizvodnju · Obriši · šifarnici)',
    razlog: 'Upis je zaključan (odluka D1), a kartica/recept/šifarnici su u 4.0 zasebni ekrani, ne dugmad na formi.',
  },
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

/**
 * Serverski slog → vrednosti forme (brojevi u srpskom formatu, boolean kao da/ne).
 *
 * Ključevi su imena polja `ItemDetail`-a; tri su IZVEDENA i postoje samo za prikaz
 * (`groupDescription`, `subgroupDescription`, `originDescription`) — BigBit forma pored
 * svakog combo-a ima široko read-only polje sa opisom iz šifarnika. Nikad se ne šalju
 * nazad; upis je i dalje zatvoren (D1), a kad se otvori, ide preko izričitog DTO-a
 * polje-po-polje, nikad generickim (Object.entries) prolazom kroz ovaj objekat.
 */
export function vrednostiIzArtikla(a: ItemDetail): Record<string, string> {
  return {
    // Zaglavlje + red 1
    externalItemId: sifra(a.externalItemId),
    catalogNumber: tekst(a.catalogNumber),
    barCode: tekst(a.barCode),
    name: tekst(a.name),
    packaging: tekst(a.packaging),
    unit: tekst(a.unit),
    box: broj(a.box),
    transportPackaging: broj(a.transportPackaging),
    // Red 2–5 (levo) + klasifikacija sa opisima (desno)
    externalCode: tekst(a.externalCode),
    maxDiscountPercent: broj(a.maxDiscountPercent),
    groupCode: tekst(a.groupCode),
    groupDescription: tekst(a.group?.description),
    minQuantity: broj(a.minQuantity),
    paymentTermDays: broj(a.paymentTermDays),
    subgroupCode: tekst(a.subgroupCode),
    subgroupDescription: tekst(a.subgroup?.description),
    wholesalePrice: broj(a.wholesalePrice),
    retailPrice: broj(a.retailPrice),
    originCode: tekst(a.originCode),
    originDescription: tekst(a.origin?.description),
    fxSalePrice: broj(a.fxSalePrice),
    plu: sifra(a.plu),
    accountingCode2: tekst(a.accountingCode2),
    // Red 6–8
    customsRate: broj(a.customsRate),
    customsTariff: tekst(a.customsTariff),
    foreignName: tekst(a.foreignName),
    originCountry: tekst(a.originCountry),
    itemExcise: broj(a.itemExcise),
    itemFee: broj(a.itemFee),
    shelf: tekst(a.shelf),
    weight: broj(a.weight),
    promotionDiscount: broj(a.promotionDiscount),
    // PDV blok
    goodsTaxRateCode: tekst(a.goodsTaxRateCode),
    goodsTaxTotalRate: procenatEho(a.goodsTaxTotalRate),
    alwaysTaxGoods: daNe(a.alwaysTaxGoods),
    serviceTaxRateCode: tekst(a.serviceTaxRateCode),
    serviceTaxTotalRate: procenatEho(a.serviceTaxTotalRate),
    alwaysTaxServices: daNe(a.alwaysTaxServices),
    // Opisi, linkovi, napomene
    webDescription: tekst(a.webDescription),
    pdfLink: tekst(a.pdfLink),
    manufacturer: tekst(a.manufacturer),
    symbolImageLink: tekst(a.symbolImageLink),
    wordLocation: tekst(a.wordLocation),
    note2: tekst(a.note2),
    memo: tekst(a.memo),
    // Desni donji blok
    accountingCode: tekst(a.accountingCode),
    rasterId: sifarnickaVrednost(a.rasterName, a.rasterId),
    signature: tekst(a.signature),
    qualityTypeId: sifarnickaVrednost(a.qualityName, a.qualityTypeId),
    thickness: broj(a.thickness),
    createdAt: datumVreme(a.createdAt),
    // Dodatna polja (van BigBit forme)
    id: sifra(a.id),
    fxPurchasePrice: broj(a.fxPurchasePrice),
    priceToWritePricelist: broj(a.priceToWritePricelist),
    manualMarkupPercent: broj(a.manualMarkupPercent),
    finalProcessingCost: broj(a.finalProcessingCost),
    wholesaleLossPercent: broj(a.wholesaleLossPercent),
    retailLossPercent: broj(a.retailLossPercent),
    nonTaxablePart: broj(a.nonTaxablePart),
    baseUnit: tekst(a.baseUnit),
    quantityInPackage: broj(a.quantityInPackage),
    weightKg: broj(a.weightKg),
    volume: broj(a.volume),
    area: broj(a.area),
    itemDescription: tekst(a.itemDescription),
    foreignUnit: tekst(a.foreignUnit),
    hps: tekst(a.hps),
    sortOrder: sifra(a.sortOrder),
    supplierId: sifra(a.supplierId),
    issuePlaceId: sifra(a.issuePlaceId),
    notStockTracked: daNe(a.notStockTracked),
    active: daNe(a.active),
    toDelete: daNe(a.toDelete),
  };
}
