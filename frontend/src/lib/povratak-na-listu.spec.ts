import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ULAZI_ARTIKAL,
  ULAZI_KOMITENT,
  ULAZI_ROBNI_DOKUMENT,
  adresaDetaljaSaRezimom,
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
const ZAHTEVI = path.join(KOREN, 'app', 'zahtevi', 'page.tsx');
const ZAHTEV_DETALJ = path.join(KOREN, 'app', 'zahtevi', 'detalj', 'page.tsx');
const ZAHTEV_AKCIJE = path.join(KOREN, 'app', 'zahtevi', 'detalj', '_components', 'action-bars.tsx');
const ZAHTEV_NOVI = path.join(KOREN, 'app', 'zahtevi', 'novi', 'page.tsx');
const ZAHTEVI_NAGRADE = path.join(KOREN, 'app', 'zahtevi', '_components', 'nagrade-tab.tsx');
const ZAHTEVI_ODLUKE = path.join(KOREN, 'app', 'zahtevi', '_components', 'odluke-tab.tsx');
const ZAHTEVI_STANJE = path.join(KOREN, 'app', 'zahtevi', '_lib', 'list-state.ts');
const ROBNO_API = path.join(KOREN, 'api', 'robno.ts');
const INVENTORY_API = path.join(KOREN, 'api', 'inventory.ts');

/**
 * Servis popisa ČITAN IZ BACKENDA (isti obrazac kao `notifications-nav.spec.ts`): id-evi
 * dokumenata razlike su ugovor dva sloja, pa prepisan spisak ovde ne bi hvatao baš ono
 * zbog čega postoji — da server prestane da ih vraća, a ekran ostane bez dugmadi.
 */
const BE_POPIS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'backend',
  'src',
  'modules',
  'robno',
  'inventory.service.ts',
);

const izvor = (f: string) => fs.readFileSync(f, 'utf8');

/**
 * Isečak izvora od jednog do drugog obeležja — provera „ova funkcija radi X" ne sme da
 * prođe zato što X postoji NEGDE u fajlu (npr. `visakDocId` u `finalize` ne dokazuje da
 * ga vraća i detalj popisa).
 */
function odsecak(src: string, od: RegExp, doKraja: RegExp): string {
  const i = src.search(od);
  assert.ok(i >= 0, `odsečak nije nađen (${od}) — test je zastareo`);
  const ostatak = src.slice(i);
  const j = ostatak.slice(1).search(doKraja);
  return j < 0 ? ostatak : ostatak.slice(0, j + 1);
}

/**
 * Provera nad izvorom se NE piše kroz `assert.match`: kad padne, on u poruku ispiše ceo
 * `page.tsx` (preko 1.000 redova) i pravi nalaz se u tome izgubi. `assert.ok` ispisuje
 * samo rečenicu — a rečenica kaže šta je pokvareno.
 */
function sadrzi(src: string, re: RegExp, poruka: string): void {
  assert.ok(re.test(src), poruka);
}

/**
 * Provera „ovo više ne sme da postoji" gleda SAMO kod: objašnjenje uz popravku po pravilu
 * citira zatečeni oblik („do 07.08.2026 je bio go `router.push('/zahtevi')`"), pa bi test
 * nad sirovim fajlom padao baš zato što je popravka uredno dokumentovana.
 *
 * Skidaju se blok komentari i komentari u sopstvenom redu; `//` usred reda se NE dira, da
 * se ne odseče ostatak reda sa adresom tipa `https://…`.
 */
