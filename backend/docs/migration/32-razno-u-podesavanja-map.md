# BigBit „RAZNO" → 2.0 `podesavanja` — mapiranje i gap

> **Status:** ANALIZA (2026-07-18). Odluka (Nenad): modul RAZNO se prepakuje u `podesavanja`. Cilj:
> da ništa ne promakne pri stapanju. Autoritativna lista: [10-bigbit-glavni-meni.md](10-bigbit-glavni-meni.md).

## Ključni nalaz o strukturi (menja pristup)

Dva odvojena podatkovna sveta u 2.0:
1. **`podesavanja` modul** radi nad **sy15/kadrovska** bazom (`@prisma-sy15`) — danas je to **RBAC + HR +
   AI-sistem konzola** (korisnici/uloge, odeljenja/radna mesta, kompetencije, AI modeli, audit). **Nijedan
   komercijalni/finansijski šifarnik iz RAZNO nije ovde.**
2. **Glavna 2.0 šema** (`@prisma/client`) — QBigTehn mirror. **Većina RAZNO šifarnika VEĆ postoji kao
   Prisma model (cache)**, deo se sync-uje, ali **NIJEDAN nema admin CRUD/UI** — koriste se read-only interno.

→ **Preporuka:** RAZNO finansijski šifarnici idu u **novi `sifarnici`/config sloj vezan na glavni
`PrismaService` (NE sy15)**, izložen kao novi tabovi u `podesavanja` UI po postojećem obrascu. Šeme za
kontiranje + Kontni plan su zapravo **GL-preduslovi**, ne „podešavanja" — izdvojiti ih u finance-foundation.

## A) Mapiranje 14 RAZNO stavki

✓ ima admin ekran · ◐ cache bez UI · ✗ ne postoji · ⛔ van opsega

| RAZNO stavka | 2.0 | Model | Napomena |
|---|---|---|---|
| **Korisnici** | ✓ (bolja impl.) | sy15 `user_roles`+GoTrue | 2.0 RBAC nadmoćan; BB korisnici se NE migriraju |
| **Poreske stope** | ◐ 🔴 | `TaxRate` (synced) | ima `validFrom/validTo/vatGroup`; fali admin+versioning ekran; GL/PDV-kritično |
| **Grupe/Podgrupe/Poreklo** | ◐ | `ItemGroup/Subgroup/Origin` | NISU u sync-map (sync neizvestan); `ItemOrigin.discountPercent`=rabat |
| **Vrste dokumenata** | ◐ 🔴 | `DocumentType` (synced) | srž: `postingTemplate` FK→šema, `kepuDefault*`, `postInVatLedger`, `affectsStock`; fali UI |
| **Vrste naloga** | ◐/✗ | `OrderType` (NIJE u sync-map→prazna) | 117 redova (GK nalozi+tipovi izvoda); GL-kritično |
| **Šeme za kontiranje** | ✗ 🔴🔴 | **NEMA modela** | **najveći gap** — 30 šema+105 stavki sa `Eval()` (`DefDug`="A+B+C") = GL posting engine |
| **Cenovnik** | ◐ | `PriceListEntry` (synced) | pun admin verovatno u `sales`; u podešavanja bar read |
| **KEPU Veleprodaja** | ⛔ | — | regulatorna knjiga → finance/inventory, ne šifarnik |
| **Knjiga PK1** | ⛔ | — | paušal/MP, van opsega |
| **KEPU Maloprodaja** | ⛔ | — | MP van opsega |
| **Poslovi** | ◐/❓ | verovatno `ProjectWorkType` (5) | potvrditi da li je GK „poslovi" dimenzija |
| **Radni nalozi** (BB komerc./MP-servis) | ⛔ | ≠ 2.0 `WorkOrder` | drugačiji od proizvodnog RN; van settings-a |
| **Magacini** | ◐ | `Warehouse` (synced) | jednostavan CRUD+UI |
| **Kursna lista** | ⛔ | **NEMA modela** | devizno van opsega (4.0: auto-import NBS kasnije) |

Pridruženi (nisu na meniju ali potrebni): `PaymentAccount` (UplatniRacuni, cache bez UI — banking),
`CodeType`, `Salesperson`, CFG parametri.

## B) Šta `podesavanja` VEĆ ima

RBAC (korisnici/uloge/grid-editori, dvostrano GoTrue+sy15+2.0), HR organizacija (odeljenja/radna mesta),
vrednosti firme, očekivanja, kompetencije, predmet-aktivacija, notifikacije, integracije, audit read,
AI-sistem, izgled. „Matični podaci" tab je tanak hub (Organizacija/Mašine/Predmeti) — **bez ijednog
finansijskog šifarnika**.

## C) Gap (po kritičnosti)

1. **Šeme za kontiranje (+Stavke) — FALI KOMPLETNO** 🔴🔴 — nema modela/syncera/UI; 30+105 sa izraz-engine.
2. **Kontni plan** — FALI (nije na RAZNO meniju nego GLAVNA KNJIGA, ali preduslov; 1389 konta, doc 30).
3. **Vrste naloga** — model prazan; treba punjenje + numeracija po vrsti (sekvenca firma/vrsta/godina).
4. **Vrste dokumenata** — cache bez UI; rešiti FK ka šemi.
5. **Poreske stope** — cache bez versioning ekrana (BigBit „masovna promena stopa" → versioning po datumu).
6. **Magacini/Grupe/Cenovnik/UplatniRacuni/Vrste šifara** — cache bez UI (potvrditi sync za Grupe/Poreklo).

## D) Zavisnosti (tvrd redosled — kapije 4.0 finansija)

- **GL/knjiženje** ← Kontni plan → Šeme za kontiranje → Vrste naloga → Vrste dokumenata (`postingTemplate`).
- **PDV/POPDV** ← Poreske stope (versioned) + PDV_Knjige + `postInVatLedger`.
- **Cenovnik/sales** ← Cenovnik + Poreske stope + Vrste dok + Grupe/Poreklo.
- **Inventory** ← Magacini + Vrste dok (`affectsStock`, KEPU).
- **Banking** ← UplatniRacuni.

→ **Šeme za kontiranje + Kontni plan + Vrste naloga + Vrste dokumenata + Poreske stope moraju biti
kompletirani PRE bilo kog finance/GL/PDV/sales/inventory modula.**

## E) Procena + isključeno

| Deo | AI-dani |
|---|---|
| Uski RAZNO šifarnici u podešavanja (Magacini, Poreske stope+versioning, Grupe, Vrste naloga, Vrste dok, Poslovi/UplatniRacuni/Vrste šifara, hub restrukturiranje) | **~11–12** |
| + finansijski temelj (Šeme za kontiranje+izraz-engine, Kontni plan, Cenovnik read) | +8–10 |
| **Ceo RAZNO temelj** | **~19–22** |

**Preporuka:** Šeme za kontiranje + Kontni plan **izdvojiti iz „podešavanja" u finance-foundation
paket** (oni su GL preduslov, ne obični šifarnik). Uski deo (~11–12 dana) je čisto podešavanja.

**ISKLJUČENO:** KEPU MP, Knjiga PK1, Kursna lista (devizno), KEPU VP (transakciona knjiga, ne šifarnik),
BB Radni nalozi (MP-servis), BB Korisnici (2.0 RBAC je zamena).

**Sažetak „da ništa ne promakne":** od 14 RAZNO — **1 pokrivena** (Korisnici), **7 delimično** (cache bez
UI), **1 kompletno fali** (Šeme za kontiranje + Kontni plan), **5 van opsega**.
