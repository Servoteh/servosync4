# Plan: Podmeniji u navigaciji — treći nivo (domen → modul → pogled)

> Status: **PRESUĐENO 26.07.2026 — „sve po preporukama" (Nenad)**; presude u §6, ERP-dodaci
> u §7 (Fable analiza+plan+presuda, Opus izvršenje — F0 na grani `feat/nav-podmeni`).
> Nadovezuje se na [PLAN_SIDEBAR_HUB.md](PLAN_SIDEBAR_HUB.md) (sidebar v2 „Harmonika") i
> DESIGN_SYSTEM.md §4. Izvor navigacije ostaje `src/lib/navigation.ts` (`NAV_DOMAINS`,
> jedan izvor istine za sidebar + hub + Ctrl+K paletu).

## 1. Problem (Nenadova primedba, 26.07)

Klik na naslov domena (npr. **„Montaža i servis"**) danas otvori accordion sa **jednom
jedinom stavkom** („Plan montaže"), a svi stvarni ekrani — Plan, Gantt, Ukupan Gant,
Izveštaji, Neusaglašenosti — žive skriveni iza unutrašnjeg hub-a te strane. Očekivano
ponašanje: klik na „Montaža" → ispod se u meniju razgranaju **sve stavke** modula.

Isti obrazac se ponavlja skoro svuda: aplikacija ima ~50 nav stavki, a iza njih preko
**150 unutrašnjih ekrana** (tabova/pogleda) do kojih se dolazi tek posle ulaska u modul —
i koji većinom **nemaju ni URL** (interni `useState` → nema bookmarka, nema deep-linka,
Ctrl+K ih ne nalazi).

## 2. Snimak stanja

### 2.1 Model i render

- `NAV_DOMAINS` ima **dva nivoa**: domen → stavka (`NavModule`, list — bez dece).
  Postoji i imenovana pod-grupa (`NavSubGroup`, danas samo „Tehnologija" u „Proizvodnji"),
  ali je to samo vizuelni odeljak — stavka i dalje ne može imati podstavke.
- Sidebar (app-shell.tsx): accordion domena (layout A/C) ili statične sekcije (B); rail
  režim sa flyout-om; hub `/pocetna` i Ctrl+K paleta čitaju isti model.
- `matchesRoute`/`findDomainByPath`/`isNavModuleActive` porede **samo pathname** —
  href sa query stringom danas nije podržan u modelu.

### 2.2 Unutrašnja navigacija po modulu (popis 26.07)

Tip aktivacije: **state** = interni `useState`, URL se ne menja (nema deep-linka) ·
**?view=/?tab=** = query param (deep-link radi) · **podruta** = pravi `page.tsx`.

| Modul | Ulaz | Unutrašnje celine | Aktivacija |
|---|---|---|---|
| `/montaza` | **hub** („Izaberite prikaz") | Plan · Gantt · Ukupan Gant · Izveštaji · Neusaglašenosti | `?view=` ✅ |
| `/plan-proizvodnje` | radni | Po mašini · Po crtežu · Zauzetost mašina · Pregled svih · Kooperacija (+ 11 chip-odeljenja) | state |
| `/pracenje-proizvodnje` | radni | Kontrolna tabla · Aktivni predmeti · Pretraga delova (+ drill predmet/RN) | state + `#tab=`; drill `?predmet=/?rn=` ✅ |
| `/work-orders` | radni | — (master-detalj, `?open=` ✅) | — |
| `/tech-processes` | radni | Kucanja · Kritični · Učinak radnika · Gotovost RN | state |
| `/handovers` | radni | Na čekanju · Na pisanju · Odobrene · Sve | state |
| `/session-analytics` | radni | Dnevnik · Zbir vs normirano · Po satu · Loše evidentirani | state |
| `/structures` | radni | Radnici · Radne jedinice · Operacije · Vrste poslova · Radnici po mašinama | state |
| `/mrp` | radni | Potrebe · Zalihe | state |
| `/part-locations` | radni | Delovi na lokacijama · Pozicije/police | state |
| `/kvalitet` | radni | Evidencija škarta · Evidencija dorada · Izveštaji (8 pod-izbora) · Dokumenti · Kontrola pogon | state |
| `/pb` | radni | Plan · Kanban · Gantt · Izveštaji · Analiza · Saveti · Podešavanja (admin) | state |
| `/pdm` | radni | Crteži · Log uvoza | state |
| `/kadrovska` | **hub** (5 grupa) | 5 grupa → 13 tabova → i treći nivo podtabova | state |
| `/odrzavanje` | radni | **16 tabova** (Pregled…Notifikacije) + kartoni (podrute masine/vozila/sredstva) | `?tab=` ✅ (mount-only) |
| `/sastanci` | radni | Pregled · Sastanci · Moj rad · Akcioni plan + **6 admin tabova iza ⚙** | `?tab=` ✅ (mount-only) + `?open=` |
| `/lokacije` | radni (tab „Početna" = de-facto hub) | 9 tabova (permisijski) | state |
| `/reversi` | radni | 7 tabova + 2 nivoa podtabova | state |
| `/energetika` | radni | Pregled · 3× Kotlarnica · 2× FNE · Komande | state |
| `/glavna-knjiga` | radni | Dnevnik · Kartica konta (+ podruta `[id]`) | state |
| `/saldakonti` | radni | Otvorene stavke · Aging · Kompenzacije; podrute: kursne-razlike (u nav), **kartica (NIJE u nav!)** | state |
| `/pdv` | radni | KIF · KUF · POPDV · KEPU (+ podruta stope, u nav) | state |
| `/izvodi` | radni | — (podrute `[id]`, kursna-lista u nav) | — |
| `/fakturisanje` | radni | — (podrute `[id]`, avansi u nav) | — |
| `/robno` | radni | paneli Kartica artikla · Lager (podrute popis/rezervacije u nav) | — |
| `/placanja` | radni | panel Nalozi za plaćanje | — |
| `/nabavka` | radni | 3 celine na jednoj strani: Zahtevi · Upiti (RFQ) · Narudžbenice | — (skrol) |
| `/sef` | radni | Izlazne · Ulazne fakture | state |
| `/kamata` | radni | Obračun · Kamatne stope | state |
| `/zavrsni-racun` | radni | Bruto bilans · Bilans stanja · Bilans uspeha | state |
| `/naplata`, `/blagajna`, `/customers`, `/projects`, `/syncs`, `/nacrti`, `/cnc-programs`, `/completed-orders`, `/production-log`, `/operations-queue`, `/ai`, `/kiosk` | radni | — | — |
| `/podesavanja` | radni | **14 tabova** (per-permisija; „Izgled" jedini za sve) | `?tab=` ✅ |
| `/zahtevi` | **dva ekrana po roli** | ne-admin: samo „Moji zahtevi"; admin: Inbox · Svi · Nagrade · Odluke · Arhiva | state |
| `/profil` | radni | 18 akordeon sekcija (nisu rute) | state |

## 3. Analiza po meniju (domenu) + predlog

Kriterijum: **podmeni dobija modul sa ≥5 unutrašnjih celina, hub-ulazom ili teško
dostupnim (admin) tabovima**. Moduli sa 2–4 taba zadržavaju tab-traku (podmeni bi bio šum).

### 3.1 Proizvodnja
- **Danas:** 2 direktne stavke + pod-grupa „Tehnologija" (11 stavki) — grupisanje već dobro.
- **Problem:** „Planiranje" krije 5 pogleda; „Strukture" 5 tabova; ostalo je 2–4 taba.
- **Predlog:** podmeni za **Planiranje** (Po mašini · Po crtežu · Zauzetost mašina ·
  Pregled svih · Kooperacija — traži uvođenje `?tab=`; napomena: ruta je `wide`, sidebar
  se auto-sklanja — podmeni koristi rail flyout/pin) i **Proizvodne strukture** (5 tabova).
  Praćenje (3), Realizacija (4), Primopredaje (4), Analitika (4), MRP (2) — ostaju bez.

### 3.2 Kontrola kvaliteta
- **Danas:** 1 stavka + spoljašnji kiosk link.
- **Predlog:** podmeni za **Kontrolu kvaliteta**: Evidencija škarta · Evidencija dorada ·
  Izveštaji · Dokumenti · Kontrola pogon (traži `?tab=`). Kiosk ostaje kako jeste.

### 3.3 Projektovanje
- **Predlog:** podmeni za **Projektni biro**: Plan · Kanban · Gantt · Izveštaji · Analiza ·
  Saveti (+ Podešavanja samo admin) — traži `?tab=`. PDM (2 taba) i Nacrti bez izmene.

### 3.4 Montaža i servis ⭐ (Nenadov primer)
- **Danas:** jedina stavka „Plan montaže" → unutrašnji hub sa karticama.
- **Predlog:** domen dobija **5 direktnih stavki** (drugi nivo, bez trećeg — jedini modul):
  **Plan** (`/montaza?view=plan`) · **Gantt** (`?view=gantt`) · **Ukupan Gant**
  (`?view=total`) · **Izveštaji montera** (`?view=izvestaji`) · **Neusaglašenosti**
  (`?view=neusaglasenosti`). Deep-link **već radi** — nula izmena u strani (osim
  write-back-a, §4.4). Unutrašnji hub ekran ostaje (tablet/touch ulaz), ništa ne smeta.

### 3.5 Logistika
- **Predlog:** podmeni za **Lokacije** (9 tabova; traži `?tab=`) i **Reverse**
  (7 tabova; traži `?tab=`). „Lokacije delova" (2 taba, crosslisted) bez izmene.

### 3.6 Oprema i energija
- **PRESUĐENO (§6.2):** podmeni za **Održavanje** = kurirani podskup **8 stavki**
  (Pregled · Tabla · Radni nalozi · Kvarovi · Mašine · Preventiva · Zalihe · Izveštaji);
  ostalih 8 tabova ostaje samo tab-traka u strani + Ctrl+K indeks (`?tab=` već radi;
  postojeći permisijski gate-ovi). Kartoni (mašina/vozilo/sredstvo) su detalj-rute — ne idu
  u meni. **Energetika** (7 tabova, samo admin+menadžment) — kandidat u F3 (traži `?tab=`).

### 3.7 Kadrovska
- **Danas:** hub sa 5 velikih grupa → 13 tabova → još podtabova (dvo-tro nivovska IA).
- **Predlog:** podmeni = **5 grupa** (Pregled · Odmori i odsustva · Radni sati · Zaposleni ·
  Zarade), deep-link `?grupa=` (uvesti). 13 tabova bi bilo previše — grupa odgovara mentalnom
  modelu koji hub već koristi. „Moj profil" (18 akordeon sekcija) bez podmenija.

### 3.8 Saradnja
- **Predlog:** podmeni za **Sastanke**: Pregled · Sastanci · Moj rad · Akcioni plan +
  admin stavke (PM teme · Po projektu · Draft teme · Šabloni · Arhiva · Podešavanja) uz
  permisijski gate — `?tab=` **već radi** (sa 1.0 alias-ima). Ovo rešava i najskrivenije
  ekrane u aplikaciji (admin tabovi iza ⚙ dropdown-a). AI bez izmene.

> **PRESUĐENO/IZVEDENO 26.07.2026 (F1 nalaz 1) — gate ⚙ sekcija = `sastanci.edit`.**
> F1 je decu isporučio BEZ gate-a jer ga ni strana nije imala (⚙ meni je prikazivao svih 6
> ekrana svakome sa `sastanci.read` — paritet 1.0, koje ih takođe ne gejtuje). Izabrana je
> POSTOJEĆA permisija **`sastanci.edit`** = 1.0 `canEdit()` / `has_edit_role` krug (admin,
> menadzment, pm, leadpm, hr, poslovni_admin) — jedini krug koji sme da mutira ono što ti
> ekrani nude; backend to već drži (`@RequirePermission(SASTANCI_EDIT)` na templates CRUD,
> teme, `draft-review`/`uvedi`, `admin-rang`, `dodeli`; `manage` i `ai_model` su još uže).
> Gate je primenjen na TRI mesta iz jednog izvora (`ADMIN_ITEMS` u `sastanci/page.tsx`,
> ogledalo u `navigation.ts`): (a) ⚙ dropdown prikazuje samo dozvoljene stavke i **nestaje**
> kad ih nema; (b) deep-link `?tab=sabloni` bez prava = **tihi redirect** na „Pregled"
> (`setTab` → `replaceState`, bez poruke — obrazac iz `podesavanja/page.tsx`); (c) 5 admin
> dece u nav modelu nosi `requires`. Uz to prečice sa „Pregleda" ka „PM temama" (KPI pločica
> i „Moje teme → Sve") prate isti gate, da ih guard ne bi nemo vraćao.
> **IZUZETAK — „Podešavanja" ostaje bez gate-a:** to nisu admin podešavanja nego LIČNA
> podešavanja mejl-obaveštenja (`PATCH /sastanci/prefs` je self-service, gejtovan samo
> `sastanci.read` uz RLS po email claim-u; paritet 1.0 `podesavanjaNotifikacijaTab`). Gate na
> `edit` bi učesniku bez edit prava oduzeo kontrolu nad SOPSTVENIM mejlovima, a drugog ulaza
> nema. AI model unutar taba već ima svoj `Can` (`sastanci.ai_model`). Ostaje otvoreno da li
> taj tab treba izvaditi iz ⚙ „Admin sekcija" u glavnu tab-traku (kozmetika, F3).
> **Backend NIJE diran** — mutacije su već pokrivene; `GET` rute (teme/templates/arhive/
> draft) namerno stoje na `sastanci.read` uz row-scope RLS, pa je ovo čisto skrivanje
> afordansi (uloga bez `edit` i dalje SME da pročita te podatke ako pogodi API).

### 3.9 Prodaja i nabavka
- **Danas:** 7 stavki ravno (fakturisanje ×3 + robno ×3 + nabavka) — već „razliveno".
- **Predlog (kozmetika, postojeći model):** dve pod-grupe (`NavSubGroup`):
  **„Fakturisanje"** (Predračuni & računi · Avansni računi · e-Fakture SEF) i
  **„Magacin"** (Zalihe & kalkulacija · Popis/inventura · Rezervacije zaliha); Nabavka
  ostaje direktna stavka. Bez novih ruta. Nabavka (3 celine na skrol) — kandidat za
  tabove + podmeni u F3.

### 3.10 Finansije (najpretrpaniji meni — 12 stavki ravno)
- **Problem:** stavke koje su logički **deca** stoje ravnopravno: „Kursne razlike" (deo
  Saldakonta), „Poreske stope" (deo PDV-a), „Kursna lista" (deo Izvoda). Plus skrivena
  ruta **`/saldakonti/kartica` (Kartica komitenta) nije nigde u meniju**.
- **Predlog:** pregrupisanje kroz podmenije:
  - **Saldakonti** → Otvorene stavke · Aging · Kompenzacije (traži `?tab=`) ·
    Kartica komitenta (ruta, **dodati u nav**) · Kursne razlike (ruta, seli se pod modul);
  - **PDV & POPDV** → KIF · KUF · POPDV · KEPU (traži `?tab=`) · Poreske stope (ruta, seli se);
  - **Izvodi** → Kursna lista (ruta, seli se pod modul);
  - Glavna knjiga (2), SEF (2), Kamata (2), Završni račun (3), Blagajna, Naplata,
    Banka & plaćanja — bez podmenija.
  - Meni pada sa 12 na **8 stavki prvog reda** — preglednije, ništa se ne gubi.
  - ⚠️ Menja mišićnu memoriju (3 stavke silaze nivo niže) — traži izričitu potvrdu.

### 3.11 Sistem
- **Predlog:** podmeni za **Podešavanja** — 14 tabova, `?tab=` **već radi**; svaka stavka
  nosi svoju permisiju (mirror gating-a iz strane; običan korisnik vidi samo „Izgled").
  **Zahtevi**: admin podmeni (Inbox · Svi · Nagrade · Odluke · Arhiva) samo uz admin gate;
  ne-admin bez podmenija (vidi samo „Moji zahtevi") — F3, traži čist permisijski uslov.
  Komitenti/Predmeti/Sinhronizacije bez izmene.

> **PRESUĐENO/IZVEDENO 26.07.2026 (F1 nalaz 2) — Podešavanja vidi SVAKI prijavljen korisnik.**
> F1 je modul ostavio na `settings.org_profile`, pa običan korisnik nije video ni „Izgled"
> (ulaz mu je bio samo deep-link iz „Moj profil") — protivno presudi „vidi samo Izgled".
> Rešenje: modul dobija **`requiresAny`** = unija `requires` vrednosti svojih 14 dece
> (`settings.users`, `settings.org_profile`, `settings.predmet_aktivacija`, `settings.system`,
> `settings.audit`, `profile.self`), a `requires: settings.org_profile` ostaje konzervativni
> fallback (isti obrazac kao pogonski `/kiosk`). Ishod: admin/menadzment/pm/leadpm vide punu
> konzolu kao i dosad; svaka druga uloga vidi modul sa **jedinim detetom „Izgled"**
> (`profile.self` dobija SVAKA uloga u `role-permissions.ts`); nalog bez ijedne od tih
> permisija ne vidi ništa.
> **Zašto `requiresAny`, a ne izvedeno „vidljiv ako je vidljivo bar jedno dete":** `children`
> mešaju dve semantike — dete BEZ `requires` znači „nasledi roditelja" (`visibleNavChildren`
> ga propušta bezuslovno), pa bi izvedeno pravilo otvorilo Sastanke i Održavanje (čija su deca
> uglavnom bez `requires`) SVIMA. `requiresAny` je uz to već postojao u modelu i već ga
> poštuje `canAccessNavModule` — jedan izvor istine za sidebar (3 layouta + rail flyout),
> hub `/pocetna`, Ctrl+K paletu i „Omiljeno" (`resolveFavoriteModules`); nula izmena kod
> potrošača. `moduleOptions()` u Zahtevima NE filtrira po permisiji (namerno — spisak modula
> za prijavu greške), pa je i tamo bez posledica.
> **Href modula ostaje `/podesavanja`**, a klik korisnika bez prava na podrazumevani tab
> („Korisnici") strana **tiho koriguje** na prvi dostupan tab — guard efekat iz F1 (`useEffect`
> nad `visibleTabs` u `podesavanja/page.tsx`) je proveren i radi bez izmene; „Izgled" je za
> takvog korisnika jedini vidljiv tab, pa se tab-traka svede na njega.
> Jedina dopuna u strani: čekanje na **`permissionsPending`** (`/auth/me` i
> `/auth/me/permissions` su dva paralelna upita, `isLoading` ne pokriva drugi) — dok dozvole
> stižu `visibleTabs` je prazan, pa je do sada bljeskala poruka „nemate pristup"; to je od sad
> ulaz koji koristi SVAKI korisnik. Sama poruka je prevedena u fail-closed formulaciju
> („Nemate pristup nijednom odeljku Podešavanja."), jer nabrajanje rola više nije tačno.

### 3.12 Šta svesno NE dobija podmeni
`/pdm`, `/mrp`, `/part-locations`, `/glavna-knjiga`, `/sef`, `/kamata`, `/handovers`,
`/tech-processes`, `/session-analytics`, `/pracenje-proizvodnje` (2–4 taba — tab-traka
dovoljna); `/fakturisanje`, `/izvodi`, `/placanja`, `/robno`, `/work-orders`, `/naplata`,
`/blagajna`, `/customers`, `/projects`, `/syncs`, `/ai`, `/nacrti`, `/kiosk`, `/profil`
(nemaju unutrašnju navigaciju rutabilnog tipa).

## 4. Tehnički predlog

### 4.1 Model (`navigation.ts`)
```ts
export interface NavSubItem {
  label: string;
  href: string;              // sme da nosi query: '/montaza?view=gantt', '/odrzavanje?tab=kvarovi'
  requires?: Permission;     // finiji gate od roditelja (admin tabovi); default = roditeljev
  keywords?: string[];       // Ctrl+K
}
export interface NavModule {
  // ...postojeće...
  children?: NavSubItem[];   // treći nivo — pogledi/tabovi modula
}
```
- Helperi postaju **query-aware**: matching razdvaja pathname i query (`hrefPath(href)`);
  `matchesRoute`/`findDomainByPath`/`isWideRoute`/`findModuleByPath` porede pathname deo.
  Aktivna podstavka: pathname jednak + svi query parovi iz `href` prisutni u tekućem URL-u.
- **Montaža izuzetak:** pogledi idu kao direktne stavke domena (drugi nivo) sa query
  href-ovima — ista query-aware mašinerija, bez trećeg nivoa.

### 4.2 Sidebar render (app-shell)
- `SidebarModuleRow` sa `children`: chevron; **auto-razgranat kad je modul aktivan** (kao
  domen accordion), ručno stanje po modulu persistovano u `useUiPrefs` (`openModules`,
  paritet sa `openDomains` — AppShell se montira per-page, lokalni state ne preživljava).
- Podstavke uvučene, manje, leva linija (vizuelni jezik `SidebarSubGroup`).
- **a11y — jedan `aria-current`:** kad je podstavka aktivna, ONA nosi `aria-current="page"`,
  roditelj samo stil (proširenje pravila iz ODLUKE #33 za crosslisted).
- **Rail flyout:** podstavke ugnježdene u flyout panelu domena.
- **Hub `/pocetna`:** v1 bez izmene (pločice ostaju na nivou modula — podmeni bi udvostručio
  visinu pločica; može u F3 kao „○ pogledi" red ako zatreba).
- **Ctrl+K paleta:** indeksira i podstavke („Održavanje: Kvarovi", „Montaža: Gantt") —
  najveći dobitak pretrage; dedup po punom href-u.
- **Omiljeno/MRU:** v1 ostaju na nivou modula (`pushRecentModule` i dalje dobija roditeljev
  href); širenje na podstavke u F3 (`resolveFavoriteModules` + `findModuleByHref` kroz decu).

### 4.3 ⚠️ Ključna zamka: navigacija na isti pathname sa drugim query-jem
Next App Router **ne remount-uje** stranicu kad se menja samo query (`/odrzavanje?tab=kvarovi`
→ `?tab=masine`), a round-1 strane čitaju `?tab=` **samo na mount-u**. Bez rešenja, klik na
podstavku dok si VEĆ u modulu ne bi uradio ništa.
- **Rešenje — zajednički hook `useQueryTab(key, defaultKey)`** (static-export bezbedan,
  `window.location` obrazac koji repo već koristi, bez `useSearchParams`/Suspense):
  1. čita param na mount + sluša `popstate` **i** custom event `servosync:nav`;
  2. shell-ov `onNavigate` posle `router.push` dispatch-uje `servosync:nav`;
  3. `setTab` iz strane radi `history.replaceState` (URL prati klik u strani → sidebar
     highlight ostaje tačan) + dispatch istog eventa.
- Time svaka strana dobija dvosmernu sinhronizaciju: sidebar → strana i strana → sidebar.

### 4.4 Izmene po stranama
- **Round 1 (deep-link postoji):** `/montaza` (samo write-back već ima ✅), `/podesavanja`,
  `/odrzavanje`, `/sastanci` — prevesti mount-only čitanje na `useQueryTab`.
- **Round 2 (uvesti `?tab=`/`?grupa=` kroz isti hook):** `/kadrovska` (grupe), `/lokacije`,
  `/reversi`, `/pb`, `/kvalitet`, `/pdv`, `/saldakonti`, `/plan-proizvodnje`, `/structures`.
- Ključevi tabova = stabilni slugovi (postojeći interni ključevi; za sastanke zadržati
  1.0 alias mapu).

## 5. Faze za Opus

- **F0 — model + shell** (bez izmena strana): `NavSubItem`/`children`, query-aware helperi,
  `openModules` u useUiPrefs, render u sva 3 layouta + rail flyout, paleta indeksira decu
  (uklj. T-kod šifre u `keywords`, §7), jedan-`aria-current` pravilo. Montaža konvertovana
  (5 stavki, `?view=` već radi).
  Acceptance: klik „Montaža" → 5 stavki; klik svake vodi na tačan pogled; postojeći e2e zeleni.
  **IZVEDENO 26.07.2026** (grana `feat/nav-podmeni`): `NavSubItem`/`children`, `hrefPath` +
  `hrefQueryMatches` + `isNavSubItemActive` + `isNavModuleRouteCurrent` + `visibleNavChildren`,
  `openModules` u `useUiPrefs`, render podstavki u sva 3 layouta + rail flyout (jedan
  `aria-current`), paleta indeksira decu (format „Modul: Podstavka", dedup po punom href-u),
  Montaža = 5 stavki sa T-kodovima `MNT-P/G/UG/IZ/N`. Query tekuće rute čita se iz
  `window.location.search` (`useCurrentSearch` u app-shell-u; osvežava se na promenu rute,
  `popstate` i custom event `servosync:nav` — emitera dobija tek F1).
  ⚠️ **Ostaje za F1:** klik na podstavku dok si VEĆ u tom modulu ne menja pogled (zamka §4.3 —
  strana čita `?view=`/`?tab=` samo na mount-u); dok F1 ne uvede `useQueryTab` + write-back,
  podmeni radi iz drugog modula, sa huba i iz Ctrl+K palete.
- **F1 — round 1 strane:** `useQueryTab` hook; `/podesavanja` (14, per-permisija),
  `/odrzavanje` (8 kuriranih, §3.6), `/sastanci` (4+6 admin gate) + write-back u sve četiri
  (uklj. montažu); „razgranaj sve / skupi sve" u dnu sidebara (§6.1); e2e smoke dopuna
  (podmeni klik → tab aktivan; tab klik → URL/highlight prati).
  **IZVEDENO 26.07.2026** (grana `feat/nav-podmeni-f1`): `useQueryTab(key, defaultKey, {valid,
  alias, omitDefault})` u `src/lib/use-query-tab.ts` + `emitNavEvent()`; emiter u shell-ovom
  `onNavigate` (cilj kao `detail.href`, jer `onClick` prethodi promeni URL-a) i u Ctrl+K paleti;
  `useCurrentSearch` čita detalj samo za ISTI pathname (bez duplih reakcija). Konvertovane 4
  strane sa write-back-om (montaža `?view=` uz `omitDefault` — hub ostaje bez parametra;
  sastanci uz očuvanu 1.0 alias mapu, a `?tab=` se sad čuva i pri otvaranju/zatvaranju detalja).
  Deca: Podešavanja 14 (svako sa svojom permisijom, ogledalo `TAB_DEFS`), Održavanje kuriranih
  8, Sastanci 4+6; T-kodovi `POD-*`/`ODR-*`/`SAS-*`. „Razgranaj sve / Skupi sve" u dnu punog
  sidebara (persist kroz `openDomains`/`openModules`). E2E `tests/nav-podmeni.spec.ts` (projekat
  `nav`) — NIJE izvršen (paket cilja PROD, gde F1 još nije deploy-ovan).
  ⚠️ **Zapažanja za F2/F3:** ~~(a) ⚙ meni sastanaka u strani NEMA permisijski gate~~ i
  ~~(b) modul „Podešavanja" stoji na `settings.org_profile`, pa običan korisnik ne vidi ni
  „Izgled"~~ — **oba REŠENA 26.07.2026** (nalazi 1 i 2; presude uz §3.8 i §3.11: ⚙ sekcije na
  `sastanci.edit` uz tihi guard-redirect, Podešavanja na `requiresAny`);
  (c) ostalih 8 tabova Održavanja Ctrl+K nalazi samo kroz roditeljeve `keywords` (sleće na
  modul, ne na tačan tab) — skok na tab traži da postanu deca ili novu mašineriju; (d) URL se
  NE normalizuje na mount-u, pa go `/odrzavanje` (bez `?tab=`) pali highlight roditelja, ne
  podstavke „Pregled".
- **F2 — round 2 strane + Finansije pregrupisanje:** `?tab=` u 9 strana (§4.4);
  deca za kvalitet/pb/lokacije/reversi/kadrovsku(grupe)/saldakonti/pdv/planiranje/strukture;
  „Kartica komitenta" u nav; Kursne razlike/Poreske stope/Kursna lista postaju deca
  (uz potvrdu §6.3); pod-grupe „Fakturisanje"/„Magacin" u Prodaji.
- **F3 — polish (opciono):** omiljeno/MRU za podstavke; hub pločice sa pogledima; zahtevi
  admin podmeni; energetika; nabavka tabovi+podmeni; `/pracenje-proizvodnje` hash→query;
  popuna T-kodova za sve module + štampani cheat-sheet (§7); preispitivanje montažnog
  hub-a po telemetriji (§6.6).

Svaka faza = zaseban PR na svežu granu sa `main`; F0/F1 su nezavisno isporučivi.

## 6. Odluke — PRESUĐENO 26.07.2026 („sve po preporukama", Nenad)

Reper za presude: kako navigaciju rešavaju SAP (Easy Access/Fiori), Pantheon i
Navision/Business Central — stablo skupljeno po default-u, širi se na zahtev; pretraga/šifra
brža od klika; rola određuje šta vidiš; meni nosi procese, forma nosi tabove.

1. ✅ **Auto-razgranat** aktivni modul + ručni chevron, stanje persistovano (SAP stablo);
   F1 dodaje „razgranaj sve / skupi sve" u dnu sidebara.
2. ✅ **Održavanje: kuriranih 8** (Pregled · Tabla · Radni nalozi · Kvarovi · Mašine ·
   Preventiva · Zalihe · Izveštaji); ostalih 8 samo tab-traka + Ctrl+K („Tell me" obrazac).
3. ✅ **Finansije pregrupisanje DA** (12 → 8; SAP FI struktura). Amortizeri navike: Ctrl+K
   nalazi i po starom imenu (`keywords`), Omiljeno/MRU, stavke se sele — ne nestaju.
4. ✅ **Kadrovska: 5 grupa** (`?grupa=`), ne 13 tabova (Role Center logika).
5. ✅ **Prag potvrđen** (2–4 taba bez podmenija) — ALI i ti moduli dobijaju `?tab=` u
   round 2, da Ctrl+K i AI deep-link rade i bez stavke u meniju.
6. ✅ **Montažin hub ostaje** kao touch/tablet ulaz (Fiori launchpad uz GUI meni koegzistira);
   preispitati u F3 po telemetriji korišćenja.

## 7. ERP-dodaci povrh plana (presuđeni uz §6)

- **„T-kodovi" za ServoSync:** svaki ekran/pogled dobija kratku šifru u `keywords`
  (`MNT-G` Montaža Gantt · `ODR-KV` Kvarovi · `SLD-OS` Otvorene stavke…) — kucanje šifre
  u Ctrl+K vodi direktno na ekran (analog SAP transakcionog koda). Šifre ulaze u
  `navigation.ts` od F0 za decu koja tada nastaju; popuna svih modula + cheat-sheet u F3.
- **AI navigacija:** AI widget već ima `screenContext`; čim tab ima URL, AI može da odgovori
  klikabilnim linkom pravo na tab (a kasnije i da vodi korisnika kroz proces) — glavni
  razlog da se round 2 (`?tab=` svuda) ne odlaže.
