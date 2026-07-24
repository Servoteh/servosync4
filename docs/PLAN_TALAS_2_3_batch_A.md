# PLAN — Talas 2 + Talas 3, Batch A (paralelno)

> **Autor:** Fable (plan, 24.07.2026 veče). **Izvršilac:** Opus multiagentima (8 agenata, protokol
> kao 1C–E2: implement fan-out → integracija → smoke → adversarial review → PR → deploy → verify).
> **Izvor:** [MASTER_PLAN_GRADNJE_4.0_ERP_JEZGRO.md](MASTER_PLAN_GRADNJE_4.0_ERP_JEZGRO.md) §3
> Talas 2 (SREDNJI/NIZAK paritet) + Talas 3 (Pantheon/SAP). Talas 1 je KOMPLETAN (PR #9–#13).

## Princip izbora za Batch A

S/M effort · bez otvorenih odluka · maksimalna dnevna vrednost za knjigovođu/komercijalu ·
minimalne izmene šeme (samo `sef_status_log`). Ostatak T2/T3 ide u Batch B/C (posebne sesije;
popisan u §3).

## 1. Batch A — 16 stavki kroz 8 agenata

| Agent | Talas | Stavke |
|---|---|---|
| A1 Saldakonti-kartica | T2 | **CustomerPicker** reusable komponenta (pretraga po nazivu/PIB — koristi postojeći customers lookup) · **Kartica komitenta**: BE ruta (ledger stavke partnera hronološki + running saldo + filter konto/period) + FE stranica + **PDF štampa** |
| A2 GK-izvodi-sitnice | T2 | **Štampa naloga za knjiženje** (PDF, temeljnica sa stavkama) · **Auto-lock starih naloga** (ruta „zaključaj sve posted starije od datuma") · **Reset/brisanje uvezenog izvoda** (samo ne-POSTED) · **Skok na karticu komitenta** iz izvoda (link na A1 rutu) |
| A3 Robno-kartica-lock | T2 | **Kartica artikla** (running saldo po magacinu: dokument, ulaz, izlaz, stanje) BE+FE · **Zaključavanje robnih dokumenata** (isLocked postoji — rute lock/unlock-zabranjen + guard u mutacijama/calculate) |
| A4 Plaćanja | T2 | **Ručni pojedinačni virman** (UnosVirmana — forma bez izvora iz saldakonta) · **Štampa virmana** (PDF obrazac naloga za prenos) · **SifraPlacanja + naziv primaoca** u FX export slogu (ako kolone postoje — proveriti) |
| A5 Fakturisanje-SEF | T2 | **SEF storno tok** (storno dugme → reverse GL + SEF cancel + razlog obavezan) · **UBL PDV granularnost** (TaxSubtotal po stvarnim stopama stavki 20/10/0, ne hardkod 20) |
| A6 Mail+XLS infra | T3 | **„Pošalji na mail"** dugmad (faktura PDF, IOS obrazac, PP-PDV — MailService attachments već postoji, BigBit paritet + Resend) · **CSV/XLS export** platformsko dugme na DataTable (klijentski CSV; primeni na lager, otvorene stavke, KIF/KUF) |
| A7 Naplata | T3 | **Dashboard naplate** (/naplata: DSO, aging heatmap po komitentu, top dužnici — agregati nad open-items) · **MaxSaldo auto-zatvaranje** sitnih salda (ruta: zatvori sve otvorene grupe sa \|saldo\| ≤ prag, uz reconcile mehanizam) |
| A8 Kredit+SEF-log | T3 | **Kreditni limit guard** (Customer.creditLimit je sync polje: postInvoice/createProforma → 422 kad saldo+iznos > limit > 0, uz `force` override + upozorenje na FE) · **SEF status istorija** (nova tabela sef_status_log; upis u enqueue/send/refresh/cancel/accept/reject tokovima; FE timeline na /sef detalju reda) |

**Šema (glavna petlja, pre fan-out-a):** samo `sef_status_log` (id, outboxId?/incomingId?, status,
note, createdAt, userId) — aditivna migracija.

**Deljeni fajlovi (glavna petlja posle):** module registracije, navigation (kartica komitenta?
unutar saldakonti — bez nove nav stavke; /naplata nova stavka), permissions (postojeće).

## 2. Definicije gotovog (smoke kriterijumi)

- Kartica komitenta: partner 555 → hronološki redovi + running saldo se slaže sa open-items; PDF > 1kB
- Kartica artikla: artikal 90001 → ulazi/izlazi/stanje konzistentno sa stateAsOf
- Auto-lock: nalozi posted stariji od datuma → locked; mlađi netaknuti
- Reset izvoda: ne-POSTED se briše sa stavkama; POSTED → 409
- Virman štampa PDF > 1kB; ručni virman ulazi u pregled naloga
- UBL: faktura sa stavkama 20% i 10% → dva TaxSubtotal-a
- CSV export: sadržaj odgovara koloni/redovima tabele
- Dashboard: DSO/aging brojevi se slažu sa open-items agregatima
- MaxSaldo: grupa sa saldom 0.5 uz prag 1 → zatvorena; 100 → ne
- Kreditni limit: limit 1000, saldo 900, faktura 200 → 422; force → prolazi
- SEF log: enqueue+send upisuju redove; timeline ih lista hronološki

## 3. Ostatak za Batch B/C (NE raditi sada)

**T2-B:** carry-over PO→Primka i Profaktura→Izdatnica (L) · devizne otvorene stavke (L) · salda
po poslovima costCenter (M) · GK carry-over + početno stanje (M) · reconciliation batch (M) ·
kontrola prometa banke (M) · Halcom grana + INO SWIFT (M) · avansne uplate (L) · odloženo plaćanje
(M) · PDV bruto↔neto most (M) · APGK PDVProvera (L) · POPDV legacy formule (L) · KUF van-PDV (S) ·
rezervacija zaliha (L) · kurs FX fakture (M) · KarticaProfaktura (M) · ZR katalog UI + SI aneks +
štampe BS/BU (M/L) · AVR avansni računi (XL — traži odluku).
**T3-B:** soft-delete+undo+audit obrazac (M) · terminologija Pantheon/SAP labeling (S) · 3-way
match (L) · dunning/opomene (M) · Payment Run F110 (M-L) · EBS fuzzy match (L) · dimenzije
knjiženja (L) · info-record cenovnik dobavljača (L) · MR21 prevrednovanje (M) · delivery monitor
(M) · validator formula ZR (M) · višegodišnja komparativa (M) · NBS auto-import kurseva (M).

## 4. Protokol (nepromenjen — kao 1C–E2)

Implement fan-out (granice fajlova stroge, registracije/nav → glavna petlja) → matrica (tsc/build/
unit/e2e/FE) → smoke na dev po §2 → adversarial review (default-refuted ×2) → fix → PR → CI →
merge → deploy → post-deploy-verify 🟢 → memorija.
