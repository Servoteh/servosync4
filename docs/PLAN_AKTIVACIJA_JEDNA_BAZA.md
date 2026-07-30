# Aktivacija predmeta — jedna baza (plan)

> Odluka vlasnika **O-8, 31.07.2026**: „ekran piše u jednu bazu, plan proizvodnje u drugu —
> to mi se ne sviđa, moramo to razrešiti da se u jednu bazu piše, a ne da se duplira i da
> ide u keš." Analitička podloga: `docs/AKTIVACIJA_PREDMETA.md`. Ovaj dokument je PLAN.

## 0. Odluke koje ovaj plan sprovodi

| # | Odluka (vlasnik, 31.07.2026) | Posledica u planu |
|---|---|---|
| **O-8** | Jedna baza, bez dupliranja, bez keša kao uslova | izvor istine = **app baza** (`predmet_aktivacije`); 4.0 se u potpunosti odriče sy15 strane |
| **P1** | Tih 24 predmeta uneti kao **aktivne** | ✅ IZVRŠENO 31.07 (Faza 0): pogon 86 → **110** aktivnih, identično ekranu; 0 predmeta bez reda |
| **P2** | Kvačice menjaju **admin + menadžment** | postojeća permisija `settings.predmet_aktivacija` se zadržava, samo cilja novu rutu |
| **P3** | „Proveri sam; ne moraš obrisati, ali da bude **sklonjen iz 4.0**" | ✅ PROVERENO: 1.0 koristi sy15 stranu u **15 fajlova** (svoj ekran Podešavanja predmeta, plan montaže, plan proizvodnje, kadrovska-teren, lokacije, nalepnice) → sy15 strana **ostaje živa za 1.0**, 4.0 je se odriče; v. §3 |
| **P5** | App baza se sluša za ⭐ prioritet (9 predmeta); admin menja, **redosled važi za sve** | ✅ VEĆ TAKO: čitanje prioriteta nema korisničku kapiju (`pracenje-read.service.ts:1349`), izmena je pod `pracenje.manage`; sy15 kopija (1 red) se ignoriše |

Nasleđene odluke koje se ovde poštuju: **O-1** (BigBit vlasnik predmeta do prelaza; 4.0 vlasnik
tehnologije), **O-2** (4.0 ne otvara predmete; ništa se ne briše), **O-5** (sync se gasi
01.02.2027).

## 1. Suština problema (izmereno)

Ekran Podešavanja → Predmeti piše u **glavnu bazu** (sy15 `production.predmet_aktivacija`,
preko RPC `set_predmet_aktivacija`). Plan proizvodnje i praćenje čitaju **drugu tabelu u
drugoj bazi** (`servosync-pg.predmet_aktivacije`) — a **nijedan pisac ne postoji između**:
tabela od 7.602 reda nasuta je jednom, 26.04.2026, i od tada je niko nije dopunio.

Posledica pre sanacije: 24 najnovija predmeta (10461–10486) bila su „aktivna" na ekranu, a
za pogon **nisu postojala** — i klik to nije mogao da popravi. Uz to, okidač u glavnoj bazi
svaki nov predmet u kešu rađa kao **aktivan**, što je suprotno pravilu vlasnika da se nov
predmet rađa ugašen pa se ručno bira šta se prati (1.824 „U TOKU" naspram 110 stvarno
praćenih — zato aktivacija i postoji).

## 2. Ciljna arhitektura

```
BigBit (.mdb, dnevno 17:32) ──► app baza: projects  ──► NOV korak uvoza:
                                                        red aktivacije = UGAŠEN
                          ┌──────────────────────────────────────────┐
   4.0 ekran Podešavanja ─┤  predmet_aktivacije (app baza)           ├─► plan proizvodnje
   (admin + menadžment)   │  JEDINI izvor istine:                    ├─► praćenje
                          │  is_active · is_projektovanje_montaza    ├─► tehnologija
                          │  plan_priority (⭐, važi za sve)          ├─► plan montaže (4.0)
                          └───────────────┬──────────────────────────┘
                                          │ jednosmerni dnevni ODRAZ (samo dok 1.0 živi)
                                          ▼
                          sy15: bigtehn_items_cache + predmet_aktivacija
                          (1.0 ekrani nastavljaju da rade; 4.0 ovo NE čita)
```

Pravila:
1. **Jedno mesto upisa** — 4.0 API nad `predmet_aktivacije`. RPC i keš prestaju da budu
   uslov za bilo šta u 4.0.
2. **Nov predmet se rađa ugašen** — korak uvoza upisuje red sa `is_active = false`.
   (Podrazumevana vrednost kolone je danas `true` — menja se migracijom na `false`, da ni
   slučajan insert ne rodi aktivan red.)
3. **Odraz ka sy15 je privremen i jednosmeran** (app → sy15), postoji isključivo zato što
   1.0 još čita tu stranu (P3 nalaz). Gasi se kad i 1.0. Redosled u odrazu: prvo keš, pa
   aktivacija — da odraz pregazi ono što okidač na kešu sam postavi.

## 3. P3 nalaz — šta tačno drži sy15 stranu u životu

