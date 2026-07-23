# Backlog — nedokumentovane kritične BigBit „caćke" (priprema za 4.0)

> **Status:** ANALIZA (2026-07-18, sweep kroz 824 VBA + 2412 upita + 496+713 report layouta).
> Lista svega kritičnog što JOŠ nije imalo svoju stranicu. Već-dokumentovano (07/13/14/18/20/06/F3)
> se samo referencira. Banking = [21](21-banking-izvodi-nalozi-rekonstrukcija.md), Predmeti =
> [22](22-predmeti-domen-rekonstrukcija.md).

## 0. Dve meta-nalaze (menjaju plan)

**M1 — ✅ REŠENO (18.07).** Ekstrakcioni agenti dumpovali sve QueryDef-ove obe baze (OnLine 1895 +
APL_2010 2901) + `MSysIMEX` import specove izvoda + sadržaj rule-tabela. Sada imamo: NSK posting
engine (`NSK_SemaZaDok`/`VrednostiPoSemi`/`ProknjiziStavkeIzRobnog`), PDV uknjiženje, POPDV ~35 upita,
KEPU/GK upite, banking action upite, i **formule kontiranja kao podatak** (`Stavke seme za kontiranje`
DefDug/DefPot, `R_Vrste dokumenata` šema-mapiranje, `Kontni plan` 1389). Detalji: [18 §3.6/§3.7](18-gl-pdv-kontiranje-rekonstrukcija.md),
[21 §A](21-banking-izvodi-nalozi-rekonstrukcija.md). → **finance/inventory/tax više nisu blokirani.**

