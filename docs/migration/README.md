# Servosync — migraciona analiza (QBigTehn → Servosync 2.0)

Read-only analize nastale multi-agent obradom legacy QBigTehn izvora, kanonskih dizajn dokumenata i trenutnog repo-a (2026-07-03). **Ništa u kodu nije menjano — čista analiza za odlučivanje.**

> **Širi kontekst:** ove analize se tiču **ServoSync 2.0** (proizvodni core iz QBigTehn). Za celu sliku verzija (1.0 → 4.0) vidi [../ROADMAP.md](../ROADMAP.md).
> Mapiranje terminologije: „Faza 1" = **1.0** (plan-montaže/Supabase), „Faza 2" = **2.0** (ovaj repo). 3.0 = objedinjavanje, 4.0 = BigBit ERP.

| Dokument | Sadržaj |
|---|---|
| [00-comparison-qbigtehn-vs-planmontaze.md](00-comparison-qbigtehn-vs-planmontaze.md) | Head-to-head: šta je komplikovanije / veći posao (QBigTehn vs plan-montaže) |
| [01-qbigtehn-architecture-analysis.md](01-qbigtehn-architecture-analysis.md) | Ciljna arhitektura vs stvarni repo, sync pravila, bug-ovi, backlog, preporuka o šemi (hibrid) |
| [02-qbigtehn-scope-triage.md](02-qbigtehn-scope-triage.md) | Klasifikacija 873 legacy fajla: used (~44% jezgro) vs bloat (26%) vs ambiguous |
| [03-planmontaze-complexity-profile.md](03-planmontaze-complexity-profile.md) | Profil kompleksnosti ServoSync 1.0 (obim, RLS, ocena težine 5/5) |
| [05-qbigtehn-sqlserver-logic.md](05-qbigtehn-sqlserver-logic.md) | **Poslovna logika iz MS SQL-a** (BOM/MRP/RN/TP algoritmi, 51 SP + 63 fn) + mapiranje na `WITH RECURSIVE` |
| [06-bigbit-preuzmi-iz-bb.md](06-bigbit-preuzmi-iz-bb.md) | **„Preuzmi iz BB" legacy mehanizam** — mapiranje kolona po tabeli (5 tabela, INSERT-only), transformacije, mirror, veza sa BigBit-om + PDM XML; referenca za `bigbit-sync` |
| [07-bigbit-sef-efaktura.md](07-bigbit-sef-efaktura.md) | **SEF eFaktura reverse engineering** — gde integracija živi (OnLine BigBit), 12+ API endpointa, rekonstruisani tokovi izlaznih/ulaznih faktura, podloga za 4.0 SEF modul |
| [08-qbigtehn-vba-domain-map.md](08-qbigtehn-vba-domain-map.md) | **Mapa QBigTehn VBA → 2.0 domeni** (455 fajlova, multi-agent): koji legacy modul pokriva koji 2.0 domen (TP/RN/PDM/MRP/lokacije/komitenti), poslovna pravila za prenos, šta je van scope-a |
| [09-bigbit-online-domain-map.md](09-bigbit-online-domain-map.md) | **Mapa BigBit OnLine VBA → 4.0 domeni** (824 fajla, multi-agent): fakturisanje/GK/PDV/banke/magacin/matični → 4.0 domeni (finance/sales/inventory/tax/banking/sef), regulatorna pravila, šta se prenosi/prepisuje/baca |
| [10-bigbit-glavni-meni.md](10-bigbit-glavni-meni.md) | **BigBit glavna maska (navigacija)** — transkript žive aplikacije (RDP): sve sekcije menija i dugmad komercijalnog ERP-a, mapirano na 4.0 domene (09 = analiza koda dopunjuje) |
| [11-bb-tehnologija-uputstvo.md](11-bb-tehnologija-uputstvo.md) | **Zvanično uputstvo — vlasnikove napomene** (iz `BB Tehnologija opis.pdf`): ko koristi koji modul, najkorišćeniji ekrani (🎯 prioritet 2.0), šta IZBACITI (❌), poznata ograničenja (⚠️), poslovna pravila |
| [12-bigbit-uputstvo-master.md](12-bigbit-uputstvo-master.md) | **Korisnički ugao za 4.0** — analiza „Uputstvo za korišćenje BigBit-a (sve zajedno).docx" (knjigovodstvo, 20 poglavlja, 40 screenshotova): ceo mesečni ciklus (prodaja/usluge/GP/nabavka/uvoz/PDV), vrste dokumenata i finansijskih naloga, kontni plan (klase 1/2/4/5/6/9), 6 workflow-lanaca, ne-sistemske zavisnosti (crvena sveska, ručni SEF) |
| [13-bigbit-nabavka.md](13-bigbit-nabavka.md) | **Nabavka (`procurement`) — proces** iz „Upustvo za Nabavku.docx" (16 screenshotova): RFQ → ponuda → porudžbenica → avans → prijem (3-way match) → knjiženje → praćenje; statusi, pragovi odobravanja (>1.000 EUR), šifra proizvođač/dobavljač, 10 entiteta + 13 pravila za 4.0 |
| [14-bigbit-carina.md](14-bigbit-carina.md) | **Carina/uvoz (`customs`) — proces** iz „Carina.docx" (9 screenshotova): 5 postupaka (redovan/privremeni uvoz, aktivno oplemenjivanje „UV 5", izvoz); **JCI radi špedicija, ne BigBit**; landed cost (ZT→nabavna cena, PDV izuzet); dokaz porekla (prag 6.000 EUR); otvoren ključ raspodele ZT |
| [15-bom-mrp-odluka-bez-negovana.md](15-bom-mrp-odluka-bez-negovana.md) | **BOM/MRP — odluka BEZ Negovana** (5-agent, ukršta SQL tela sa VBA pozivima): razrešava 13 od ~40 „POTVRDITI" tačaka iz kôda. Ključno: grana A/B nije nekonzistentna (klijent pre-netuje zalihe), „bug otvorene transakcije" ne postoji, barkod format je DVA barkoda (ispravka speca), `RobneStavkeMirror` mrtav, lager stiže iz BigBit robnog (Level 0/250), mapiranje artikla po `KataloskiBroj`, broj-plana parsing bug realan, ciklus-guard fali na 3 mesta. **Ostaje 5 tačaka za Negovana** (magacin tip, ciklus-politika, 23h semantika, predmet 4521, BB nivo-konvencije) |

