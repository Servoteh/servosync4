# MODULE SPEC — Kontrola kvaliteta (kartica u PROIZVODNJI)

> **Status: PREDLOG — analiza i plan (Nenad, 15.07.2026). Ništa se ne implementira dok Nenad ne potvrdi.**
> Izvori: `Evidencija škartova 2026.xlsx` + `Evidencija dorada 2026.xlsx` (koren repoa, snimljeno 15.07),
> legacy QBigTehn `Form_KeyboardSaPostupkom`/`BBTehn_Module` (analiza 15.07), postojeći 2.0 kod
> (`tech-processes` control tok, D8 notifikacije, `tech_process_documents`), MODULE_SPEC_kontrola.md.

## 0. Cilj

Kontrola kvaliteta postaje **prava kartica u grupi PROIZVODNJA** (ne samo kiosk ekran):
jedno mesto gde kontrola vodi **evidenciju neusaglašenosti (škart + dorada)** — do sada ručno u
dva Excel fajla — sa automatskim punjenjem iz kucanja kontrole, izveštajima (dan/nedelja/mesec/
godina, po radniku/RJ/kupcu/uzroku) i pregledom „mojih neusaglašenosti" u Moj profil za svakog
radnika. Dugoročno: elektronske beleške/anotacije naloga sa tableta (zamena za skeniranje
odštampanih naloga).

## 1. Analiza postojećih Excel evidencija (izvor istine za model)

Obe tabele imaju praktično isti sleng/kolone (razlika: škart „Količina odbačenih", dorada
„Količina dorađenih" + kolona „Dodatno"). Stanje 15.07.2026:

| | Škart | Dorada |
|---|---|---|
| Zapisa 2026 | 27 (poslednji izveštaj **027/26**, 14.01–jul) | 12 (poslednji **012/26**, do 18.06) |
| Ukupno komada | 73 | 130 |
| Vodeći uzrok | „Neopreznost" (15), „Loš materijal" (4) | „Neopreznost" (8) |

Kolone (obe tabele): `R.br · Datum · Br. izveštaja (NNN/YY, po godini i tipu!) · Naziv pozicije ·
Br. crteža · Br. RN · Kupac · Količina · Opis greške · Uzrok · Radna jedinica · Izvršilac ·
Trošak materijala · Trošak kooperacije · Utrošeno radnih sati · Napomena · Preventivne mere ·
Kontrolor („Neusaglašenost ističe") · [Dodatno — samo dorada]`.

**Ključna zapažanja iz podataka (oblikuju model):**
1. **Br. izveštaja** je godišnja sekvenca PO TIPU (škart i dorada nezavisno broje NNN/26) —
   aplikacija mora da NASTAVI numeraciju (sledeći škart = 028/26, dorada = 013/26) → jednokratni
   uvoz postojećih zapisa je obavezan.
