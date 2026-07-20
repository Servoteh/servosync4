# TRAKA B — Predmeti/RFQ + Nabavka (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Komercijala — **ne zavisi
> od GL**, može krenuti odmah posle Faze 1 (paralelno sa finansijama). **Nabavka = najbolji sprint kandidat.**
> Verifikovano nad kodom. **Ništa nije primenjeno.**

## A — Predmeti write-path + RFQ (`src/modules/projects/`)

### Stanje
`Project` = pun BigBit keš (32 polja, id=IDPredmet), piše ga isključivo sync (§3/§4). `directory` = **read-only**
(listProjects/findProject, finansijske kolone sakrivene). **Nema mutacije/numeracije/validacije**; RFQ ne postoji.
App-owned obrazac koji visi na projects već postoji: `PracenjeNote`, `PredmetAktivacija` (projectId meki ref) — presedan.
**IDPredmet = FK kroz ~25 modela** (work_orders/tech_processes/part_locations imaju pravi FK). **Blokada N3** (§11.1):
projects master ili ogledalo?

### Dizajn
**Preporuka N3 = 2.0 postaje MASTER** (write direktno u `projects`; sync→jednokratni seed/read-back) — jer je IDPredmet
kičma FK-ova; dva izvora bi razbila lanac RFQ→predmet→RN→faktura i part_locations/work_orders FK. Overlay samo za dodatna polja.

1. **Project write-path** (novi modul, odvojen od read-only directory): piše direktno u `Project` (bez izmene jezgra).
   `create`: `projectNumber = MAX(project_number::int)+1` u `$transaction` uz `pg_advisory_xact_lock` (BigBit DMax+1);
   openedAt=danas, salespersonId=JWT, status="UNKNOWN". Validacije (domenske exceptions): **workTypeId obavezno ≠0**
   (`ProjectWorkTypeRequiredException` = „Niste definisali vrstu posla!!!"), customerId postoji.
2. **`CustomerRfq`** (`/// Was: ZahteviZaPonude`, app-owned, meki refovi): requestDate, quoteDeadline, customerId,
   projectId (null dok se ne napravi predmet), origin, salespersonId, proformaDocId (→ ponuda kupcu), description, status,
   audit. **„Napravi predmet iz zahteva"** (`createProjectFromRfq`): samo ako projectId==null && description; u JEDNOJ
   `$transaction` → projects.create (kopira customerId, generiše broj, workTypeId=1/TRGOVINA, description) → **write-back
   `rfq.projectId`** (BigBit :234). Idempotentno.
3. **PredmetiPoDokumentima** — READ agregat (PG view `v_projects_by_documents`, bez persistentne tabele): jedan red po
   predmetu, boolean „ima dokument" po fazi (hasRfq/hasProforma/hasTrebovanje/hasFaktura/hasWorkOrder) preko EXISTS;
   **`Sporni` = quoteDeadline < danas AND NOT hasFaktura**. Filteri (komitent/prodavac/status/vrsta/datum). Faze koje još
   nemaju modele vraćaju false (graceful).

**Endpointi:** POST/PATCH `/projects`, POST/PATCH/GET `/rfqs`, POST `/rfqs/:id/create-project`, GET `/projects/overview`.
Nove permisije `projects.read/write`. Directory read putanja netaknuta.

## B — Nabavka (`src/modules/nabavka/`) — SPRINT kandidat
### Dizajn (doc 24)
- **`PurchaseRequest`** (`/// Was: ZahteviZaNabavku`): inicijator, `broj NNNN/god`, **IDPredmetDok NOT NULL**, IDRadniNalog,
  status; `PurchaseRequestItem` (`/// Was: SpecifikacijaZahtevaNabavke`): artikal, količina, **`KreirajUpit` flag**, dobavljač.
  Može nastati i iz MRP demand-a.
- **`SupplierRfq`** (`/// Was: T_UpitDobavljacu`): **broj prefiks=predmet-N**, dobavljač, `IDTrebVeza`=zahtev, `Poslato`;
  stavke (ponuda: rok, `PrihvacenaPonuda`; **cena tek u narudžbenici**).
- **Auto-mail RFQ** preko **Faza-0 Resend** (PDF upit prilog, log `Poslato=True`) — zamenjuje BigBit OSSMTP.
- **`PurchaseOrder`** (`/// Was: T_Trebovanja`): Poruceno/Potpisano/Zakljucano, IDUpita; stavke `TrebKol`/`IsporucenaKolicina`/
  IDStavkeUpita/IDZahtevaZaNabavku.
- **Prijem** (`IsporucenaKolicina` default=TrebKol) → **3-way match** (naručeno/primljeno/fakturisano; anti-duplo
  `IDStavkeTrebovanja Is Null`). Veza sa **Faza-3 robni ulaz** i **Faza-5 ulazna faktura**.
- **Status-mašina:** zahtev(IDStatus) → upit(Poslato) → ponuda(PrihvacenaPonuda) → narudžbenica(Poruceno) →
  prijem(Isporuceno) → faktura. `T_Statusi` per-tabela.

## Redosled + Quick win
1. Projects write-path + numeracija. 2. CustomerRfq + „napravi predmet". 3. PredmetiPoDokumentima view. 4. Nabavka:
zahtev/spec → radna lista → upit + **auto-mail RFQ** → ponude → narudžbenica → prijem → 3-way flag.
**Quick win (sprint MVP):** zahtev → auto-mail RFQ dobavljaču (PDF preko Resend) — najveća vrednost, ne zavisi od GL,
odmah upotrebljivo.

## Odluke
- ✅/⏳ **N3: 2.0 MASTER za predmete** (write direktno u projects; sync→seed) — **Negovan** (preporuka jaka: IDPredmet je
  kičma, ne fragmentisati; ako padne na ogledalo, skuplje i lomi FK).
- ⏳ **Numeracija tokom dual-run** (dok BigBit još kreira predmete) — Nenad (preporuka: 2.0 preuzima numeraciju na cutover,
  do tada RFQ→predmet samo kad 2.0 postane master).
- ⏳ **N5 servisni RN** (IFUSL iz RN) — Negovan/Nesa.
- ⏳ **MRP demand → zahtev za nabavku** veza — mi-tehnicki (postoji MrpDemand, mapirati na PurchaseRequest).

## Rizici
- **Dva pisca predmeta** (BigBit + 2.0) → N3 mora biti rešeno; do tada write-path čeka.
- **Numeracija race** → advisory lock.
- **3-way match anti-duplo** → `IDStavkeTrebovanja Is Null` guard (kao BigBit).

**Procena Trake B:** predmeti/RFQ ~9–12 AI-dana; nabavka MVP ~16–23 (sprint); ukupno ~25–35 (paralelno sa finansijama).
