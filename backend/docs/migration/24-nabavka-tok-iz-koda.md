# NABAVKA (procurement) — tok iz koda (status-mašina)

> **Status:** ANALIZA (2026-07-18, iz izvučenog VBA + action upita). Code-level dopuna
> [13-bigbit-nabavka.md](13-bigbit-nabavka.md) (koji je iz korisničkih uputstava). Ovde = STVARNA
> logika: prečica, numeracija, auto-mail RFQ, status-tok, 3-way match. Nabavka živi u **dve app**:
> QBigTehn (inženjeri kreiraju zahtev/specifikaciju) + OnLine BigBit (služba nabavke sprovodi).

## A) Ulaz + prečica

**Prečica CTRL+J/K — nije potvrđena iz makroa.** Jedini tekstualno izvučen AutoKeys je komercijalni
(`Izvoz\Makroi\AutoKeys.txt`): `^K→OK_Start` (Obračun Kamata, NE nabavka), `^M→OP_Start`, `^E→BBMail`,
**nema `^J`**. **QBigTehn AutoKeys** (koji inženjeri koriste) **postoji u bazi ali nije tekstualno
izvezen** (`QBigTehn_APL\macros.txt` = samo imena). Obrazac vezivanja je `RunCode→BBOpenForm("<forma>")`.
Skrivenost ("nije na glavnoj formi") se poklapa — forme se otvaraju samo prečicom / iz MRP putanje.
→ **otvorena tačka:** izvući QBigTehn AutoKeys iz `.accdb` (isti DAO put) da se potvrdi `^J/^K→forma`.

**Forme inženjera (QBigTehn):** `Form_UnosZahtevaZaNabavku`, `Form_ZahteviZaNabavku` (pregled/filter),
`Form_SpecifikacijaZahtevaZaNabavku` (stavke).

**Numeracija zahteva** (`Form_UnosZahtevaZaNabavku.cls:131-172`, `OdrediSledeciBrojZahteva`):
`Format(max+1,"0000") & "/" & godina` → `0007/2026` (max per godina iz `EXT_ZahteviZaNabavku`).

**Obavezno / veze** (DDL `ZahteviZaNabavku` schema:2286): `InicijatorZahteva` (Prodavci), `BrojZahteva`,
`DatumZahteva`, **`IDPredmetDok` NOT NULL**, **`IDRadniNalog` NOT NULL**, `IDStatus`, `RokZaZavrsetak`.
→ **nabavka je uvek vezana za predmet i radni nalog** (hard FK).

**MRP putanja** (`PlaniranjeNabavke.bas:474-508`): iz BOM/MRP plana `INSERT INTO
EXT_SpecifikacijaZahtevaNabavke SELECT ... FROM PDM_PlaniranjeStavke WHERE ZaNabavku>0` sa
`KreirajUpit=True`. Dakle inženjer puni specifikaciju ručno ILI iz MRP-a.

## B) Status-tok end-to-end

```
[Inženjer/QBigTehn]                        [Nabavka/OnLine BigBit]
 Zahtev (ZahteviZaNabavku.IDStatus)
 Specifikacija (.KreirajUpit=True) ──► UPIT DOBAVLJAČU (T_UpitDobavljacu)
                                       └─(mail RFQ)─► Poslato=True
                                             ▼
                                       PONUDA (cena/rok na stavci upita)
                                       IDStatus=1, PrihvacenaPonuda=True (po stavci)
                                             ▼
                                       NARUDŽBENICA (T_Trebovanja, VrstaTreb='narucivanje')
                                       Poruceno / Potpisano / Zakljucano
                                             ▼
                                       PRIJEM (IsporucenaKolicina default=TrebKol, Isporuceno=T)
                                             ▼
                                       ULAZNA FAKTURA (Robne stavke, Kolicina=IsporucenaKolicina)
                                       + T_Trebovanja_ERNabavka.PurchaseInvoiceID (SEF)
```