## Otvorena pitanja za Negovana/Nesu (blokiraju odluke)
- Odluka o šemi: 1:1 vs **hibrid (legacy-cache + overlay)** vs kanonski (preporuka: hibrid).
- Sync: BigBit-wins upsert vs legacy insert-only; delete-propagacija; ostaje li single-tenant.
- 8 AMBIGUOUS granica iz scope-a (ulazna faktura/uvoz, robni sloj, recepture, klasifikacija artikala, shop-floor hardver, lokalizacija, dev-leftover, client-specific).
- SP/UDF tela izvučena iz `script.sql` → [05](05-qbigtehn-sqlserver-logic.md). **BOM/MRP grana:** ~40 „POTVRDITI"
  tačaka je **razrešeno ukrštanjem sa VBA** — vidi [15](15-bom-mrp-odluka-bez-negovana.md). Split A/B, write-path
  prijave rada, „završeno" definicija, ciklusi, mapiranje artikla, izvor lagera — **odlučeno iz koda**. Ostaje
  **samo 5** za Negovana (magacin ID→tip, ciklus=tvrda greška?, 23h semantika, predmet 4521, BB nivo-konvencije).
- **Ostale grane (TP vreme/utrošeno, primopredaja status-matrica, lokacije):** i dalje imaju „POTVRDITI" tačke iz
  [05 §4/§5/§6](05-qbigtehn-sqlserver-logic.md) — nisu obuhvaćene [15] (fokus BOM/MRP); rešiti istim pristupom po potrebi.

## Napomena o bezbednosti
Ovi dokumenti su čista analiza — bez kredencijala/PII. SQL Server lozinka je namerno **maskirana** (živi samo u `backend/.env`, van gita).
