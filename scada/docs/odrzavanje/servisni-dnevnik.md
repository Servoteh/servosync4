# Servisni dnevnik

Hronološki zapis svih radova na sistemima: kvarovi, preventivno održavanje, izmene PLC
programa i izmene podešavanja (setpointi, raspored). Dnevnik je **jedan izvor istine** o
tome ko je šta i kada radio — koristi se za dijagnostiku („šta se promenilo pre nego što je
počeo problem") i za predaju posla između servisera.

Vodi se u dve forme — obe sadrže iste kolone:
- **ovaj fajl (Markdown)** — za brzo čitanje u repozitorijumu/pregledaču,
- [`servisni-dnevnik.csv`](servisni-dnevnik.csv) — za vođenje u Excel-u (separator `;`).

> Drži obe forme usklađene, ili izaberi jednu kao primarnu. Ako vodiš u Excel-u (CSV),
> povremeno izvezi/iskopiraj ovde radi pregleda.

---

## ⚠️ Obavezno pravilo (backup pre izmene)

**SVAKA izmena PLC programa ili veća izmena podešavanja MORA imati:**
1. **Backup PRE izmene** (Unitronics `.U90` upload / Siemens upload from device + arhiva),
2. **red u ovom dnevniku** sa imenom backup fajla u koloni „Backup",
3. proveru rada posle izmene (temperature se čitaju, izlazi reaguju, alarmi čisti).

Bez backup-a se ne dira PLC program. Vidi procedure:
[Unitronics](../kotlarnica-unitronics/odrzavanje-plc.md) ·
[Siemens](../kotlarnica-siemens-hala5/odrzavanje-plc.md).

---

## Kako se popunjava

| Kolona | Šta upisati |
|---|---|
| **Datum** | `DD.MM.GGGG` (po potrebi i vreme) |
| **Sistem** | `Unitronics` / `Siemens` / `SCADA` (ako se tiče više — navedi sve) |
| **Ko** | ime i prezime osobe koja je radila |
| **Vrsta** | `kvar` / `preventiva` / `izmena programa` / `izmena setpointa` |
| **Opis radova** | šta je konkretno urađeno (kratko, ali jasno) |
| **Backup (Da/Ne + fajl)** | `Da — program_30_06_2026.U90` ili `Ne` (za radove gde backup nije relevantan, npr. čisto čitanje stanja) |
| **Rezultat / Napomena** | ishod, da li je problem rešen, šta dalje pratiti |

**Pravila:**
- Za `izmena programa` i `izmena setpointa` kolona **Backup mora biti `Da`** sa nazivom fajla.
- Novi unosi idu **na vrh tabele** (najnovije prvo) ili na dno — izaberi jedan dosledan smer.
- Naziv backup fajla nek nosi datum (`program_<DD_MM_GGGG>.U90`, TIA arhiva sa datumom).

---

## Dnevnik

| Datum | Sistem | Ko | Vrsta | Opis radova | Backup (Da/Ne + fajl) | Rezultat / Napomena |
|---|---|---|---|---|---|---|
| _PRIMER_ 29.06.2026 | Unitronics | `[ime]` | izmena programa | Dodat senzor temperature za zonu 3, nova MI adresa; ažuriran `app/tags.js` | Da — `program_29_06_2026.U90` | OK, zona 3 se čita u SCADA; restartovan servis |
| _PRIMER_ 28.06.2026 | SCADA | `[ime]` | preventiva | Sezonski smoke test veze (`npm run test:connection`), pregled Event Viewer logova | Ne | Bez grešaka; tunel i Access rade |
| _PRIMER_ 15.05.2026 | Siemens | `[ime]` | kvar | Hala 5 ne greje zonu 2; pronađena olabavljena stezaljka na kontaktoru, pritegnuta | Da — TIA arhiva `Hala5_15_05_2026.zip` | Rešeno; zona 2 ponovo greje, bez dijagnostike u CPU |
| | | | | | | |
| | | | | | | |
| | | | | | | |

> Redovi označeni **_PRIMER_** služe samo kao prikaz formata — obriši ih kad počneš stvarno vođenje.
