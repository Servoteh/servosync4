# Sastanci — primedbe korisnika 20.07.2026 — analiza i plan

**Izvor:** [zahtevi/2026-07-20_Servosync-Sastanci.docx](zahtevi/2026-07-20_Servosync-Sastanci.docx)
(Zoran Jaraković, 7 primedbi sa screenshotovima) + usmena dopuna: „omogući da se lako
odštampa zapisnik sa prethodnog sastanka, ovako je zbunjujuće".

**Proces:** Fable analiza+plan (ovaj dokument, 20.07); implementacija Opus agenti po talasima (§Podela).
Analiza je rađena nad živim kodom (`frontend/src/app/sastanci/`, `backend/src/modules/sastanci/`)
i verifikovana uživo na serveru (ssh `ubuntusrv`, curl probe — §S0).

---

## S0 — KRITIČNO: „Ne mogu da zaključam sastanak" (storage 404) — infra fix, bez koda

**Simptom:** klik na „Zaključaj" → alert `Upload nije uspeo (storage 404: {"message":"Route
POST:/storage/v1/object/sastanci-arhiva/<id>/<ts>_zapisnik.pdf not found"...})`. Sastanak ostaje
otključan (ispravno — lock se prekida ako PDF ne prođe).

**Tok:** FE generiše PDF (jsPDF) → `POST /api/sastanci/:id/arhiva/pdf` → BE
[sy15-storage.service.ts](../backend/src/common/sy15/sy15-storage.service.ts) šalje na
`${SY15_STORAGE_URL}/object/sastanci-arhiva/...` → tek onda RPC lock sa `pdfStoragePath`.

**Uzrok (potvrđen uživo):** na produ `~admluka/servosync/backend.env:24` stoji

```
SY15_STORAGE_URL=http://sy15-storage:5000/storage/v1     # POGREŠNO
```

To gađa storage-api kontejner **direktno**, ali sa `/storage/v1` prefiksom koji storage-api
(supabase storage v1.60.4, Fastify) **ne poznaje** — prefiks skida Caddy gateway (`sy15-gateway:8080`).
Otud Fastify `Route POST:/storage/v1/... not found` 404. Vrednost potiče iz
[REVERSI_PILOT_DEPLOY.md §1a](../backend/docs/design/REVERSI_PILOT_DEPLOY.md) — tamo je i dokumentovana
pogrešno (storage tok reversija očigledno nikad nije bio živo verifikovan).

**Probe (20.07, read-only):**
- `ubuntusrv: curl http://localhost:8080/storage/v1/status` → **200** (gateway ispravno skida prefiks)
- `https://api.servosync.servoteh.com/storage/v1/status` → **200** (javna ruta kroz CF tunel → gateway :8080, postoji od 1.5 cutover-a)
- `https://servosync.servoteh.com/storage/v1/status` → **404** (glavni origin = Next front, NEMA storage rutu)

**Zašto fix mora biti JAVNI URL:** `signUrl()` vraća `${base}${signedURL}` koji **browser** otvara
(preuzimanje PDF-a, prikaz slika). Interna vrednost (`sy15-storage:5000` ili `sy15-gateway:8080`) je
browseru nedostupna — dakle i da je upload radio, download bi bio slomljen.

**Fix (env jedan red + restart, ~5 min):**
```
SY15_STORAGE_URL=https://api.servosync.servoteh.com/storage/v1
```
u `~admluka/servosync/backend.env` (admnenad ima ACL rw), pa `docker compose up -d backend`
iz `~admluka/servosync/` (v. INFRASTRUKTURA.md §sudo-docker napomena). BE upload/sign ide odlazno
kroz CF tunel — isti obrazac kao mail/AI egress.

**Domet kvara — NIJE samo sastanci.** `Sy15StorageService` koristi **8 modula**: sastanci (PDF
zapisnika + slike), reversi (potpisnice), projektni-biro, plan-proizvodnje, plan-montaze,
odrzavanje, kadrovska (dosije dokumenti), ai-chat. Svi BE storage tokovi na produ su do ovog
fixa mrtvi (upload i potpisivanje URL-ova). Jedan env red popravlja sve.

