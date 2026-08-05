import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRANA_ARTIKAL,
  BRANA_KOMITENT,
  formatirajBroj,
  formatirajTekuciRacun,
  ispravanGln,
  ispravanPib,
  ispravanTekuciRacun,
  izmenjenaPolja,
  kbroj97,
  parsirajBroj,
  predlogKataloskogBroja,
  prethodnoPolje,
  proveriBroj,
  proveriGln,
  proveriKataloskiBroj,
  proveriObavezno,
  proveriPib,
  proveriTekuciRacun,
  redosledFokusa,
  sledecePolje,
  sporneStavke,
  type SekcijaDef,
} from './pravila';
import type { ItemDetail } from '@/api/masters';
import { SEKCIJE_KOMITENT } from '@/app/komitenti/_forma/komitent-polja';
import { SEKCIJE_ARTIKAL, praznArtikal, vrednostiIzArtikla } from './artikal-polja';

/**
 * Pokretanje (frontend nema jest ni vitest — v. `package.json`), iz `frontend/`:
 *   node --import ./src/app/artikli/_forma/test-runner.mjs --test "src/app/**‌/*.spec.ts"
 * Node 22.18+/24 sam skida tipove; `test-runner.mjs` samo dopisuje `.ts` pri
 * razrešavanju putanje (v. komentar u tom fajlu — ESM i `tsc` traže suprotno).
 */

/* ─────────────────────────────────────────────────────── BRANA je ZATVORENA */

test('brana je zatvorena za oba entiteta — ekran ne sme ništa da pošalje', () => {
  assert.equal(BRANA_ARTIKAL.otvorena, false);
  assert.equal(BRANA_KOMITENT.otvorena, false);
});

test('poruka komitenta je doslovna kopija backend konstante BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE', () => {
  // Izvor: backend/src/modules/directory/bigbit-owned.ts (BIGBIT_CUSTOMERS_READ_ONLY_MESSAGE).
  // Ako se tamo promeni tekst, ovaj test pada i tera da se promeni i ovde (nema
  // deljenog paketa poruka). Tekst od reopena 061/26 (04.08.2026): komitent stiže
  // noćnim .mdb uvozom — dugme „Pokreni sync" ga ne može doneti (frozen QBigTehn).
  assert.equal(
    BRANA_KOMITENT.poruka,
    'Komitente vodi BigBit — u ServoSync-u se ne unose ni ne menjaju (odluka 26.07.2026). ' +
      'Novog komitenta unesite u BigBit — ovde stiže automatski noćnim uvozom: uneto do ' +
      '17:30 vidi se sutra ujutru, kasnije prekosutra. Bržeg puta nema (izvoz iz BigBita ide ' +
      'jednom dnevno) — ako je hitno, javite u BigBit-u da izvezu ranije.',
  );
});

test('svaki uslov brane ima izvor u kodu — nalaz se ne mora ponovo tražiti', () => {
  for (const brana of [BRANA_ARTIKAL, BRANA_KOMITENT]) {
    assert.ok(brana.uslovi.length > 0, `${brana.entitet}: nema nijedan uslov`);
    for (const u of brana.uslovi) {
      assert.ok(u.tekst.trim().length > 10, `${brana.entitet}: prazan opis uslova`);
      assert.match(u.izvor, /\.(ts|prisma|md|sql)/, `${brana.entitet}: izvor nije fajl — „${u.izvor}“`);
    }
  }
});

/* ──────────────────────────────────────────── decimalni zarez = decimalna tačka */

test('zarez i tačka rade isto', () => {
  assert.equal(parsirajBroj('12,5').vrednost, 12.5);
  assert.equal(parsirajBroj('12.5').vrednost, 12.5);
});

test('prazno polje je legitimno (null, ne 0)', () => {
  const p = parsirajBroj('   ');
  assert.equal(p.ok, true);
  assert.equal(p.vrednost, null);
});

