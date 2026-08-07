/**
 * KEŠ PROFIL RADNIH LISTI SA BESKONAČNIM SKROLOM — jedan izvor za `useArtikliSkrol`
 * (`masters.ts`) i `useLagerSkrol` (`lager.ts`).
 *
 * Obe liste nadovezuju strane po 200 redova (do 25 strana pod kapom) i obe se napuštaju
 * radi jednog pogleda u karticu/detalj artikla, pa moraju da izdrže povratak: keš mora
 * da PREŽIVI odlazak i ne sme da se osveži u plotunu po povratku.
 *
 * 🔴 `refetchOnMount: false` SAM PO SEBI NE SPREČAVA PLOTUN — mereno nad
 * `@tanstack/query-core` 5.101.2 (v. `kes-liste.spec.ts`). Ta opcija se čita isključivo u
 * `shouldFetchOnMount`, a montiranje ovih listi ide DRUGOM granom, `shouldFetchOptionally`:
 *
 *     (query !== prevQuery || prevOptions.enabled === false) && … && isStale(query, options)
 *
 * Oba uslova su na povratku ispunjena: ekran drži upit isključenim dok `useListQueryState`
 * ne pročita adresu (`enabled: resolved`), pa se između prvog i drugog rendera menjaju I
 * `enabled` I sam `queryKey` (podrazumevani filteri → filteri iz adrese). Ostaje samo
 * `isStale`, a bez sopstvenog `staleTime` važi globalnih 10 s (`query-provider.tsx`) —
 * dakle uvek istekao. Osvežavanje beskonačnog upita BEZ `direction` vrti
 * `do { fetchPage } while (currentPage < remainingPages)`, pa je cena povratka do 25
 * uzastopnih zahteva nad 92.592 artikla, odnosno 25 agregacija nad lager ogledalom.
 *
 * Zato branu drži `staleTime`, ne `refetchOnMount`. 30 minuta nije proizvoljno: podaci se
 * u toku radnog dana ne menjaju — `items` i `*_mirror` puni noćni `.mdb` uvoz u 03:45.
 * Jednako je `gcTime`-u, pa je prozor u kom je keš živ a podatak bajat prazan.
 *
 * `refetchOnMount: false` DOK EKRANI DRŽE `enabled: resolved` NE MENJA NIŠTA — nije „druga
 * brava". Izmereno (isti postroj kao `kes-liste.spec.ts`, tri scenarija, sa opcijom i bez
 * nje): povratak sa svežim kešom 0 : 0 zahteva, sa bajatim (31 min) 5 : 5, i to bez obzira
 * menja li se ključ. Razlog je isti kao gore: montiranje ovih listi UVEK ide granom
 * `shouldFetchOptionally` (prvi render je `enabled: false`), a ta grana `refetchOnMount`
 * uopšte ne čita.
 *
 * Zašto onda ostaje: `shouldFetchOnMount` oživi čim se posmatrač montira odmah sa
 * `enabled: true` — dakle ako neki budući ekran uzme ovaj profil bez `useListQueryState`
 * gejta. Tada, i samo tada, ova opcija zaustavlja osvežavanje bajatog keša. Za slučaj iz
 * gornjeg pasusa se na nju NE SME računati.
 *
 * Prvo učitavanje ostaje JEDAN zahtev: `isStaleByTime` vraća `true` kad je `data`
 * `undefined`, pa `staleTime` ne može da zaključa praznu listu.
 *
 * ⚠️ SVAKO PISANJE U OVE PODATKE MORA DA RADI `invalidateQueries(['masters', …])` — uz
 * ovoliki `staleTime` promena inače „nedostaje" u listi do isteka pola sata. Dva izvora,
 * ne jedan:
 *  • RE-UVOZ IZ BIGBITA — i noćni (03:45) i RUČNI, dugmetom „Pokreni" na `/syncs`. Ovo je
 *    danas jedini kanal kojim artikli i lager uopšte stižu, pa je i jedini realan slučaj:
 *    administrator pokrene uvoz jer je nešto falilo, uvoz prođe, a lista mu pola sata
 *    prikazuje isti stari spisak — i on zaključi da uvoz ne radi.
 *  • BUDUĆI UNOS/IZMENA ARTIKLA u aplikaciji, kad se otključaju (zaključani odlukom od
 *    26.07.2026, v. `/artikli`).
 */
export const KES_BESKONACNE_LISTE = {
  gcTime: 30 * 60_000,
  staleTime: 30 * 60_000,
  refetchOnMount: false,
} as const;
