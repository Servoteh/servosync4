# Gašenje 1.0 — analiza izvodljivosti (03.08.2026)

Zahtev Nenada: ukinuti 1.0, `/m` preusmeriti da bude isto što i `/mob`, ukinuti i
`plan-montaze` pages.dev link, pogledati šta ostaje u sy15 — **za sada deaktivirati,
ne brisati.**

Sve niže je **izmereno u kodu**, ne po sećanju.

---

## 1. Glavni nalaz: gašenje je mnogo lakše nego što izgleda

### 1.1 APK već gađa glavni domen, ne pages.dev

`servoteh-plan-montaze/capacitor.config.json`:

```json
"server": { "url": "https://servosync.servoteh.com/m" }
```

**Posledica:** čim `/m` prestane da vodi na 1.0 i počne da vodi na `/mob`, **postojeći APK
na telefonima radnika otvara 3.0 — bez reinstalacije, bez ijedne radnje sa njihove strane.**
Ne treba nov APK. Ikona, ime i prečica na telefonu ostaju iste.

Nativni Google-ov skener (`BarcodeScanner` plugin, `moduleAvailable`) je registrovan u samoj
APK ljusci i **dostupan je svakoj stranici koja se u njoj učita** — dakle i 3.0 stranicama.

### 1.2 1.0 nema svoj offline keš na glavnom domenu

Ovo je bio najveći zamišljeni rizik — „radnik ima keširanu 1.0 koju SW servira iz memorije,
pa neće ni primetiti da smo prebacili". **Ne stoji.**

1.0 je građena sa Workbox-om (`vite-plugin-pwa`) i pri svakom startu registruje `/sw.js`.
Ali na glavnom domenu `/sw.js` **nije 1.0-in fajl** — worker ga ne proksira, pa se servira
`frontend/public/sw.js` iz 3.0, koji namerno: obriše sve keševe, preuzme kontrolu i propušta
sve na mrežu (`fetch` bez presretanja). Znači 1.0 na glavnom domenu radi **isključivo online**,
bez zaglavljene kopije.

> ⚠️ Isti taj `/sw.js` je razlog jednog **postojećeg konflikta**: njegov `activate` briše
> **sve** keševe, pa i naš novi `ss3-mob-*` (PWA od 02.08). Radnik koji svrati na `/m` obriše
> sopstvenu 3.0 offline rezervu. Posle gašenja 1.0 ovaj skript se povlači i problem nestaje —
> to je još jedan argument da se ne odugovlači.

### 1.3 Rute se poklapaju — nema nepokrivenog ekrana

**Mobilne rute (1.0 ima 25, sve imaju parnjaka):**

| 1.0 | 3.0 | | 1.0 | 3.0 |
|---|---|---|---|---|
| `/m` | `/mob` | | `/m/odobravanja` | `/mob/odobravanja` |
| `/m/magacin` | `/mob` (magacinski raspored) | | `/m/odrzavanje` | `/mob/odrzavanje` |
| `/m/scan` | u skener ljusci | | `/m/odsustva` | `/mob/odsustva` |
| `/m/manual` | ručni unos u ljusci | | `/m/onboarding` | `/mob/onboarding` |
| `/m/lookup` | `/mob/lokacije/pretraga` | | `/m/pracenje` | `/mob/pracenje` |
| `/m/batch` | `/mob/lokacije/batch` | | `/m/profil` | `/mob/profil` |
| `/m/history` | `/mob/lokacije/istorija` | | `/m/proizvodnja` | `/mob/proizvodnja` |
| `/m/lokacije` | `/mob/lokacije` | | `/m/projektovanje` | `/mob/projektovanje` |
| `/m/ai` | `/mob/ai` | | `/m/reversi` | `/mob/reversi` |
| `/m/energetika` | `/mob/energetika` | | `/m/sastanci` | `/mob/sastanci` |
| `/m/izvestaj` | `/mob/izvestaj` | | `/m/sati` | `/mob/sati` |
| `/m/kadrovska` | `/mob/kadrovska` | | `/m/vise` | `/mob/vise` |
| `/m/montaza` | `/mob/montaza` | | `/m/za-mene` | `/mob/za-mene` |

3.0 povrh toga ima: `/mob/diktafon`, `/mob/neusaglasenosti`, `/mob/prisustvo`,
`/mob/moje-prisustvo`, `/mob/prijava`.

**Desktop moduli 1.0 → 3.0:** `plan-montaze`→`montaza`, `lokacije-delova`→`lokacije`,
`stampa-nalepnica`→`lokacije` (kartica Štampa), `reversi`, `energetika-scada`→`energetika`,
`proizvodnja`/`plan-proizvodnje`/`pracenje-proizvodnje`, `kadrovska`, `projektni-biro`→`pb`,
`sastanci`, `moj-profil`→`profil`, `ai`, `kiosk`, `podesavanja`, `maintenance/*`→`odrzavanje`.
**Nema modula bez parnjaka.**