test('zarez pobeđuje: tačke su tada hiljade', () => {
  assert.equal(parsirajBroj('1.234,50').vrednost, 1234.5);
  assert.equal(parsirajBroj('1.234.567,89').vrednost, 1234567.89);
});

test('više tačaka bez zareza = hiljade', () => {
  assert.equal(parsirajBroj('1.234.567').vrednost, 1234567);
});

test('jedna tačka + TAČNO tri cifre = hiljade (round-trip našeg ispisa)', () => {
  // Regresija: parser nije umeo da pročita ono što polje samo ispisuje.
  // `Intl.NumberFormat('sr-RS')` 500000 prikaže kao „500.000", a stari parser
  // je to vraćao kao 500 — kreditni limit od pola miliona postajao bi 500 din.
  assert.equal(parsirajBroj('1.234').vrednost, 1234);
  assert.equal(parsirajBroj('500.000').vrednost, 500000);
  assert.equal(parsirajBroj('12.345').vrednost, 12345);
});

test('jedna tačka + drugačiji broj cifara ostaje DECIMALNA (navika sa engleske tastature)', () => {
  assert.equal(parsirajBroj('12.5').vrednost, 12.5);
  assert.equal(parsirajBroj('12.45').vrednost, 12.45);
  assert.equal(parsirajBroj('1.2345').vrednost, 1.2345);
});

test('round-trip: ispis pa čitanje vraća isti broj', () => {
  for (const n of [500000, 1234, 12345, 999999, 1000, 2500000, 12.5, 1234.5]) {
    assert.equal(parsirajBroj(formatirajBroj(n, 6)).vrednost, n);
  }
});

test('razmaci i NBSP iz Excel-a se ignorišu', () => {
  assert.equal(parsirajBroj('1 234,5').vrednost, 1234.5);
  assert.equal(parsirajBroj(' 42 ').vrednost, 42);
});

test('negativan broj prolazi (nivelacija ume da bude minus)', () => {
  assert.equal(parsirajBroj('-12,5').vrednost, -12.5);
});

test('nepotpun unos „12," i „,5" se čita, ne odbija', () => {
  assert.equal(parsirajBroj('12,').vrednost, 12);
  assert.equal(parsirajBroj(',5').vrednost, 0.5);
});

test('slovo u broju daje poruku ŠTA da se uradi, ne „Nevalidna vrednost"', () => {
  const p = parsirajBroj('12x');
  assert.equal(p.ok, false);
  assert.match(p.greska ?? '', /decimale odvoji zarezom/);
  assert.doesNotMatch(p.greska ?? '', /[Nn]evalidn/);
});

test('dva zareza se odbijaju sa konkretnom uputom', () => {
  const p = parsirajBroj('1,2,3');
  assert.equal(p.ok, false);
  assert.match(p.greska ?? '', /samo jedan decimalni zarez/);
});

test('proveriBroj vraća pročitanu vrednost kao eho (dvosmislenost se vidi odmah)', () => {
  assert.equal(proveriBroj('1.234').poruka, '= 1.234');
  assert.equal(proveriBroj('1.234,5').poruka, '= 1.234,5');
});

test('opseg: negativna težina se odbija sa porukom', () => {
  const r = proveriBroj('-3', { min: 0 });
  assert.equal(r.ton, 'greska');
  assert.match(r.poruka ?? '', /ne sme biti manja/);
});

/* ───────────────────────────────────────────────────────────────── PIB */

test('ispravanPib — sidro iz backend porta (Telekom Srbija)', () => {
  assert.equal(ispravanPib('100002887'), true);
  assert.equal(ispravanPib('SR100002887'), true);
  assert.equal(ispravanPib('100002888'), false);
});

test('PIB dok se kuca: ispod 9 cifara NIJE crveno', () => {
  assert.equal(proveriPib('1000').ton, 'u-toku');
  assert.equal(proveriPib('10000288').ton, 'u-toku');
});