2. **Izvršilac** nije uvek radnik: „Magacin alata", „Projektni biro", „RN 9000", i ume da bude
   VIŠE radnika („Ivan Zagrajski, Jovan Peladić") → model: M:N veza ka `workers` + slobodan tekst
   fallback (za org-jedinice). Za Moj profil se koristi SAMO M:N veza.
3. **Radna jedinica** je čas RC („CNC glodanje", „Ravno brušenje"), čas organizaciona celina
   („Projektni biro", „Magacin alata") → tekst + opcioni link na `operations.work_center_code`.
4. **Troškovi** su danas slobodan tekst sa specifikacijom materijala („Č.4732--14,14kg") →
   zadržati tekst polja (paritet), NE forsirati brojeve u P0; „Utrošeno radnih sati" parsirati
   best-effort u numerik (za izveštaje) uz čuvanje originalnog teksta.
5. **Uzrok** je kandidat za šifarnik (Neopreznost / Loš materijal / Alat / DXF-dokumentacija /
   Kooperant-proces...), ali u P0 ostaje slobodan tekst + kasnije normalizacija.
6. Neusaglašenost može nastati i BEZ kucanja na kiosku (npr. DXF greška Projektnog biroa) →
   ručni unos je ravnopravan tok, ne samo auto-iz-kioska.

## 2. Postojeće stanje u 2.0 (šta već imamo)

- Kucanje kontrole (kiosk `/pogon`): kvalitet **0=dobar / 1=dorada / 2=škart** na
  `tech_processes.quality_type_id`; količine po kvalitetu već agregirane u kartici/rn-progress.
- **D8 notifikacija tehnolozima + projektantu crteža** na doradu/škart iz `control()` — VEĆ ŽIVI.
- Child RN za doradu/škart (−D/−S, `parent_work_order_id` + `?reworkOnly` filter) — deployovano
  (PAKET B); `childOrderPending` u control odgovoru.
- `tech_process_documents (tech_process_id, file_link, file_name)` — tabela + prikaz POSTOJE,
  nema unosa (Faza 2 dole).
- `note` na control DTO (upis u `tech_processes.note`) — ali FE nema polje (Faza 1 dole).
- Legacy paritet (QBigTehn): škart/dorada toggle bez potvrde; `T_Planer` poruka „TEHNOLOG";
  overshoot TVRDA blokada; dokumentacija = kopija fajla na CFG share + link u
  `tTehPostupakDokumentacija`. **Excel evidencije su vođene VAN qbigtehn-a** — ovo je prvi put
  da se digitalizuju.

## 3. Informaciona arhitektura — kartica „Kontrola kvaliteta"

Nova stavka u nav grupi **PROIZVODNJA** (app-shell): `Kontrola kvaliteta` → ruta `/kvalitet`,
gate `KVALITET_READ` (nova permisija — dole §7). Tabovi:

| Tab | Sadržaj | Gate |
|---|---|---|
| **Evidencija škarta** | tabela svih škart izveštaja (kolone iz Excel-a), filteri (period, RN/predmet, radnik, RJ, uzrok, kupac), detalj + izmena, „Novi izveštaj" | KVALITET_READ / _WRITE |
| **Evidencija dorada** | isto za doradu | isto |
| **Izveštaji** | agregati: dnevno/nedeljno/mesečno/godišnje (kom + izveštaja + sati); po radniku, RJ, kupcu, uzroku; trend grafikon; poređenje škart vs dorada | KVALITET_READ |
| **Kontrola pogon** | pločica/prečica ka kiosku `/pogon` (fullscreen kucanje kontrole) — kao HUB pločica u 1.0; NE embed | TEHNOLOGIJA_APPROVE |
| **Dokumentacija** *(Faza 2)* | pregled priloženih QC skenova po nalogu (tech_process_documents) + prilaganje sa share-a | KVALITET_READ |

„Na čekanju" bedž na tabovima evidencija: broj **draft** izveštaja (auto-kreiranih iz kioska,
nepopunjenih) — to je radna lista kontrolora.

## 4. Model podataka (novo — app-only 2.0 tabele, NISU legacy sync)

```prisma
/// Izveštaj o neusaglašenosti (škart ILI dorada) — digitalizacija Excel evidencija.
model NonconformityReport {
  id              Int      @id @default(autoincrement())
  type            Int      // 1 = dorada, 2 = škart (poklapa PART_QUALITY)
  reportNumber    String   // "028/26" — sekvenca PO (type, godina); dodeljuje server
  reportYear      Int      // 2026 (za sekvencu i filtere)
  reportDate      DateTime // Datum iz evidencije
  status          Int      // 0 = draft (auto iz kioska, čeka dopunu), 1 = potvrđen
  // Veza na proizvodnju (meki FK-ovi, batch-resolve; slobodan tekst uvek postoji)
  workOrderId     Int?     // work_orders.id kad je razrešen
  identNumber     String?  // "9400-1/442" — i kad RN nije u 2.0
  sourceTechProcessId Int? // tech_processes.id kad je nastao iz kucanja kontrole
  drawingNumber   String?
  partName        String?
  customerName    String?  // tekst (Excel paritet); customerId Int? opciono
  quantity        Int      // odbačeni/dorađeni komadi
  defectDescription String // Opis greške
  cause           String?  // Uzrok (slobodan tekst; šifarnik u kasnijoj fazi)
  workUnit        String?  // Radna jedinica (tekst; opciono RC kod)
  culpritText     String?  // Izvršilac — slobodan tekst (org jedinice, spoljni)
  materialCostNote String? // Trošak materijala (tekst, npr. "Č.4732--14,14kg")
  coopCostNote    String?  // Trošak kooperacije (tekst)
  spentHoursText  String?  // Original ("4,64h")
  spentHours      Decimal? // parsirano za izveštaje (best-effort)
  note            String?
  preventiveMeasures String?
  extra           String?  // „Dodatno" (dorada tabela)
  raisedByWorkerId Int?    // Kontrolor / „Neusaglašenost ističe"
  createdByUserId  Int?
  createdAt/updatedAt
}

/// Izvršioci-radnici (M:N) — OVO puni Moj profil „Neusaglašenosti".
model NonconformityWorker { reportId; workerId; @@unique([reportId, workerId]) }
```

Pravila:
- `reportNumber` dodeljuje server pri **potvrdi** (draft nema broj → nema rupa u sekvenci ako se
  draft obriše kao lažan). Sekvenca `MAX(number) + 1` po (type, year), advisory lock.
- Jednokratni **uvoz iz oba Excel-a** (27 + 12 zapisa, originalni brojevi/datumi, status=potvrđen;
  izvršioci se mapiraju na workers po imenu gde je moguće, ostalo u culpritText) → numeracija
  prirodno nastavlja (028/26, 013/26). Uvoz = skripta u `tools/` (idempotentna po reportNumber).

## 5. Automatski tok iz kioska (ključna ideja korisnika)

Kad kontrolor na kiosku otkuca kontrolu sa kvalitetom **dorada/škart**, `control()` POSLE
transakcije (best-effort, kao D8) kreira **DRAFT NonconformityReport**:
- prefill: type (iz qualityTypeId), reportDate = danas, workOrderId/identNumber/drawingNumber/
  partName/customerName (iz RN-a), quantity = otkucana količina, workUnit = RC operacije,
  izvršioci = radnik(ci) sa poslednjih kucanja te operacije (predlog — kontrolor potvrđuje!),
  raisedBy = kontrolor, sourceTechProcessId, defectDescription = napomena kontrolora (Faza 1).
- Kontrolor u kartici „Kontrola kvaliteta" dopuni (uzrok, troškovi, sati, preventivne mere,
  koriguje izvršioce) i **Potvrdi** → dobija reportNumber.
