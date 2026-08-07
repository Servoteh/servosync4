import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/query-core';
import { KES_BESKONACNE_LISTE } from '@/api/kes-liste';

/**
 * KOLIKO ZAHTEVA KOŠTA POVRATAK NA LISTU SA BESKONAČNIM SKROLOM — MERENO, NE TVRĐENO.
 *
 * Paket „povratak na listu" je na `/artikli` i `/artikli/lager` podigao `gcTime` na 30
 * minuta uz `refetchOnMount: false` i uz komentar da to sprečava ponovno dovlačenje svih
 * strana. Komentar je bio netačan, a podignut `gcTime` je grešku učinio POUZDANOM: keš
 * sad sigurno dočeka povratak, pa se plotun okida svaki put (ranije bi keš često propao i
 * povratak bi bio jedan zahtev za prvu stranu).
 *
 * Ovaj test ne čita komentare — vozi PRAVI `@tanstack/query-core` (istu verziju koju
 * koristi aplikacija) kroz tačan tok montiranja i BROJI pozive `queryFn`:
 *
 *   1. prva poseta listi: filteri iz adrese, učitano `STRANA` strana;
 *   2. odlazak na detalj: posmatrač se odjavljuje (komponenta se demontira);
 *   3. povratak: NOV posmatrač se prvo montira sa `enabled: false` i PODRAZUMEVANIM
 *      ključem (`useListQueryState` čita adresu tek u efektu), pa se u drugom renderu
 *      prebacuje na `enabled: true` i ključ iz adrese.
 *
 * Korak 3 je ono što obara `refetchOnMount`: menja se i `enabled` i `queryKey`, pa
 * odluku donosi `shouldFetchOptionally`, koji `refetchOnMount` uopšte ne gleda.
 */

const KOREN = path.resolve(import.meta.dirname, '..');
const MASTERS = path.join(KOREN, 'api', 'masters.ts');
const LAGER = path.join(KOREN, 'api', 'lager.ts');

/** Koliko je strana bilo učitano pre odlaska na detalj (stvarno ide do kape od 25). */
const STRANA = 5;

/**
 * Koliko je korisnik proveo na detalju. Test se izvrti za milisekunde, pa se protok
 * vremena mora ODIGRATI — inače je i bez `staleTime` sve još „sveže" (globalnih 10 s nije
 * isteklo) i merenje bi lažno pokazalo nulu. Minut je konzervativno: kraće od jednog
 * pogleda u karticu artikla, a duže od globalnog `staleTime`.
 */
const PAUZA_NA_DETALJU = 60_000;

/** Globalne opcije aplikacije — `query-provider.tsx`. Ovde su deo merenja, ne dekor. */
const GLOBALNO = { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } as const;

type Strana = { redovi: number[]; strana: number };

/** Zatečeni profil pre popravke — bez `staleTime`. Kontrolna grupa merenja. */
const KES_PRE_POPRAVKE = { gcTime: 30 * 60_000, refetchOnMount: false } as const;