test('PIB: deveta cifra odmah presuđuje zeleno/crveno', () => {
  assert.equal(proveriPib('100002887').ton, 'ok');
  assert.equal(proveriPib('100002888').ton, 'greska');
});

test('PIB: greška kaže i izlaz za strano lice („Ne proveravaj PIB")', () => {
  assert.match(proveriPib('100002888').poruka ?? '', /Ne proveravaj PIB/);
});

test('PIB: „Ne proveravaj PIB" gasi crveno (BigBit NeProveravajPIB)', () => {
  assert.equal(proveriPib('ABC-123', true).ton, 'neutralno');
});

test('PIB: XX_<šifra> je BigBit placeholder, ne greška', () => {
  assert.equal(proveriPib('XX_4821').ton, 'neutralno');
});

test('PIB: prazno je upozorenje sa uputstvom, ne tiho ne-dešavanje', () => {
  const r = proveriPib('');
  assert.equal(r.ton, 'upozorenje');
  assert.match(r.poruka ?? '', /obavezan/);
});

test('PIB: više od 9 cifara je greška (legacy port je tolerantan, ekran nije)', () => {
  assert.equal(proveriPib('1000028871').ton, 'greska');
});

/* ───────────────────────────────────────────────────────────────── GLN */

test('GLN — 6..14 cifara, bez GS1 kontrolne cifre', () => {
  assert.equal(ispravanGln('123456'), true);
  assert.equal(ispravanGln('12345678901234'), true);
  assert.equal(ispravanGln('12345'), false);
  assert.equal(ispravanGln('123456789012345'), false);
  assert.equal(ispravanGln('12345a'), false);
});

test('GLN dok se kuca: kratko je „u toku", ne greška', () => {
  assert.equal(proveriGln('123').ton, 'u-toku');
  assert.equal(proveriGln('123456').ton, 'ok');
  assert.equal(proveriGln('').ton, 'neutralno');
});

/* ────────────────────────────────────────────────────────── tekući račun */

test('kbroj97 je uvek dvocifren', () => {
  assert.match(kbroj97('1600000000000000'), /^\d{2}$/);
  assert.equal(kbroj97(''), '');
});

test('DobarTR: račun sa ispravnim kontrolnim brojem prolazi', () => {
  const banka = '160';
  const sredina = '0000000012345';
  const kk = kbroj97(banka + sredina);
  assert.equal(ispravanTekuciRacun(`${banka}-${sredina}-${kk}`), true);
});

test('DobarTR: pogrešan kontrolni broj pada', () => {
  const banka = '160';
  const sredina = '0000000012345';
  const kk = kbroj97(banka + sredina);
  const pogresan = kk === '00' ? '01' : '00';
  assert.equal(ispravanTekuciRacun(`${banka}-${sredina}-${pogresan}`), false);
});

test('DobarTR: sredina kraća od 13 se dopuni nulama (legacy pravilo)', () => {
  const kk = kbroj97('160' + '12345'.padStart(13, '0'));
  assert.equal(ispravanTekuciRacun(`160-12345-${kk}`), true);
});

test('DobarTR: bez crtica pada (format se rekonstruiše)', () => {
  assert.equal(ispravanTekuciRacun('160000000001234516'), false);
});

test('18 golih cifara se formatira u bbb-…-kk', () => {
  assert.equal(formatirajTekuciRacun('160000000001234516'), '160-0000000012345-16');
  assert.equal(formatirajTekuciRacun('160-0000000012345-16'), '160-0000000012345-16');
  assert.equal(formatirajTekuciRacun('123'), '123');
});

test('račun dok se kuca: gole cifre su „u toku", ne greška', () => {
  assert.equal(proveriTekuciRacun('16000').ton, 'u-toku');
  assert.equal(proveriTekuciRacun('').ton, 'neutralno');
  assert.equal(proveriTekuciRacun('160/123/16').ton, 'greska');
});

/* ──────────────────────────────────────────────────────── kataloški broj */