**M2 — ✅ REŠENO (18.07).** POPDV/USL/avansna logika (upiti) izvučena iz `BigBit_APL_2010.MDB`
+ sekcijski report layouti (713) + **`POPDV_DEF` (164 reda, ceo obrazac) iz `BB_POPDV_T.mdb`** koji je
Nenad doneo (bio linkovan na nedostupni `P:\`). Posting-strana (`POPDV_SemeKontaZaKnjizenje`, 84) +
definicija obrasca sada kompletne → POPDV ~95% ([18 §3.3](18-gl-pdv-kontiranje-rekonstrukcija.md)).
Kalo logika: i dalje u APL_2010, izvući kad se radi kalo (odobreno u scope).

## 1. MUST — jezgro zamene BigBit-a

| # | Caćka | Gde živi | Šta radi | Doc |
|---|---|---|---|---|
| 1.1 | **Kompenzacija** (multilateralno prebijanje) | `GRKZag/GrkStavke/GrkStavkeIzGK`, `R_Kompenzacije`, report `Kompenzacija` (APL_2010) | gradi kompenzacioni dok iz otvorenih GK stavki (`Konto=KontoKupca, Duguje<>0`), **delimično prebijanje** (flag „Deo" kad razlika ≥0.01), knjiži u nalog | nova (saldakonti) |
| 1.2 | **Godišnji prelaz + početno stanje (PS/PSF)** | `Form_PS/PSF`, `BAZE_NapraviBazeZaNovuFirmu` | **1 `.mdb` po (firma,godina)**; PS=robno poč. stanje (popis-stil), PSF=GL nalog vrste `PS` + kontni plan + komitenti + carry-forward | nova (year-close + multi-tenant) |
| 1.3 | **IOS + otvorene stavke (saldakonti/aging)** | `OTST Pojedinacno`→report `IOS`, `Zatvori otvorene stavke`, `DospeloINedospelo`, `>90 dana` | IOS usaglašavanje, aging bucket + dani kašnjenja, **auto-zatvaranje** duguje↔potražuje kad `|saldo|≤Max` | nova / proširiti 09 §4 |
| 1.4 | **Knjižna odobrenja/zaduženja (KO/KZ)** | `ER_Module` (`ER_KnjiznoOdobrenjeOBA` L1003, `…Zaduzenje` L1091) | NISU zaseban dok — faktura sa `Vrsta dok` prefiksom (KNO/KNZ), veza na original = **slobodan tekst** `RefBrojDok`; UBL 381/383, `<CreditNote>` | proširiti 09 §2 |
| 1.5 | **Avansi — alokacioni model** | subforme `AVR_Roba/Usluge`, `T_AVR_Roba`, `ER_Module` UBL 386 | avans = link-redovi na konačnoj (`BrojDokAVR`+`DatumDokAVR`), PDV po stopi na **datum avansa**; **bug: AVR_Roba ne oduzima iskorišćeno** → 4.0 ujednačiti | proširiti 09 §5 |
| 1.6 | **Pricing + 2-nivo rabat + formiranje cenovnika** | `Module__Cene`, `Cenovnik(.VP)`, `CEN_*` | cena: MP→sam kod, VP→`Komitenti.Cenovnik`, fallback CFG; ključ (Vrsta dok=kod cenovnika, artikal); **rabat 2-nivo** (po-artiklu→opšti, cap `MaxRabat`, 2 ulančana %); CEN_ transform (množi/deli/prepiši) | proširiti 09 §8 / nova |

⚠️ Za 1.1/1.3/1.6 odlučni upiti nisu bili izvučeni (M1) — čekaju ekstrakciju u toku.

## Scope odluke (Nenad, 18.07)

| Stavka | Odluka |
|---|---|
| Servisni radni nalozi (2.2) | ✅ **MUST** — Servoteh fakturiše servis kroz ERP (obračun materijala+rada, garantni list) |
| Reversi — roba na revers (2.3) | ✅ **U scope** |
| Kalo / rastur / škart (2.4) | ✅ **U scope** (metal: rez/otpad, poresko/KEPU) |
| Provizija prodavaca (2.1) | ⛔ **SKIP** |
| OTKUP dokumenti (3.2) | ⛔ **SKIP** |
| **Opomene / dunning** (net-new) | ✅ **GRADI kao novo** (BigBit ima samo aging listu) |
| **Kampanjski pricing / promo** (net-new) | ✅ **GRADI kao novo** (BigBit menja cenovnik ručno) |

## 2. SHOULD

| # | Caćka | Šta radi | Napomena scope |
|---|---|---|---|
| 2.1 | **Provizija prodavaca** (`Obracun po prodavcima`, `KarticaProdavca`, `RF_Obracun`) | % na promet po `Sifra prodavca`, varijanta **na naplaćeno** | koristi li Servoteh? |
| 2.2 | **Obračun radnih naloga** (servisni/komercijalni: `ObracunRadnogNaloga_SERVIS/_MATERIJAL/_USLUGE`, `RN_Faktura`) | naplata RN: plan vs stvarni utrošak (dok „RAZ-<RN>"), fakturisanje + garantni list | **fakturiše li Servoteh servis kroz BigBit? — POTVRDITI** |
| 2.3 | **Reversi** (roba na revers: `Reversi_UnosZad`, report `Revers`/`Revers_Razduzenje`) | privremeno izdavanje robe (mesto/vozač/ruta) kao **zaduženje** do vraćanja/fakturisanja | dodiruje 2.0 `reversi` (drugi domen!) |
| 2.4 | **Kalo/rastur** (`MP/VP_ObracunKala`, samo APL_2010) | otpis dozvoljenog gubitka/loma (poresko/KEPU) | metal = rez/otpad realan; izvući iz APL_2010 |

## 3. COULD (napomena, potvrditi upotrebu)

Dostavnica sa rutama/vozačima (`OP_ZbiroviPoRutama`) · OTKUP dokument-familija (klon ulazne fakture,
periodna konsolidacija — NIJE poljo-otkup) · Garancija/garantni list (report-only) · CarMag carinski
magacin/izvoz (APL_2010, English INVOICE) · interni „Izveštaji/servis" dok-tip · customer-specific
adapteri (`Cyclamin`, `BEOHOME`, `Metro`, DExpress kurirske nalepnice, brendovani layouti).

## 4. SKIP / negativne nalaze (scoping)

- **Nema prave backup/mirror strategije** — samo Access compact/repair + kopije po godini + SHUTTLE
  replikacija. **Rizik za cutover** (nema pravog backup-a legacy podataka) — zabeležiti.
- **Kafana/POS** (APL_2010 `KafeRacun`…), **PK-1/paušalci/PPDG-1** — nije d.o.o./nije Servoteh. SKIP.
- **`Module__Kontiranje` = prazan stub** — potvrđeno, sve auto-knjiženje je u `SemaZaKontiranje`.
- **ODSUTNO iz BigBit-a (0 pogodaka):** Reklamacije (u 2.0 kvalitet ili net-new), **Opomene/dunning**
  (samo proxy „stavke sa danima kašnjenja"), Cesija, Asignacija, **promo/„akcija" engine**
  („Akcija" = MRP/Dnevnik token, ne kampanja). Ako 4.0 želi dunning/kampanjski pricing → **net-new**.

## 5. Uticaj na procenu (nove MUST stavke van dosadašnjih redova)

Redovi §3 procene (GL/PDV/sales/inventory) NE pokrivaju eksplicitno: kompenzaciju, IOS/saldakonti,
godišnji prelaz/PS-PSF, avanse-alokaciju. To su **računovodstveno obavezne** dopune finance domena:

| Nova MUST stavka | ≈ AI-aktivni dani | Pripada domenu |
|---|---|---|
| IOS + otvorene stavke + auto-zatvaranje | 2–4 | finance/saldakonti |
| Kompenzacija | 1–2 | finance/saldakonti |
| Godišnji prelaz + početno stanje (PS/PSF) | 2–3 | finance (kritično, jednom godišnje) |
| Avansi-alokacija (+ ispravka bug-a) | 1–2 | sales/tax |
| Pricing engine + 2-nivo rabat | 2–3 | sales |

→ **+8–14 AI-aktivnih dana** na Scenario B (finance/sales domeni), koje ranija tabela nije brojala.
Ažurirano u [procenu §3b](../../../docs/ANALIZA_PROCENA_4.0_AGENTI_2026-07.md).
