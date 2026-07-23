# BigBit „IZVEŠTAJI / SERVIS" vs 2.0 — šta se pakuje, šta je već nadmašeno

> **Status:** ANALIZA (2026-07-18). Odluka (Nenad): „izveštaji/servis upakovati u 2.0 jer je napredniji".
> **Nalaz: potvrđeno za operativni deo** — 2.0 `montaza` Izveštaji su napredniji; BI/finansijske stavke
> su zaseban 4.0 tok.

## Meni je HIBRID (4 stavke, `Doc__Form_Prva maska.txt:549-563`)

| Meni stavka | Forma | Priroda | Kuda |
|---|---|---|---|
| Unos izveštaja | `Izvestaj` | servisni/poseta zapisnik | → 2.0 `montaza` (već pokriveno+) |
| Pregled izveštaja | `Pregled izvestaja` | lista/filter | → 2.0 `montaza` |
| **GK izveštaj** | `APGK` | GL/PDV analitički hub (BI) | → 4.0 finance |
| **Analiza prodaje** | `Prodaja_Pregled` | prodaja/potraživanja po fakturama | → 4.0 sales |

## A) Servisni/poseta izveštaj (`T_Izvestaj`) — lagani zapisnik vremena

**Priroda:** tehničar/prodavac po komitentu loguje **vremenske intervale + komentar**; NIJE BI generator,
NIJE obračun materijala/rada. F3 klasifikacija: sales/CRM „izveštaj o poseti", **1.592 zaglavlja / 8.658
stavki**, ODLOŽI-4.0, aktivno se koristi.

DDL (schema:1394): `T_Izvestaj` (Sifra komitenta, Datum, Broj izvestaja, Sifra prodavca, Napomena, Potpis,
**Zakljucano**); `T_IzvestajStavke` (IDKontaktOsobe, **OdVremena, DoVremena, Komentar**). **Stavka nema
artikal/količinu/cenu** — samo od-do vreme + komentar + kontakt osoba (= zapisnik vremena, ne obračun).
Numeracija globalni sekvencijal. Status = samo `Zakljucano` (lock), bez workflow-a. Štampa „Izvestaj - DEFAULT".

## B) Analiza prodaje (`Prodaja_Pregled`) — 4.0 sales

Pregled nad izlaznim fakturama: filteri datum/pozicija/komitent/vrsta/otvoreno-zatvoreno; red po fakturi,
drill na fakturu + analitičku karticu kupca. Saldakonto-orijentisan (ne po artiklu — to je „VP Analiza"=APVP).

## C) GK izveštaj (`APGK`) — 4.0 finance/GL+tax

Hub „Analiza prometa GK" + PDV knjige: podforme KUF/KIF/POPDV/Dnevnik/Bruto promet/salda analitike/analiza
dugovanja. Logika u [18](18-gl-pdv-kontiranje-rekonstrukcija.md)/[30](30-glavna-knjiga-modul-dubinski.md).

## D) 2.0 ekvivalent — `montaza` Izveštaji (napredniji, potvrđeno)

Servisni izveštaj (A) je **već pokriven i nadmašen** modulom `montaza`→Izveštaji (1.0 port):
- `montaza_izvestaji` (+foto), `listReports`/`createReport`/upload foto/PDF/**AI-strukturiranje**;
  wizard obavezna polja `datum/predmet/klijent/lokacija/pocetak_rada/kraj_rada` = **1:1 T_Izvestaj** +
  fotke (16/izv.) + AI + glasovni unos + mobilni + PDF + idempotentno snimanje + nacrt.
- **Bogat status lifecycle** (`zavrseno/delimicno/u_toku/ceka_materijal/ceka_potvrdu/dodatna_intervencija`)
  vs BigBit **jedan** `Zakljucano`.
→ BigBit servisni izveštaj je **striktan podskup** 2.0 montaza izveštaja.

Srodni zreli 2.0 dokumenti (drugi domeni): `kvalitet` (NonconformityReport), `odrzavanje` (CMMS — servis
opreme), `sastanci`. GK izveštaj i Analiza prodaje **NEMAJU 2.0 ekvivalent** (4.0 finance/sales).

## E) Plan stapanja (da ništa ne promakne)

**Već pokriveno (ne raditi ponovo):** ceo dokument A → `montaza` Izveštaji.

**Proveriti/dodati (jedini realni gap prema BigBit-u):**
1. **Više vremenskih intervala po izveštaju** — BigBit `T_IzvestajStavke` dozvoljava N „od-do" blokova;
   2.0 wizard ima jedan `pocetak_rada/kraj_rada`. Ako serviseri loguju više intervala po poseti → dodati.
   **Potvrditi sa Nenadom.**
2. **Kontakt osoba + telefon** po stavci — proveriti da 2.0 hvata kontakt-osobu kod klijenta.
3. **„Odgovorno lice" + potpis** — 🔴 **potvrđeno da FALI u 2.0** (grep `potpis/signature/odgovorno lice`
   po montaza/report kodu = 0). BigBit report `Izvestaj - DEFAULT` ima „Odgovorno lice" = ImeProdavca +
   Br. l.k. Ako Servotehu treba potpisan servisni list → dodati potpisnika na PDF.

**Napomena (2.0 mapiranje potvrđeno):** `plan-montaze.PmIzvestaj` = jedan interval, bez potpisa;
`odrzavanje.MaintWoLabor` = ponovljivi intervali (technician+start/end+notes) ali INTERNO (mašine/vozila),
bez potpisa; `odrzavanje` ima pun `prijava kvara → MaintIncident → MaintWorkOrder` tok. Nijedan nema
potpisan servisni list ka kupcu — to je jedini pravi gap.

**Odbacuje se (ne u montaza):** GK izveštaj (APGK) + Analiza prodaje → **4.0 finance/sales** + report-engine
trijaža (od 496 izveštaja na top ~30). Blokirano na GL/PDV.

**„Servis" ≠ servisni radni nalozi (MUST doc 23 §2.2).** Dva različita dokumenta:
- `T_Izvestaj` = lagani zapisnik vremena (CRM/poseta) — već u montaza.
- §2.2 servisni RN = **naplatni** dokument (`RadniNalozi` sa vozilskim poljima + `T_Usluge Servis` +
  `StvarniUtrosakSirovina` + garantni list) — MUST, gradi se nativno.

## F) Procena

| Stavka | Status | AI-dani |
|---|---|---|
| Servisni/poseta izveštaj (A) jezgro | ✅ već u 2.0 `montaza` | 0 |
| Gap-closure A (multi-interval + kontakt + potpisnik) | opciono, potvrda Nenada | ~1–2 |
| GK izveštaj (C) | 4.0 finance (kad GL postoji) | ~3–5 |
| Analiza prodaje (B) | 4.0 sales (kad fakture postoje) | ~2–4 |
| **Neto za pakovanje servisnog izveštaja** | verifikacija + sitni gap | **~1–3** |

**Zaključak:** operativni deo („Unos/Pregled izveštaja") je **već upakovan i nadmašen** u 2.0 `montaza`;
jedini rizik da promakne = **multi-interval stavke po poseti** + kontakt-osoba (potvrditi, ~1–3 dana).
BI/finansijske stavke su zaseban 4.0 tok.