test('predlog kataloškog broja je 5 cifara sa vodećim nulama (BigBit DoChLeft)', () => {
  assert.equal(predlogKataloskogBroja(0), '00001');
  assert.equal(predlogKataloskogBroja(4710), '04711');
  assert.equal(predlogKataloskogBroja(99999), '100000');
});

test('kataloški broj: prazan je upozorenje, predugačak je greška', () => {
  assert.equal(proveriKataloskiBroj('').ton, 'upozorenje');
  assert.equal(proveriKataloskiBroj('4711-02').ton, 'ok');
  assert.equal(proveriKataloskiBroj('x'.repeat(21)).ton, 'greska');
});

test('obavezno polje imenuje sebe u poruci', () => {
  assert.match(proveriObavezno('', 'Naziv').poruka ?? '', /Naziv/);
  assert.equal(proveriObavezno('Ležaj', 'Naziv').ton, 'ok');
});

/* ──────────────────────────────────────────────────── redosled fokusa (Enter) */

const SEKCIJE: SekcijaDef[] = [
  {
    naslov: 'Prva',
    polja: [
      { id: 'a', labela: 'A', tip: 'tekst', proveri: (v) => proveriObavezno(v, 'A') },
      { id: 'b', labela: 'B', tip: 'tekst' },
    ],
  },
  { naslov: 'Druga', polja: [{ id: 'c', labela: 'C', tip: 'broj', proveri: (v) => proveriBroj(v, { min: 0 }) }] },
];

test('Enter ide kroz sekcije redom kojim su napisane', () => {
  assert.deepEqual(redosledFokusa(SEKCIJE), ['a', 'b', 'c']);
  assert.equal(sledecePolje(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(sledecePolje(['a', 'b', 'c'], 'b'), 'c');
});

test('poslednje polje vraća null (pozivalac fokusira Snimi)', () => {
  assert.equal(sledecePolje(['a', 'b', 'c'], 'c'), null);
  assert.equal(prethodnoPolje(['a', 'b', 'c'], 'a'), null);
  assert.equal(prethodnoPolje(['a', 'b', 'c'], 'c'), 'b');
});

test('nepoznato polje ne ruši navigaciju', () => {
  assert.equal(sledecePolje(['a', 'b'], 'zzz'), null);
});

test('sporne stavke skupljaju i obavezno-prazno i pogrešan broj', () => {
  const sporne = sporneStavke(SEKCIJE, { a: '', b: '', c: '-5' });
  assert.deepEqual(
    sporne.map((s) => s.id),
    ['a', 'c'],
  );
});

test('kad je sve popunjeno nema spornih stavki', () => {
  assert.deepEqual(sporneStavke(SEKCIJE, { a: 'x', b: '', c: '12,5' }), []);
});

/* ───────────────────────────────────────────────────── brojanje izmena */

test('izmena teksta se broji', () => {
  assert.deepEqual(
    izmenjenaPolja(SEKCIJE, { a: 'x', b: '', c: '' }, { a: 'y', b: '', c: '' }),
    ['a'],
  );
});

test('12,50 i 12.5 su ISTI broj — ne prijavljuje se lažna izmena', () => {
  assert.deepEqual(
    izmenjenaPolja(SEKCIJE, { a: '', b: '', c: '12,50' }, { a: '', b: '', c: '12.5' }),
    [],
  );
});

test('stvarna izmena broja se broji', () => {
  assert.deepEqual(
    izmenjenaPolja(SEKCIJE, { a: '', b: '', c: '12,5' }, { a: '', b: '', c: '13' }),
    ['c'],
  );
});

test('nedostajući ključ u polaznom slogu se tretira kao prazno', () => {
  assert.deepEqual(izmenjenaPolja(SEKCIJE, {}, { a: '', b: '', c: '' }), []);
  assert.deepEqual(izmenjenaPolja(SEKCIJE, {}, { a: 'novo', b: '', c: '' }), ['a']);
});

/* ─────────────────────── BigBit paritet forme „Unos artikala“ (04.08.2026) */

/**
 * Zahtev vlasnika: „otvaranje artikala da ima ista polja i isti raspored, što više da
 * bude isto da se ne menja navika korisnika.“ Testovi ispod čuvaju upravo to — redosled
 * polja, celovitost mreže i to da se ništa nije izgubilo pri premeštanju.
 */

const ARTIKAL_SLOG = {
  id: 12345,
  externalItemId: 58143,
  catalogNumber: '00042',
  name: 'Lim 2 mm',
  group: { code: 'G1', description: 'Limovi' },
  subgroup: { code: 'S1', description: 'Hladno valjani' },
  origin: { code: 'P1', description: 'Domaći' },
  createdAt: '2026-08-04T10:30:00.000Z',
} as unknown as ItemDetail;

test('svako polje forme ima vrednost — nijedno se ne crta prazno bez razloga', () => {
  const izSloga = vrednostiIzArtikla(ARTIKAL_SLOG);
  const prazan = praznArtikal();
  for (const s of SEKCIJE_ARTIKAL) {
    for (const p of s.polja) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(izSloga, p.id),
        `vrednostiIzArtikla ne mapira „${p.id}“ (${s.naslov} → ${p.labela})`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(prazan, p.id),
        `praznArtikal ne mapira „${p.id}“ (${s.naslov} → ${p.labela})`,
      );
    }
  }
});

