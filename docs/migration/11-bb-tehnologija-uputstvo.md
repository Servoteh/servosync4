# BB Tehnologija — zvanično uputstvo (vlasnikove napomene po modulu)

> Izvor: **`BB Tehnologija opis.pdf`** (22 strane, zvanično uputstvo QBigTehn/Tehnologija sa screenshotovima).
> Ovo je **vlasnikov (Negovan/vendor) pogled** na aplikaciju: **ko koristi koji modul**, **šta je najkorišćenije**,
> **šta je nepotrebno i treba IZBACITI**, i **poznata ograničenja**. Najvredniji dokument za **2.0 scope i
> prioritete** — jer direktno kaže šta gradimo prvo, šta preskačemo, i šta popravljamo. Dopunjuje
> [08 (kod)](08-qbigtehn-vba-domain-map.md), [QBIGTEHN_UI_REFERENCE (ekrani)](../design/QBIGTEHN_UI_REFERENCE.md).

Legenda: 🎯 = najkorišćenije (prioritet za 2.0) · ❌ = vlasnik kaže IZBACITI · ⚠️ = poznato ograničenje (popraviti u 2.0) · 👥 = ko koristi.

## PDM — veza sa SolidWorks PDM-om
👥 **CEO MODUL KORISTI PROJEKTNI BIRO.** Konstruktori izvoze XML+PDF; služi za primopredaju dokumentacije.
- **Pregled crteža** — glavni browser; opcije: otvori/štampaj PDF, **sastavnica** (ako je sklop), **sastavnica gotove robe** za sklop, **gde se koristi** (where-used), **kreiranje nove primopredaje**.
- **XML import log** · **Sklop (crtež)** (detalj).

## Nabavka
👥 **Uglavnom za UVID u statuse nabavke** — postoji **posebna aplikacija** za iniciranje nabavke i praćenje statusa.
- Unos specifikacije za nabavku · Planiraj nabavku iz sklopnog crteža · Planiraj nabavku pre crteža · Pregled specifikacija · Realizacija i analiza nabavki.

## Nacrti
👥 **CEO MODUL KORISTI PROJEKTNI BIRO.** Nacrti su **razvrstani po bojama** (semantika statusa → dizajn sistem).
- Pregled predatih nacrta · Pregled nacrta · **Kreiraj primopredaju**.

## Primopredaje
- **Odobravanje primopredaja** — primopredaje na čekanju; klik na **„Odobri primopredaju"** → **lista kom tehnologu se dodeljuje dokumentacija** za izradu tehnoloških postupaka (👥 dodela tehnologu).
- **Odobrene** — lista odobrenih crteža za lansiranje za koje **nije završena tehnologija**.
- **Odbijene** · **Lansirane** (lansirani radni nalozi) · **Pregled svih** (svi predati u proizvodnju: odbijene/lansirane/na čekanju).

## ❌ Lansiranje (izbaciti)
- ❌ **„Lansiranje — NEPOTREBAN MODUL ZA TEHNOLOGIJU."**
- ❌ **„Lansiranje primopredaje — nepotrebna opcija; lansiranje RN vršimo iz Primopredaje/Odobrene → izabere se crtež/dokument primopredaje → Lansiraj radni nalog. DUPLIRANA OPCIJA I TREBA JE IZBACITI."**
- **⇒ 2.0:** ne graditi zaseban „Lansiranje" ekran; lansiranje je akcija unutar Primopredaje (Odobrene).

## Radni nalog
- **Unos radnog naloga** — otvaranje novog RN kad **nije po automatskoj primopredaji** (ručno predat crtež, ili kopiranje tehnologije za isti deo po novom RN).
- 🎯 **Pregled radnih naloga** (po broju crteža/predmeta, nazivu dela...) — **„NAJČEŠĆE KORIŠĆEN PREGLED ZA STATUSE DELOVA."** Akcije po redu: PDF crtež · **Kartica tehnološkog postupka** (šta je od operacija završeno, ko je radio, broj komada, utrošeno vreme) · **Lokacija delova** (ako je završna kontrola gotova) · **Detaljno radni nalog** (tehnologija izrade).
- **Kopiranje celih naloga (projekata)** — kad se isti projekat pušta ponovo (npr. drugom kupcu). Primer: `RN8034`, `RN8035`.

