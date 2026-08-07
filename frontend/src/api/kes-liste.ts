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
 * `refetchOnMount: false` ostaje kao druga brava za montiranje BEZ promene ključa (isti
 * filteri, npr. povratak kroz Nazad pregledača na istu adresu) — jeftino je i ne škodi,
 * ali se na njega NE SME računati za slučaj iz gornjeg pasusa.
 *
 * Prvo učitavanje ostaje JEDAN zahtev: `isStaleByTime` vraća `true` kad je `data`
 * `undefined`, pa `staleTime` ne može da zaključa praznu listu.
 *
 * ⚠️ Kad se unos/izmena artikla otključaju, ta mutacija MORA da radi
 * `invalidateQueries(['masters', …])` — uz ovoliki `staleTime` nov artikal inače
 * „nedostaje" u listi do isteka pola sata.
 */
export const KES_BESKONACNE_LISTE = {
  gcTime: 30 * 60_000,
  staleTime: 30 * 60_000,
  refetchOnMount: false,
} as const;
