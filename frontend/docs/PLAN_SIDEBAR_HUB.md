# Plan: Main page (hub) + sidebar v2 — „Harmonika"

> Odluka Nenad 17.07.2026: od tri ponuđena koncepta izabrana **Opcija 1 — Harmonika**
> (accordion domeni + auto-hide). **Dopuna istog dana: uključiti i Opciju 2 (rail +
> flyout) kao korisničko podešavanje** — rail je treće stanje istog sidebara, svaki
> korisnik bira svoj podrazumevani režim. Opcija 3 (globalna traka) se NE nudi kao
> lični izbor (druga paradigma celog ekrana = duplo održavanje); ostaje kandidat za
> 3.0 shell kao sistemska odluka.
> Analiza sa interaktivnim mockup-ima: https://claude.ai/code/artifact/63fb29ec-f43e-46cf-b273-274c388a5d60
>
> **VAŽNO za implementaciju:** raditi kroz SVEŽ worktree iz `origin/main` (lokalni
> checkoutovi su istorijski stari — poznata zamka). Stanje opisano ovde je čitano sa
> `origin/main` 17.07.2026.

## 1. Zašto

- Sidebar (`src/components/ui-kit/app-shell.tsx`) je **ravna lista: 10 domena / 31 modul**,
  fiksnih 208 px, uvek pun. U Kadrovskoj korisnik i dalje gleda svih 13 stavki Proizvodnje.
- **Nema sklanjanja** — Gantt ekrani (Plan montaže, Planiranje) i mali ekrani gube 208 px;
  DESIGN_SYSTEM §11 propisuje off-canvas < 1024 px, nije implementirano.
- **Nema početne strane** — `/` je redirect (`landingRoute`: kontrolori → `/kvalitet`,
  ostali → `/work-orders`). Novi korisnik nema pregled šta postoji.
- `Ctrl+K` propisan u DS §8, ne postoji. Zvonce + korisnik stisnuti u sidebar.
- Nav taksonomija duplirana: `NAV_SECTIONS` (app-shell) + `RAZVOJ_DOMAINS` (`/razvoj`).
- Stižu još ~3 krupna modula iz 1.0 → lista raste ka 40+ stavki.

## 2. Ciljno ponašanje

### Sidebar „Harmonika"
- Domeni su **accordion redovi** (ikona + naziv + chevron); klik otvara/zatvara.
- **Aktivni domen se otvara automatski** po ruti; ručna otvaranja/zatvaranja se pamte.
- Aktivni modul: postojeći stil (bg `sidebar-line` + leva `sidebar-accent` traka).
- **Tri stanja — korisnik bira svoj režim** (pamti se, važi svuda):
  - `full` (232 px): pun accordion — podrazumevano za nove korisnike;
  - `rail` (52 px): samo ikone domena; hover/klik na ikonu otvara **flyout panel** sa
    modulima tog domena (hover-intent ~250 ms, na touch: tap = otvori, drugi tap = izbor);
    pin u flyout headeru privremeno usidri panel;
  - `hidden`: sidebar van ekrana; **hover na levu ivicu (≤ 12 px) vraća ga kao overlay**
    (ne gura sadržaj); klik van / Esc / odlazak miša ga sklanja. Hamburger dugme u
    `PageHeader` (komandnoj traci) kao touch/vidljiva alternativa.
- Prebacivanje: dugme u vrhu sidebara (ciklus full → rail → hidden) + `Ctrl+B`
  (toggle poslednja dva korišćena stanja); izbor režima i kao stavka na hubu.
- **< 1024 px: uvek off-canvas** (DS §11) — isto overlay ponašanje, bez hover-ivice (touch).
- **`wide` rute** (Gantt: `/montaza?view=gantt|ukupan`, `/plan-proizvodnje`, po potrebi
  druge): pri ulasku auto-`hidden` uz pin „zadrži otvoren"; pri izlasku vraća prethodno stanje.
- RBAC nepromenjen: stavka vidljiva samo uz `can(requires)`; prazan domen se ne prikazuje.

### Hub početna
- Pločice = **domeni** iz nav modela (RBAC-filtrirane), svaka sa ikonom, brojem modula
  i 2–3 najčešća prečaca; hover lift kao 1.0 (`translateY(-2px)` + accent border).
- Header huba: brand, **Ctrl+K pretraga**, zvonce (seli se iz sidebara), korisnik + odjava.
- „Brzo" traka: personalizovane prečice (poslednje korišćeni moduli, localStorage).
- Bez emoji ikona (CURSOR_UI_USKLADJIVANJE §7) — lucide, isti set kao sidebar.

### Ctrl+K komandna paleta
- Fuzzy pretraga modula iz nav modela (label + domen + sinonimi); Enter = navigacija.
- Kasnije (van ovog plana): pretraga zapisa (broj RN, crtež…).

## 3. Faze

