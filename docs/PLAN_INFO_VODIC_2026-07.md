# Plan: Info režim + Vođena tura (pilot na modulu Zahtevi)

| | |
|---|---|
| **Cilj** | Ugrađeni vodič za nove korisnike: objašnjenje svakog polja/akcije + tura korak-po-korak; pilot na Zahtevima, pa rollout svuda |
| **Presuđeno** | Nenad, 22.07.2026 (interaktivno, Fable): obim = **Info režim + Vođena tura** (slovne prečice = kasnija faza 2); aktivacija = **Shift+? i „?" dugme**; default = **auto novim korisnicima** (prvi ulazak u modul, gasi se jednim klikom i pamti); pamćenje = **localStorage** (pilot; BE preferenca pri rollout-u) |
| **Status** | Presuđeno → Opus izvođenje (grana `feat/info-vodic`) |

## 1. Arhitektura (generička od prvog dana — rollout je samo sadržaj)

**ui-kit (novo, po pravilu §10: komponenta + `/dev/ui` katalog + DESIGN_SYSTEM spisak):**

- `help-mode.tsx` — `HelpProvider` + `useHelpMode()`: drži `active`, `toggle()`,
  `moduleKey`; localStorage ključevi: `servosync.help.enabled` (globalni izbor
  korisnika) i `servosync.help.seen.<modul>` (auto-on samo prvi put po modulu).
  Tastatura: `Shift+?` toggle — IGNORIŠE se dok je fokus u input/textarea/
  contenteditable; `Esc` gasi. Provider se montira PO MODULU (wrap u page.tsx),
  ne globalno — pilot ne dira ostatak aplikacije.
- `help-spot.tsx` — `<HelpSpot id="zahtevi.novi.naslov">{children}</HelpSpot>`:
  kad je režim aktivan, renderuje malu „i" oznaku uz element (apsolutno
  pozicioniranu, ne pomera layout); klik/tap/hover/fokus otvara oblačić sa
  naslovom + opisom iz registra. Bez režima = čist passthrough (nula troška).
  A11y: `aria-describedby`, fokusabilna oznaka, Esc zatvara oblačić.
- `help-tour.tsx` — `HelpTour`: ručno pisana tura (BEZ novih zavisnosti):
  overlay + „prozor" (highlight) oko ciljnog elementa (getBoundingClientRect +
  scrollIntoView) + oblačić sa tekstom koraka + Nazad/Dalje/Preskoči +
  brojač koraka. Koraci ciljaju `HelpSpot` id-jeve. Responsive 360px
  (oblačić se lepi uz ivice, nikad van ekrana).
- Dugme „?" — u zaglavlju modula (uz PageHeader akcije): pali/gasi režim;
  u režimu nudi i „▶ Provedi me" (start ture). Na telefonu ovo je JEDINI ulaz
  (nema tastature) — zato dugme, ne samo prečica.

**Registar sadržaja po modulu:** `frontend/src/app/<modul>/_lib/help.ts` —
`export const HELP: Record<string, { title: string; text: string }>` + liste
koraka tura. Tekstovi srpski, pisani iz ugla korisnika (šta radi i ZAŠTO,
ne tehnički). Ključevi tipizirani (`keyof typeof HELP` gde je praktično).

## 2. Pilot — obim na Zahtevima

**HelpSpot pokrivenost (sve iz MODULE_SPEC_zahtevi semantike):**
- `/zahtevi/novi`: naslov, opis (+ šta radi diktat 🎤 i ✨ dotera), tip, modul,
  prioritet, očekivano/trenutno ponašanje, prilozi (šta sme, limiti), glasovna
  poruka (čuva se trajno + transkript), panel „Ovo možda već postoji",
  Sačuvaj nacrt vs Podnesi (šta se dešava posle: AI trijaža, ocena, nagrada).
- `/zahtevi` lista: kolone (broj, status, ocena ★, iznos), kartica „Moje
  nagrade", admin tabovi (Inbox brojači, Nagrade, Odluke, Arhiva).
- `/zahtevi/detalj`: statusna značka (šta znači svaki status — iz statusMeta),
  tabovi (Zahtev/AI analiza/Pitanja/Istorija), admin akcije (oba odobrenja,
  ocena/potvrda, vrati u obradu, spajanje), realizaciona polja.

**Ture (2, po ulozi):**
1. **Podnosilac** (svi): Novi zahtev — naslov → opis + diktat → slični panel →
   prilozi/glas → Podnesi → „šta sledi" (trijaža/ocena/nagrada/statusi).
2. **Admin** (vidljiva samo uz `zahtevi.admin`): Inbox → red sa AI ocenom →
   detalj: potvrda ocene → odobrenje analize → odluka → nagrade tab →
   zaključivanje meseca.

**Auto-on:** prvi ulazak u `/zahtevi*` (nema `servosync.help.seen.zahtevi`) →
režim se sam upali + nenametljiv baner „Novi ste ovde? ▶ Provedi me / ✕ Ugasi".
Bilo koje gašenje upisuje seen (+ enabled=false ako je korisnik eksplicitno
ugasio). Stari korisnici: ništa se ne menja dok ne pritisnu ? ili Shift+?.

## 3. Van obima pilota (svesno)
- Slovne prečice za akcije (faza 2, power-user).
- BE user-preferenca (rollout; localStorage se tada migrira).
- Ostali moduli (rollout = registar + HelpSpot omotači po modulu).
- AI-generisan sadržaj pomoći u runtime-u (tekstovi su statični, kurirani).

## 4. Kriterijum uspeha pilota
Novi korisnik bez ikakvog objašnjenja podnese ispravan zahtev sa prilogom
< 3 min; Nenad proceni da li info tekstovi „zvuče kao Servoteh" → GO za rollout
(sledeći kandidati: Pogon/Praćenje — najviše novih korisnika).

## 5. Ograničenja izvođenja
Bez novih zavisnosti; tokeni/kit komponente isključivo; responsive 360–1440;
režim NIKAD ne ometa unos (oznake ne kradu fokus, prečica mrtva u poljima);
`tsc` + `next build` zeleno; čisto frontend izmene (bez BE) — deploy: Cloudflare
auto + `workflow_dispatch` za LAN bake.
