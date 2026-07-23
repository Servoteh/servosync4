# Predmeti — rekonstrukcija domena + veza sa ServoSync 2.0

> **Status:** ANALIZA (2026-07-18, iz izvučenog koda). Procedura unosa rekonstruisana iz BigBit
> koda (nema zapisane procedure — Nenad: „rekonstruiši iz koda"). Predmet unosi **poslovni
> administrator/komercijala**.

## 0. Dva „predmeta" — ne mešati

| | (1) Pisarnica — delovodnik | (2) **Poslovni predmet** ← OVAJ domen |
|---|---|---|
| Tabela | `T_Predmeti` | **`Predmeti`** |
| Numeracija | `ORGAN/KLASIF/Godina` | rastući broj (max+1) |
| 2.0 | nema | `projects` (7.602 reda, sync) |

## 1. DDL `Predmeti` (schema.sql:858-898) — globalna tabela (bez firma/OJ/god particije)

Ključne kolone: `IDPredmet` (PK), **`BrojPredmeta`** T(20) NOT NULL (jedinstven, auto-broj),
`NazivPredmeta` T(250), `DatumOtvaranja`/`RokZavrsetka` NOT NULL, `DatumZakljucenja`, **`Status`**
T(20) NOT NULL (slobodan tekst), `NextAction`, **`IDProdavac`** (vlasnik/komercijalista) +
**`IDKomitent`** (kupac) + **`IDVrstaPosla`** (FK `PredmetiVrstaPosla`, obavezno) — sve NOT NULL.
Uvozna kalkulacija na predmetu: `NabavnaVrednost, Carina, Spedicija, Prevoz, Ostalo` (Currency),
`InoDobavljac`, `devvaluta`/`kurs`. Reference: `Nasa/VasaRef` + kontakti, `BrojUgovora`,
`BrojNarudzbenice`, `RJ`, `Memo`, audit (`Potpis`/`DatumIVreme`).

Vezane: `PredmetiVrstaPosla` (šifarnik), `PredmetiFazeDef` + `PredmetiFaze` (faze/napredak po
predmetu), `ZahteviZaPonude` (RFQ, schema:3135), `ZahteviZaNabavku` (interni, schema:2286).

## 2. Procedura unosa (rekonstruisano)

1. **Ko:** komercijala/poslovni administrator; vlasnik = `IDProdavac` = `CurrentUser()`.
2. **Numeracija = max+1** (NE datumski): `BrojPredmeta = CLng(Nz(DMax(NajveciBrojPredmeta),0))+1`
   (`Izvoz\Forme\Predmeti.txt:1977-1980`; isto u komercijalnoj `Doc__Form_Predmeti.txt:42-45`).
   Prost rastući integer čuvan kao tekst; `Date&"/"&IDPredmet` je fallback. `DatumOtvaranja=Date` auto.
3. **Obavezno `IDVrstaPosla`** — `Form_BeforeUpdate`: ako je 0 → „Niste definisali vrstu posla!!!"
   + CancelEvent (`Predmeti.txt:2030-2036`). DDL NOT NULL i na broju/datumima/prodavcu/komitentu/statusu.
4. **Statusi = slobodan tekst** (combo `SELECT DISTINCT Status`, bez enuma); default `"UNKNOWN"`.
5. **Idempotentno kreiranje:** `KreirajIliPronadjiPredmet(BrojPredmeta,…)` dedup po broju, hvata
   index-clash 3022 (`BBKreiranjeDokumenata.txt:1558-1627`).
6. Import komercijala→tehnologija: `F_PrebaciPredmeteIzEXTBaze` (isti model, dva izvora).

## 3. Veze (lead-to-cash)

```
RFQ kupca (ZahteviZaPonude, IDDokProf→Profaktura)
        └─"Napravi predmet na osnovu zahteva"─▶ Predmet
                 ├─▶ RadniNalozi (IDPredmet NOT NULL, 1:N)   ─▶ TP ─▶ PDM/nacrti (preko RN)
                 ├─▶ Trebovanja / ZahteviZaNabavku (IDPredmetDok, IDRadniNalog)
                 └─▶ Profaktura / Izlazna faktura (IDPredmet)
```
`IDPredmet` je FK u **~25+ tabela**. „Kartica predmeta" = agregat svih artikala/dokumenata/troškova
po predmetu (`PredmetiPoDokumentima`, `KarticaArtikalaPredmet`). RFQ je **ulazna tačka pre predmeta**.

## 4. Šta 2.0 ima vs. fali

**Ima (read-only cache):** `Project` (schema.prisma:685-729, svih 32 polja), `ProjectWorkType`,
sync `Predmeti→projects` (permanent master cache), read pristup (`directory.listProjects/getProject`,
`lookups.projects`), reference `WorkOrder.projectId`/`TechProcess.projectId`/`projectItemId`.

**Fali za pun modul:**
1. **Write-path** — nema Unos/izmena, nema auto-numeracije (max+1), validacije `IDVrstaPosla`, statusa.
2. **RFQ / „Zahtevi za ponude od kupaca"** — nema tabele/modela; grep `rfq|zahtev-za-ponud` po
   `backend/src` = 0. **Ceo lead-in tok nedostaje.**
3. **Kartica predmeta** (agregat) kao ekran.
4. **Faze predmeta** (`PredmetiFaze*`).
5. `NextAction`/workflow.

## 5. Procena (dopuna 4.0)

| Celina | Procena |
|---|---|
| Projects CRUD + numeracija (max+1) + validacije/statusi | 3–4 d |
| RFQ modul „Zahtevi za ponude" (nove tabele, CRUD, „napravi predmet iz zahteva") | 4–5 d |
| Kartica predmeta (read agregat RN+dok+troškovi+faze) | 2–3 d |
| Faze predmeta | 1–2 d |
| Frontend (Unos/Pregled/Kartica/RFQ) | 4–6 d |
| Sync/vlasništvo + overlay dizajn | 2 d + **odluka** |
| **Ukupno** | **~16–22 radna dana** |

⚠️ **Blocker (BACKEND_RULES §11.1):** pre write-a u `projects` treba odluka — postaje li 2.0 master
za predmete (BigBit sync → read-back) ili ostaje ogledalo. Menja procenu i arhitekturu.

> **O „modul za 10 dana":** čist CRUD predmeta + kartica (bez RFQ) staje u ~8–10 dana. Ali „pun
> predmeti modul" sa RFQ lead-inom i overlay odlukom je ~16–22. RFQ je ono što BigBit-u daje
> vrednost (lead→predmet→RN→faktura) — preporuka: ne izostaviti ga.

**Ključni fajlovi:** DDL `_analiza\bigbit\BB_T_26_schema.sql:858,2286,2581,3135`; numeracija/validacija
`Izvoz\Forme\Predmeti.txt:1977,2031`; RFQ→Predmet `_extracted\OnLine_BigBit_VBA\Doc__Form_ZahteviZaPonude.txt:200`,
`Doc__Form_Predmeti.txt:42,171`; 2.0 `backend\prisma\schema.prisma:685-738`, `sync-map.generated.ts:1303`.