### 1.4 Pola posla je već urađeno

3.0 static export **već sadrži 9 `/m/*` stranica** koje preusmeravaju na `/mob`
(`src/app/m/*/page.tsx` → `LegacyMobRedirect`): `ai`, `energetika`, `izvestaj`, `montaza`,
`odrzavanje`, `pracenje`, `prisustvo`, `proizvodnja`, `sastanci`. Danas su nevidljive jer ih
worker presreće pre nego što se do njih dođe (`run_worker_first: true`).

---

## 2. Šta ostaje u sy15 — gašenje 1.0 ≠ gašenje sy15

**sy15 baza OSTAJE ŽIVA i posle gašenja 1.0.** Nije rep 1.0 nego temelj 3.0:

- **161 fajl** u `backend/src` je koristi.
- Ima sopstvenu šemu `backend/prisma/sy15.prisma` (drugi datasource).
- Kroz nju idu kadrovska, odsustva, prisustvo, sastanci, lokacije, plate, onboarding —
  3.0 ih čita **uživo**, ne kopira.

Gašenje 1.0 znači samo da **prestaje drugi pisac** u tu bazu. To je čist dobitak: nestaje rizik
razilaženja (dva UI-ja nad istim redovima). **Ništa se u sy15 ne gasi niti briše.**

Ono što se gasi je **`servoteh-plan-montaze.pages.dev`** — Cloudflare Pages projekat, tj.
hosting stare aplikacije. To je ono što Nenad zove „dev link".

---

## 3. Preporučeni plan — tri koraka, svaki reverzibilan

### Korak 1 — prebacivanje (jedan radni dan, potpuno povratno)

1. Dopuniti `/m/*` stubove u 3.0 sa 9 na **svih 25**, sa **1:1 mapiranjem**: radnik sa
   obeleživačem na `/m/lokacije` završi na `/mob/lokacije`, a ne na početnoj.
2. U `worker/index.ts` isključiti proksiranje 1.0 (`/m`, `/m/*`, `/assets/*`, `/icons/*`,
   `/manifest.webmanifest`) — jednom promenljivom, ne brisanjem koda, da se vraća u minutu.
3. `frontend/public/sw.js` prestaje da bude „kapija za 1.0" i postaje čist sunset skript
   (uz oprez: **ne** vraćati staru `unregister + navigate` verziju dok proxy postoji — to je
   21.07. napravilo petlju reload-ova).
4. **pages.dev OSTAJE ŽIV** — netaknut, dostupan onome ko zna adresu. To je rezerva.

**Povratak ako nešto pukne:** vrati promenljivu u workeru → 1.0 se vraća za ~2 minuta,
koliko traje objava.

### Korak 2 — zaključavanje (nedelju dana kasnije, ako nema žalbi)

pages.dev se **ne briše** nego zaključava: Cloudflare Access ispred njega (samo Nenad/IT),
ili početna stranica „Aplikacija je preseljena → servosync.servoteh.com". Podaci i istorija
ostaju.

### Korak 3 — brisanje (najranije mesec dana kasnije, posebna odluka)

Tek tada Pages projekat i 1.0 repo idu u arhivu. **Ne predlažem da se sada planira datum.**

---

## 4. Rizici i šta se sa njima radi

| Rizik | Težina | Odgovor |
|---|---|---|
| **3.0 skener promaši na Samsungu** a 1.0 više nema | 🔴 visoka | **Proba pre prebacivanja** — 11 stavki iz preseka 03.08. Ovo je jedini pravi razlog da se sačeka. |
| Nativni skener u APK ljusci na 3.0 stranicama | srednja | Plugin je dostupan, ali **nije probano** da ga 3.0 zove. Proveriti u koraku 1 na jednom telefonu pre nego što se objavi svima. |
| Tablet na kapiji (`/kiosk`) | srednja | Utvrditi na koju adresu gađa. Ako gađa pages.dev direktno — mora se prebaciti pre koraka 2. |
| Push notifikacije 1.0 (`push-sw.js`) | niska | Utvrditi ko ih još prima; 3.0 ima svoj kanal. |
| Obeleživači na desktop 1.0 rute | niska | Isto 1:1 mapiranje kao za `/m`. |
| Navika ljudi | niska | `/mob` je namerno pravljen po rasporedu 1.0; magacinski krug ima svoj ekran. |

---

## 5. Šta preporučujem

**Ne prebacivati pre nego što se 3.0 skener isproba na Samsungu** — to je jedina stavka koja
u slučaju greške ostavlja pogon bez rezerve. Sve ostalo je pokriveno.

Sam prelaz je posle toga **posao od jednog dana**, i vraća se jednom promenljivom.
