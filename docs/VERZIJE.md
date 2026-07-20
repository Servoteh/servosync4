# ServoSync — verzije i terminologija (rečnik)

> **Od 19.07.2026 važi: ovaj repo i aplikacija su ServoSync 3.0.** Dokument postoji da
> raspetlja imena koja su se nakupila kroz istoriju — kad negde piše „2.0" ili „sy15",
> ovde se vidi na šta se to odnosi. Stariji dokumenti se ne prepravljaju retroaktivno.

## Rečnik (kanonska imena od sada)

| Kanonsko ime | Šta je | Ranija imena po dokumentima |
|---|---|---|
| **ServoSync 3.0** (ili samo „aplikacija") | Ovaj monorepo (`servosync4`): NestJS backend + Next.js frontend + **glavna baza**. Jedini aktivni sistem — sav novi razvoj ide ovde. | „ServoSync 2.0", „2.0 stack" |
| **Glavna baza** | Prod PostgreSQL na Ubuntu serveru (`ubuntusrv` 192.168.64.28:5435, Docker `servosync-pg`, baza `servosync`). Originalne tabele proizvodnje (`work_orders`, `tech_processes`, …) — vlasništvo aplikacije. | „2.0 baza", „prod PG" |
| **Stara aplikacija (1.0/1.5)** | `servoteh-plan-montaze` + njena baza (Supabase → on-prem kopija). **Read-only nasleđe koje se prazni**: moduli se sele u 3.0, podaci se migriraju, pa se gasi. | „ServoSync 1.0", „1.5", **„sy15"** (ime drugog Prisma klijenta u kodu) |
| **BigTehn / QBigTehn** | Legacy Access/MSSQL proizvodni sistem (Vasa-SQL). Ugašen kao izvor na cutover-u 14.07.2026 — pojavljuje se još samo u imenima keš tabela stare aplikacije. | „BigTehn (MES)", „QBigTehn" |
| **BigBit** | Legacy Access ERP (finansije/robno). Izvor istine za matične podatke (komitenti, artikli, projekti) **do 4.0**; u glavnoj bazi živi kao read-only keš koji puni `bigbit-sync`. | — |
| **4.0** | Faza u kojoj 3.0 preuzima i BigBit domene (GL, nabavka, fakturisanje…) i BigBit se gasi. U toku je gradnja na grani `feat/4.0-faza1` + dev sandbox baza (192.168.64.28:5437). | „4.0 ERP" |

## Šta gde piše u kodu (nasleđena imena koja OSTAJU dok se ne isprazne)

- `@prisma-sy15` / `Sy15Service` / `backend/prisma/sy15.prisma` — klijent ka bazi stare
  aplikacije. Potrošača je **15+** (puna mapa: `PLAN_F5_GASENJE_MOSTA.md` §2.2) — među njima
  `pracenje-akcije-sy15.service.ts` (karantin, akcione tačke), `plan-proizvodnje`,
  `plan-montaze`, `locations` (+ `loc-tp-feed` hranilica), sastanci… Gase se modul po modul.
- `bigtehn_*` imena u SQL-u stare baze — keš tabele koje je punio QBigTehn most do gašenja
  14.07. Planirana zamena (`loc-tp-feed` iz glavne baze) **nikad nije puštena u rad**
  (preflight 20.07: `loc_tp_feed_state` ne postoji, keš zamrznut 14–15.07). **Sa F5 nestaju
  samo 3 feed keša** (RN / linije / TP); kataloški keševi padaju tek uz B2 (BigBit most).
- Dokumenti pisani pre 19.07.2026 slobodno govore „2.0" — čitaj kao „3.0 / glavna baza".

## Istorijat verzija (ukratko)

- **1.0** — `servoteh-plan-montaze` (Supabase). HUB moduli fabrike.
- **2.0** — proizvodni core (RN/TP/PDM/kucanja) prerađen iz QBigTehn-a u ovaj repo; cutover
  14.07.2026 (QBigTehn sync ugašen, tabele vlasništvo aplikacije).
- **3.0 (SADA)** — ista aplikacija, faza seobe 1.0 modula u ovaj stack i gašenja mostova;
  praćenje proizvodnje od 19.07.2026 radi direktno na glavnoj bazi.
- **4.0** — preuzimanje BigBit ERP domena; BigBit se gasi.
