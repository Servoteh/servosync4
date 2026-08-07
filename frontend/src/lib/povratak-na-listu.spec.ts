import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ULAZI_ARTIKAL,
  ULAZI_KOMITENT,
  ULAZI_ROBNI_DOKUMENT,
  citajIzvor,
  citajZapisPozicije,
  hrefIzvora,
  odlukaOPoziciji,
  serijalizujStanjeListe,
  spojiStanjeListe,
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
const ARTIKLI = path.join(KOREN, 'app', 'artikli', 'page.tsx');
const MASTERS = path.join(KOREN, 'api', 'masters.ts');
const USE_ID_PARAM = path.join(KOREN, 'lib', 'use-id-param.ts');
const ROBNO = path.join(KOREN, 'app', 'robno', 'page.tsx');
const ROBNO_DETALJ = path.join(KOREN, 'app', 'robno', 'detalj', 'page.tsx');
const ROBNO_PRENOS = path.join(KOREN, 'app', 'robno', 'detalj', 'transfer-panel.tsx');
const POPIS = path.join(KOREN, 'app', 'robno', 'popis', 'page.tsx');
const POPIS_DETALJ = path.join(KOREN, 'app', 'robno', 'popis', 'count-detail.tsx');
const KOMITENTI = path.join(KOREN, 'app', 'komitenti', 'page.tsx');
const KOMITENT_DETALJ = path.join(KOREN, 'app', 'komitenti', 'detalj', 'page.tsx');
const KOMITENT_NOV = path.join(KOREN, 'app', 'komitenti', 'nov', 'page.tsx');
const INTEGRACIJE = path.join(KOREN, 'app', 'podesavanja', '_components', 'integracije-tab.tsx');

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
    assert.equal(citajIzvor('?id=42&izvor=lager', ULAZI_ARTIKAL, 'artikli'), 'lager');
    assert.equal(hrefIzvora(ULAZI_ARTIKAL.lager), '/artikli/lager');
  });

  test('bez `izvor` (deljen link, pregled artikala) vodi na pregled artikala', () => {
    assert.equal(citajIzvor('?id=42', ULAZI_ARTIKAL, 'artikli'), 'artikli');
    assert.equal(citajIzvor('', ULAZI_ARTIKAL, 'artikli'), 'artikli');
    assert.equal(hrefIzvora(ULAZI_ARTIKAL.artikli), '/artikli');
  });

  test('prelomljena vrednost ne obara „Nazad" nego pada na pregled artikala', () => {
    for (const s of ['?izvor=', '?izvor=smece', '?izvor=LAGER', '?izvor=lager2', '?izvor[]=lager']) {
      assert.equal(citajIzvor(s, ULAZI_ARTIKAL, 'artikli'), 'artikli', s);
    }
  });

  test('🔴 ključ iz prototipa NIJE validan izvor', () => {
    // `v in ulazi` bi ovde prošao i `hrefIzvora(ULAZI[v])` bi dobio funkciju umesto ulaza —
    // dugme „Nazad" bi puklo na `undefined.putanja`. Zato provera ide preko `hasOwnProperty`.
    for (const s of ['?izvor=constructor', '?izvor=__proto__', '?izvor=toString', '?izvor=valueOf']) {
      assert.equal(citajIzvor(s, ULAZI_ARTIKAL, 'artikli'), 'artikli', s);
    }
  });
});

/**
 * Meta koja NIJE radna lista (tab u Podešavanjima, kartica) ne sme kroz `listHref`:
 * za nju ne postoji zapis `listState:` pa bi je `listHref` svukao na podrazumevani tab.
 */
describe('href izvora razlikuje radnu listu od ostalih ulaza', () => {
  test('radna lista ide kroz `listHref` (u testu bez `window` → gola putanja)', () => {
    assert.equal(hrefIzvora({ putanja: '/robno' }), '/robno');
    assert.equal(hrefIzvora({ putanja: '/robno', radnaLista: true }), '/robno');
  });

  test('ulaz koji nije lista nosi SVOJ fiksan query', () => {
    assert.equal(
      hrefIzvora({ putanja: '/podesavanja', radnaLista: false, query: 'tab=integracije' }),
      '/podesavanja?tab=integracije',
    );
    assert.equal(hrefIzvora({ putanja: '/podesavanja', radnaLista: false }), '/podesavanja');
  });
});