function neSadrzi(src: string, re: RegExp, poruka: string): void {
  const kod = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(!re.test(kod), poruka);
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
 * 🔴 BRANA `enabled: resolved` NA LISTI ROBNIH DOKUMENATA.
 *
 * Bez nje prvi render (dok je `resolved` još `false`) gađa PODRAZUMEVANI ključ upita
 * `{page:1, kind:'', …}`. Taj ključ po pravilu IMA podatke u kešu — korisnik je u modul
 * ušao na golu listu pa tek onda filtrirao — pa je `loading` netačno `false` i tabela
 * ispaint-uje 50 redova NEFILTRIRANE strane 1 pre nego što je drugi render zameni
 * tačnima (efekat ide posle paint-a). To je bljesak koji je vlasnik prijavio kao
 * „izbacilo me na početnu stranu"; kad keša nema, isti render umesto bljeska pošalje
 * jedan uzaludan zahtev na SVAKI povratak sa detalja.
 */
describe('lista robnih dokumenata čeka filtere iz adrese', () => {
  test('🔴 `useStockDocuments` UOPŠTE ima gejt (kao `useKomitenti`/`useZahtevi`/`useArtikliSkrol`)', () => {
    // Kraj odsečka je i `/**` sledećeg hooka, ne samo `export`: dokumentacija SUSEDNOG
    // hooka (`useStockDocument`) pominje `enabled`, pa bi širi odsečak lažno prolazio.
    const hook = odsecak(izvor(ROBNO_API), /export function useStockDocuments\(/, /\n(\/\*\*|export )/);
    sadrzi(
      hook,
      /enabled/,
      'useStockDocuments nema opciju `enabled` — ekran nema čime da zaustavi nefiltriran upit',
    );
  });

  test('🔴 ekran drži upit isključenim dok ne pročita adresu, i tabela to kaže', () => {
    const src = izvor(ROBNO);
    sadrzi(
      src,
      /enabled:\s*resolved/,
      'lista robnih dokumenata šalje nefiltriran upit pre nego što pročita adresu',
    );
    sadrzi(
      src,
      /loading=\{!resolved \|\| list\.isLoading\}/,
      'uz isključen upit `isLoading` je netačno `false` — tabela na tren piše „Nema robnih dokumenata"',
    );
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

  test('🔴 pamti i MESTO u listi, ne samo stranu', () => {
    // Tačna strana bez skrola je pola posla: 50 redova je oko 1.750 px, pa je referent
    // koji je sa strane 4 otvorio 40. red posle „Nazad" stajao na vrhu te strane i
    // ponovo skrolovao. Isti defekt je na `/robno` zaslužio sopstveni komentar.
    const src = izvor(KOMITENTI);
    sadrzi(src, /useZapamcenaPozicijaListe/, 'lista komitenata ne pamti mesto u listi');
    sadrzi(src, /kljuc:\s*'\/komitenti'/, 'mesto se pamti pod tuđim ključem');
    // Skrol-okvir je STRANA (`flex-1 … overflow-auto`), a ne `DataTable` — tabela nema
    // `maxHeight`, pa `scrollRef` ovde ne bi imao šta da uhvati.
    sadrzi(src, /ref=\{okvirRef\}/, 'skrol-okvir strane nije predat hooku — nema šta da se vrati');
  });
});

/**
 * ZAHTEVI — jedina radna lista u aplikaciji koja nije koristila `useListQueryState`
 * (krši `frontend/CLAUDE.md` §12). Celo stanje admin liste (tab, status, modul, tip,
 * podnosilac, pretraga, strana) bilo je u `useState`, a izlaz sa detalja zakucan na
 * `router.push('/zahtevi')` — povratak sa BILO KOG od 7 ulaza je uvek isti: Inbox,
 * bez filtera, strana 1.
 *
 * `?izvor=` se NAMERNO NE uvodi: svih 7 ulaza vodi na ISTU putanju `/zahtevi`, razlika
 * je samo u tabu — a tab posle ove izmene i sam živi u URL-u i u `sessionStorage`.
 */
describe('zahtevi — stanje liste preživljava povratak sa detalja', () => {
  test('🔴 celo stanje admin liste živi u URL-u, ne u `useState`', () => {
    const src = izvor(ZAHTEVI);
    sadrzi(src, /useListQueryState/, 'lista zahteva ne drži stanje u URL-u');
    for (const kljuc of ['tab', 'strana', 'status', 'modul', 'tip', 'trazi', 'podnosilac']) {
      sadrzi(src, new RegExp(`\\b${kljuc}:`), `filter „${kljuc}" se ne pamti`);
    }
    neSadrzi(src, /useState<AdminTab>\('inbox'\)/, 'tab je i dalje `useState` — povratak vraća na Inbox');
    neSadrzi(src, /useState\(1\)/, 'strana je i dalje goli `useState`');
  });

  test('upit čeka filtere iz adrese i tabela to kaže', () => {
    const src = izvor(ZAHTEVI);
    sadrzi(src, /enabled:\s*resolved/, 'lista šalje nefiltriran upit pre nego što pročita adresu');
    sadrzi(
      src,
      /loading=\{!resolved \|\| list\.isPending\}/,
      'uz isključen upit `isLoading` je netačno `false` — tabela na tren piše „Inbox je prazan"',
    );
  });

  test('🔴 SVA ČETIRI izlaza sa zahteva idu kroz `listHref`', () => {
    // Dugme „Nazad"/Esc na detalju, „Obriši nacrt", pa Esc i „Nazad" na novom zahtevu.
    // Popravka mora da pokrije SVA mesta, ne samo dugme Nazad.
    for (const [ime, fajl] of [
      ['detalj', ZAHTEV_DETALJ],
      ['akcije detalja', ZAHTEV_AKCIJE],
      ['novi zahtev', ZAHTEV_NOVI],
    ] as const) {
      const src = izvor(fajl);
      neSadrzi(
        src,
        /router\.push\(\s*['"]\/zahtevi['"]\s*\)/,
        `izlaz sa „${ime}" je i dalje tvrdo zakucan na go /zahtevi (Inbox, strana 1)`,
      );
    }
    sadrzi(izvor(ZAHTEV_DETALJ), /listHref\(\s*['"]\/zahtevi['"]\s*\)/, 'detalj ne vraća stanje liste');
  });

  test('🔴 provera duplikata ne sme da uništi popunjenu formu', () => {
    // Klik na sličan zahtev je radio `router.push` i brisao naslov, opis, priloge i
    // snimljenu glasovnu poruku — a baš tu korisnika teramo da proveri duplikat.
    const src = izvor(ZAHTEV_NOVI);
    sadrzi(src, /isModifiedNavClick/, 'klik na sličan zahtev otima Ctrl/srednji klik');
    sadrzi(src, /target="_blank"/, 'sličan zahtev se otvara u istom tabu i briše popunjenu formu');
  });

  test('🔴 tabovi Nagrade i Odluke NAVODE i ključeve roditelja', () => {
    // `setValues` serijalizuje SAMO svoje ključeve i to piše kroz `router.replace`. Tab
    // koji navede samo svoje obrisao bi `tab=nagrade` iz adrese, pa bi administratora
    // prva promena meseca izbacila na Inbox.
    for (const [ime, fajl] of [
      ['Nagrade', ZAHTEVI_NAGRADE],
      ['Odluke', ZAHTEVI_ODLUKE],
    ] as const) {
      const src = izvor(fajl);
      sadrzi(src, /useListQueryState/, `tab „${ime}" ne pamti svoje stanje`);
      sadrzi(
        src,
        /\.\.\.STANJE_LISTE_ZAHTEVA/,
        `tab „${ime}" ne navodi ključeve roditelja — njegov upis briše tab iz adrese`,
      );
    }
    // Jedan izvor ključeva, da se tabovi i roditelj ne raziđu.
    sadrzi(izvor(ZAHTEVI_STANJE), /tab:\s*'inbox'/, 'podrazumevani tab više nije `inbox`');
  });

  test('lista zahteva pamti i skrol strane', () => {
    // Skrol-okvir je strana (`flex-1 overflow-auto`), a ne `DataTable` — tabela nema
    // `maxHeight`, pa `scrollRef` ovde ne bi imao šta da uhvati.
    const src = izvor(ZAHTEVI);
    sadrzi(src, /useZapamcenaPozicijaListe/, 'lista zahteva ne pamti skrol');
    sadrzi(src, /kljuc:\s*'\/zahtevi'/, 'mesto se pamti pod tuđim ključem');
  });

  test('Odluke koriste ODVOJENE ključeve od liste zahteva', () => {
    // Roditelj drži `strana`/`trazi` za svoju tabelu; deljenje bi pomešalo dve liste.
    const src = izvor(ZAHTEVI_ODLUKE);
    for (const kljuc of ['odlukeStrana', 'odlukeTrazi', 'odlukeTag']) {
      sadrzi(src, new RegExp(kljuc), `Decision Log nema sopstveni ključ „${kljuc}"`);
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
  for (const [ime, fajl] of [
    ['lager', LAGER],
    ['pregled artikala', ARTIKLI],
    ['robni dokumenti', ROBNO],
    ['popis', POPIS],
    ['komitenti', KOMITENTI],
    ['zahtevi', ZAHTEVI],
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
    // Same keš opcije su od 07.08.2026 u `api/kes-liste.ts` i pokrivene su MERENJEM
    // (`kes-liste.spec.ts` broji pozive `queryFn` pri montiranju sa promenom ključa) —
    // ovde ostaje samo veza, jer prepisan spisak literala ovde ništa ne bi dokazao.
    sadrzi(
      src,
      /\.\.\.KES_BESKONACNE_LISTE/,
      'useArtikliSkrol ne koristi zajednički keš profil — keš ističe za 5 min i povratak dovlači sve strane redom',
    );
  });
});

// ─────────────────────── C. ono ZBOG ČEGA se korisnik vraća mora da dočeka povratak

/**
 * 🔴 POPIS: dugmad ka generisanim dokumentima razlike.
 *
 * Vraćanje na mesto u popisu je rešeno, ali je samo mesto bilo prazno: id-evi kreiranih
 * VISAK/MANJAK dokumenata živeli su u `useState` panela, pa je povratak sa jednog od njih
 * brisao dugme za DRUGI. Popis koji je napravio i višak i manjak ostavljao je magacionera
 * bez ijednog puta do drugog dokumenta — a to je jedini razlog zbog kog se i vraća.
 *
 * Izvor istine je BAZA, ne pregledač: veza `stock_documents.inventory_count_id` već postoji
 * (upisuje je `finalize`), pa detalj popisa samo mora da je pročita. `sessionStorage` bi bio
 * drugi zapis iste činjenice — i lagao bi čim se popis otvori na drugoj mašini.
 */
describe('popis: dokumenti razlike preživljavaju povratak', () => {
  test('🔴 DETALJ popisa (ne samo `finalize`) vraća id-eve dokumenata razlike', () => {
    const get = odsecak(izvor(BE_POPIS), /async get\(/, /\n {2}async \w+\(/);
    sadrzi(
      get,
      /visakDocId/,
      'detalj popisa sa servera ne nosi id-eve kreiranih dokumenata (nosi ih samo odgovor `finalize`, koji se ne pamti)',
    );
    sadrzi(get, /manjakDocId/, 'detalj popisa vraća samo jedan od dva dokumenta razlike');
    sadrzi(
      get,
      /inventoryCountId:\s*id/,
      'id-evi se ne izvode iz veze `stock_documents.inventory_count_id` — negde su prepisani',
    );
  });

  test('FE tip detalja popisa prati backend ugovor', () => {
    const tip = odsecak(izvor(INVENTORY_API), /interface InventoryCountDetail/, /\n}/);
    sadrzi(tip, /visakDocId/, 'InventoryCountDetail ne deklariše `visakDocId`');
    sadrzi(tip, /manjakDocId/, 'InventoryCountDetail ne deklariše `manjakDocId`');
  });

  test('🔴 panel čita id-eve SA SERVERA, a odgovor `finalize` mu je samo trenutna dopuna', () => {
    const src = izvor(POPIS_DETALJ);
    sadrzi(
      src,
      /count\?\.visakDocId/,
      'panel dugmad izvodi isključivo iz `result` (`useState`) — povratak sa jednog dokumenta briše dugme za drugi',
    );
    sadrzi(src, /count\?\.manjakDocId/, 'panel ne čita id manjka sa servera');
  });
});

// ───────────────── D. NAJVIŠE JEDAN AUTOMATSKI ZAHTEV PRI MONTIRANJU (zamka paketa)

/**
 * Restauracija mesta ne sme da postane pogon za dovlačenje: kad je zapamćeno više strana
 * nego što keš drži, `odlukaOPoziciji` vraća `odustani` (mereno gore), a EKRAN mora da
 * prikaže prvu stranu i rečenicom kaže koliko je ranije bilo učitano. Ovde se meri druga
 * polovina te tvrdnje — da nijedan ekran iz paketa ne dovlači strane sam od sebe.
 */
describe('nijedan ekran ne vrti dovlačenje pri montiranju', () => {
  for (const [ime, fajl] of [
    ['pregled artikala', ARTIKLI],
    ['lager', LAGER],
  ] as const) {
    test(`${ime}: sledeća strana se dovlači SAMO na klik, i gubitak se kaže rečenicom`, () => {
      const src = izvor(fajl);
      const mesta = [...src.matchAll(/^.*fetchNextPage.*$/gm)].map((m) => m[0]);
      assert.ok(mesta.length >= 1, `${ime} više ne dovlači strane — test je zastareo`);
      for (const m of mesta) {
        assert.ok(
          /onClick=/.test(m),
          `strana se dovlači bez klika korisnika (efekat/posmatrač = plotun zahteva): ${m.trim()}`,
        );
      }
      sadrzi(
        src,
        /izgubljenoRedova\s*>/,
        `${ime} ne kaže koliko je ranije bilo učitano — korisnik ne zna da mu fali deo spiska`,
      );
    });
  }

  for (const [ime, fajl] of [
    ['robni dokumenti', ROBNO],
    ['popis', POPIS],
    ['komitenti', KOMITENTI],
    ['zahtevi', ZAHTEVI],
  ] as const) {
    test(`${ime}: serverska paginacija prijavljuje TAČNO jednu stranu u kešu`, () => {
      // Kod serverske paginacije je strana u URL-u, pa keš uvek drži tačno jednu stranu.
      // Prijaviti više bi značilo da grana „odustani" laže; prijaviti rastući broj bi
      // uvelo dovlačenje kog na ovim ekranima nema.
      sadrzi(
        izvor(fajl),
        /straneUKesu:[^,\n]*\?\s*1\s*:\s*0/,
        `${ime} ne prijavljuje broj strana kao „ima podataka → 1, nema → 0"`,
      );
    });
  }
});

// ───────────────────── D. adversarijalni pregled paketa (07.08.2026) — druga runda

/**
 * 🔴 TAB KOJI RODITELJ USLOVNO MONTIRA UVEK IMA JEDAN RENDER SA `resolved === false`.
 *
 * `/zahtevi` montira Nagrade i Odluke kroz `{tab === '…' && <Tab />}`, pa se komponenta
 * REMONTIRA na svaki povratak i prvi render ide sa PODRAZUMEVANIM vrednostima (tekući
 * mesec, strana 1, bez pretrage). `enabled: false` gasi ZAHTEV, ali ne i čitanje keša —
 * a baš podrazumevani ključ je gotovo uvek u kešu. Zato brana mora i na PRIKAZ:
 * administrator koji se vraća u obračun jula je video kadar AVGUSTOVSKIH iznosa po
 * korisnicima i „Ukupno … RSD" — pogrešan novac na ekranu za zaključenje meseca.
 */
describe('zahtevi: tabovi Nagrade i Odluke imaju branu `resolved`', () => {
  test('🔴 obračun nagrada: i upit i prikaz čekaju mesec iz adrese', () => {
    const src = izvor(ZAHTEVI_NAGRADE);
    sadrzi(src, /\bresolved\b[^\n]*\}\s*=\s*useListQueryState/, 'tab ne uzima `resolved` iz `useListQueryState`');
    sadrzi(src, /usePayoutReport\([^)]*\bresolved\b/, 'obračun se traži pre nego što se pročita mesec iz adrese');
    sadrzi(
      src,
      /const data = resolved \?/,
      '🔴 iznosi po korisnicima i „Ukupno … RSD" se crtaju iz keša TEKUĆEG meseca — `enabled: false` ne gasi čitanje keša',
    );
    sadrzi(src, /const ucitava = !resolved/, 'uz isključen upit `isLoading` je netačno `false` — ekran napiše „Nema potvrđenih nagrada"');
  });

  test('🔴 odluke: i upit i prikaz čekaju stranu/pretragu iz adrese', () => {
    const src = izvor(ZAHTEVI_ODLUKE);
    sadrzi(src, /\bresolved\b[^\n]*\}\s*=\s*useListQueryState/, 'tab ne uzima `resolved` iz `useListQueryState`');
    const poziv = odsecak(src, /const list = useDecisions\(/, /\n\s*\);/);
    sadrzi(poziv, /\bresolved\b/, 'lista odluka se traži pre nego što se pročita adresa');
    sadrzi(
      src,
      /const rows = resolved \?/,
      'povratak na `?odlukeTrazi=…&odlukeStrana=3` iscrtava stranu 1 bez pretrage (keš podrazumevanog ključa)',
    );
    sadrzi(src, /const ucitava = !resolved/, 'uz isključen upit `isLoading` je netačno `false` — ekran napiše „Nema odluka"');
  });

  test('🔴 restauracija mesta se NE troši na tabu koji listu ne crta', () => {
    // Upit liste ide bez obzira na tab, pa su `imaPodatke`/`redova` tačni i na Nagradama.
    // Restauracija se izvodi TAČNO JEDNOM: kad bi `spremno` postalo `true` nad DOM-om
    // tuđeg taba, jedina prilika da se vrati mesto potrošila bi se u prazno.
    sadrzi(
      izvor(ZAHTEVI),
      /crtaSeLista:\s*isListTab/,
      'pamćenje mesta ne zna na kom je tabu — `spremno` postaje `true` nad DOM-om Nagrada/Odluka',
    );
  });
});

/**
 * 🔴 `promeniRezim` je brisao `?izvor=` iz adrese.
 *
 * Adresa se sklapala iz `id` (`?id=N[&rezim=izmena]`), pa je lager → „Detaljno" →
 * „Izmeni" → F5 → „Nazad" vodio na `/artikli` umesto na lager. `izvor` je deo identiteta
 * onoga što je na ekranu, isto kao `id`, i ne sme da nestane zato što se menja režim.
 */
describe('prebacivanje pregled ↔ izmena čuva izvor liste', () => {
  test('izvor i svaki drugi parametar preživljavaju ulazak u izmenu', () => {
    const u = new URLSearchParams(adresaDetaljaSaRezimom('?id=42&izvor=lager', 42, 'izmena'));
    assert.equal(u.get('izvor'), 'lager');
    assert.equal(u.get('rezim'), 'izmena');
    assert.equal(u.get('id'), '42');
  });

  test('izlazak iz izmene briše SAMO `rezim`', () => {
    const u = new URLSearchParams(adresaDetaljaSaRezimom('?id=42&izvor=lager&rezim=izmena', 42, 'pregled'));
    assert.equal(u.get('rezim'), null);
    assert.equal(u.get('izvor'), 'lager');
  });

  test('adresa bez izvora (deljen link) ostaje čitljiva', () => {
    assert.equal(adresaDetaljaSaRezimom('?id=42', 42, 'pregled'), '?id=42');
  });

  test('`id` se poravnava sa prikazanim zapisom, ne prepisuje iz adrese', () => {
    const u = new URLSearchParams(adresaDetaljaSaRezimom('?id=1&izvor=lager', 42, 'pregled'));
    assert.equal(u.get('id'), '42');
  });

  for (const [ime, fajl] of [
    ['artikal', DETALJ],
    ['komitent', KOMITENT_DETALJ],
  ] as const) {
    test(`detalj ${ime}a gradi adresu iz zatečene, ne sklapa je iz id-a`, () => {
      const src = izvor(fajl);
      sadrzi(src, /adresaDetaljaSaRezimom\(window\.location\.search/, `detalj ${ime}a ne čuva zatečene parametre`);
      neSadrzi(
        src,
        /`\?id=\$\{validId\}(&rezim=izmena)?`/,
        `detalj ${ime}a i dalje sklapa adresu iz id-a — \`?izvor=\` se briše na svaki ulazak/izlazak iz izmene`,
      );
    });
  }
});

/**
 * 🔴 POPIS: visinu strane pravi PANEL DETALJA, pa i restauracija mora da ga sačeka.
 *
 * `useZapamcenaPozicijaListe` u istom `rAF`-u postavi `scrollTop` pa odmah pozove `upisi()`.
 * Dok je strana kratka (master lista je nekoliko redova, stavki još nema), pregledač odseče
 * vrednost i hook tu odsečenu vrednost upiše NAZAD preko zapisa — `resenoRef` je potrošen.
 */
describe('popis: restauracija čeka panel detalja', () => {
  test('🔴 `spremno` uslovljava i stavkama izabranog popisa', () => {
    const src = izvor(POPIS);
    sadrzi(src, /useInventoryCount\(selectedId\)/, 'strana ne zna je li panel detalja dobio stavke');
    sadrzi(
      src,
      /spremno:[^\n]*detalj\.data/,
      'mesto se vraća dok je strana još kratka — pregledač odseče `scrollTop`, a hook odsečenu vrednost upiše nazad',
    );
  });

  test('keš detalja popisa preživljava povratak sa dokumenta razlike', () => {
    const detalj = odsecak(izvor(INVENTORY_API), /export function useInventoryCount\(/, /\n\}/);
    sadrzi(
      detalj,
      /gcTime/,
      'detalj popisa ističe za 5 min, pa je za svaki duži povratak strana kratka baš u trenutku restauracije',
    );
  });
});

/**
 * BROJAČI IZVAN TABELE nisu pokriveni `loading`-om na `DataTable`: dok filteri iz adrese
 * nisu pročitani, dolaze iz keša NEFILTRIRANE liste („Prikazano 200 od 92.592" za suženu
 * pretragu). Dugme „Učitaj još" je gore od kozmetike — klik pre `resolved` dovlači stranu
 * 2 POGREŠNOG ključa.
 */
describe('brojači i paginacija izvan tabele su pod `resolved`', () => {
  for (const [ime, fajl] of [
    ['pregled artikala', ARTIKLI],
    ['lager', LAGER],
  ] as const) {
    test(`${ime}: brojači i „Učitaj još" čekaju adresu`, () => {
      const src = izvor(fajl);
      sadrzi(src, /count=\{resolved && upit\.data/, `${ime}: broj u zaglavlju je iz keša nefiltrirane liste`);
      sadrzi(src, /\{resolved && \(\s*\n\s*<span/, `${ime}: „Prikazano X od Y" je iz keša nefiltrirane liste`);
      sadrzi(
        src,
        /\{resolved && upit\.hasNextPage/,
        `${ime}: „Učitaj još" pre gejta dovlači stranu 2 POGREŠNOG ključa`,
      );
      sadrzi(src, /\{resolved && naKapi/, `${ime}: upozorenje o kapi računa nad tuđim brojem`);
    });
  }

  test('komitenti: broj u zaglavlju i pager čekaju adresu', () => {
    const src = izvor(KOMITENTI);
    sadrzi(src, /count=\{resolved && meta/, 'broj komitenata je iz keša nefiltrirane liste');
    sadrzi(src, /\{resolved && meta && meta\.totalPages > 1/, 'pager pomera stranu nad brojem koji ne pripada ovoj listi');
  });
});