| Korak | Tabela | Status/flag | Okidač |
|---|---|---|---|
| Zahtev/spec | `ZahteviZaNabavku`/`SpecifikacijaZahtevaNabavke` | `IDStatus`, `KreirajUpit` | `Form_UnosZahtevaZaNabavku` |
| Kreiraj upit | `T_UpitDobavljacu`(+Stavke) | `IDTrebVeza=IDZahteva` | `DugmeKreirajUpit` |
| Poslat RFQ | `T_UpitDobavljacu` | **`Poslato=True`** | `BBMail_UpitZaDobavljaca:124` |
| Ponuda prihv. | `T_UpitDobavljacu Stavke` | `PrihvacenaPonuda=True` | `UpitDobavljacu:104-127` |
| Narudžbenica | `T_Trebovanja`(+stavke) | `Poruceno/Potpisano/Zakljucano`, `IDUpita` | `Trebovanje` |
| Prijem | `T_Trebovanja stavke` | **`IsporucenaKolicina`**, `Isporuceno` | `UpisiTrebKolUIsporucenu` |
| Faktura | `Robne stavke` | `IDStavkeTrebovanja`, `PurchaseInvoiceID` | `ProknjiziStavkeIzPorudzbineUUlazni` |

Ključna veza zahtev↔upit: `T_UpitDobavljacu.IDTrebVeza = ZahteviZaNabavku.IDZahtevaZaNabavku`
(`Form_ZahteviZaNabavku.cls:61`). Statusi = podatak u `T_Statusi` (`Tabela`+`OpisStatusa`, per-tabela;
konkretne vrednosti nisu u dumpu — izvući).

**Transformacioni upiti:** `DodajStavkeIzSpecifikacijeZahtevaUUpitDobavljacu` (spec→upit, `KreirajUpit=True`)
· `UpisiPrihvacenaPonudaUSveStavkeUpita` · `ProknjiziStavkeIzTMPUpitaUPorudzbinu` (upit→narudžbenica,
`Dodaj=True`) · `ProknjiziStavkeIzPorudzbineUUlazni` (narudžbenica→faktura).

## C) Auto-mail RFQ (najveća vrednost toka)

**Mehanizam = OSSMTP** (third-party COM SMTP komponenta, NE Outlook/CDO) —
`WithEvents objMailer As OSSMTP.SMTPSession` (`BBMail_UpitZaDobavljaca.txt:11`). `SendAnEmail` (:316-368):
`AuthLogin`, server/nalog/lozinka/from iz **`CFG_Global`** preko `Email_Class` (`:70-83`:
`SMTPhost/SMTPport/EmailAcct/EmailAcctPwd/FromEmail`). `ReplyTo` = email trenutnog korisnika;
`EmailSluzbeNabavka` default `nabavka@servoteh.com`.

- **Dobavljačev email:** iz `Komitenti` (join na `T_UpitDobavljacu.Sifra komitenta`).
- **Prilog:** PDF `OutputTo acOutputReport, "UpitZaDobavljaca"→acFormatPDF` (INO: `INOUpitZaDobavljaca`),
  ime `Upit_broj_<N>.PDF` u `BB_EXPORT` folder; briše se posle slanja (`Form_Close Kill`).
