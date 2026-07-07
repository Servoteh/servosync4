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
| [10-bigbit-glavni-meni.md](10-bigbit-glavni-meni.md) | **BigBit glavna maska (navigacija)** — transkript žive aplikacije (RDP): sve sekcije menija i dugmad komercijalnog ERP-a, mapirano na 4.0 domene (09 = analiza koda dopunjuje) |

## Otvorena pitanja za Negovana/Nesu (blokiraju odluke)
- Odluka o šemi: 1:1 vs **hibrid (legacy-cache + overlay)** vs kanonski (preporuka: hibrid).
- Sync: BigBit-wins upsert vs legacy insert-only; delete-propagacija; ostaje li single-tenant.
- 8 AMBIGUOUS granica iz scope-a (ulazna faktura/uvoz, robni sloj, recepture, klasifikacija artikala, shop-floor hardver, lokalizacija, dev-leftover, client-specific).
- SP/UDF tela SU sada izvučena iz `script.sql` → vidi [05](05-qbigtehn-sqlserver-logic.md). Otvoreno ostaje **~40 „POTVRDITI sa Negovanom"** tačaka (duple definicije „završeno"/„napravljeno"/„utrošeno vreme", split rezervisano/nabavka A vs B, ciklusi u BOM-u, write-path prijave rada koji NIJE u dumpu).

## Napomena o bezbednosti
Ovi dokumenti su čista analiza — bez kredencijala/PII. SQL Server lozinka je namerno **maskirana** (živi samo u `backend/.env`, van gita).
