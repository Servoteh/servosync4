# Plan: izgled `/mob` po uzoru na 1.0 (da ne zbunjujemo ljude)

**Datum:** 01.08.2026 · **Odluka Nenada:** „izgled `/mob` (bar glavni ekran i raspored) što bliži
1.0; magacioner/logistika/vozači da imaju ekran fokusiran na lokacije delova pa reverse; ostali
moduli vidljivi, ali kad odu na njih" · **Status:** predlog — čeka potvrdu pre izrade

## 1. Kako 1.0 izgleda danas (doslovan snimak)

```
┌──────────────────────────────┐
│ SERVOSYNC              🌓   │  ← zaglavlje: naslov + podnaslov „Servoteh · mobilni"
│ Servoteh · mobilni           │
├──────────────────────────────┤
│ Zdravo 👋                    │  ← pozdrav u telu ekrana
│ Brzi pristup onome što ti…   │
│                              │
│ ┌────────┐ ┌────────┐        │  ← MREŽA 2 KARTICE U REDU
│ │ 🚀     │ │ 🏖️     │        │
│ │ServoSync│ │Godišnji│ ← „primary" (naglašena)
│ │  3.0    │ │ odmor  │        │
│ └────────┘ └────────┘        │
│ ┌────────┐ ┌────────┐        │
│ │ ✅ Za  │ │ 🧰     │        │
│ │  mene  │ │Montaža │        │
│ └────────┘ └────────┘        │
│ ┌────────┐ ┌────────┐        │
│ │ 📝 Nov │ │ 👤 Moj │        │
│ │izveštaj│ │ profil │        │
│ └────────┘ └────────┘        │
│ ┌────────┐ ┌────────┐        │
│ │ 📷     │ │ 🔁     │        │  ← uslovno (magacin / reversi)
│ │Magacin │ │REVERSI │        │
│ └────────┘ └────────┘        │
│ ┌──────────────────────────┐ │
│ │ ⋯ Svi moduli           › │ │  ← puna širina
│ └──────────────────────────┘ │
├──────────────────────────────┤
│  🏠     ✅    (📷)   👤   ⋯  │  ← DONJA TRAKA, „Skeniraj" je krug KOJI VIRI IZNAD
│Početna Za mene Sken Profil Više│
└──────────────────────────────┘
```

Ključno što 3.0 **nema**: donja traka sa istaknutim „Skeniraj", pozdrav, jedinstveno zaglavlje,
i „Svi moduli" kao zaseban ekran.

## 2. Kako `/mob` izgleda danas

Jedna duga mreža od 18 kartica (2 u redu) + dve grupe (Montaža, Magacin), bez donje trake; svaki
ekran sam crta svoje zaglavlje. Funkcionalno bogatije od 1.0, ali vizuelno drugačije — i za
magacionera je „Magacin" samo jedna kartica među osamnaest.

## 3. Predlog

### 3.1 Zajednička ljuska `/mob` (novo)

- **Zaglavlje**: „SERVOSYNC" **+ badge `3.0`** (traži Nenad 01.08 — radnici prelaze između 1.0 i
  3.0 pa moraju odmah videti gde su; verzija je hardkodovana konstanta, NE build hash iz
  `version.json`) + podnaslov „Servoteh · mobilni". Na pod-ekranima: ← nazad + naslov ekrana.
  Pun identitet („ServoSync 3.0 · Servoteh") stoji i na dnu ekrana „Više".
- **Donja traka, 5 tabova** — 1.0 raspored: `🏠 Početna · ✅ Za mene · 📷 SKENIRAJ · 👤 Profil · ⋯ Više`,
  gde je **Skeniraj istaknut krug koji viri iznad trake** (kao u 1.0) i vodi pravo na
  `/mob/lokacije` (skener).
- Traka se vidi na glavnim ekranima, ne na pod-ekranima (isto kao 1.0).

### 3.2 Početni ekran — DVA rasporeda po ulozi

**A) „Magacinski" početni ekran** (magacioner i ekipa oko magacina):

```
Zdravo 👋
Skeniraj, premesti, zaduži.

┌──────────────────────────────┐
│ 📷  SKENIRAJ DEO           › │  ← puna širina, naglašeno (glavni posao)
├──────────────────────────────┤
│ 🔎 Gde je deo?  │ ⌨ Ručni unos│
├─────────────────┼────────────┤
│ 📦 Batch        │ 🕘 Istorija │
├──────────────────────────────┤
│ 🔁  REVERSI — moja zaduženja › │  ← puna širina (drugi po važnosti)
├──────────────────────────────┤
│ ⏳ 3 skena čeka slanje       │  ← samo kad ima neposlatih (1.0 badge)
├──────────────────────────────┤
│ ⋯  Svi moduli              › │  ← ostalo je ovde, ne na početnoj
└──────────────────────────────┘
```

**B) „Opšti" početni ekran** (svi ostali) — 1.0 redosled 1:1:
Godišnji odmor (naglašen) · Za mene · Montaža · Novi izveštaj · Moj profil ·
[Magacin] · [Reversi] · **Svi moduli** (puna širina).

### 3.3 „Svi moduli" (`/mob/vise`) — novo

Lista svih modula kao u 1.0 („Više"), sa oznakama gde treba: **mobilno** / **računar** (za module
koji se realno rade na desktopu) / 🔒 (nema prava). Time početni ekran ostaje kratak, a ništa se
ne gubi — sve je dva tapa daleko.

## 4. Ko dobija magacinski ekran — TRAŽI ODLUKU

Nalaz iz sistema: **rola `magacioner` postoji; „vozač" i „logistika" NE postoje kao role.**
„Logistika" je samo naziv grupe u meniju. Prava `lokacije.read/move` ima **svako** (namerno), pa
ona ne mogu da razlikuju magacinsku ekipu od ostalih.

Tri opcije:

| | Uslov | Koga hvata | Rizik |
|---|---|---|---|
| **P1 (preporuka)** | rola `magacioner` **ili** pravo `reversi.manage` | magacioner + admin/menadžment/PM krug | Vozači/logistika koji nemaju tu rolu neće dobiti — rešava se dodelom role |
| P2 | samo rola `magacioner` | uski krug | Isto kao gore, ali bez admin krug „šuma" |
| P3 | korisnik sam bira („Postavi magacinski ekran kao početni") | svako ko hoće | Traži jedan prekidač u Profilu; najfleksibilnije |

**Moja preporuka: P1 + kasnije P3** kao dopuna (prekidač u Profilu) — tako magacin odmah dobija
svoj ekran, a onaj ko nije obuhvaćen može sam da ga uključi.

**Pitanje za tebe:** ko su konkretno „vozači i logistika" — da li ti ljudi danas imaju rolu
`magacioner`? Ako nemaju, treba im je dodeliti (ili idemo na P3).

## 5. Redosled izrade (predlog)

1. **F1 — Ljuska**: zaglavlje + donja traka sa istaknutim „Skeniraj" (bez menjanja ijednog
   postojećeg ekrana).
2. **F2 — Početna**: dva rasporeda (magacinski/opšti) + pozdrav; `/mob/vise` sa punom listom.
3. **F3 — Pod-ekrani**: jedinstveno zaglavlje sa „←" (danas svaki ekran crta svoje).
4. **F4 — Sitnice pariteta**: badge „⏳ N čeka" na magacinskoj početnoj, `Skeniraj` guard poruka
   kad nema prava (1.0 ima „🔒 Nemaš pristup magacinu").

Batch semantika („dodaj na policu" umesto „premesti") ide uz F2 kao zasebna mala izmena.