- **Subject/telo:** `CFG_Global/Nabavka_Subject` + `Nabavka_BodyMail` (fallback „Poštovani, u prilogu je
  dokument … pošaljite ponudu"). INO varijanta „Request for quotation".
- **Log:** po uspehu `DAO_UpdateColumn("T_UpitDobavljacu","Poslato",True,...)`. **Nema trajnog mail-log-a**
  — samo bool `Poslato` + status na ekranu. → za 4.0: dodati pravi outbox/log.

`BBMail_ZaNabavku` = paralelni tok inženjer→interna nabavka (subject „Zahtev za nabavku broj X",
prilog `SpecifikacijaZaNabavku.PDF`).

## D) 3-way match (narudžbenica ↔ prijem ↔ faktura)

Vezivni ključ = **`T_Trebovanja stavke.IDStavke`** + traceback `IDStavkeUpita`, `IDZahtevaZaNabavku`.
1. **Naručeno:** `TrebKol`, `Cena`.
2. **Primljeno:** `IsporucenaKolicina` — `UpisiTrebKolUIsporucenu` puni default = `TrebKol`, pa ručna korekcija.
3. **Fakturisano:** `ProknjiziStavkeIzPorudzbineUUlazni` knjiži samo `IsporucenaKolicina<>0`,
   `Kolicina=IsporucenaKolicina`. **Anti-duplo:** `StavkeTrebovanjaZaNaknjizavanje` —
   `LEFT JOIN T_Robne stavke ON IDStavke=IDStavkeTrebovanja WHERE IDStavkeTrebovanja Is Null`.

→ sve tri veličine (naručeno/primljeno/fakturisano) stoje na istoj stavci → razlike vidljive.
`T_Trebovanja_ERNabavka.PurchaseInvoiceID` vezuje za e-fakturu (SEF, doc 07).

## E) DDL ključnih tabela (schema.sql)

`ZahteviZaNabavku` (:2286) · `SpecifikacijaZahtevaNabavke` (:1227, `KreirajUpit`, `IDPlanStavka`→MRP) ·
`T_UpitDobavljacu` (:2064, `IDTrebVeza`, `Poslato`, `PrihvacenaPonudaDok`) · `T_UpitDobavljacu Stavke`
(:3051, cena/ponuda na stavci) · `T_Trebovanja` (:1982, `Poruceno/Potpisano/Zakljucano`, `IDUpita`,
`VrstaTreb`) · `T_Trebovanja stavke` (:2013, `TrebKol`, `IsporucenaKolicina`, `IDStavkeUpita`,
`IDZahtevaZaNabavku`) · `T_Trebovanja_ERNabavka` (:3044) · `T_Statusi` (:1970, generički šifarnik) ·
`OP_Dokumenta` (:638, prodajne porudžbine — odvojena grana). Predmet/RN → nabavka: `IDPredmetDok`+
`IDRadniNalog` NOT NULL, propagiraju kao `IDPredmet` kroz spec/upit/narudžbenicu.

## F) 2.0 stanje + procena

**2.0 ima:** samo MRP read-only (`mrp.service.ts:12-20` — „`purchase_requests` NISU u šemi, NE
implementiraju se"); modeli `MrpDemand/Item/Stock` (schema:389-462) nose `supplierId/toProcureQuantity/
leadTimeDays`. **Nema** nijedan procurement dokument, nema Supplier tabele (dobavljač = `Customer`),
nema `nabavka.*` permisija.

**Fali:** sve — zahtev, upit, auto-mail, ponude, narudžbenica, prijem, 3-way match, status-mašina.

| Celina | AI-dani | 1-dev dani | MVP |
|---|---|---|---|
| Šema + migracije (7 tabela + statusi) | 2–3 | 6–8 | ✅ |
| Backend: CRUD + status-mašina + 3-way match | 4–5 | 12–15 | ✅ |
| Auto-mail RFQ: SMTP + PDF upit + prilog + outbox/log | 2–3 | 5–8 | ✅ |
| Frontend: unos trebovanja, radna lista, ponude, narudžbenica, prijem, faktura-match | 5–7 | 15–20 | ✅ |
| Integracije: MRP demand→zahtev, Komitenti→dobavljač, PDM→artikal | 1–2 | 4–6 | delom |
| INO + SEF/e-faktura + profaktura/avans | 2–3 | 6–9 | ❌ faza 2 |
| **Ukupno** | **~16–23 AI-dana** | **~48–66 dev-dana** | |

**MVP „sprint modul" (zatvara petlju):** zahtev/spec (numeracija, predmet+RN) → radna lista nabavke →
kreiranje upita + **auto-mail RFQ** → unos ponuda + prihvatanje → narudžbenica → prijem → 3-way flag ka
fakturi. **Van MVP:** INO, SEF veza, profaktura/avans, auto-izbor najniže cene po stavci.

## Otvorene tačke
1. QBigTehn AutoKeys makro (`^J/^K→forma`) — izvući iz `.accdb` (isti DAO put).
2. `T_Statusi.OpisStatusa` vrednosti po tabelama — dump.