## Proizvodnja
- 🎯 **Pregled tehnoloških postupaka** — **„NAJČEŠĆE KORIŠĆEN FILTER za pregled učinka po radniku."**
- 🎯 **Detaljan pregled statusa gotovosti delova** (po radnoj jedinici / nazivu crteža / RN) — **„NAJČEŠĆE KORIŠĆEN PREGLED ZA STATUS GOTOVOSTI DELOVA."** ⚠️ **„nema mogućnost pregleda za CEO SKLOP"** — ograničenje za 2.0 (dodati agregaciju po sklopu).
- **Dinamika izrade sklopova** (levo nalozi, desno stepen gotovosti po operacijama) — ⚠️ **„NE FUNKCIONIŠE pregled za ceo sklop."**
- **Kartica tehnološkog postupka** — započete/završene operacije sa utrošenim vremenom, količinama, imenom radnika.
- **Analiza dnevnih aktivnosti** — evidencija RN po radniku po satu; 🔴 **„u 23h se AUTOMATSKI zatvaraju nezatvoreni nalozi"** (poslovno pravilo za 2.0 — noćni auto-close job).
- ❌ **Razlike verzija 1 i 2 — NEPOTREBNO ZA TEHNOLOGIJU („programer napravio da bi rešio svoj problem").** Ne portovati.

## Lokacije delova
- **Unos raspoloživih lokacija** (police, paletna mesta...).
- **Pregled lokacija gotovih delova** — 🔴 **„nakon ZAVRŠNE KONTROLE se definiše lokacija dela"** (lokacija se postavlja tek posle završne kontrole — pravilo za 2.0).

## Proizvodne strukture
- **Unos/pregled radnika** — 🔴 „ukoliko radnik koristi aplikaciju za unos/pregled teh. postupka **dodaje se LogAcc**" (nalog za login).
- 🔴 **Vrste poslova** — **„određene vrste poslova DODELJUJU/UKIDAJU PRAVA za određene funkcije u aplikaciji"** (= **RBAC**! `worker_type` → permisije, vidi [RBAC_RLS_PREDLOG](../design/RBAC_RLS_PREDLOG.md)).
- **Unos/pregled radnih jedinica** · **Unos/pregled operacija** („sve mašine/operacije u firmi koje se pozivaju u izradi TP").
- **Radnici po mašinama** — **„izbor dozvoljenih operacija za kucanje po radniku"** (= `machine_access` ACL).

## Razno
- **Pregled komitenata** (read-only overlay).
- ❌ **„Unos predmeta — TREBA IZBACITI IZ OPCIJA."**
- **Preuzmi iz BigBit-a** — preuzimanje podataka o novootvorenim predmetima (= `bigbit-sync`, vidi [06](06-bigbit-preuzmi-iz-bb.md)).
- **Izlaz** — izlaz iz aplikacije.

---

## Sažetak za 2.0 (šta ovo menja u planu)

**🎯 Prioritetni ekrani (grade se prvi — najkorišćeniji):**
1. **Pregled radnih naloga** (statusi delova) + akcije: kartica TP, lokacija, detaljno RN, PDF.
2. **Pregled tehnoloških postupaka** (učinak po radniku).
3. **Detaljan pregled gotovosti delova** — uz **novu mogućnost pregleda za ceo sklop** (rešiti legacy ograničenje).
4. **Kartica tehnološkog postupka**.

**❌ NE graditi (vlasnik eksplicitno kaže izbaciti):** zaseban „Lansiranje" modul; „Lansiranje primopredaje"
(duplikat); „Razlike verzija 1/2"; „Unos predmeta". → uža 2.0 lista ekrana nego što UI referenca sugeriše.

**⚠️ Ograničenja da se poprave u 2.0:** agregacija gotovosti/dinamike **za ceo sklop** (legacy ne ume — rekurzivni BOM CTE).

**🔴 Poslovna pravila (dopuna specovima):**
- Noćni **auto-close nezatvorenih naloga u 23h** (dodati [MODULE_SPEC_tehnologija](../design/MODULE_SPEC_tehnologija.md)).
- **Lokacija dela se definiše tek posle završne kontrole** (dodati [MODULE_SPEC_lokacije](../design/MODULE_SPEC_lokacije.md)).
- **Vrste poslova = RBAC prava** (potvrđuje `worker_type → permisije` iz RBAC predloga).

**👥 Role/ko-koristi (potvrda za RBAC):** PDM + Nacrti = **Projektni biro** (konstruktori); Primopredaja odobrenje
→ **dodela tehnologu**; unos TP → radnik sa LogAcc; Nabavka = uvid (zasebna app inicira).
