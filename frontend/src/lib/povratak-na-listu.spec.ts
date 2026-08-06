import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  citajIzvorListeArtikala,
  citajZapisPozicije,
  odlukaOPoziciji,
  putanjaListeArtikala,
  type ZapisPozicijeListe,
} from '@/lib/povratak-na-listu';

/**
 * Prijava vlasnika 07.08.2026: „Kada uđem u detaljno artikal u lager listi, i vratim se
 * jedan korak nazad, vrati me na početnu stranu. Ne zadržava trenutnu poziciju."
 *
 * Dva odvojena kvara — oba se mere ovde:
 *   A) detalj se otvarao BEZ `izvor`, pa je „Nazad" vodio na pregled artikala (tuđa
 *      lista, tuđi filteri) umesto na lager;
 *   B) i kad se vrati na lager, vraća se na VRH — mesto u beskonačnom skrolu se nigde
 *      nije pamtilo.
 */

const KOREN = path.resolve(import.meta.dirname, '..');
const LAGER = path.join(KOREN, 'app', 'artikli', 'lager', 'page.tsx');
const DETALJ = path.join(KOREN, 'app', 'artikli', 'detalj', 'page.tsx');
const KARTICA = path.join(KOREN, 'app', 'artikli', 'kartica', 'page.tsx');

const izvor = (f: string) => fs.readFileSync(f, 'utf8');

/**
 * Provera nad izvorom se NE piše kroz `assert.match`: kad padne, on u poruku ispiše ceo
 * `page.tsx` (preko 1.000 redova) i pravi nalaz se u tome izgubi. `assert.ok` ispisuje
 * samo rečenicu — a rečenica kaže šta je pokvareno.
 */
function sadrzi(src: string, re: RegExp, poruka: string): void {
  assert.ok(re.test(src), poruka);
}
function neSadrzi(src: string, re: RegExp, poruka: string): void {
  assert.ok(!re.test(src), poruka);
}

// ───────────────────────────────────────────────────── A. na KOJU listu se vraća

describe('izvor liste artikala', () => {
  test('`izvor=lager` iz adrese vodi nazad na lager listu', () => {
    assert.equal(citajIzvorListeArtikala('?id=42&izvor=lager'), 'lager');
    assert.equal(putanjaListeArtikala(citajIzvorListeArtikala('?id=42&izvor=lager')), '/artikli/lager');
  });

  test('bez `izvor` (deljen link, pregled artikala) vodi na pregled artikala', () => {
    assert.equal(citajIzvorListeArtikala('?id=42'), 'artikli');
    assert.equal(citajIzvorListeArtikala(''), 'artikli');
    assert.equal(putanjaListeArtikala(citajIzvorListeArtikala('?id=42')), '/artikli');
  });

  test('prelomljena vrednost ne obara „Nazad" nego pada na pregled artikala', () => {
    for (const s of ['?izvor=', '?izvor=smece', '?izvor=LAGER', '?izvor=lager2', '?izvor[]=lager']) {
      assert.equal(citajIzvorListeArtikala(s), 'artikli', s);
    }
  });
});

/**
 * VEZA EKRANA I POMOĆNIKA — merena nad IZVOROM, namerno.
 *
 * `npm test` je goli `node --test`: JSX se ne prevodi, pa se `page.tsx` ne može uvesti
 * ni izvršiti. Bez ove provere bi pomoćnik iznad mogao biti savršen a ekran ga ne bi
 * ni zvao — a upravo to je i bio kvar A: `citajIzvorListeArtikala` logika je već
 * postojala (ugrađena u karticu), samo je detalj nije koristio.
 */
describe('ekrani artikala su povezani na izvor liste', () => {
  test('lager svaki prelaz na detalj/karticu potpisuje sa `izvor=lager`', () => {
    const src = izvor(LAGER);
    const adrese = [...src.matchAll(/`\/artikli\/(?:detalj|kartica)\?[^`]*`/g)].map((m) => m[0]);
    assert.ok(adrese.length >= 2, 'lager više ne otvara detalj i karticu — test je zastareo');
    for (const a of adrese) {
      assert.ok(/[?&]izvor=lager/.test(a), `prelaz bez izvora vodi na tuđu listu: ${a}`);
    }
  });

  test('detalj artikla izvodi povratak iz `izvor`, a ne iz zakucane putanje', () => {
    const src = izvor(DETALJ);
    sadrzi(src, /citajIzvorListeArtikala/, 'detalj ne čita odakle je došao');
    sadrzi(src, /putanjaListeArtikala/, 'detalj ne izvodi putanju liste iz izvora');
    neSadrzi(
      src,
      /listHref\(\s*['"]\/artikli['"]\s*\)/,
      'izlaz sa detalja je i dalje tvrdo zakucan na pregled artikala',
    );
  });

  test('kartica artikla koristi ISTOG pomoćnika (jedan izvor za oba ekrana)', () => {
    const src = izvor(KARTICA);
    sadrzi(src, /citajIzvorListeArtikala/, 'kartica drži sopstvenu kopiju čitanja izvora');
    sadrzi(src, /putanjaListeArtikala/, 'kartica drži sopstvenu kopiju putanja listi');
  });

  test('kartica PROSLEĐUJE izvor dalje na detalj (lager → kartica → detalj)', () => {
    // Bez ovoga trag pukne posle prvog skoka: sa detalja otvorenog iz kartice „Nazad"
    // opet vodi na pregled artikala, iako je put počeo u lageru.
    const src = izvor(KARTICA);
    const adrese = [...src.matchAll(/`\/artikli\/detalj\?[^`]*`/g)].map((m) => m[0]);
    assert.ok(adrese.length >= 1, 'kartica više ne otvara detalj — test je zastareo');
    for (const a of adrese) {
      assert.ok(/[?&]izvor=\$\{izvor\}/.test(a), `izvor se gubi na skoku ka detalju: ${a}`);
    }
  });
});