**Verifikacija posle fixa:**
1. Zaključaj probni sastanak (ili pravi — Zoran) → PDF u arhivi, mejl učesnicima.
2. Arhiva tab → „PDF" dugme → otvara se potpisan URL.
3. Slika uz tačku zapisnika: upload + prikaz thumbnail-a.
4. Reversi: „Preuzmi" potpisnicu.

**Prateće (kod/docs, Opus):**
- [ ] `backend/.env.example:85` — komentar uz `SY15_STORAGE_URL` (mora biti javna gateway adresa
      `/storage/v1`, primer; objasniti zašto ne interni host).
- [ ] `REVERSI_PILOT_DEPLOY.md` §1a — ispraviti dokumentovanu vrednost + napomena o lekciji.
- [ ] Opciono hardening (NE sada, otvorena odluka): split `SY15_STORAGE_URL` (interni, brzi upload)
      + `SY15_STORAGE_PUBLIC_URL` (za signed URL) — ima smisla tek ako 20MB uploadi kroz tunel zasmetaju.

---

## S1 — Štampa zapisnika PRETHODNOG sastanka (usmena primedba)

**Trenutno:** jedini put je glavna lista → tab „Arhiva" → nađi red → „Štampaj"/„PDF"
([arhiva-tab.tsx](../frontend/src/app/sastanci/_components/arhiva-tab.tsx)). Iz detalja tekućeg
sastanka ne postoji nikakva prečica — a to je trenutak kad zapisnik s prošlog sastanka treba
(čita se na početku sastanka). Dodatno zbunjuje što tab „Arhiva" POSTOJI i unutar detalja
sastanka ([detalj-arhiva.tsx](../frontend/src/app/sastanci/_components/detalj-arhiva.tsx)), ali se
odnosi samo na TEKUĆI sastanak. I sve to je do S0 fixa bilo duplo slomljeno (PDF dugme = storage 404;
prošli sastanak možda uopšte nije u arhivi jer lock nije prošao).