- Draft se može odbaciti (lažna uzbuna) — bez broja, bez rupe u sekvenci.
- Ručni „Novi izveštaj" ostaje ravnopravan (slučajevi bez kioska: DXF/biro, kooperant...).
- (Opciono, odluka: da li i dorada iz child-RN kreiranja generiše draft, ili samo kontrola.)

## 6. Izveštaji + Moj profil

**Tab Izveštaji** (`GET /kvalitet/reports/summary?from&to&groupBy=day|week|month|year|worker|workUnit|cause|customer&type=`):
- kom + broj izveštaja + Σ sati po periodu; škart vs dorada uporedo; top uzroci; top RJ;
  po kupcu (reklamaciona perspektiva). Trend linija po mesecima (dataviz obrasci).
- Izvor NIJE tech_processes agregat nego **NonconformityReport** (jer nosi uzrok/sate/izvršioce);
  tech_processes ostaje operativna evidencija komada.

**Moj profil → sekcija „Neusaglašenosti"** (`/profil`):
- radnik vidi SVOJE: lista izveštaja gde je među izvršiocima (datum, RN, opis, kom, tip) +
  zbir po mesecu/godini. Read-only, bez tuđih podataka (scope po worker_id iz JWT veze).
- Gate: postojeći PROFILE_SELF; podaci se filtriraju server-side.

## 7. Permisije

Nove: `kvalitet.read`, `kvalitet.write` (unos/izmena/potvrda izveštaja).
- KONTROLOR: read + write (primarni korisnik). SEF/MENADZMENT/ADMIN: read + write.
- TEHNOLOG: read (uvid — dobijaju D8 notifikacije ionako). PROIZVODNI_RADNIK: bez pristupa
  kartici; svoje vidi kroz Moj profil.