| Faza | Obim | Procena |
|---|---|---|
| **F0** | **Nav model + UI infra.** `src/lib/navigation.ts` — jedan izvor istine: `{ domain, label, href, icon, requires, wide? }`; iz njega se izvode sidebar, hub i `/razvoj` (ukida `RAZVOJ_DOMAINS` duplikat). `src/lib/use-ui-prefs.ts` — localStorage `servosync.ui.*` (SSR-safe za static export: čitanje u efektu, nikad pri renderu). | ~0.5 dan |
| **F1** | **Sidebar v2** u `app-shell.tsx`: accordion + **tri stanja `full/rail/hidden`** (korisničko podešavanje) + `Ctrl+B` + hover-ivica + off-canvas < 1024 px (hamburger u `PageHeader`) + `wide` auto-hide sa pinom. Rail: flyout sa hover-intent tajmerima, touch fallback (tap-tap), focus management. Tastatura: strelice po stavkama, Enter/Space toggle, Esc zatvara overlay/flyout. | 2.5–4 dana |
| **F2** | **Hub** (`/pocetna` ili `/` — vidi §5): pločice + „Brzo" + zvonce/korisnik u header. `landingRoute` odluka. | ~1 dan |
| **F3** | **Ctrl+K paleta** (nov ui-kit `command-palette.tsx`, bez novih zavisnosti — dialog + lista + fuzzy match ručno). | ~1 dan |
| **F4** | **Polish:** tooltips, fokus prsten, `prefers-reduced-motion`, provera 1366×768 / tablet / 360 px, **ažurirati DESIGN_SYSTEM.md §4** (novi obrasci shell-a — obavezno po §12). | ~0.5 dan |

Napomena: implementacija po ustaljenom modelu — paralelni opus agenti (Workflow), FE-only
deploy = `workflow_dispatch` backend deploy-a (paths filter ne okida na FE push).

## 4. Tehničke napomene

- **AppShell se montira per-page (19 uvoza)** — ostaje tako (static export, kiosk/login bez
  shella), ali sva logika stanja ide u zajedničke hook-ove da stranice ništa ne znaju.
- **Persistencija:** `servosync.ui.sidebar` = `'full' | 'rail' | 'hidden'`;
  `servosync.ui.openDomains` = string[]; `servosync.ui.recentModules` = string[] (za „Brzo").
  Po korisniku nije potrebno odvajati (jedan korisnik po browseru na radnim stanicama);
  ako zatreba — prefiks user id, a server-side sync preferenci (kolona na `users`) je
  kasnija opcija ako korisnici menjaju mašine.
- **Hover-ivica:** fiksni `div` širine ~12 px uz levu ivicu, samo kada je `hidden` i pointer
  fine (`@media (hover: hover)`); na touch samo hamburger.
- **LAN = http** (nije secure context): ne koristiti `crypto.randomUUID` u ovom kodu
  (poznata zamka) — nije ni potrebno.
- **1.0 iframe (`/tehnologija`):** ponašanje NE menjati dok se ne potvrdi §5.2 — 2.0 unutar
  1.0 shella i dalje prikazuje svoj sidebar kao danas.
- Ikonice domena: lucide, predlog — Proizvodnja `Factory`, Montaža `Hammer`, Projektovanje
  `PencilRuler`, Lično `CircleUser`, Logistika `Warehouse`, Oprema i energija `Wrench`,
  Kadrovska `IdCard`, Saradnja `CalendarClock`, Sistem `SlidersHorizontal`, Razvojna faza
  `FlaskConical` (uglavnom već u upotrebi na stavkama).

## 5. Otvorene odluke (potvrda Nenad pre F2)

1. **Landing:** hub za sve posle logina, ili zadržati rolno preusmerenje
   (kontrolori → `/kvalitet`, pogon pravo na svoj ekran) uz hub na klik na logo?
2. **1.0 iframe režim:** kada 2.0 radi unutar 1.0 huba, da li `embedded` flag krije
   hub/duple elemente?
3. **Zaključani moduli na hubu:** 1.0 prikazuje „Zaključano"; 2.0 danas krije nedostupno.
   Predlog: ostati na skrivanju (manje šuma).
4. **„Razvojna faza":** ostaje domen u sidebaru ili samo pločica na hubu (admin/menadžment)?

## 6. Buduće dogradnje (svesno van obima)

- **Globalna gornja traka** (Opcija 3): kandidat za 3.0 shell kada 2.0 hub preuzme ulogu
  1.0 HUB-a; tada zvonce/Ctrl+K/korisnik već žive u hub headeru pa je selidba u topbar mala.
  Svesno se NE nudi kao per-korisnik podešavanje (dve paradigme rasporeda = duplo
  testiranje svake nav izmene, različita uputstva/screenshotovi, dupli iframe režim) —
  ako dođe, dolazi kao sistemska promena za sve.
- Ctrl+K pretraga zapisa (RN, crteži) preko postojećih API-ja.
- Server-side sync UI preferenci (ako korisnici često menjaju radne stanice).