// ──────────────────────────────────── A2. stanje liste se pamti i BEZ diranja filtera

describe('serijalizacija stanja radne liste', () => {
  const D = { tab: 'inbox', strana: '1', trazi: '' };

  test('sve podrazumevano → prazno (adresa ostaje čitljiva)', () => {
    assert.equal(serijalizujStanjeListe({ ...D }, D), '');
  });

  test('samo ono što odstupa od podrazumevanog', () => {
    assert.equal(serijalizujStanjeListe({ ...D, strana: '7' }, D), 'strana=7');
  });

  test('prazna vrednost se izostavlja i kad podrazumevana nije prazna', () => {
    assert.equal(serijalizujStanjeListe({ ...D, tab: '' }, D), '');
  });

  test('🔴 ključ koji nije u `defaults` se NE piše (tuđi parametar ne curi u „Nazad")', () => {
    assert.equal(serijalizujStanjeListe({ ...D, open: '3', izvor: 'lager' }, D), '');
  });
});

describe('spajanje stanja radne liste (ugnežđeni pogledi)', () => {
  // `/glavna-knjiga` ima DVA pisca istog ključa: roditelj drži `tab`, dete filtere.
  // Dete montira PRE roditelja, pa bi roditeljev upis bez spajanja obrisao filtere deteta.
  const RODITELJ = { tab: 'dnevnik' };

  test('roditelj čuva ključeve deteta koji su i dalje u adresi', () => {
    assert.equal(
      spojiStanjeListe('vrsta=UL&strana=7', '?vrsta=UL&strana=7', { tab: 'dnevnik' }, RODITELJ),
      'vrsta=UL&strana=7',
    );
  });

  test('🔴 zastareo ključ kog VIŠE NEMA u adresi se ne vaskrsava', () => {
    // Korisnik je ranije filtrirao, pa ušao u modul čist iz sidebara — „Nazad" mora
    // da vrati golu listu, a ne filtere kojih na ekranu nema.
    assert.equal(spojiStanjeListe('vrsta=UL&strana=7', '', { tab: 'dnevnik' }, RODITELJ), '');
  });

  test('tuđi parametar iz adrese ne ulazi u pamćenje ako ga u pamćenju nije ni bilo', () => {
    assert.equal(spojiStanjeListe('', '?open=3', { tab: 'dnevnik' }, RODITELJ), '');
  });

  test('sopstveni ključ uvek pobeđuje zapamćeni', () => {
    assert.equal(
      spojiStanjeListe('tab=kartica', '?tab=dnevnik', { tab: 'dnevnik' }, RODITELJ),
      '',
    );
  });
});