`servoteh-plan-montaze/src` koristi: `predmetAktivacija.js`, `pb.js` (pb_list_projects),
`podesavanja/podesavanjePredmeta/predmetiTable.js` (sopstveni ekran za kvačice!),
`planMontaze/projectBar.js`, `planProizvodnje/poMasiniTab.js`, `kadrovska/gridTerenPredmet.js`,
`lokacije`, `stampaNalepnica`, `pracenjeProizvodnje`, audit log. Ukupno 15 fajlova.

**Otvorena stavka koja traži potvrdu vlasnika (jedina u ovom planu):** 1.0 ima sopstveni
ekran za kvačice. Posle Faze 2 postoje dva mesta upisa (1.0 → sy15, 4.0 → app), a odraz ide
samo app → sy15, pa bi **klik u 1.0 ekranu bio pregažen sledećim odrazom**. Predlog: 1.0
ekran učiniti read-only (ili sakriti) u trenutku Faze 2. Trošak: jedna izmena u 1.0 repou.

## 4. Faze

### Faza 0 — sanacija ✅ IZVRŠENA 31.07.2026
24 predmeta dopunjena u `predmet_aktivacije` kao aktivna (P1). Provereno: 7.626 redova,
110 aktivnih (= ekran), 0 predmeta bez reda. Operativni udar: +2 RN u pogonu (oba 10005).
Idempotentno — ponovni prolaz ubacuje 0.

⚠️ Do Faze 2 ekran i dalje piše u sy15, pa se strane mogu ponovo razići. Zato Faza 2
počinje **ponovnim poravnanjem** (isti obrazac kao Faza 0, u oba smera po `updated_at`).

### Faza 1 — sync radi, nov predmet se rađa ugašen (traži deploy)
1. PR → CI → deploy `.mdb` kanala na produkciju (prod danas nema nijednu `bb_mdb` tabelu).
2. Tajmer `env`: dev → prod URL (jedan red, `ops/bigbit/README.md`).
3. Nov korak uvoza: za svaki predmet bez reda u `predmet_aktivacije` upiši
   `is_active=false, is_projektovanje_montaza=false`. Migracija: default kolone `true→false`.
4. Prvi nadzirani prolaz na produkciji; sync prekidač ostaje dostupan za gašenje.
Kontrola: posle prolaza — 0 predmeta bez reda aktivacije; broj aktivnih NEPROMENJEN
(sync ne sme nikoga da upali).

### Faza 2 — preseljenje istine (jedan deploy, jedan presek)
1. **Backend:** rute za kvačice + napomenu nad `predmet_aktivacije`
   (`settings.predmet_aktivacija` = admin + menadžment, P2). Audit kolone
   (`updated_by_user_id`) se pune — trag koji je do sada živeo u sy15.
2. **Migracija podataka:** poravnanje is_active (v. Faza 0 ⚠️), prenos **22**
   `je_projektovanje_montaza` u (danas mrtvu) app kolonu, prenos napomena.
   ⭐ prioritet se NE dira — app je već istina (P5).
3. **Frontend:** ekran Podešavanja → Predmeti na nove rute; usput ispravka nađenog
   `ids`/`itemIds` buga (`podesavanja.ts:138` vs servis).
4. **Prevezivanje 4.0 čitalaca sa sy15 na app:** plan montaže (lista `pb_list_projects` →
   upit nad app bazom; pretraga `bigtehn_items_cache` → `projects`), kadrovska-teren.
   Plan proizvodnje i praćenje se NE diraju — već čitaju pravu stranu.
5. **Odraz app → sy15** (aktivacija + keš + novi predmeti u keš — jer je most koji ga je
   punio mrtav od 22.07, pa bi 1.0 pretrage inače zastarele): dnevno, posle uvoza.
6. **1.0 ekran kvačica** → read-only/sakriven (čeka potvrdu, §3).
Kontrola: klik u 4.0 ekranu vidljiv u pogonu ODMAH (ista tabela); 1.0 ekrani pokazuju
isto stanje najkasnije sutradan (odraz).

### Faza 3 — prelaz (01.02.2027)
Gasi se uvoz (O-5) i odraz ka sy15. **Ništa se ne seli** — istina već živi u 4.0.
To je i glavna dobit O-8: dan prelaza za aktivaciju je prazan posao.

## 5. Šta se namerno NE radi
- Ne brišе se ništa u sy15 (P3: „ne moraš ga obrisati") — samo se 4.0 odriče.
- Ne preslikava se BigBit `status` u `is_active` (1.824 „U TOKU" vs 110 praćenih;
  1.757 od njih bez ijednog RN — izmereno u AKTIVACIJA_PREDMETA.md §7).
- Ne dira se okidač na sy15 kešu — posle Faze 2 njegov ishod pregazi odraz.

## 6. Redosled i zavisnosti
Faza 0 ✅ → **danas 17:32**: prvi automatski prolaz na dev (test celog lanca) →
Faza 1 (PR čim prolaz prođe čisto) → Faza 2 (sledeći PR; jedina spoljna zavisnost je
potvrda za 1.0 ekran) → Faza 3 po kalendaru.