test('nijedno polje se ne pojavljuje dvaput (id je i ključ vrednosti i redosled fokusa)', () => {
  const svi = SEKCIJE_ARTIKAL.flatMap((s) => s.polja.map((p) => p.id));
  assert.equal(new Set(svi).size, svi.length, `duplikat među: ${svi.join(', ')}`);
});

test('prvi ekran prati redosled BigBit forme, red po red, sleva nadesno', () => {
  // Izvučeno iz same Access baze (kontrole forme „Unos artikala“ sa x/y koordinatama).
  assert.deepEqual(
    SEKCIJE_ARTIKAL[0].polja.map((p) => p.id),
    [
      'externalItemId',
      'catalogNumber', 'barCode', 'name',
      'packaging', 'unit', 'box', 'transportPackaging',
      'externalCode', 'maxDiscountPercent', 'groupCode', 'groupDescription',
      'minQuantity', 'paymentTermDays', 'subgroupCode', 'subgroupDescription',
      'wholesalePrice', 'retailPrice', 'originCode', 'originDescription',
      'fxSalePrice', 'plu', 'accountingCode2',
      'customsRate', 'customsTariff', 'foreignName',
      'originCountry', 'itemExcise', 'itemFee',
      'shelf', 'weight', 'promotionDiscount',
    ],
  );
});

test('doslovne BigBit labele se ne „ulepšavaju“', () => {
  const labele = new Map(
    SEKCIJE_ARTIKAL.flatMap((s) => s.polja).map((p) => [p.id, p.labela] as const),
  );
  assert.equal(labele.get('box'), 'Kilograma u komadu');
  assert.equal(labele.get('transportPackaging'), 'Transp. pakovanje');
  assert.equal(labele.get('wholesalePrice'), 'VP cena iz posl. KL');
  assert.equal(labele.get('retailPrice'), 'MP cena iz posl. KL');
  assert.equal(labele.get('fxSalePrice'), 'MP devizna cena');
  assert.equal(labele.get('paymentTermDays'), 'Odloženo plaćanje (dana)');
  assert.equal(labele.get('accountingCode2'), 'Grupa za šemu');
  assert.equal(labele.get('accountingCode'), 'Kng. šifra');
  assert.equal(labele.get('foreignName'), 'INO Naziv');
  assert.equal(labele.get('rasterId'), 'Dimenzija (mm)');
  assert.equal(labele.get('qualityTypeId'), 'Kvalitet artikla');
  assert.equal(labele.get('thickness'), 'Debljina lima(mm)');
  assert.equal(labele.get('note2'), 'Napomena 2 ( viskoznost )');
  assert.equal(labele.get('symbolImageLink'), 'Slika simbola (jpg lokacija)');
  assert.equal(labele.get('wordLocation'), 'Tabela za sliku simbola (Word lokacija)');
  // Poreklo se u BigBit formi i pregledu zove „PodPodgrupa“ — tako ga korisnici zovu.
  assert.equal(labele.get('originCode'), 'PodPodgrupa');
});