describe('useListQueryState pamti stanje i kad korisnik ne dira filtere', () => {
  test('🔴 upis ide i pri montiranju/`popstate`, ne samo iz `setValues`', () => {
    // Bez toga: deljen link `/robno?vrsta=UL&strana=7` → klik na red → „Nazad" vraća
    // golu listu, jer `listHref` nema šta da pročita. Pogađa SVE liste koje hook koriste.
    const src = izvor(USE_ID_PARAM);
    sadrzi(
      src,
      /spojiStanjeListe/,
      'useListQueryState ne upisuje stanje pri montiranju — deljen link i Nazad pregledača gube filtere',
    );
    sadrzi(
      src,
      /serijalizujStanjeListe/,
      'setValues drži sopstvenu kopiju serijalizacije umesto deljenog pomoćnika',
    );
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
    sadrzi(src, /citajIzvor\(/, 'detalj ne čita odakle je došao');
    sadrzi(src, /hrefIzvora\(/, 'detalj ne izvodi adresu liste iz izvora');
    neSadrzi(
      src,
      /listHref\(\s*['"]\/artikli['"]\s*\)/,
      'izlaz sa detalja je i dalje tvrdo zakucan na pregled artikala',
    );
  });

  test('kartica artikla koristi ISTOG pomoćnika (jedan izvor za oba ekrana)', () => {
    const src = izvor(KARTICA);
    sadrzi(src, /citajIzvor\(/, 'kartica drži sopstvenu kopiju čitanja izvora');
    sadrzi(src, /hrefIzvora\(/, 'kartica drži sopstvenu kopiju putanja listi');
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

/**
 * ROBNI DOKUMENT ima dva ulaza: radnu listu `/robno` i panel detalja popisa (dugmad
 * „Višak"/„Manjak" posle zaključenja). Magacioner koji je iz popisa otvorio generisani
 * dokument viška završavao je u listi robnih dokumenata.
 */
describe('izvor liste robnih dokumenata', () => {
  test('`izvor=popis` vodi nazad na popis', () => {
    assert.equal(citajIzvor('?id=8&izvor=popis', ULAZI_ROBNI_DOKUMENT, 'robno'), 'popis');
    assert.equal(hrefIzvora(ULAZI_ROBNI_DOKUMENT.popis), '/robno/popis');
  });

  test('bez izvora, sa smećem, i sa TUĐIM tokenom pada na listu robnih dokumenata', () => {
    // `izvor=lager` je validan token DRUGOG modula — ovde ne sme da prođe, inače bi
    // dugme „Nazad" sa robnog dokumenta odvelo u lager listu artikala.
    for (const s of ['', '?id=8', '?izvor=', '?izvor=lager', '?izvor=artikli', '?izvor=Popis']) {
      assert.equal(citajIzvor(s, ULAZI_ROBNI_DOKUMENT, 'robno'), 'robno', s);
    }
    assert.equal(hrefIzvora(ULAZI_ROBNI_DOKUMENT.robno), '/robno');
  });
});

describe('ekrani robnog su povezani na izvor liste', () => {
  test('popis potpisuje OBA prelaza na generisani dokument sa `izvor=popis`', () => {
    const src = izvor(POPIS_DETALJ);
    const adrese = [...src.matchAll(/`\/robno\/detalj\?[^`]*`/g)].map((m) => m[0]);
    assert.ok(adrese.length >= 2, 'popis više ne otvara višak i manjak — test je zastareo');
    for (const a of adrese) {
      assert.ok(/[?&]izvor=popis/.test(a), `prelaz bez izvora vodi na tuđu listu: ${a}`);
    }
  });

  test('detalj robnog dokumenta izvodi povratak iz `izvor`', () => {
    const src = izvor(ROBNO_DETALJ);
    sadrzi(src, /citajIzvor\(/, 'detalj ne čita odakle je došao');
    sadrzi(src, /hrefIzvora\(/, 'detalj ne izvodi adresu iz izvora');
    neSadrzi(
      src,
      /listHref\(\s*['"]\/robno['"]\s*\)/,
      'izlaz sa detalja je i dalje tvrdo zakucan na listu robnih dokumenata',
    );
  });

  test('🔴 panel prenosa PRENOSI izvor na drugu stranu para', () => {
    // Bez ovoga trag pukne posle prvog skoka: popis → dokument viška → „Otvori drugu
    // stranu" → adresa više nema `izvor` → „Nazad" vodi u listu robnih dokumenata.
    const src = izvor(ROBNO_PRENOS);
    sadrzi(src, /izvor/, 'skok na drugu stranu prenosa gubi izvor');
  });
});

describe('popis pamti izabrani popis i mesto u listi', () => {
  test('🔴 izabran popis živi u URL-u, ne u `useState`', () => {
    // Sa `useState` se izbor gubi i na povratak sa detalja, i na Nazad pregledača, i
    // na osvežavanje strane — a `listState:/robno/popis` ostaje prazan, pa `listHref`
    // nema šta da vrati.
    const src = izvor(POPIS);
    sadrzi(src, /useListQueryState/, 'popis ne drži izbor u URL-u');
    neSadrzi(
      src,
      /useState<number \| null>\(null\)/,
      'izabran popis je i dalje goli `useState` — gubi se na svaki povratak',
    );
    sadrzi(src, /parseIdParam/, 'id popisa se čita iz adrese bez provere (`?popis=0x10` → popis 16)');
  });

  test('obe strane robnog pamte skrol', () => {
    sadrzi(izvor(ROBNO), /useZapamcenaPozicijaListe/, 'lista robnih dokumenata ne pamti skrol');
    sadrzi(izvor(ROBNO), /kljuc:\s*'\/robno'/, 'mesto se pamti pod tuđim ključem');
    sadrzi(izvor(POPIS), /useZapamcenaPozicijaListe/, 'popis ne pamti skrol');
    sadrzi(izvor(POPIS), /kljuc:\s*'\/robno\/popis'/, 'mesto se pamti pod tuđim ključem');
  });
});

/**
 * KOMITENT ima ulaz koji NIJE radna lista: kartica „Dupli PIB kod komitenata" u
 * Podešavanjima (`/podesavanja?tab=integracije`). Za nju ne postoji `listState:` zapis,
 * pa bi je `listHref` svukao na podrazumevani tab „Korisnici" — administrator koji čisti
 * O-7 spisak bi posle svakog komitenta morao ponovo: Podešavanja → Integracije → skrol.
 */
describe('izvor liste komitenata', () => {
  test('`izvor=podesavanja` vodi nazad NA TAB, ne kroz `listHref`', () => {
    assert.equal(citajIzvor('?id=5&izvor=podesavanja', ULAZI_KOMITENT, 'komitenti'), 'podesavanja');
    assert.equal(hrefIzvora(ULAZI_KOMITENT.podesavanja), '/podesavanja?tab=integracije');
  });

  test('bez izvora i sa tuđim tokenom pada na listu komitenata', () => {
    for (const s of ['', '?id=5', '?izvor=', '?izvor=lager', '?izvor=popis', '?izvor=smece']) {
      assert.equal(citajIzvor(s, ULAZI_KOMITENT, 'komitenti'), 'komitenti', s);
    }
    assert.equal(hrefIzvora(ULAZI_KOMITENT.komitenti), '/komitenti');
  });
});

describe('ekrani komitenata su povezani na izvor liste', () => {
  test('kartica „Dupli PIB" potpisuje prelaz sa `izvor=podesavanja`', () => {
    const src = izvor(INTEGRACIJE);
    const adrese = [...src.matchAll(/`\/komitenti\/detalj\?[^`]*`/g)].map((m) => m[0]);
    assert.ok(adrese.length >= 1, 'Podešavanja više ne otvaraju komitenta — test je zastareo');
    for (const a of adrese) {
      assert.ok(/[?&]izvor=podesavanja/.test(a), `prelaz bez izvora vodi na tuđu listu: ${a}`);
    }
  });

  test('🔴 SVA TRI izlaza sa detalja komitenta izvode adresu iz izvora', () => {
    // Esc, dugme „Nazad" i „Odustani" na unosu — na artiklima su sva tri bila zakucana
    // i vlasnik je to prijavio; ovde su sva tri bila zakucana na `/komitenti`.
    const src = izvor(KOMITENT_DETALJ);
    sadrzi(src, /citajIzvor\(/, 'detalj komitenta ne čita odakle je došao');
    sadrzi(src, /hrefIzvora\(/, 'detalj komitenta ne izvodi adresu iz izvora');
    neSadrzi(src, /router\.push\(\s*['"]\/komitenti['"]\s*\)/, 'izlaz je i dalje tvrdo zakucan');
    neSadrzi(
      izvor(KOMITENT_NOV),
      /router\.push\(\s*['"]\/komitenti['"]\s*\)/,
      '„Odustani" na unosu novog komitenta briše pretragu i stranu',
    );
  });

  test('🔴 režim izmene NIJE izlaz sa ekrana', () => {
    // `onIzlaz` na `MaticniEkran` vraća iz izmene u pregled — vezivanje na povratak
    // na listu bi izbacilo korisnika iz ekrana umesto iz sloja.
    sadrzi(
      izvor(KOMITENT_DETALJ),
      /promeniRezim\('pregled'\)/,
      'izlaz iz izmene više ne vraća u pregled',
    );
  });
});

describe('lista komitenata pamti pretragu i stranu', () => {
  test('🔴 pretraga i strana žive u URL-u, ne u `useState`', () => {
    // Nad šifarnikom od desetina hiljada komitenata gubitak pretrage i strane je
    // doslovno „vrati me na početnu stranu".
    const src = izvor(KOMITENTI);
    sadrzi(src, /useListQueryState/, 'lista komitenata ne drži stanje u URL-u');
    neSadrzi(src, /useState\(1\)/, 'strana je i dalje goli `useState`');
    sadrzi(src, /enabled:\s*resolved/, 'upit kreće pre nego što se filteri pročitaju iz adrese');
  });

  test('imena parametara prate zatečenu konvenciju (`trazi`/`strana`)', () => {
    const src = izvor(KOMITENTI);
    sadrzi(src, /trazi:\s*''/, 'parametar pretrage nije `trazi`');
    sadrzi(src, /strana:\s*'1'/, 'parametar strane nije `strana`');
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
  for (const [ime, fajl] of [
    ['lager', LAGER],
    ['pregled artikala', ARTIKLI],
  ] as const) {
    test(`${ime} ne upisuje skrol ni broj strana kroz setValues`, () => {
      const src = izvor(fajl);
      for (const m of src.matchAll(/setValues\(\s*\{[^}]*\}/g)) {
        assert.ok(!/\b(skrol|strane|pozicija|scrollTop)\b/.test(m[0]), `skrol curi u URL: ${m[0]}`);
      }
      neSadrzi(src, /\bstrane:\s*String\(/, 'broj strana se upisuje u URL');
    });
  }
});

/**
 * `/artikli` je druga lista sa beskonačnim skrolom (92.592 artikla, strana po 200), a do
 * 07.08.2026 nije imala NIJEDAN deo mehanizma: ni `enabled`, ni `strane`, ni `scrollRef`.
 */
describe('pregled artikala pamti mesto u listi', () => {
  test('ekran je zakačen na pamćenje mesta pod SVOJIM ključem', () => {
    const src = izvor(ARTIKLI);
    sadrzi(src, /useZapamcenaPozicijaListe/, 'pregled artikala ne pamti mesto u listi');
    sadrzi(src, /kljuc:\s*'\/artikli'/, "mesto se pamti pod tuđim ključem (lager i artikli bi se gazili)");
    sadrzi(src, /scrollRef=\{okvirRef\}/, 'skrol-okvir tabele nije predat hooku — nema šta da se vrati');
  });

  test('🔴 upit čeka filtere iz adrese (`enabled: resolved`)', () => {
    // Bez gejta prvi render pošalje NEFILTRIRAN upit od 200 redova nad 92.592 artikla i
    // sedne u keš pod pogrešnim ključem — a restauracija tiho otkaže (potpis se ne poklopi).
    sadrzi(izvor(ARTIKLI), /enabled:\s*resolved/, 'lista šalje nefiltriran upit pre nego što pročita adresu');
  });

  test('keš skrola artikala preživljava posetu detalju', () => {
    const src = izvor(MASTERS);
    sadrzi(src, /strane:\s*strane\?\.length/, 'useArtikliSkrol ne vraća broj strana u kešu');
    sadrzi(src, /gcTime:\s*30\s*\*\s*60_000/, 'keš ističe za 5 min — kraće od jednog pogleda u karticu');
    sadrzi(src, /refetchOnMount:\s*false/, 'povratak ponovo dovlači SVE učitane strane redom');
  });
});
