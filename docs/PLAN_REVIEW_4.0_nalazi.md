# 4.0 fazni plan — adversarni review (nalazi + ispravke)

> **Datum:** 2026-07-19. Fable review celog plana (4 recenzenta: zavisnosti, računovodstvo, data/migracija,
> rizik) + sinteza. **52 nalaza**, dedupovano. **Verdikt: UZ-ISPRAVKE** — plan je zreo i kod-verifikovan, ali
> NIJE build-ready dok se ne zatvore 4 blokade koje ruše temelj. Sve 4 su rešive odlukama na Kapiji 0 +
> preraspodelom rada, bez rušenja arhitekture.

## 🔴 4 BLOKADE (moraju pre gradnje)

### B1 — Vlasništvo `goods_documents` je pogrešno pretpostavljeno
Faza 3/5 tvrde „2.0 ih vlasnički piše (nisu sync-cache)". **Kod dokazuje suprotno:** `sync-map.generated.ts:3079-3081`
(T_Robna dokumenta→goods_documents) i `:3505-3506` (→items); `table-ownership.ts` kaže da ih BigBit nastavlja da hrani.
→ **dual-writer sudar tiho korumpira robno/GL.**
**Akcija:** Kapija 0 — **nova odluka o vlasništvu goods_documents** (fali u planu). Ili izbaciti `T_Robna dokumenta` iz
SYNC_MAP i preneti u 2.0 (kao QBigTehn lanac na cutover-u), ili overlay/dual-key kao za items. **Ispraviti netačnu
tvrdnju u [PLAN_FAZA_3](PLAN_FAZA_3_robno-costing.md).**

### B2 — GL model-imena nekonzistentna kroz faze
Kontni plan = `Account` (F1) vs `ChartOfAccount` (FN); stavka = `LedgerEntry` (F2/F4) vs `JournalLine`+`isOpenItem` (FN).
→ **cutover puni tabele koje GL jezgro/saldakonti/POPDV/ZR ne čitaju** = nevidljiva istorija ili paralelni drift.
**Akcija:** **Zaključati kanonska imena PRE Faze 2** (`Account`, `LedgerEntry`) i u Fazi 2 predvideti SVE kolone koje
kasnije faze traže: `dueDate`, `documentNumber`, `analyticalCode`(=customerId), `entryType='PS'`, `reconciledAt`/
`reconciliationGroupId`, `projectId`. Faza N tada samo PUNI postojeću šemu. Otvorena stavka = `reconciledAt IS NULL`
(bez paralelnog `isOpenItem` flaga).

### B3 — PS prenos: otvorene stavke po komitentu vs po fakturi
F4 = izveden pogled (reconciledAt NULL, grupisano po account+partner+**documentNumber**). Faza N migrira „neto po
komitentu + isOpenItem". → **aging/priprema plaćanja/IOS/kompenzacija/auto-reconcile po broju fakture nemaju podatke.**
**Akcija:** Cutover PS migrira **PO POJEDINAČNOJ FAKTURI** (documentNumber+dueDate+iznos, reconciledAt=NULL). **V2
verifikacija poredi i po dokumentu i aging bucket**, ne samo ukupan saldo po komitentu.

### B4 — Prod migraciona strategija (deploy okida migracije automatski!)
`deploy-backend.yml:61` radi `prisma migrate deploy` **na svaki push `backend/**`**. Plan traži **Float→Decimal
`ALTER USING` in-place na vrućim popunjenim tabelama** → lock/zastoj proda bez rollback/prozora.
**Akcija:** Kapija 0 odluka (ne fusnota): Float→Decimal kao **aditivna kolona + backfill + swap** (NE in-place ALTER na
hot tabeli), izvesti **PRE prvog produkcionog knjiženja (Faza 0/1, ne Faza 3)**, razdvojiti tešku migraciju od koda,
prozor održavanja + rollback + snapshot backup + pre/posle verifikacija suma (tolerancija 0).

## 🟠 VISOK — jedna autoritativna konto mapa
Konta se koriste kroz faze, ali nema JEDNOG registra. **Akcija:** U Fazi 1 definisati **jednu `SaldakontoAccount`**
(konto→kontrolni→strana, uklj. 435x dobavljači, 202x/2040/2050 kupci + izvozne/devizne `holdsFxBalance`) i **jednu PDV
konto mapu** (47x izlazni po stopi, 27x ulazni, 2740 carinski, 2790 transit). **SVE faze čitaju taj registar.**
Knjigovođa potvrđuje pod-konta pre Faze 2. **Balans-kontrolu ΣDug=ΣPot pomeriti na chokepoint kreiranja SVAKOG
JournalEntry** (ručni, izvod, kompenzacija, storno, PS, migracioni uvoz — svi kroz isti gate), ne samo posting engine.

## ✅ Šta je plan uradio dobro (review potvrdio)
- **Kod-verifikacija je stvarna i ubojita** — B1 (goods_documents) uhvaćen čitanjem sync-map/table-ownership, ne
  nagađanjem. To je klasa greške koja tiho obara ovakve projekte.
- **Tačno prepoznat najveći rizik = validacija knjigovođe** (paralelni rad „do dinara"), ne kod — zrelo.
- **Kapija 0 kao koncept** je pravi pristup (samo lista nepotpuna — fale B1, B4).
- **Idempotentnost svesno tretirana** (guard po sourceGoodsDocId, anti-duplo, @@unique, 3-way match).
- **Dual-writer disciplina** ispravna za items/customers/projects (samo nedosledno na goods_documents).
- **Domenska dubina visoka** — POPDV/KEPU/ZR-AOP/SEF UBL/carinski pretporez/kursne razlike svi na radaru.

## Zaključak
**Plan je gradiv UZ-ISPRAVKE.** 4 blokade + 1 autoritativna konto mapa = ~1–2 dana rada na Kapiji 0 (odluke +
preraspodela između faza), bez rušenja arhitekture. Ove ispravke unete su kao **dopune u [Kapiju 0](PLAN_GRADNJE_4.0_FAZNI.md)**
i relevantne fazne planove (F2 kanonska imena, F3 goods_documents ispravka, FN PS-po-fakturi, F0/F1 prod migracija).
