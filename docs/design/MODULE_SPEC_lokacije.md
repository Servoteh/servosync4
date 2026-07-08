# Module Spec: Lokacije delova — ServoSync 2.0

| | |
|---|---|
| **Modul** | Lokacije napravljenih delova (police) + proizvodne strukture (pozicije/objekti) |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 2.0 |
| **Izvor** | QBigTehn: [migration/08 §5](../migration/08-qbigtehn-vba-domain-map.md), UI `Izvoz/Forme` |
| **Status** | Spec spreman; ledger-write posle §11 |

> Premeštanje/trebovanje napravljenih delova po policama (**ledger model**) + matični podaci pozicija/polica.
> **Napomena:** ServoSync 1.0 ima svoj modul „Lokacije delova" (Supabase) — u 3.0 se usklađuju; ovaj spec je
> QBigTehn/2.0 verzija (proizvodni delovi po RN-u).

## 1. Domenski model (Prisma)

| Tabela | Was | Uloga |
|---|---|---|
| `part_locations` | tLokacijeDelova | **LEDGER** — postavljanje i uklanjanje = odvojeni zapisi |
| `positions` | tPozicije | pozicije/police (X/Y/Z koordinate) |
| (novo) `part_location_movements` | | eksplicitan ledger pokreta (prenos/trebovanje) |
| `workers` | | ko je postavio/uklonio |

**🔴 Ključno: `part_locations` je LEDGER** — stanje = `SUM(placed) − SUM(removed)`, ne apsolutna količina.

## 2. Ekrani (iz dizajna `Izvoz/Forme`)

| Ekran | Svrha / akcije |
|---|---|
| **Lokacija napravljenih delova (zaglavlje)** (`LokacijaNapravljenihDelovaZag`) | **glavni nosilac** — prenos i trebovanje delova po policama; unos lokacija iskontrolisanih delova |
| **Kartica lokacije dela** (`KarticaLokacijaDela`) | istorija postavljanja/uklanjanja + totali (ledger prikaz) |
| **Sve lokacije po RN** (`LokacijaSvihNapravljenihDelovaPoRN`) | grid + validacija koordinata police (X/Y/Z numeričke) |
| **Unos lokacija** (`LokacijaNapravljenihDelova`) | append-only unos novih lokacija (`DataEntry`) |
| **Pregled po lokacijama** (`PregledDelovaPoLokacijama`) | globalna pretraga (server-side TVF, 12 param) |
| **Pozicije** (`frmPozicije`) | CRUD pozicija/polica |
| **Grupe/objekti** (`frmGrupe`) | CRUD objekata/hala/zona (hijerarhija) |

## 3. Poslovna pravila (🔴 = obavezan port; [08 §5](../migration/08-qbigtehn-vba-domain-map.md))

1. **🔴 Ledger:** stanje dela na lokaciji = `SUM(postavljeno) − SUM(uklonjeno)` (odvojeni zapisi, ne update količine).
2. **🔴 Prenos/trebovanje isključivi:** `KolicinaZaPrenos` i `KolicinaZaTrebovanje` **međusobno isključive** (tačno jedna ≠ 0),
   obe ≥ 0, ≤ trenutne količine, izvor ≠ cilj. Izvršenje = **transakcioni servis** (legacy SP `spIzvrsiPrenosIliCiscenjeDela`).
3. **🔴 Validacija rasporeda:** `ProveriDefinisneKolicine` — suma raspoređenih = broj iskontrolisanih delova (obavezno pre snimanja).
4. **🔴 Mapiranje kvaliteta:** `qualityType` iz flagova — **Dorada → 1, Škart → 2, inače → 0** (enum `0=OK, 1=rework, 2=scrap`).
5. **Koordinate police** `XPoz/YPoz/ZPoz` moraju biti numeričke; promena reda re-inicijalizuje parametre transfera.
6. Metapodaci dela = join `work_orders × customers × workers`.

## 4. RBAC ([RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md))

- **MAGACIONER:** write (prenos/trebovanje/unos lokacija).
- ŠEF/ADMIN: pun rad; TEHNOLOG/KONTROLOR/RADNIK: R.
- Ledger zapisi su append-only (ne brišu se; korekcija = kontra-zapis).

## 5. API (predlog, `/api/v1/part-locations/*`)

| Endpoint | Metod | Opis | Faza |
|---|---|---|---|
| `/part-locations` | GET | pregled/pretraga (po RN/lokaciji/delu) | read-only ✅ |
| `/part-locations/card/:partId` | GET | kartica dela (ledger istorija + stanje) | read-only ✅ |
| `/positions` | GET/POST/PUT | pozicije/police | read ✅ / write MAGACIONER+ |
| `/part-locations` | POST | unos lokacije (iskontrolisani delovi) | posle §11 |
| `/part-locations/transfer` | POST | prenos (transakcija, ledger) | posle §11 |
| `/part-locations/requisition` | POST | trebovanje (transakcija, ledger) | posle §11 |

## 6. Zamke (NE prenositi)

- Ručni PK `DMax('IDPozicije')+1` (race) → identity/sekvenca.
- Bez transakcije za prenos/trebovanje → DB transakcija.
- `tObjekti` lokalna Access lookup hijerarhija — **potvrditi sa Nešom** model lokacija (parent/child).
- Error handler koji skače na FindRecord (legacy bug) — ne portovati.

## 7. Otvorena pitanja

1. **§11.1** — ledger-write (mutacije).
2. **Usklađivanje sa 1.0 „Lokacije delova"** (Supabase) — u 3.0; potvrditi da li 2.0 i 1.0 dele model ili su odvojeni.
3. Hijerarhija lokacija (`positions` parent/child, objekti/hale/zone) — potvrda Neša/Negovan.
