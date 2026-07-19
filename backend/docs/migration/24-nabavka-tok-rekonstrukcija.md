# Nabavka (procurement) — rekonstrukcija toka iz koda

> **Status:** ANALIZA (2026-07-18). Code-level dopuna [13-bigbit-nabavka.md](13-bigbit-nabavka.md)
> (koji je iz korisničkih uputstava) — ovde je STVARNA logika: status-mašina, auto-mail RFQ,
> 3-way match, action upiti. Poslovni kontekst (Nenad): inženjeri prečicom (CTRL+J/K, skriveno —
> nije na glavnoj formi) kreiraju trebovanja; nabavka šalje upite mailom, prikuplja ponude, kreira
> narudžbenicu, proverava prijem i potvrđuje fakturu — sve kao praćeni tok.

## 0. Arhitektura: dva APL-a, isti backend

- **QBigTehn (tehnologija)** — inženjeri: zahtev za nabavku + specifikacija (`EXT_*` linkovane tabele).
- **OnLine_BigBit (komercijala)** — služba nabavke: upit→ponuda→narudžbenica→prijem→faktura.

## A) Ulaz + prečica

- Komercijalni `AutoKeys` (tekstualno izvezen, `Izvoz\Makroi\AutoKeys.txt`): `^K`→`OK_Start`
  (obračun kamata!), `^M`→`OP_Start`, `^E`→`BBMail`; `^J` nema. **QBigTehn AutoKeys (inženjerski
  binding) postoji u bazi ali nije bio tekstualno izvezen** → vidi §G (ekstrakcija).
- Forme inženjera (QBigTehn): `Form_UnosZahtevaZaNabavku` (zaglavlje+stavke),
  `Form_ZahteviZaNabavku` (pregled/filter po statusu), `Form_SpecifikacijaZahtevaZaNabavku`.
- **Numeracija zahteva:** `Format(max+1,"0000") & "/" & godina` → `0007/2026`, per godina
  (`Form_UnosZahtevaZaNabavku.cls:131-172`).
- **Hard veze:** `ZahteviZaNabavku.IDPredmetDok` NOT NULL + `IDRadniNalog` NOT NULL — **nabavka je
  uvek vezana za predmet i RN**; `IDPredmet` se propagira kroz ceo lanac.
- **Automatska putanja iz MRP-a:** `PlaniranjeNabavke.bas:474-508` — iz BOM/MRP plana INSERT u
  `EXT_ZahteviZaNabavku` + specifikacija iz `PDM_PlaniranjeStavke WHERE ZaNabavku>0`, `KreirajUpit=True`.

## B) Status-tok end-to-end

```
[Inženjer/QBigTehn]                    [Nabavka/OnLine_BigBit]
Zahtev (NNNN/god, predmet+RN) ──► UPIT DOBAVLJAČU ──mail──► Poslato=True
  Specifikacija.KreirajUpit=T      T_UpitDobavljacu(+Stavke)    │
                                                                ▼
                                   PONUDA (cena/rok na stavci upita)
                                   IDStatus=1, PrihvacenaPonuda(Dok)=True
                                                                │
                                                                ▼
                                   NARUDŽBENICA (T_Trebovanja, VrstaTreb='narucivanje')
                                   Poruceno/Potpisano/Zakljucano; stavke nose IDStavkeUpita+IDZahteva
                                                                │ prijem
                                                                ▼
                                   PRIJEM: IsporucenaKolicina (default=TrebKol), Isporuceno=T
                                                                │ proknjiži
                                                                ▼
                                   ULAZNA FAKTURA (Robne stavke.IDStavkeTrebovanja)
                                   + T_Trebovanja_ERNabavka.PurchaseInvoiceID (SEF)
```

Ključna veza zahtev↔upit: `T_UpitDobavljacu.IDTrebVeza = IDZahtevaZaNabavku`
(`Form_ZahteviZaNabavku.cls:61`). Statusi = generički šifarnik **`T_Statusi`** (`IDStatus`,
`Tabela`, `OpisStatusa`) — per-tabela; vrednosti su podatak (vidi §G).

**Action upiti (izvučeni, `queries_full\OnLine_BigBit_APL\`):**
`DodajStavkeIzSpecifikacijeZahtevaUUpitDobavljacu` (zahtev→upit, izvor `KreirajUpit=True`),
`UpisiPrihvacenaPonudaUSveStavkeUpita`, `UpitNaruzbineZa_tmp_tabelu` →
`ProknjiziStavkeIzTMPUpitaUPorudzbinu` (upit→narudžbenica, `Dodaj=True`),
`UpisiTrebKolUIsporucenu` (prijem default), `ProknjiziStavkeIzPorudzbineUUlazni`
(narudžbenica→faktura, samo `IsporucenaKolicina<>0`).

## C) Auto-mail RFQ mehanizam

- **OSSMTP COM komponenta** (ne Outlook/CDO): `WithEvents objMailer As OSSMTP.SMTPSession`,
  AUTH LOGIN (`BBMail_UpitZaDobavljaca.txt:316-368`).
- **Config iz `CFG_Global`** preko `Email_Class` (`:70-83`): `SMTPhost/SMTPport/EmailAcct/
  EmailAcctPwd/FromEmail`; `ReplyTo` = mail trenutnog korisnika; služba nabavke default
  `nabavka@servoteh.com`.
- **Prilog:** `OutputTo acOutputReport "UpitZaDobavljaca"` (INO varijanta za strane) → PDF
  `Upit_broj_<N