# MODULE_SPEC — Kontrola i Kucanje (BarKod terminal)

| | |
|---|---|
| **Modul** | Pogonski terminal — **Kucanje** (prijava rada) i **Kontrola** (završna kontrola: kvalitet + lokacija + nalepnica) |
| **Verzija spec** | 0.1 (draft, 2026-07-08) |
| **Faza** | 2.0 — proširenje kioska (Talas 3); jedan terminal sa dva režima |
| **Izvor UX** | `Algoritam rada aplikacije BarKodUnos2024.docx` (koren repoa, 7 screenshotova) + QBigTehn `QBigTehn_APL/forms/Form_BarKod_Unos.cls`, `Form_KeyboardSaPostupkom.cls`, `Form_LokacijaNapravljenihDelovaZag.cls` |
| **Vezano** | [MODULE_SPEC_tehnologija](MODULE_SPEC_tehnologija.md) (kucanje/scan/finish/rework), [MODULE_SPEC_lokacije](MODULE_SPEC_lokacije.md) (lokacija delova), [MODULE_SPEC_stampa](MODULE_SPEC_stampa.md) (RNZ barkod, nalepnice) |
| **Odluke** | [ODLUKE.md #4, #14](../ODLUKE.md) |

> Legacy „Kontrola" je imala **zaseban terminal/aplikaciju** (BarKodUnos2024) u kojoj su kontrolori radili. U 2.0
> se **svi loguju u istu aplikaciju**; kontrola i kucanje postaju dva režima proširenog kioska. Ovaj spec ne
> duplira tehnologiju/lokacije/štampu — **povezuje** ih i definiše samo ono što je specifično za terminal.
>
> **Ulaz u kiosk (od 12.07.2026):** nav stavke „Kucanje (pogon)"/„Kontrola (pogon)" su UKLONJENE iz 2.0
> sidebara — kiosk se otvara direktnim URL-om `/kiosk` na terminalima ili preko 1.0 HUB pločica u oblasti
> Proizvodnja (iframe deep-link, SSO handoff). Ruta i režimska logika su nepromenjeni.

## 1. Cilj i kontekst

BarKodUnos je **jedan touch-terminal** koji radi u dva režima; granicu određuje da li je skenirana operacija
**završna kontrola** (`operations.significantForFinishing = true`, Was: `tOperacije.ZnacajneOperacijeZaZavrsen`):

- **Obična operacija → KUCANJE** (prijava rada): samo broj urađenih komada.
- **Završna kontrola → KONTROLA**: broj komada + kvalitet (dorada/škart) + lokacija delova + štampa nalepnice.

„Međufazna kontrola" je operacija kao svaka druga (samo kucanje) — **pun kontrolni tok ide samo na završnoj kontroli.**

## 2. Izvor UX — BarKodUnos2024 (7 ekrana)

Screenshotovi su u izvornom `.docx` (koren repoa). Polja su verna legacy-ju:

| # | Ekran (legacy forma) | Ključna polja / dugmad |
|---|---|---|
| 1 | **Početni ekran** — „Prijava za rad identifikacionom karticom" (`ReklamniPanel_LogIn` + `Form_BarKod_Unos`) | 2 polja (šifra + ime radnika, puni sken kartice); *Zatvori nalog drugog radnika*, *Unos novog TP pre zatvaranja započetog*, *Detaljan pregled postupaka*, keypad, [X] |
| 2 | **Barkod_Unos** (posle skena) | Radnik · datum/vreme · **Postupak**: Broj predmeta, Identifikacioni broj (`predmet/redni`), Varijanta · **Operacija**: Operacija, Radna jedinica (`RJ + naziv`), Količina |
| 3 | **„ZAPOČELI STE:"** (potvrda otvaranja) | Predmet, Varijanta, Datum unosa, **Rok za izradu**, Broj crteža, Naziv dela, Komitent, **Potrebno / Napravljeno** (crveno), Operacija/RJ/Opis, žuta **napomena tehnologa** |
| 4 | **Keypad — kucanje** (`Form_KeyboardSaPostupkom`) | „Unesi broj napravljenih komada" + numerika (BS/DEL/ENTER/ESC); *Dokumentacija*, *Napomena*. **Bez Dorada/Škart.** |
| 5 | **Keypad — ZAVRŠNA KONTROLA** | Isti keypad **+ dugmad „Dorada" i „Škart"** (crveno) — samo na završnoj kontroli i samo kontroloru (Was: `tVrsteRadnika.DodatnaOvlascenja`) |
| 6–7 | **„Unos lokacije iskontrolisanih delova"** (`Form_LokacijaNapravljenihDelovaZag`) | ID RN, Predmet/Broj naloga/Komitent, Broj crteža, **Šifra radnika / Radnik**, Naziv dela, **Br. komada**, **Kvalitet** (DOBAR/DORADA/ŠKART) · grid **Pozicija / Opis / Količina** · **Ukupno komada** (mora = Br. komada) · *Kartica dela*, *Istrebuj (očisti) deo sa police*, *Premesti deo sa police*, **`Nalepnice`** (štampa), STOP |

## 3. Dva modula — podela posla

### 3.1 KUCANJE (prijava rada) — ekrani 1→2→3→4
**Tok:** sken kartice (radnik) → sken RN barkoda → sken operacija barkoda → „ZAPOČELI STE" potvrda → keypad: broj komada (+ napomena/dokumentacija) → zatvori.
**Dodatne funkcije (ekran 1):** *Zatvori nalog drugog radnika* (uz `definesApproval`/dodatna ovlašćenja), *Unos novog TP pre zatvaranja započetog* (rad na 2 RJ / 2 RN paralelno), *Detaljan pregled postupaka*.
**„Moji otvoreni"** *(isporučeno 13.07.2026, ODLUKE #36/proba r2)*: kiosk panel sa listom otvorenih
postupaka prijavljenog radnika (`GET /tech-processes/worker/open` — kartica ili JWT worker, +
`hasOpenSession`); zatvaranje operacije direktno iz liste kroz postojeći `POST /:id/finish`, **bez
ponovnog skeniranja** RN+operacija barkoda — alternativa sken-driven toku gore.
**Uglavnom već isplaniran/izgrađen** — vidi [MODULE_SPEC_tehnologija §3, §5](MODULE_SPEC_tehnologija.md). **Delta ovog terminala:** identitet iz kartice, „ZAPOČELI STE" potvrda, dodatne funkcije (§4).

### 3.2 KONTROLA (završna kontrola) — ekrani 1→2→3→**5→6→7**
**Tok:** kao KUCANJE **+** Dorada/Škart na keypadu **+** „Unos lokacije iskontrolisanih delova" (police, zbir = br. komada) **+** dugme `Nalepnice` **+** kod dorade/škarta child RN `-D/-S` + poruka tehnologu; kad su tražene operacije gotove → RN završen + zaključan.
**Delovi već specirani:** rework → [tehnologija §3.3](MODULE_SPEC_tehnologija.md); lokacija → [lokacije §2, §3](MODULE_SPEC_lokacije.md); nalepnica → [stampa §3, §6](MODULE_SPEC_stampa.md). **Net-new terminal-glue:** keypad Dorada/Škart, panel lokacije u kiosk toku, dugme štampe, kontrolorov identitet+audit.

## 4. Mapiranje na 2.0 (šta postoji / šta fali)

| Feature | Postoji u 2.0 | Fali |
|---|---|---|
| Sken + broj komada | `scan()`/`finish()` [tech-processes.service.ts](../../src/modules/tech-processes/tech-processes.service.ts), kiosk [kiosk.ts](../../../frontend/src/api/kiosk.ts) | — |
| Identitet radnika/kontrolora | `workers.cardId` u šemi | `scan`/`finish` DTO ne prima radnika; kiosk nema login karticom |
| „ZAPOČELI STE" potvrda | decode vraća `workOrder` + `operationCount` | UI kartica (naziv dela, potrebno/napravljeno, rok, napomena) |
| Okidač završne kontrole | `operations.significantForFinishing` + `markWorkOrderIfComplete` | grananje UI-a (kucanje vs kontrola) |
| Kvalitet DOBAR/DORADA/ŠKART | `PART_QUALITY {0,1,2}`, `rework-work-order.dto.ts` | keypad toggle; rework endpoint na postupku (`/tech-processes/:id/rework` — [tehnologija §5](MODULE_SPEC_tehnologija.md)) |
| Lokacija iskontrolisanih delova | modul [part-locations](../../src/modules/part-locations/) (ledger) | kiosk panel + validacija zbira (`ProveriDefinisneKolicine`) |
| Nalepnica | ništa (backend ni frontend) | port `tspl2.js` iz 1.0 + RNZ barkod + dugme štampe |

## 5. Poslovna pravila (🔴 = mora preživeti)

1. **🔴 Identitet i audit ([ODLUKE #14](../ODLUKE.md)):** kontrolor se identifikuje **skeniranjem ID kartice** (`workers.cardId`). Završna kontrola upisuje **ko (ime+prezime) i kada** — obavezan audit. **KONTROLOR (i `MENADZMENT`) sme validirati da je TP završen i ako sve operacije nisu otkucane** („ako on kaže da je dobro, dobro je").
2. **🔴 Okidač:** pun kontrolni tok (Dorada/Škart + lokacija + nalepnica) **samo kad `significantForFinishing = true`**. Sve ostalo je kucanje.
3. **🔴 Dorada/Škart:** vidljivi samo kontroloru na završnoj kontroli; kvalitet enum `0=dobar, 1=dorada, 2=škart`; 1/2 → child RN (`-D`n/`-S`n) + poruka tehnologu ([tehnologija §3.3](MODULE_SPEC_tehnologija.md)).
4. **🔴 Lokacija tek posle završne kontrole** ([lokacije §3.7](MODULE_SPEC_lokacije.md)): deo dobija policu tek kad prođe kontrolu. Zbir raspoređenih količina po policama **mora = Br. komada** pre snimanja (`ProveriDefinisneKolicine`, [lokacije §3.3](MODULE_SPEC_lokacije.md)); ledger model (`SUM(postavljeno)−SUM(uklonjeno)`).
5. **🔴 Zatvaranje/zaključavanje RN:** kad su sve `significantForFinishing` operacije gotove → RN završen + zaključan (`markWorkOrderIfComplete`).
6. **Autorizacija:** radnik radi samo operacije iz `machine_access`; „zatvori nalog drugog radnika" traži `definesApproval`/dodatna ovlašćenja ([tehnologija §3.4](MODULE_SPEC_tehnologija.md)).
7. **Transakcije:** kontrola (kvalitet + lokacija + zatvaranje + eventualni child RN) ide u **jednu DB transakciju** (legacy nije atomičan).

## 6. Nalepnica — RNZ barkod (reuse iz 1.0)

**Barkod = kanonski RNZ iz [stampa §3.1](MODULE_SPEC_stampa.md): `RNZ:{projectId}:{identNumber}:{variant}:{revision}`** (NE legacy 3-delni `IDPredmet:IdentBroj:Varijanta`). Prednost: kiosk `useDecodeBarcode` već dekodira RNZ → **odštampana nalepnica se kasnije re-skenira** (kiosk ili telefon, §8) i vodi nazad na RN.

**Polja na nalepnici** (legacy report `Nalepnice`): Naziv predmeta · Broj predmeta + Komitent · Naziv dela · Broj crteža · Količina/Ukupno · Materijal · Datum + RNZ barkod. **Jedna nalepnica po komadu.**

**Reuse:** port `src/lib/tspl2.js` + `dispatchOptionalNetworkLabelPrint` iz `servoteh-plan-montaze` → TSPL2 → lokalni proxy → **TCP 9100** (TSC ML340P, 300 DPI); `window.print()` fallback. Detalji [stampa §6](MODULE_SPEC_stampa.md). Zavisnost `jsbarcode`/proxy dostupnost → [stampa §10](MODULE_SPEC_stampa.md) (odobrenje BACKEND_RULES §10).

## 7. API (predlog)

| Ruta | Metod | Opis |
|---|---|---|
| `/tech-processes/scan` | POST | **+ `workerCard`** (identitet iz kartice); prijava rada |
| `/tech-processes/:id/finish` | POST | zatvaranje; kontrolor sme i bez svih otkucanih (ODLUKE #14) |
| `/tech-processes/worker/open` | GET | **isporučeno 13.07.2026 (ODLUKE #36)** — „Moji otvoreni": otvoreni postupci radnika (`?card=` ili JWT worker) + `hasOpenSession`; zatvaranje iz liste kroz `/:id/finish` bez ponovnog skeniranja |
| `/tech-processes/:id/control` | POST | **novo** — završna kontrola: `{ workerCard, qualityTypeId, pieceCount, locations: [{positionId, quantity}], note? }`; jedna transakcija: kvalitet + lokacije + zatvaranje + child RN |
| `/tech-processes/:id/rework` | POST | dorada/škart → novi nalog ([tehnologija §5](MODULE_SPEC_tehnologija.md)) |
| `/work-orders/:id/labels` | GET | TSPL2/PDF nalepnice ([stampa §8](MODULE_SPEC_stampa.md)) |

## 8. Fazni plan

- **P1 — tanak presek (end-to-end):** login karticom → sken RN+operacija → „ZAPOČELI STE" → keypad broj komada → (ako završna kontrola) kvalitet **DOBAR** + lokacija → **štampa nalepnice (RNZ)** → zatvaranje/zaključavanje RN. Audit ko/kada.
- **P2 — puna parnost:** Dorada/Škart + child RN + poruka tehnologu; prenos/trebovanje sa police; dodatne funkcije (zatvori tuđi nalog, paralelni TP), „Detaljan pregled postupaka".
- **P3 (priprema, ne gradi se sad) — MOBILNI UNOS:** operater sa **telefona** skenira RNZ nalepnicu i radi UNOS iste operacije umesto na terminalu. **Zahtev za sad:** UNOS endpoint-i ostaju čist REST/JWT (bez vezanosti za kiosk), RNZ barkod telefon-kamerom čitljiv (CODE128), identitet radnika parametar (kartica **ili** ulogovani korisnik) — da mobilni klijent kasnije samo gađa iste rute.

## 9. Otvorene odluke / zavisnosti

1. **Audit identitet:** kartica-sken (`cardId`) je dovoljan za „ime+prezime+kada" u P1; puni `users.worker_id` link je [tehnologija/RBAC](RBAC_RLS_PREDLOG.md) posao — ne blokira P1.
2. **Nalepnice — gde žive** i zavisnost `jsbarcode`/proxy → [stampa §10.1/§10.2](MODULE_SPEC_stampa.md).
3. **`revision` bump** kao 5. polje barkoda → [stampa §5, §10.3](MODULE_SPEC_stampa.md).
4. **predmet 4521 / `excludeFromReworkScrap`** ([ODLUKE — za Negovana, tačka 4](../ODLUKE.md)) — utiče na child-RN logiku u P2.

## 10. Nove odluke (registrovati u ODLUKE.md kad se potvrde)

- **Barkod na nalepnici = RNZ** (`RNZ:projectId:identNumber:variant:revision`), da ga kiosk i mobilni skener dekodiraju (potvrda Nenad, 2026-07-08). Poklapa se sa [stampa §3.1](MODULE_SPEC_stampa.md).
- **Mobilni UNOS sa telefona = Faza 2** (priprema od P1: čist REST/JWT + telefon-čitljiv RNZ), ne gradi se u 2.0 pilotu.