**Plan:**
- **BE (mala dopuna):** `sastanakWeeklyDiff` ([sastanci.service.ts:433](../backend/src/modules/sastanci/sastanci.service.ts#L433))
  već pronalazi prethodni zaključani sastanak (`prev`) — u odgovor dodati `prethodniSastanakId`
  (+ `prethodniDatum`, `prethodniNaslov`) uz postojeća polja. Backward-kompatibilno. Spec test.
- **FE helper:** logiku `stampaj(r)` iz `arhiva-tab.tsx` (snapshot pun → direktno; 2.0 okrnjen
  snapshot → živi podaci + potpisane slike → `printZapisnik`) izvući u deljeni modul
  (npr. `_components/print-zapisnik.ts`, prima `qc` + sastanakId/arhiva red) — koristi je i arhiva
  tab i novo dugme.
- **FE dugme:** u headeru detalja sastanka ([sastanak-detalj.tsx:154](../frontend/src/app/sastanci/_components/sastanak-detalj.tsx#L154)),
  za status `planiran`/`u_toku`, sekundarno dugme **„Prethodni zapisnik"** (Printer ikona):
  štampa zapisnik prethodnog zaključanog sastanka (id iz weekly-diff odgovora). Nema prethodnog →
  dugme se ne renderuje. Uz štampu ponuditi i „Preuzmi PDF" (ista logika kao arhiva „PDF" dugme) —
  predlog: split-dugme ili dva mala dugmeta jedno uz drugo.
- **Pregled tab (opciono, ako stane u talas):** ista prečica uz karticu „Sledeći sastanak".

---

## S2 — „Nema mogućnosti promene redosleda akcija u zavisnosti od prioriteta"

**Trenutno:** akcije su grupisane po projektu/RN (⭐ prioritetni predmeti pa šifra —
[common.tsx groupAkcijeByRn](../frontend/src/app/sastanci/_components/common.tsx#L160)); unutar grupe
detalj sortira po `rb` (ručni redosled iz 1.0, ali 3.0 **nema UI** za menjanje rb), akcioni plan po
statusu. Prioritet akcije (1 Visok / 2 Srednji / 3 Nizak) je samo tačkica u boji — ne utiče na redosled.

**Plan (FE, bez BE izmena):**
- Sort unutar grupe: **prioritet ASC pa rb** (detalj) odnosno **status pa prioritet pa rb**
  (akcioni plan) — `groupAkcijeByRn` dobija `rowSort: 'prioritet'` varijantu; promena prioriteta u
  modalu (već postoji polje) sada stvarno reorderuje.
- Prioritet učiniti vidljivijim: umesto samo tačkice, `StatusBadge` tone danger/warn/neutral sa
  labelom na širim ekranima (kanonska mapa — DESIGN_SYSTEM §7).
- (Opciono kasnije, ako Zoran ipak traži RUČNI redosled: ↑/↓ strelice koje pišu `rb` — postoji u
  patch DTO-u. Ne raditi unapred.)
- **Svesna divergencija (review nalaz, 20.07):** ekran detalja sada ređa po prioritetu, a zvanični
  PDF / print zapisnika / arhiva i dalje po `rb` (1.0 paritet zvaničnog dokumenta). Da li i štampa
  treba da pređe na prioritet — pitanje za Zorana; do odluke ostaje rb.

---

## S3 — „Šta je funkcija polja Započni" (▷ dugme u redu akcije)

**Trenutno:** icon-only ▷ = `patch status: 'u_toku'`; ✓ = `zavrsen`
([detalj-akcije.tsx:76](../frontend/src/app/sastanci/_components/detalj-akcije.tsx#L76), isto u
akcioni-plan-tab). Samo `title` tooltip — korisniku nejasno.

**Plan (FE):** icon dugmad zameniti kompaktnim tekst-chip dugmadima **„Započni"** / **„Završi"**
(ikona + tekst, kao „Štampaj" u arhiva tabu). Posle klika status badge se odmah menja (uz S7
optimistic fix). Ako je akcija `u_toku`, „Započni" se ne prikazuje (sada se prikazuje uvek dok
nije završena — redundantno).

---

## S4 — Veći prozor za Opis akcije

**Trenutno:** [akcija-modal.tsx:83](../frontend/src/app/sastanci/_components/akcija-modal.tsx#L83)
`textarea rows={2}` — Zoranu se svaki put ručno razvlači.

**Plan (FE):** `rows={6}` + CSS auto-grow do max visine (field-sizing/auto-resize obrazac ako već
postoji u kitu; inače min-h + resize-y), i širi Dialog (proveriti `Dialog` kit size prop; ako nema —
dodati `size="lg"` varijantu u kit + `/dev/ui` katalog po pravilu §10). Važi za Nova i Izmena.

---

## S5 — „Kada kliknem na Nova akcija, nemam mogućnost unosa broja RN"

**Trenutno:** akcija u modelu IMA `projekat_id` (grupa = projekat/RN, `projekatCode` = broj) i
`useCreateAkcija` input već prima `projekatId` — ali [akcija-modal.tsx](../frontend/src/app/sastanci/_components/akcija-modal.tsx)
polje ne nudi, pa nova akcija uvek pada u „Bez RN / projekta". BE sastanci modul nema endpoint za
listu projekata (postoji samo `draftTeme(projektId)`).

**Plan:**
- **BE:** `GET /sastanci/projekti?q=` — lista aktivnih projekata iz sy15 (id, code, naziv;
  ILIKE po code/naziv, limit ~20; RLS read kroz `withUserMapped`). Spec test.
- **FE:** hook `useSastanciProjekti(q)` + combobox **„Projekat / RN"** u AkcijaModal (obrazac kao
  `DirectoryPicker`), opciono polje; šalje `projekatId` u create i u patch (izmena postojeće).

---

## S6 — „Uz svaki projekat mogućnost dodavanja zadatka, kao u prethodnoj verziji"

**Trenutno:** grupno zaglavlje (šifra + naziv + brojači) nema akciju — Zoranova strelica pokazuje
baš na prazno mesto u zaglavlju. U 1.0 je svaka projektna grupa imala „dodaj zadatak".

**Plan (FE, naslanja se na S5):** u zaglavlje grupe (detalj-akcije i akcioni-plan-tab, `canEdit`)
dodati dugme **„+ Zadatak"** → otvara AkcijaModal sa **prefilled projekatId** (i `sastanakId` u
kontekstu detalja). Globalno „+ Nova akcija" ostaje (sa S5 pickerom).

---

## S7 — „Check dugme Prisutan baguje, često ne odreaguje na klik"

**Uzrok (iz koda):** [detalj-priprema.tsx:94](../frontend/src/app/sastanci/_components/detalj-priprema.tsx#L94)
— kontrolisani checkbox (`checked={u.prisutan}`) čiji `onChange` samo pokreće mutaciju;
`useSastanciMutation` ([api/sastanci.ts:643](../frontend/src/api/sastanci.ts#L643)) invalidira keš
tek `onSuccess` → checkbox se vizuelno NE pomera dok mutacija + refetch `full` ne prođu (sekunda+ na
sporijoj vezi = utisak „nije reagovao"), brzi dupli klik šalje kontradiktorne patch-eve, a klik iz
fokusa textarea se trka sa `onBlur` mutacijom pripreme. Važi identično za sva tri checkbox-a
(Pozvan/Prisutan/Pripremljen).

**Plan (FE):** optimistički update u `useUpdateUcesnik`: `onMutate` → `setQueryData` na
`sastanakFullQueryKey(id)` (patch učesnika po email-u) + cancel queries, `onError` rollback na
snapshot, `onSettled` invalidate. Checkbox reaguje trenutno; server ostaje izvor istine.

---

## Podela za Opus agente (redosled)

| Talas | Šta | Gde | Napomena |
|---|---|---|---|
| **0 — ODMAH, infra** | S0 env fix + živa verifikacija (4 tačke) | `ubuntusrv`, backend.env | Ručno (Nenad) ili agent sa ssh; bez koda. **Blokira Zorana danas.** |
| **0b — docs** | S0 prateće: `.env.example`, REVERSI_PILOT_DEPLOY ispravka | backend | trivijalno, ide uz talas 1 commit |
| **1 — BE** | S1 `prethodniSastanakId` u weekly-diff; S5 `GET /sastanci/projekti` (+ spec testovi) | `backend/src/modules/sastanci/` | mali, nezavisni; BACKEND_RULES envelope/testovi |
| **2 — FE** | S7 optimistic (prvi — najveći dnevni bol); S1 helper+dugme; S2 sort+badge; S3 tekst dugmad; S4 modal; S5 picker; S6 „+ Zadatak" | `frontend/src/app/sastanci/` | poštovati frontend/CLAUDE.md (kit, tokeni, tastatura); S5/S6 zavise od talasa 1 |
| **3 — verifikacija** | `verify` na živom sastanku + e2e smoke ako postoji za sastanke | — | uklj. regresiju: zaključavanje, štampa, arhiva |

**Prioriteti:** S0 kritičan (prod kvar, širi od sastanaka) · S7 i S1 visoki (svakodnevni tok
sastanka) · S2–S6 srednji (UX dug iz porta 1.0→3.0).

**Napomena o paritetu:** S3/S5/S6 vraćaju 1.0 ponašanje koje je u portu izgubljeno — pri
implementaciji pogledati 1.0 `akcioniPlan.js`/`sastanakDetalj.js` u `servoteh-plan-montaze`
(read-only referenca) za tačnu semantiku.