/** Pusti `notifyManager` i lanac `fetchPage`-ova da se izvrte do kraja. */
async function ispraznired(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Odvrti ceo tok „lista → detalj → povratak" i vrati broj poziva `queryFn` NA POVRATKU
 * (pozivi iz prve posete se ne broje — brojač se nuluje posle koraka 1).
 */
async function zahtevaNaPovratku(profil: Record<string, unknown>): Promise<number> {
  let poziva = 0;
  const klijent = new QueryClient({ defaultOptions: { queries: { ...GLOBALNO } } });

  const kljucIzAdrese = ['masters', 'artikli', 'skrol', { trazi: 'ventil', pageSize: 200 }];
  const kljucPodrazumevani = ['masters', 'artikli', 'skrol', { trazi: '', pageSize: 200 }];

  const opcije = (kljuc: unknown[], enabled: boolean) => ({
    queryKey: kljuc,
    initialPageParam: 1,
    enabled,
    ...profil,
    queryFn: async ({ pageParam }: { pageParam: number }): Promise<Strana> => {
      poziva++;
      return { redovi: [pageParam], strana: pageParam };
    },
    getNextPageParam: (poslednja: Strana) =>
      poslednja.strana >= STRANA ? undefined : poslednja.strana + 1,
  });

  // ── 1. prva poseta: filteri iz adrese, korisnik doskrolao do `STRANA`-te strane
  const prvi = new InfiniteQueryObserver(klijent, opcije(kljucIzAdrese, true) as never);
  const odjavi1 = prvi.subscribe(() => {});
  await ispraznired();
  for (let i = 1; i < STRANA; i++) {
    await prvi.fetchNextPage();
  }
  assert.equal(poziva, STRANA, 'priprema merenja nije učitala očekivan broj strana');
  assert.equal(
    (klijent.getQueryData(kljucIzAdrese) as { pages: Strana[] } | undefined)?.pages.length,
    STRANA,
    'priprema merenja: keš ne drži sve strane',
  );

  // ── 2. odlazak na detalj artikla — komponenta liste se demontira, vreme teče
  odjavi1();
  klijent.setQueryData(kljucIzAdrese, klijent.getQueryData(kljucIzAdrese), {
    updatedAt: Date.now() - PAUZA_NA_DETALJU,
  });
  poziva = 0;

  // ── 3. povratak: render 1 (adresa još nije pročitana) pa render 2 (jeste)
  const drugi = new InfiniteQueryObserver(klijent, opcije(kljucPodrazumevani, false) as never);
  const odjavi2 = drugi.subscribe(() => {});
  drugi.setOptions(opcije(kljucIzAdrese, true) as never);
  await ispraznired();
  odjavi2();
  klijent.clear();
  return poziva;
}

/** Prvo otvaranje liste ikad (prazan keš) — mora ostati TAČNO jedan zahtev. */
async function zahtevaNaPrvomOtvaranju(profil: Record<string, unknown>): Promise<number> {
  let poziva = 0;
  const klijent = new QueryClient({ defaultOptions: { queries: { ...GLOBALNO } } });
  const kljuc = ['masters', 'artikli', 'skrol', { trazi: 'ventil', pageSize: 200 }];

  const opcije = (enabled: boolean) => ({
    queryKey: enabled ? kljuc : ['masters', 'artikli', 'skrol', { trazi: '', pageSize: 200 }],
    initialPageParam: 1,
    enabled,
    ...profil,
    queryFn: async ({ pageParam }: { pageParam: number }): Promise<Strana> => {
      poziva++;
      return { redovi: [pageParam], strana: pageParam };
    },
    getNextPageParam: (poslednja: Strana) =>
      poslednja.strana >= STRANA ? undefined : poslednja.strana + 1,
  });

  const o = new InfiniteQueryObserver(klijent, opcije(false) as never);
  const odjavi = o.subscribe(() => {});
  o.setOptions(opcije(true) as never);
  await ispraznired();
  odjavi();
  klijent.clear();
  return poziva;
}

describe('keš beskonačnih listi: povratak sa detalja ne sme da bude plotun', () => {
  test('🔴 zatečeni profil (gcTime + refetchOnMount:false) dovlači SVE strane redom', async () => {
    const mereno = await zahtevaNaPovratku(KES_PRE_POPRAVKE);
    assert.equal(
      mereno,
      STRANA,
      `kontrolna grupa: očekivano ${STRANA} zahteva (po jedan za svaku učitanu stranu), mereno ${mereno} — ` +
        'ako je ovo 0, merenje više ne pogađa granu `shouldFetchOptionally` i test je zastareo',
    );
  });

  test('🔴 profil sa `staleTime` ne šalje NIJEDAN zahtev na povratak', async () => {
    const mereno = await zahtevaNaPovratku(KES_BESKONACNE_LISTE);
    assert.equal(
      mereno,
      0,
      `povratak na listu košta ${mereno} zahteva (do 25 nad 92.592 artikla) — ` +
        '`refetchOnMount: false` NE zatvara granu `shouldFetchOptionally`, to radi `staleTime`',
    );
  });

  test('gašenje upita (`enabled`) samo po sebi NE pomaže — ključ se menja svejedno', async () => {
    // Dokaz da popravka mora biti `staleTime`: i prvi render sa `enabled: false` (što ekrani
    // već rade preko `enabled: resolved`) ostavlja plotun, jer `shouldFetchOptionally` pali
    // i na promenu ključa i na `prevOptions.enabled === false`.
    const mereno = await zahtevaNaPovratku(KES_PRE_POPRAVKE);
    assert.ok(mereno > 1, 'merenje je izgubilo granu koju treba da pokrije');
  });

  test('prvo otvaranje liste ostaje JEDAN zahtev (staleTime ne zaključava prazan keš)', async () => {
    assert.equal(
      await zahtevaNaPrvomOtvaranju(KES_BESKONACNE_LISTE),
      1,
      '`staleTime` je zaključao praznu listu — `isStaleByTime` mora vratiti `true` kad je `data` undefined',
    );
  });
});

describe('oba beskonačna upita voze isti keš profil', () => {
  for (const [ime, fajl] of [
    ['useArtikliSkrol', MASTERS],
    ['useLagerSkrol', LAGER],
  ] as const) {
    test(`${ime} koristi KES_BESKONACNE_LISTE`, () => {
      // 🔴 `replace` je uslov, ne kozmetika: fajlovi u repou su CRLF, pa `'\n}\n'` nikad
      // ne pogodi kraj funkcije i „telo" postane ceo ostatak fajla (tiho lažan test).
      const src = fs.readFileSync(fajl, 'utf8').replace(/\r\n/g, '\n');
      const i = src.indexOf(`export function ${ime}`);
      assert.ok(i >= 0, `${ime} više ne postoji pod tim imenom — test je zastareo`);
      // Samo telo TOG hook-a: `gcTime` drugih upita u istom fajlu nije predmet ove provere.
      const kraj = src.indexOf('\n}\n', i);
      assert.ok(kraj > i, `kraj funkcije ${ime} nije nađen — test je zastareo`);
      const telo = src.slice(i, kraj);
      assert.ok(
        /\.\.\.KES_BESKONACNE_LISTE/.test(telo),
        `${ime} ne koristi mereni keš profil — merenje iz ovog fajla onda ništa ne dokazuje o ekranu`,
      );
      // Ručno prepisan `gcTime`/`staleTime` pored spread-a bi tiho pregazio profil.
      assert.ok(
        !/^\s*(gcTime|staleTime|refetchOnMount):/m.test(telo),
        `${ime} pored profila drži i sopstvenu keš opciju — dva izvora istine`,
      );
    });
  }
});
