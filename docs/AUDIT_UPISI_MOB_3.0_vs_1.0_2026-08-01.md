# Audit: da li upisi iz mobilne 3.0 (`/mob`) i 1.0 (`/m`) idu u ISTU bazu

**Datum:** 01.08.2026 · **Povod:** pitanje Nenada („da vidimo oko upisa u bazu iz mob 3.0 i /m 1.0
da li je sve čisto") · **Metod:** 7 paralelnih tragača kroz OBA repoa, lanac po lancu
(FE hook → BE ruta → servis → baza/tabela/RPC), pa isti lanac u 1.0; svaka tvrdnja sa fajl:linija.

## Zaključak u jednoj rečenici

**Nema haosa — 6 od 7 domena je čisto (ista baza, ista tabela/RPC, isti autor, ista
idempotencija). JEDAN crveni slučaj: `/mob/proizvodnja` (3.0) i `/m/proizvodnja` (1.0) pišu
ISTI podatak u DVE RAZLIČITE baze.**

## Tabela po domenima

| Domen | Verdikt | Suština |
|---|---|---|
| **Magacin / lokacije** | ✅ ČISTO (po dizajnu) | Obe app zovu ISTU sy15 funkciju `loc_create_movement`, isti `moved_by` (auth uid), ista idempotencija (`client_event_uuid`). „Moja istorija" u svakoj app vidi i skenove iz druge. |
| **Sastanci** (RSVP, akcije, priprema) | ✅ ČISTO | Iste sy15 tabele/RPC-ovi u obe; 3.0 self-service ide kroz nove SECURITY DEFINER RPC-ove nad ISTIM redovima. |
| **Montaža / izveštaji / PB** | ✅ ČISTO | Glavni sumnjivac (projektni biro) je čist: i 3.0 i 1.0 pišu sy15 `pb_*` kroz iste RPC-ove. |
| **Kadrovska samousluga** (GO, sati, prisustvo, odobravanja) | 🟡 RIZIK (nije split-brain) | Svih 14 mutacija u ISTU sy15 bazu i iste tabele. ALI: pravilo 026/26 („izmena/otkaz POTVRĐENOG godišnjeg ide kao molba HR-u") sprovedeno je samo u 3.0 — kroz 1.0 radnik i dalje može direktno da otkaže odobren termin. |
| **Onboarding / profil** | 🟡 RIZIK (nije split-brain) | Ista baza; sitne asimetrije prava/idempotencije. |
| **Reversi / održavanje** | 🟡 RIZIK (nije split-brain) | Ista sy15 baza i isti bucket za fotke; razlike u putanjama/pravima, ne u bazi. |
| **Praćenje** | ✅ ČISTO po dizajnu | 1.0 `/m/pracenje` je od O8 forwarda (Faza 1) preusmeren na 3.0 i **nema nijedan upis**; jedini pisac je 3.0 glavna baza. |
| **Proizvodnja** | 🔴 **SPLIT-BRAIN** | vidi dole |

## 🔴 Jedini crveni nalaz: proizvodnja po mašini

- **3.0** `/mob/proizvodnja` upisuje status/„spremno"/napomenu smene u **glavnu bazu**
  (`plan_proizvodnje_overlays`).
- **1.0** `/m/proizvodnja` (myProdMachine) je i dalje **ŽIV, bez forwarda** i isti podatak
  upisuje u **sy15** (`production_overlays`) preko PostgREST-a.
- Migracija sy15 → glavna baza je bila **jednokratna** (F5b-1a skripta) i **nema sinhronizacije**:
  upis iz 1.0 posle preklopa je nevidljiv u 3.0 i obrnuto.

**Koliko je opasno u praksi (ublažavanja):**
- 1.0 ekran dozvoljava izmenu samo administratorima/PM/menadžmentu (ne operaterima).
- 1.0 čita **zamrznut** sy15 keš operacija (stao 14–15.07) — noviji radni nalozi tamo se i ne vide.
- Dakle: tiho „izgubljen" upis je moguć, ali za uzak krug ljudi i nad starim nalozima.

**Preporuka (čeka tvoju odluku):** kloniraj isti obrazac koji smo već primenili na praćenje —
forward `/m/proizvodnja` → `/mob/proizvodnja` u 1.0 (mali, dokazan zahvat: ~40 linija, per-uređaj
beg ostaje). Time nestaje i poslednji izvor dvostrukog upisa.
**Nije urađeno** jer diranje 1.0 tokom tvog odmora nije u dogovoru (odluka od 26.07: bez
diranja 1.0 do 03.08).

## 🟡 Vredi znati (nije baza, nego pravilo/semantika)

1. ~~**026/26 zaobilaznica**~~ — ✅ **ISPRAVKA NALAZA (provereno na živoj sy15, 01.08):
   zaobilaznice NEMA.** DB brana `kadr_vacreq_direct_blocked()` postoji i radi u
   `hr_cancel_vacation_request` i `hr_revise_vacation_request`: podnosilac (koji nije HR/upravljač)
   nad `approved` NE menja ništa — funkcija vraća `needs_change_request`. (Audit agent se oslonio
   na zastareo komentar u 3.0 kodu; nalaz oboren proverom same baze — pouka: pravila se proveravaju
   u DB definiciji, ne u komentarima.) **Stvarni defekt je bio UX u 1.0**: dugmad „Izmeni/Otkaži"
   su se prikazivala i za potvrđen termin, confirm je obećavao oslobađanje salda, a ishod je bio
   „⚠ Otkazivanje nije uspelo" — izgledalo kao kvar. Popravljeno 01.08 (odluka Nenada „zatvori iz
   1.0 otkazivanje odmora"): za `approved` 1.0 sada nudi „Molba za izmenu/otkaz" sa prelaskom na
   3.0 `/mob/odsustva` gde 026/26 tok postoji.
2. **Batch premeštanje se drugačije tumači:** 1.0 batch uvek radi „dodavanje na policu"
   (`INITIAL_PLACEMENT`, izvorna polica se ne prazni), a 3.0 batch radi **premeštaj** (skida sa
   izvora). Ista tabela, ali ista fizička radnja daje različitu sliku zaliha zavisno od toga iz
   koje aplikacije je urađena. Vredi ujednačiti (odluka: koja semantika je ispravna).
3. **Offline redovi su odvojeni po aplikaciji** (svaki svoj localStorage): neposlat sken iz 1.0
   ne vidi se u 3.0 dok ne ode na server. Oba se na kraju slivaju u istu funkciju sa istom
   idempotencijom — bezopasno, ali objašnjava „gde mi je sken" u prelaznom periodu.

## Zašto nema duplikata i pogrešne atribucije

- **Identitet:** 3.0 backend postavlja sy15 GUC klaimove (`sub` = `auth.users.id` razrešen po
  email-u) pa DB funkcije vide **istog korisnika** kao kad piše 1.0 kroz GoTrue token. Nalog bez
  sy15 para → funkcija odbija upis (fail-closed), nikad tuđa atribucija.
- **Idempotencija:** ključ (`client_event_uuid` / `clientEventId`) se generiše jednom po akciji;
  ponovno slanje istog ključa vraća postojeći zapis umesto novog.