test('u gustoj mreži nijedan red ne straduje — rasponi popunjavaju tačno 12 kolona', () => {
  for (const s of SEKCIJE_ARTIKAL) {
    if (s.mreza !== 12) continue;
    let u = 0;
    for (const p of s.polja) {
      u += p.raspon ?? 1;
      assert.ok(u <= 12, `„${s.naslov}“: polje ${p.id} prelazi ivicu reda (${u}/12)`);
      if (u === 12) u = 0;
    }
    assert.equal(u, 0, `„${s.naslov}“: poslednji red nije popunjen (ostalo ${12 - u}/12)`);
  }
});

test('opis grupe/podgrupe/podpodgrupe se čita iz šifarnika i ne kuca se', () => {
  const v = vrednostiIzArtikla(ARTIKAL_SLOG);
  assert.equal(v.groupDescription, 'Limovi');
  assert.equal(v.subgroupDescription, 'Hladno valjani');
  assert.equal(v.originDescription, 'Domaći');
  for (const id of ['groupDescription', 'subgroupDescription', 'originDescription']) {
    const p = SEKCIJE_ARTIKAL.flatMap((s) => s.polja).find((x) => x.id === id);
    assert.ok(p?.zakljucano, `„${id}“ mora biti zaključan — to je eho šifarnika`);
  }
});

test('šifre se ispisuju sirove, bez tačke za hiljade (BigBit ih tako prikazuje)', () => {
  const v = vrednostiIzArtikla(ARTIKAL_SLOG);
  assert.equal(v.externalItemId, '58143');
  assert.equal(v.id, '12345');
});

test('D2 — „Dodatna polja“ su POSLEDNJA sekcija, sklopiva i zatvorena', () => {
  const poslednja = SEKCIJE_ARTIKAL[SEKCIJE_ARTIKAL.length - 1];
  assert.equal(poslednja.naslov, 'Dodatna polja (van BigBit forme)');
  assert.equal(poslednja.sklopivo, true);
  assert.equal(poslednja.podrazumevanoZatvoreno, true);
  // Ništa se ne briše: polja koja BigBit forma ne prikazuje i dalje postoje.
  for (const id of ['fxPurchasePrice', 'weightKg', 'volume', 'area', 'hps', 'active', 'toDelete']) {
    assert.ok(
      poslednja.polja.some((p) => p.id === id),
      `„${id}“ je nestalo iz forme umesto da se sklopi`,
    );
  }
});

test('D1 — paritet izgleda nije otvorio upis', () => {
  assert.equal(BRANA_ARTIKAL.otvorena, false);
});

test('ADITIVNOST — komitenti ostaju na zatečenoj mreži i bez sklapanja', () => {
  // `mreza` i `sklopivo` su uvedeni za BigBit paritet artikla; da su obavezni ili da su
  // podrazumevano uključeni, ekran komitenta bi se pomerio bez ijedne izmene u njegovom
  // fajlu. Ovaj test je brana za to.
  for (const s of SEKCIJE_KOMITENT) {
    assert.equal(s.mreza, undefined, `„${s.naslov}“: komitent ne sme dobiti gustu mrežu`);
    assert.equal(s.sklopivo, undefined, `„${s.naslov}“: komitent ne sme dobiti sklapanje`);
    for (const p of s.polja) {
      assert.ok(
        p.raspon === undefined || p.raspon === 1 || p.raspon === 2 || p.raspon === 4,
        `„${s.naslov}“ → ${p.id}: raspon ${p.raspon} nije iz zatečenog skupa 1/2/4`,
      );
    }
  }
});