// ────────────────────────────────────────────── B. na KOJE MESTO u listi se vraća

const ZAPIS: ZapisPozicijeListe = { potpis: 'A', strane: 3, redova: 600, skrol: 1840 };

describe('čitanje zapamćenog mesta', () => {
  test('ispravan zapis prolazi u celini', () => {
    assert.deepEqual(citajZapisPozicije(JSON.stringify(ZAPIS)), ZAPIS);
  });

  test('smeće daje null umesto izuzetka (pamćenje je udobnost, ne uslov)', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'nije json',
      '[]',
      'null',
      '"tekst"',
      JSON.stringify({ strane: 3, redova: 600, skrol: 10 }), // fali potpis
      JSON.stringify({ ...ZAPIS, potpis: 7 }),
      JSON.stringify({ ...ZAPIS, skrol: 'puno' }),
      JSON.stringify({ ...ZAPIS, skrol: Number.NaN }),
      JSON.stringify({ ...ZAPIS, redova: -1 }),
      JSON.stringify({ ...ZAPIS, strane: 0 }), // ništa nije bilo učitano
    ]) {
      assert.equal(citajZapisPozicije(raw as string | null), null, String(raw));
    }
  });
});

describe('odluka o vraćanju na zapamćeno mesto', () => {
  test('isti filter i pun keš — skrol se vraća', () => {
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'A', 3), { vrsta: 'vrati', skrol: 1840 });
  });

  test('🔴 drugi potpis filtera — restauracija se ODBIJA', () => {
    // Inače korisnik posle filtriranja završi nasred spiska koji nikad nije video.
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'B', 3), { vrsta: 'nista' });
    // I to bez obzira na to što keš ima dovoljno strana.
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'B', 99), { vrsta: 'nista' });
  });

  test('nema zapisa — ništa se ne radi', () => {
    assert.deepEqual(odlukaOPoziciji(null, 'A', 3), { vrsta: 'nista' });
  });

  test('keš ne drži sve strane — odustaje se, NE dovlači se u petlji', () => {
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'A', 1), { vrsta: 'odustani', ranijeRedova: 600 });
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'A', 0), { vrsta: 'odustani', ranijeRedova: 600 });
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'A', 2), { vrsta: 'odustani', ranijeRedova: 600 });
  });

  test('keš drži i više strana nego što je zapamćeno — skrol se i dalje vraća', () => {
    assert.deepEqual(odlukaOPoziciji(ZAPIS, 'A', 5), { vrsta: 'vrati', skrol: 1840 });
  });

  test('skrol je bio na vrhu — okvir se ne dira', () => {
    assert.deepEqual(odlukaOPoziciji({ ...ZAPIS, skrol: 0 }, 'A', 3), { vrsta: 'nista' });
  });
});

/**
 * Hook mesto pamti u `sessionStorage`, NIKAD u URL-u — dve zamke odjednom:
 *   • `useListQueryState.setValues` radi `router.replace`, pa bi svaki događaj skrola
 *     upisivao u istoriju pregledača;
 *   • adresa lagera se po dizajnu šalje kolegi u poruci, a `?strane=15` bi kod
 *     primaoca okinuo 15 sekvencijalnih agregacija nad ogledalom.
 */
describe('mesto u listi ne curi u URL', () => {
  test('lager ne upisuje skrol ni broj strana kroz setValues', () => {
    const src = izvor(LAGER);
    for (const m of src.matchAll(/setValues\(\s*\{[^}]*\}/g)) {
      assert.ok(!/\b(skrol|strane|pozicija|scrollTop)\b/.test(m[0]), `skrol curi u URL: ${m[0]}`);
    }
    neSadrzi(src, /\bstrane:\s*String\(/, 'broj strana se upisuje u URL');
  });
});