## 8. Tablet / elektronske beleške (vizija — planirana faza, ne implementira se odmah)

Cilj: kontrola sa tableta/telefona unosi beleške uz nalog, umesto skeniranja odštampanih naloga.
Stepenice (svaka samostalno korisna):
1. **F3a — beleške sa tableta:** kartica Kontrola kvaliteta i kiosk su web → već rade na tabletu.
   Napomena (Faza 1) + evidencija (ova kartica) pokrivaju tekstualne beleške odmah.
2. **F3b — foto prilog:** dugme „Slikaj" na tabletu (input capture=camera) → upload → veže se za
   izveštaj/tech_process (proširenje tech_process_documents ili nova attachments tabela za
   NonconformityReport). Zamena za veći deo skeniranja.
3. **F3c — anotacija naloga (stylus):** otvaranje RN/crtež PDF-a na tabletu + crtanje preko
   (canvas overlay) → snima se kao slika/PDF sloj uz nalog, vidljivo svima. Ovo je „notepad sa
   olovkom" ideja — zahteva viewer/canvas komponentu; planirati kao zaseban paket kad se kupe
   uređaji. NIJE preduslov ničemu gore.

## 9. Odnos sa prethodnim planom (kiosk kontrola — 4 stavke, odluke 15.07)

Faza 1 (napomena svuda, škart POTVRDA „Da li ste sigurni?", overshoot uz upozorenje) i Faza 2
(dokumentacija sa share-a `\\srv\SHARES\Kontrola Kvaliteta\Dokumentacija`) iz prethodnog plana
ULAZE u ovaj modul: napomena postaje defectDescription prefill drafta; škart-potvrda je kapija
pre auto-drafta; dokumentacija tab živi u ovoj kartici. Ništa od toga se ne duplira.

## 10. Faze isporuke (predlog)

| Paket | Sadržaj | Obim | Zavisnosti |
|---|---|---|---|
| **K0 — kiosk dorade** | napomena (control+scan/stop), škart potvrda, overshoot uz potvrdu (`confirmOvershoot`) | S–M | ništa (worktree spreman) |
| **K1 — evidencije** | migracija 2 tabele + servis/API (CRUD, sekvenca, draft/potvrda) + FE kartica sa tabovima Škart/Dorada + uvoz Excel-a | M–L | odluke §11 |
| **K2 — auto-draft iz kioska** | control() → draft report (best-effort) + bedž „na čekanju" | S | K1 |
| **K3 — izveštaji + Moj profil** | summary endpoint + tab Izveštaji (trend, top liste) + sekcija u /profil | M | K1 |
| **K4 — dokumentacija** | mount QC share na ubuntu + list/attach/open endpoints + tab Dokumentacija (= Faza 2 starog plana) | M | share IP + nalog |
| **F3 — tablet** | F3a odmah pokriveno; F3b foto prilog; F3c stylus anotacija | S / M / L | K1; uređaji |

Predlog redosleda: **K0 odmah** (nezavisno), zatim **K1 → K2 → K3**, K4 čim stigne share pristup,
F3b/F3c po nabavci uređaja.

## 11. Otvorena pitanja (potvrda pre gradnje)

1. **Numeracija:** potvrditi format `NNN/YY` po tipu i godini, i da app nastavlja (028/26, 013/26).
2. **Draft bez broja do potvrde** — OK? (alternativa: broj odmah i „poništen" status za lažne).
3. **Auto-draft** samo iz završne kontrole, ili i međufazne (8.4) kad se otkuca škart/dorada?
4. **Uzrok šifarnik** odmah ili slobodan tekst pa normalizacija kasnije (predlog: kasnije)?
5. **Troškovi** ostaju tekst (Excel paritet) — potvrditi da NE računamo dinarske iznose u P0.
6. **Moj profil naziv sekcije:** „Neusaglašenosti" ili „Škart/dorada"?
7. QC share (za K4): IP „srv" servera + read nalog.
8. Ko sme da POTVRDI izveštaj — samo kontrolor koji ga je istakao, bilo koji kontrolor, ili i šef?
