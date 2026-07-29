// Navigacioni model — JEDAN izvor istine za sidebar, hub i Ctrl+K paletu (F0 SIDEBAR_HUB).
// Reorg 18.07.2026 (Nenad, SIDEBAR_THEME_SPEC §1): domeni dobijaju POD-GRUPE.
// „Tehnologija" je imenovana pod-grupa unutar „Proizvodnje"; „Kontrola kvaliteta" je
// svoj domen (+ diskretan spoljašnji link ka pogonskom /kiosk-u); Reversi je prešao u
// „Logistiku"; PDM/Nacrti su u „Projektovanju", a „Primopredaje" u „Proizvodnji/
// Tehnologiji" (UX 008/26); „Lokacije delova" je
// UNAKRSNO navedena (crosslisted) na dva mesta — Tehnologija (praćenje kroz
// proizvodnju) i Logistika (fizičko skladištenje). RUTE I PERMISIJE su NETAKNUTE u
// odnosu na prethodni model — menja se samo grupisanje/redosled i vizuelni raspored.
//
// PODMENIJI F0 (26.07.2026, PLAN_NAV_PODMENIJI §4.1): modul sme da ima `children`
// (`NavSubItem` — pogledi/tabovi), a href SME da nosi query (`/montaza?view=gantt`).
// Zato su svi helperi QUERY-AWARE: rute se porede po `hrefPath(href)`, a query zasebno
// (`hrefQueryMatches`) — `usePathname()` nikad ne nosi query.

import {
  AlertTriangle,
  Bot,
  Briefcase,
  Building2,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  CircleUser,
  ClipboardList,
  Clock,
  Cog,
  Cpu,
  DraftingCompass,
  Factory,
  FolderKanban,
  GanttChartSquare,
  Hammer,
  IdCard,
  Layers,
  Lightbulb,
  ListChecks,
  ListOrdered,
  MapPin,
  Package,
  PackageCheck,
  PencilRuler,
  Radar,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Table2,
  Users,
  Warehouse,
  Workflow,
  Wrench,
  Zap,
  FileText,
  type LucideIcon,
  Wallet,
  Percent,
} from 'lucide-react';
import { PERMISSIONS, type Permission } from '@/lib/permissions';

/**
 * Podstavka modula — treći nivo navigacije (pogled/tab unutar modula), PLAN_NAV_PODMENIJI §4.1.
 * `href` sme da nosi query (`/montaza?view=gantt`, `/odrzavanje?tab=kvarovi`) — sva poređenja
 * ruta rade nad pathname delom (`hrefPath`), a aktivnost dodatno traži da svi query parovi iz
 * href-a postoje u tekućem URL-u (`hrefQueryMatches`).
 */
export interface NavSubItem {
  label: string;
  href: string;
  /** Finiji gate od roditelja (admin tabovi). Bez njega važi roditeljev `requires`. */
  requires?: Permission;
  /** Dodatne reči za Ctrl+K (sinonimi + „T-kod" šifra ekrana, npr. `MNT-G`; §7 plana). */
  keywords?: string[];
}

export interface NavModule {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Modul je vidljiv u nav-u samo ako uloga ima ovu permisiju (AUTHZ_UNIFIED §8 Faza 2b). */
  requires?: Permission;
  /**
   * Vidljiv ako uloga ima BILO KOJU od ovih permisija (OR). Ima prednost nad
   * `requires` kad je zadat (koristi ga `canAccessNavModule`). Dva slučaja:
   *  • stavka pripada ukrštenim krugovima — npr. pogonski /kiosk (kvalitet ILI tehnologija);
   *  • modul čija DECA nose različite permisije, pa je modul vidljiv kad je vidljivo bar jedno
   *    dete — npr. „Podešavanja" (admin konzola ILI samo „Izgled" za svakog prijavljenog).
   *    Tada je `requiresAny` UNIJA `requires` vrednosti dece i drži se ručno u koraku sa njima
   *    (vidljivost se NE izvodi iz `children`: dete BEZ `requires` nasleđuje roditelja, pa bi
   *    izvedeno pravilo otvorilo module tipa Sastanci/Održavanje svima — vidi `visibleNavChildren`).
   */
  requiresAny?: Permission[];
  /** Ruta „širokog" ekrana (Gantt) — sidebar se auto-sklanja (F1). */
  wide?: boolean;
  /** Dodatne reči za Ctrl+K pretragu (sinonimi, QBigTehn nazivi). */
  keywords?: string[];
  /**
   * Spoljašnja meta (npr. pogonski /kiosk) — nije klasična nav-ruta unutar AppShell-a;
   * render sa „↗" oznakom, otvara se direktno. Isključen iz `findDomainByPath`/
   * `isWideRoute` (ne predstavlja aktivni domen kad se prikaže).
   */
  external?: boolean;
  /**
   * Isti modul (isti `href`) je NAMERNO naveden u više od jednog domena/pod-grupe.
   * Signal za dedup u globalnim listama (Ctrl+K paleta) i „↗" oznaku u sidebaru.
   */
  crosslisted?: boolean;
  /**
   * Treći nivo — pogledi/tabovi modula (PLAN_NAV_PODMENIJI §4.1). Red modula sa decom
   * dobija chevron u sidebaru; deca se auto-razgranaju kad je modul aktivan i indeksiraju
   * u Ctrl+K paleti („Modul: Podstavka"). Dete bez `requires` nasleđuje roditeljev gate.
   */
  children?: NavSubItem[];
}

/** Imenovana pod-grupa unutar domena (npr. „Tehnologija" ispod „Proizvodnje"). */
export interface NavSubGroup {
  id: string; // stabilan slug, jedinstven unutar domena: 'tehnologija'
  title: string;
  icon: LucideIcon;
  modules: NavModule[];
}

export interface NavDomain {
  id: string; // stabilan slug: 'proizvodnja', 'montaza', ...
  title: string; // naslov sekcije kao danas
  icon: LucideIcon; // ikona domena za accordion header i rail
  /** Direktne stavke domena (prikazuju se PRE pod-grupa). */
  modules: NavModule[];
  /** Imenovane pod-grupe ispod direktnih stavki (opciono). */
  groups?: NavSubGroup[];
}

// Moduli iz DESIGN_SYSTEM.md §4. Bez href = placeholder (seli se u 3.0).
// Pogonski kiosk (/kiosk): do sada BEZ nav stavke (otvarao se direktnim URL-om na
// terminalima ili preko 1.0 HUB pločica). Od 18.07 postoji DISKRETAN spoljašnji link u
// domenu „Kontrola kvaliteta" (external:true) za tehnologe/kontrolu — kiosk sam bira
// režim po skeniranoj operaciji (`significantForFinishing`).
// `requires` = read/akcija permisija modula (vidljivost = paritet matrice RBAC §3).
//
// „Lokacije delova" (part-locations) je 2.0-native ledger praćenja pozicija KROZ
// proizvodnju → primarno u pod-grupi „Tehnologija", ali je UNAKRSNO (crosslisted)
// navedena i u „Logistici" (fizičko skladištenje, budući loc_* seobom 3.0). Ista ruta,
// ista permisija — dupla stavka je namerna afordansa, ne greška.
export const NAV_DOMAINS: NavDomain[] = [
  {
    id: 'proizvodnja',
    title: 'Proizvodnja',
    icon: Factory,
    modules: [
      // Talas C — Plan proizvodnje (Planiranje) + Praćenje proizvodnje (direktno u domenu).
      {
        label: 'Planiranje',
        href: '/plan-proizvodnje',
        icon: CalendarRange,
        requires: PERMISSIONS.PLAN_PROIZVODNJE_READ,
        wide: true,
        keywords: ['plan', 'proizvodnja', 'gantt'],
        // PODMENIJI F2 (§3.1): 5 pogleda, `?tab=` uveden u strani (TABS u plan-proizvodnje/
        // page.tsx = izvor istine za ključeve). Ruta je `wide` — pun sidebar se auto-sklanja,
        // pa se podmeni koristi kroz RAIL FLYOUT (F0 ga renderuje) i Ctrl+K paletu.
        // Bez `requires` po detetu: strana tabove ne gejtuje dodatno (sve na plan_proizvodnje.read;
        // stroža prava su per-AKCIJA — edit/force/koop_admin — ne per-tab).
        children: [
          { label: 'Po mašini', href: '/plan-proizvodnje?tab=po-masini', keywords: ['po masini', 'masine', 'raspored', 'PLA-PM'] },
          { label: 'Po crtežu', href: '/plan-proizvodnje?tab=po-crtezu', keywords: ['po crtezu', 'crtez', 'pozicija', 'PLA-PC'] },
          { label: 'Zauzetost mašina', href: '/plan-proizvodnje?tab=zauzetost', keywords: ['zauzetost', 'kapacitet', 'opterecenje', 'PLA-ZA'] },
          { label: 'Pregled svih', href: '/plan-proizvodnje?tab=pregled', keywords: ['pregled svih', 'sve operacije', 'PLA-PS'] },
          { label: 'Kooperacija', href: '/plan-proizvodnje?tab=kooperacija', keywords: ['kooperacija', 'koop', 'usluga', 'PLA-KO'] },
        ],
      },
      { label: 'Praćenje', href: '/pracenje-proizvodnje', icon: Radar, requires: PERMISSIONS.PRACENJE_READ, keywords: ['pracenje', 'status'] },
    ],
    groups: [
      {
        id: 'tehnologija',
        title: 'Tehnologija',
        icon: ClipboardList,
        modules: [
          { label: 'Radni nalozi', href: '/work-orders', icon: ClipboardList, requires: PERMISSIONS.RN_READ, keywords: ['rn', 'nalozi'] },
          { label: 'Realizacija', href: '/tech-processes', icon: Workflow, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['tp', 'kucanje', 'tehnoloski postupak'] },
          // Premešteno iz „Projektovanja" u „Proizvodnju/Tehnologiju" (UX 008/26, Jovica
          // 23.07): tehnolog odavde kuca TP i lansira, pa stavka pripada proizvodnom toku
          // uz Radne naloge/Realizaciju. Ruta i permisija (primopredaje.read) NETAKNUTE.
          { label: 'Primopredaje', href: '/handovers', icon: PackageCheck, requires: PERMISSIONS.PRIMOPREDAJE_READ, keywords: ['primopredaja', 'predaja'] },
          { label: 'Operacije po prioritetu', href: '/operations-queue', icon: ListOrdered, requires: PERMISSIONS.RN_READ, keywords: ['operacije', 'prioritet', 'red'] },
          { label: 'CAM programiranje', href: '/cnc-programs', icon: Cpu, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['cam', 'cnc', 'program'] },
          { label: 'Završeni nalozi', href: '/completed-orders', icon: CheckCircle2, requires: PERMISSIONS.RN_READ, keywords: ['zavrseni', 'arhiva'] },
          { label: 'Evidencija u proizvodnji', href: '/production-log', icon: ListChecks, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['evidencija', 'log'] },
          { label: 'Analitika vremena', href: '/session-analytics', icon: Clock, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['vreme', 'analitika', 'sesije'] },
          {
            label: 'Proizvodne strukture',
            href: '/structures',
            icon: Users,
            requires: PERMISSIONS.STRUKTURE_READ,
            keywords: ['strukture', 'bom'],
            // PODMENIJI F2 (§3.1): 5 tabova, `?tab=` uveden u strani (TABS u structures/page.tsx).
            // Strana ih ne gejtuje dodatno — ceo modul stoji na `strukture.read`.
            children: [
              { label: 'Radnici', href: '/structures?tab=workers', keywords: ['radnici', 'zaposleni u pogonu', 'STR-RA'] },
              { label: 'Radne jedinice', href: '/structures?tab=work-units', keywords: ['radne jedinice', 'rj', 'pogoni', 'STR-RJ'] },
              { label: 'Operacije', href: '/structures?tab=operations', keywords: ['operacije', 'sifarnik operacija', 'STR-OP'] },
              { label: 'Vrste poslova', href: '/structures?tab=worker-types', keywords: ['vrste poslova', 'zanimanja', 'worker types', 'STR-VP'] },
              { label: 'Radnici po mašinama', href: '/structures?tab=machine-access', keywords: ['radnici po masinama', 'dozvole za masine', 'STR-RM'] },
            ],
          },
          { label: 'MRP / Nabavka', href: '/mrp', icon: ShoppingCart, requires: PERMISSIONS.MRP_READ, keywords: ['mrp', 'nabavka'] },
          // Unakrsno (crosslisted) — vidi i domen „Logistika".
          { label: 'Lokacije delova', href: '/part-locations', icon: MapPin, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'pozicije'], crosslisted: true },
        ],
      },
    ],
  },
  {
    // Kontrola kvaliteta — svoj domen (evidencija škart/dorada + izveštaji). Uz njega
    // DISKRETAN spoljašnji ulaz u pogon (/kiosk — kucanje/kontrola) za one koji ga
    // koriste: kvalitet ILI tehnologija (requiresAny).
    id: 'kontrola-kvaliteta',
    title: 'Kontrola kvaliteta',
    icon: ShieldCheck,
    modules: [
      {
        label: 'Kontrola kvaliteta',
        href: '/kvalitet',
        icon: ShieldCheck,
        requires: PERMISSIONS.KVALITET_READ,
        keywords: ['kk', 'skart', 'dorada', 'kontrola'],
        // PODMENIJI F2 (§3.2): tabovi strane (`tabs` u kvalitet/page.tsx = izvor istine).
        // „Aktivnost kontrole" (K4) čita evidenciju kucanja i strana je nudi samo uz
        // `tehnologija.read` — dete nosi ISTI gate (plan §3.2 je pisan pre nego što je
        // taj tab dodat; ogledalo strane je jače od spiska u planu).
        children: [
          { label: 'Evidencija škarta', href: '/kvalitet?tab=skart', keywords: ['skart', 'neusaglasenost', 'nc', 'KVA-SK'] },
          { label: 'Evidencija dorada', href: '/kvalitet?tab=dorada', keywords: ['dorada', 'rework', 'popravka', 'KVA-DO'] },
          { label: 'Aktivnost kontrole', href: '/kvalitet?tab=aktivnost', requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['aktivnost kontrole', 'kontrolori', 'kucanja', 'KVA-AK'] },
          { label: 'Izveštaji', href: '/kvalitet?tab=izvestaji', keywords: ['izvestaji kvaliteta', 'analitika skarta', 'KVA-IZ'] },
          { label: 'Dokumenti', href: '/kvalitet?tab=dokumenti', keywords: ['dokumenti', 'sertifikati', 'atesti', 'KVA-DK'] },
          { label: 'Kontrola pogon', href: '/kvalitet?tab=pogon', keywords: ['kontrola pogon', 'pogonska kontrola', 'KVA-PG'] },
        ],
      },
      {
        label: 'Pogon — kucanje / kontrola',
        href: '/kiosk',
        icon: ScanLine,
        // Vidljiv uz KVALITET_READ ILI TEHNOLOGIJA_READ — pun OR presuđuje
        // `canAccessNavModule` (potrošači treba da ga koriste). `requires` je
        // KONZERVATIVNI fallback: potrošač koji još radi `!requires || can(requires)`
        // gejtuje na KVALITET_READ (griješi ka SKRIVANJU, ne ka izlaganju svima).
        requires: PERMISSIONS.KVALITET_READ,
        requiresAny: [PERMISSIONS.KVALITET_READ, PERMISSIONS.TEHNOLOGIJA_READ],
        external: true,
        keywords: ['kiosk', 'pogon', 'kucanje', 'kontrola', 'terminal', 'skener'],
      },
    ],
  },
  {
    id: 'projektovanje',
    title: 'Projektovanje',
    icon: PencilRuler,
    modules: [
      // Projektni biro (3.0 TALAS D) — plan/kanban/gantt/izveštaji/analiza/saveti.
      // Vidljivost = pb.read (SELECT `true` paritet = svi prijavljeni).
      {
        label: 'Projektni biro',
        href: '/pb',
        icon: FolderKanban,
        requires: PERMISSIONS.PB_READ,
        keywords: ['pb', 'projekti', 'kanban'],
        // PODMENIJI F2 (§3.3): 6 tabova za sve + „Podešavanja" samo za `pb.admin` — isti
        // gate koji strana već koristi (`isAdmin = can(PB_ADMIN)` u pb/page.tsx, izvor istine).
        children: [
          { label: 'Plan', href: '/pb?tab=plan', keywords: ['plan', 'zadaci', 'lista', 'PB-PL'] },
          { label: 'Kanban', href: '/pb?tab=kanban', keywords: ['kanban', 'tabla', 'board', 'PB-KB'] },
          { label: 'Gantt', href: '/pb?tab=gantt', keywords: ['gantt', 'vremenska linija', 'PB-GA'] },
          { label: 'Izveštaji', href: '/pb?tab=izvestaji', keywords: ['izvestaji projektovanja', 'PB-IZ'] },
          { label: 'Analiza', href: '/pb?tab=analiza', keywords: ['analiza', 'utrosak', 'PB-AN'] },
          { label: 'Saveti', href: '/pb?tab=saveti', keywords: ['saveti', 'preporuke', 'PB-SV'] },
          { label: 'Podešavanja', href: '/pb?tab=podesavanja', requires: PERMISSIONS.PB_ADMIN, keywords: ['podesavanja projektnog biroa', 'PB-PD'] },
        ],
      },
      { label: 'PDM / Crteži', href: '/pdm', icon: DraftingCompass, requires: PERMISSIONS.PDM_READ, keywords: ['crtez', 'bom', 'pdm', 'nacrt'] },
      // „Nacrti" (projektanti, gate write) ostaje ovde na `primopredaje.write` (radni
      // prostor projektanata). „Primopredaje" (/handovers) je preseljeno u
      // „Proizvodnju/Tehnologiju" (UX 008/26) — tehnološki tok, ne projektovanje.
      { label: 'Nacrti', href: '/nacrti', icon: PencilRuler, requires: PERMISSIONS.PRIMOPREDAJE_WRITE, keywords: ['nacrti', 'projektanti'] },
    ],
  },
  {
    // Talas C — Montaža i servis (Plan montaže: Plan/Gantt/Ukupan Gant/Izveštaji montera).
    id: 'montaza',
    title: 'Montaža i servis',
    icon: Hammer,
    // PODMENIJI F0 (PLAN_NAV_PODMENIJI §3.4) — IZUZETAK: pogledi modula su DIREKTNE stavke
    // domena (drugi nivo, bez trećeg), jer je „Plan montaže" bio jedina stavka domena i klik
    // na domen je otvarao accordion sa jednim redom. Deep-link `?view=` već radi u strani
    // (/montaza čita param na mount-u), unutrašnji hub „Izaberite prikaz" ostaje netaknut
    // (touch/tablet ulaz, presuda §6.6). Ključevi `?view=` su iz strane (VIEWS/VALID).
    modules: [
      // BEZ `wide` na celoj ruti: /montaza ima i tabelarne poglede (hub/plan/izveštaji);
      // Gantt pogledi (?view=gantt|total) traže wide RUNTIME kroz <WideMode/> u strani.
      { label: 'Plan', href: '/montaza?view=plan', icon: Table2, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'plan montaze', 'faze', 'MNT-P'] },
      { label: 'Gantt', href: '/montaza?view=gantt', icon: GanttChartSquare, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'gantt', 'vremenska linija', 'MNT-G'] },
      { label: 'Ukupan Gant', href: '/montaza?view=total', icon: Layers, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'gantt', 'ukupan', 'svi projekti', 'MNT-UG'] },
      { label: 'Izveštaji montera', href: '/montaza?view=izvestaji', icon: FileText, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'izvestaji', 'monteri', 'servisni izvestaj', 'MNT-IZ'] },
      { label: 'Neusaglašenosti', href: '/montaza?view=neusaglasenosti', icon: AlertTriangle, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'neusaglasenosti', 'odstupanja', 'MNT-N'] },
    ],
  },
  {
    // Logistika (PLAN_MODULA_MES_3.0 §4 / MODULE_SPEC_lokacije_30 §4) — 1.0 fizičke
    // lokacije (hale/police/kavezi/mašine, loc_*) seobom Talas A. Reversi (alat) je 3.0
    // pilot i živi ovde. „Lokacije delova" je unakrsno navedena (vidi i Tehnologija).
    id: 'logistika',
    title: 'Logistika',
    icon: Warehouse,
    modules: [
      {
        label: 'Lokacije',
        href: '/lokacije',
        icon: Warehouse,
        requires: PERMISSIONS.LOKACIJE_READ,
        keywords: ['lokacije', 'skladiste', 'police'],
        // PODMENIJI F2 (§3.5): 9 tabova; poslednja tri su permisijska — OGLEDALO gate-ova iz
        // lokacije/page.tsx (labels/manage/admin), koji je izvor istine. Prvih 6 nasleđuje
        // roditeljev `lokacije.read`.
        children: [
          { label: 'Početna', href: '/lokacije?tab=pocetna', keywords: ['pocetna', 'skener', 'brzo premestanje', 'LOK-PO'] },
          { label: 'Pregled predmeta', href: '/lokacije?tab=predmet', keywords: ['pregled predmeta', 'predmet', 'LOK-PP'] },
          { label: 'Lokacije', href: '/lokacije?tab=lokacije', keywords: ['definicije lokacija', 'hale', 'police', 'kavezi', 'LOK-LO'] },
          { label: 'Stavke', href: '/lokacije?tab=stavke', keywords: ['stavke', 'delovi', 'pretraga stavki', 'LOK-ST'] },
          { label: 'Pregled po lokacijama', href: '/lokacije?tab=report', keywords: ['pregled po lokacijama', 'izvestaj lokacija', 'LOK-PL'] },
          { label: 'Istorija premeštanja', href: '/lokacije?tab=pokreti', keywords: ['istorija premestanja', 'pokreti', 'kretanje', 'LOK-IP'] },
          { label: 'Štampa nalepnica', href: '/lokacije?tab=stampa', requires: PERMISSIONS.LOKACIJE_LABELS, keywords: ['stampa nalepnica', 'barkod', 'etikete', 'LOK-SN'] },
          { label: 'Istorija definicija', href: '/lokacije?tab=audit', requires: PERMISSIONS.LOKACIJE_MANAGE, keywords: ['istorija definicija', 'audit lokacija', 'LOK-ID'] },
          { label: 'Sync', href: '/lokacije?tab=sync', requires: PERMISSIONS.LOKACIJE_ADMIN, keywords: ['sync', 'sinhronizacija lokacija', 'LOK-SY'] },
        ],
      },
      // Unakrsno (crosslisted) — primarni dom je pod-grupa „Tehnologija".
      { label: 'Lokacije delova', href: '/part-locations', icon: MapPin, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'pozicije'], crosslisted: true },
      {
        label: 'Reversi',
        href: '/reversi',
        icon: Wrench,
        requires: PERMISSIONS.REVERSI_READ,
        keywords: ['reversi', 'alat'],
        // PODMENIJI F2 (§3.5): 7 GLAVNIH tabova (drugi nivo podtabova unutar „Stanja magacina"
        // ostaje u strani — meni nosi procese). „Otpisan alat" je manage-only (paritet 1.0
        // `manageOnly`); ključevi i gate su ogledalo `TAB_KEYS`/`manage` iz reversi/page.tsx.
        // Stari 1.0 id-jevi (workbench, zaduzenja, inventar, rezni-alat, scrapped) idu u
        // `keywords` — sam deep-link ih prevodi alias mapom u strani.
        children: [
          { label: 'Radni sto', href: '/reversi?tab=radni-sto', keywords: ['radni sto', 'workbench', 'izdavanje', 'REV-RS'] },
          { label: 'Moji alati', href: '/reversi?tab=moji', keywords: ['moji alati', 'zaduzeni alat', 'moja', 'REV-MA'] },
          { label: 'Izdavanje i povraćaj', href: '/reversi?tab=dokumenti', keywords: ['izdavanje', 'povracaj', 'zaduzenja', 'revers', 'REV-IP'] },
          { label: 'Stanje magacina', href: '/reversi?tab=magacin', keywords: ['stanje magacina', 'inventar', 'alat i oprema', 'REV-SM'] },
          { label: 'Rezni alat', href: '/reversi?tab=rezni', keywords: ['rezni alat', 'cutting', 'plocice', 'REV-RA'] },
          { label: 'Mašine', href: '/reversi?tab=masine', keywords: ['masine', 'alat po masini', 'REV-MS'] },
          { label: 'Otpisan alat', href: '/reversi?tab=otpisano', requires: PERMISSIONS.REVERSI_MANAGE, keywords: ['otpisan alat', 'otpis', 'scrapped', 'REV-OT'] },
        ],
      },
    ],
  },
  {
    // Oprema i energija — Održavanje (CMMS) i Energetika/SCADA.
    id: 'oprema-energija',
    title: 'Oprema i energija',
    icon: Wrench,
    modules: [
      {
        label: 'Održavanje',
        href: '/odrzavanje',
        icon: Cog,
        requires: PERMISSIONS.ODRZAVANJE_READ,
        // U keywords ulaze i imena tabova KOJI NISU u podmeniju (Kalendar, Vozila, Vozači, IT
        // oprema, Objekti, Dokumenta, Notifikacije) — Ctrl+K ih tako bar nalazi kroz roditelja
        // („Tell me" obrazac, §6.2); skok na TAČAN tab imaju samo kurirane stavke (F3).
        keywords: [
          'odrzavanje', 'cmms', 'servis',
          'kalendar', 'vozila', 'vozaci', 'it oprema', 'objekti', 'dokumenta', 'notifikacije',
        ],
        // PODMENIJI F1, presuda §6.2: KURIRANIH 8 (ne svih 16 tabova) — meni nosi procese,
        // forma nosi tabove. Ključevi `?tab=` su iz strane (TAB_KEYS u odrzavanje/page.tsx).
        // Bez `requires`: strana ovih 8 tabova ne gejtuje dodatno (gejtuje samo „Podešavanja"
        // = odrzavanje.admin_ui i „Notifikacije" = /maintenance/me gate — a oni nisu u podmeniju).
        children: [
          { label: 'Pregled', href: '/odrzavanje?tab=pregled', keywords: ['pregled', 'dashboard', 'kontrolna tabla', 'ODR-PR'] },
          { label: 'Tabla', href: '/odrzavanje?tab=board', keywords: ['tabla', 'board', 'kanban', 'ODR-TB'] },
          { label: 'Radni nalozi', href: '/odrzavanje?tab=nalozi', keywords: ['radni nalozi', 'nalozi', 'work orders', 'ODR-RN'] },
          { label: 'Kvarovi', href: '/odrzavanje?tab=kvarovi', keywords: ['kvarovi', 'kvar', 'prijava kvara', 'zastoj', 'ODR-KV'] },
          { label: 'Mašine', href: '/odrzavanje?tab=masine', keywords: ['masine', 'oprema', 'sredstva', 'ODR-MA'] },
          { label: 'Preventiva', href: '/odrzavanje?tab=preventiva', keywords: ['preventiva', 'preventivno odrzavanje', 'plan odrzavanja', 'ODR-PV'] },
          { label: 'Zalihe', href: '/odrzavanje?tab=zalihe', keywords: ['zalihe', 'rezervni delovi', 'magacin odrzavanja', 'ODR-ZA'] },
          { label: 'Izveštaji', href: '/odrzavanje?tab=izvestaji', keywords: ['izvestaji', 'analitika', 'ODR-IZ'] },
        ],
      },
      // Energetika/SCADA — vidljiva SAMO admin+menadzment (energetika.read; paritet 1.0).
      { label: 'Energetika', href: '/energetika', icon: Zap, requires: PERMISSIONS.ENERGETIKA_READ, keywords: ['energetika', 'scada', 'struja'] },
    ],
  },
  {
    // Kadrovska (HR) — 3.0 Talas G (POSLEDNJI; PII + zarade). Vidljivost = `kadrovska.read`
    // (paritet 1.0 canAccessKadrovska). Interni tabovi/hub gejtuju stroža prava. „Moj
    // profil" je self-service agregator za svakog prijavljenog (profile.self).
    id: 'kadrovska',
    title: 'Kadrovska',
    icon: IdCard,
    modules: [
      {
        label: 'Kadrovska',
        href: '/kadrovska',
        icon: IdCard,
        requires: PERMISSIONS.KADROVSKA_READ,
        keywords: ['kadrovska', 'hr', 'zaposleni'],
        // PODMENIJI F2, presuda §6.4: 5 GRUPA (ne 13 tabova) uz `?grupa=` — grupa odgovara
        // mentalnom modelu koji hub strane već koristi (Role Center logika). Ključevi su
        // `GROUP_DEFS` iz kadrovska/page.tsx (izvor istine); imena tabova unutar grupa idu u
        // `keywords`, pa ih Ctrl+K nalazi i sleće na grupu koja ih sadrži.
        // „Zarade" nosi TVRD gate `kadrovska.salary` (1.0 allowlist Nenad+Nevena) — isti uslov
        // kojim strana pravi grupu; ostale 4 grupe imaju bar jedan tab na baseline `kadrovska.read`.
        children: [
          { label: 'Pregled', href: '/kadrovska?grupa=pregled', keywords: ['pregled', 'dashboard', 'izvestaji', 'notifikacije', 'KAD-PR'] },
          { label: 'Odmori i odsustva', href: '/kadrovska?grupa=odmori', keywords: ['odmori', 'godisnji odmor', 'odsustva', 'zahtevi', 'kalendar', 'KAD-OD'] },
          { label: 'Radni sati', href: '/kadrovska?grupa=sati', keywords: ['radni sati', 'grid', 'prisustvo', 'kapija', 'KAD-RS'] },
          { label: 'Zaposleni', href: '/kadrovska?grupa=zaposleni', keywords: ['zaposleni', 'kartoni', 'ugovori', 'imenik', 'razvoj', 'uvodjenje', 'onboarding', 'KAD-ZP'] },
          { label: 'Zarade', href: '/kadrovska?grupa=zarade', requires: PERMISSIONS.KADROVSKA_SALARY, keywords: ['zarade', 'plate', 'obracun zarada', 'bruto', 'KAD-ZR'] },
        ],
      },
      { label: 'Moj profil', href: '/profil', icon: CircleUser, requires: PERMISSIONS.PROFILE_SELF, keywords: ['profil', 'moj'] },
    ],
  },
  {
    // Saradnja (PLAN_MODULA domen) — seoba 3.0 TALAS B: Sastanci + AI asistent.
    // Sastanci: vidljivost = canAccessSastanci (sastanci.read). AI: „/ai za sve" (ai.chat).
    id: 'saradnja',
    title: 'Saradnja',
    icon: CalendarClock,
    modules: [
      {
        label: 'Sastanci',
        href: '/sastanci',
        icon: CalendarClock,
        requires: PERMISSIONS.SASTANCI_READ,
        keywords: ['sastanci', 'meeting'],
        // PODMENIJI F1 (§3.8): 5 glavnih tabova + 5 tabova koji su skriveni iza ⚙ dropdown-a
        // — najskriveniji ekrani u aplikaciji. Ključevi `?tab=` su iz strane (MainKey/GearKey
        // u sastanci/page.tsx); stari 1.0 id-jevi (dashboard, akcioni-plan, pregled-projekti,
        // podesavanja-notif) idu u `keywords` da Ctrl+K nalazi i po njima — sam deep-link ih
        // i dalje prevodi TAB_DEEPLINK_ALIAS mapom u strani.
        //
        // GATE (F1 nalaz 1, 26.07): 4 admin ekrana stoje na `sastanci.edit` — to je 1.0
        // `canEdit()` / `has_edit_role` krug (admin/menadzment/pm/leadpm/hr/poslovni_admin) i
        // JEDINI krug koji sme da mutira ono što ti ekrani nude (backend: `@RequirePermission
        // (SASTANCI_EDIT)` na templates CRUD, teme, draft-review/uvedi, admin-rang, dodeli).
        // Bez `requires` (27.07, presuda Nenada) namerno ostaju:
        //   • „Podešavanja" — LIČNA podešavanja mejl-obaveštenja (`PATCH /sastanci/prefs` je
        //     self-service, gejtovan samo `sastanci.read` + RLS po email claim-u); zato su i
        //     u strani izašla iz ⚙ u glavnu tab-traku, uz ostala 4 taba;
        //   • „Arhiva" — čitanje starih zapisnika (`GET /sastanci/arhive`, `:id/arhiva/pdf`
        //     stoje na klasnom `sastanci.read`); tab je read-only, mutacija arhive živi u
        //     zaključavanju i nosi svoj SASTANCI_EDIT.
        // Izvor istine za isti gate u strani = `GEAR_ITEMS` u sastanci/page.tsx.
        children: [
          { label: 'Pregled', href: '/sastanci?tab=pregled', keywords: ['pregled', 'dashboard', 'SAS-PR'] },
          { label: 'Sastanci', href: '/sastanci?tab=sastanci', keywords: ['lista sastanaka', 'termini', 'SAS-SA'] },
          { label: 'Moj rad', href: '/sastanci?tab=moj-rad', keywords: ['moj rad', 'moje teme', 'moje obaveze', 'SAS-MR'] },
          { label: 'Akcioni plan', href: '/sastanci?tab=akcioni', keywords: ['akcioni plan', 'akcioni-plan', 'zadaci', 'SAS-AP'] },
          { label: 'Podešavanja', href: '/sastanci?tab=podesavanja', keywords: ['podesavanja sastanaka', 'podesavanja-notif', 'notifikacije', 'SAS-PD'] },
          { label: 'PM teme', href: '/sastanci?tab=pm-teme', requires: PERMISSIONS.SASTANCI_EDIT, keywords: ['pm teme', 'teme projektnih menadzera', 'SAS-PM'] },
          { label: 'Po projektu', href: '/sastanci?tab=po-projektu', requires: PERMISSIONS.SASTANCI_EDIT, keywords: ['po projektu', 'pregled-projekti', 'predmeti', 'SAS-PP'] },
          { label: 'Draft teme', href: '/sastanci?tab=draft-teme', requires: PERMISSIONS.SASTANCI_EDIT, keywords: ['draft teme', 'nacrti tema', 'SAS-DT'] },
          { label: 'Šabloni', href: '/sastanci?tab=sabloni', requires: PERMISSIONS.SASTANCI_EDIT, keywords: ['sabloni', 'template', 'SAS-SB'] },
          { label: 'Arhiva', href: '/sastanci?tab=arhiva', keywords: ['arhiva', 'stari sastanci', 'SAS-AR'] },
        ],
      },
      { label: 'AI asistent', href: '/ai', icon: Bot, requires: PERMISSIONS.AI_CHAT, keywords: ['ai', 'asistent', 'chat'] },
    ],
  },
  // ─────────────────────────────────────────────────────────────────────────
  // 4.0 — Komercijala i finansije (zamena BigBit-a). Integracija: varijanta C→A
  // (docs/PLAN_GRADNJE_4.0_INDEKS.md + artefakt predloga menija).
  //   • Ovi domeni su OKVIR — moduli dobijaju `href` TEK kad su izgrađeni (postepeni
  //     C pristup: nav uvek odražava stvarnost, bez praznih ruta). Do tada su
  //     zakomentarisani placeholderi ispod, ne renderuju se.
  //   • Grupisanje = varijanta A (Prodaja i nabavka | Finansije) — odvaja komercijalu
  //     od knjigovodstva jer su različite uloge (RBAC prirodno gejtuje).
  //   • RBAC: nove permisije (sales.read, gl.read, nabavka.read…) uvode se u Fazi 0
  //     u BACKEND katalogu (permissions.ts je MIRROR), pa se dodaju `requires` ovde.
  //     Dok ne postoje — modul se NE dodaje (fail-closed), a ne stavlja pod tuđu permisiju.
  // ─────────────────────────────────────────────────────────────────────────
  {
    id: 'prodaja-nabavka',
    title: 'Prodaja i nabavka',
    icon: ShoppingCart,
    // PODMENIJI F2 (§3.9): 7 ravnih stavki („razliveno") → Nabavka kao DIREKTNA stavka +
    // dve imenovane pod-grupe (postojeći `NavSubGroup` mehanizam — bez novih ruta, bez
    // promene permisija; menja se samo grupisanje/redosled prikaza).
    modules: [
      // Postepeno (Faza po faza) — otkomentarisati modul kad je ruta+permisija spremna:
      // Traka B (SPRINT — prvi): Nabavka
      { label: 'Nabavka', href: '/nabavka', icon: PackageCheck, requires: PERMISSIONS.NABAVKA_READ, keywords: ['nabavka', 'upit', 'narudzbenica', 'dobavljac'] },
      // Traka B: RFQ kupca → predmet
      // { label: 'Upiti kupaca', href: '/rfqs', icon: ClipboardList, requires: PERMISSIONS.SALES_READ, keywords: ['rfq', 'zahtev za ponudu', 'upit kupca'] },
    ],
    groups: [
      {
        // Matični podaci 4.0 (backend `masters`) — READ-ONLY pregled BigBit cache
        // tabela `items`/`customers`. Unos ostaje u BigBit-u (prelazni režim), pa
        // ovde nema „Novi artikal/komitent" — samo pretraga i kartica.
        // Od 29.07.2026 nema duplikata: stariji „Komitenti" iz domena „Sistem"
        // (`/customers`) je ugašen i preusmeren ovamo, a njegove ključne reči su
        // spojene u ovu stavku. Obe stavke stoje na `directory.read` — širinu
        // podatka (bezbedan podskup vs. komercijalne kolone) presuđuje BACKEND
        // kroz `masters.read`, ne vidljivost stavke u meniju.
        id: 'maticni-podaci',
        title: 'Matični podaci',
        icon: Layers,
        modules: [
          { label: 'Artikli', href: '/artikli', icon: Package, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['artikli', 'roba', 'sifarnik artikala', 'kataloski broj', 'barkod', 'maticni podaci'] },
          { label: 'Komitenti', href: '/komitenti', icon: Building2, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['komitenti', 'kupci', 'klijenti', 'dobavljaci', 'pib', 'sifarnik komitenata', 'maticni podaci'] },
        ],
      },
      {
        id: 'fakturisanje',
        title: 'Fakturisanje',
        icon: ListOrdered,
        modules: [
          // Faza 5: Predračuni & računi (izlazni, dom+izvoz)
          { label: 'Predračuni & računi', href: '/fakturisanje', icon: ListOrdered, requires: PERMISSIONS.SALES_READ, keywords: ['faktura', 'racun', 'predracun', 'profaktura', 'izvoz'] },
          { label: 'Avansni računi', href: '/fakturisanje/avansi', icon: ListOrdered, requires: PERMISSIONS.PDV_READ, keywords: ['avans', 'avansni racun', 'avr', 'predujam'] },
          // Faza 5: e-Fakture (SEF)
          { label: 'e-Fakture (SEF)', href: '/sef', icon: RefreshCw, requires: PERMISSIONS.SEF_READ, keywords: ['sef', 'efaktura', 'ubl'] },
        ],
      },
      {
        id: 'magacin',
        title: 'Magacin',
        icon: Warehouse,
        modules: [
          // Faza 3: Zalihe & kalkulacija (crosslisted u Logistiku)
          { label: 'Zalihe & kalkulacija', href: '/robno', icon: Warehouse, requires: PERMISSIONS.ROBNO_READ, keywords: ['zalihe', 'lager', 'kalkulacija', 'primka', 'nivelacija'], crosslisted: true },
          // E2: popis/inventura (zakonski godišnji tok — predpunjenje → unos → VISAK/MANJAK)
          { label: 'Popis / inventura', href: '/robno/popis', icon: Warehouse, requires: PERMISSIONS.ROBNO_READ, keywords: ['popis', 'inventura', 'visak', 'manjak'] },
          { label: 'Rezervacije zaliha', href: '/robno/rezervacije', icon: Warehouse, requires: PERMISSIONS.ROBNO_READ, keywords: ['rezervacija', 'rezervisano', 'raspolozivo'] },
        ],
      },
    ],
  },
  {
    id: 'finansije',
    title: 'Finansije',
    icon: SlidersHorizontal,
    // PODMENIJI F2, presuda §6.3 (SAP FI struktura): stavke koje su LOGIČKI DECA prestaju da
    // stoje ravnopravno u prvom redu — „Kursne razlike" pod Saldakonte, „Poreske stope" pod
    // PDV, „Kursna lista" pod Izvode; uz to je iskopana ruta `/saldakonti/kartica` (Kartica
    // komitenta), koja do sada NIJE bila nigde u meniju. Prvi red pada sa 12 na 9 stavki.
    // Amortizeri navike (§6.3): stavke se SELE, ne nestaju — stara imena ostaju u `keywords`
    // dece, pa ih Ctrl+K nalazi kao i pre („Saldakonti: Kursne razlike"), a auto-razgranavanje
    // aktivnog modula ih drži vidljivim čim uđeš u roditelja.
    modules: [
      // Faza 2: Glavna knjiga
      { label: 'Glavna knjiga', href: '/glavna-knjiga', icon: ListChecks, requires: PERMISSIONS.GL_READ, keywords: ['gk', 'nalozi', 'kontni plan', 'dnevnik', 'bruto bilans'] },
      // Faza 4: Izvodi (bankovni, TXT uvoz)
      {
        label: 'Izvodi',
        href: '/izvodi',
        icon: FileText,
        requires: PERMISSIONS.IZVODI_READ,
        keywords: ['izvod', 'banka', 'txt', 'uparivanje'],
        // Sam modul nema tabove (podrute `[id]`) — jedino dete je preseljena ruta.
        children: [
          // E6: kursna lista (devizni izvodi — prodajni kurs; blagajna srednji)
          { label: 'Kursna lista', href: '/izvodi/kursna-lista', keywords: ['kursna lista', 'kurs', 'devize', 'eur', 'valuta', 'IZV-KL'] },
        ],
      },
      // Faza 4: Saldakonti (otvorene stavke, IOS, kompenzacija)
      {
        label: 'Saldakonti',
        href: '/saldakonti',
        icon: Users,
        requires: PERMISSIONS.SALDAKONTI_READ,
        keywords: ['otvorene stavke', 'ios', 'aging', 'kompenzacija'],
        // 3 taba strane (`TABS` u saldakonti/page.tsx = izvor istine za ključeve `?tab=`) +
        // 2 PODRUTE: „Kartica komitenta" (do F2 dostupna samo kroz linkove iz Izvoda/Naplate)
        // i „Kursne razlike" (preseljena iz prvog reda). Sve stoji na `saldakonti.read` —
        // strožih per-tab gate-ova nema (reconcile je per-AKCIJA, unutar „Otvorenih stavki").
        children: [
          { label: 'Otvorene stavke', href: '/saldakonti?tab=open', keywords: ['otvorene stavke', 'ios', 'uparivanje', 'SLD-OS'] },
          { label: 'Aging', href: '/saldakonti?tab=aging', keywords: ['aging', 'dospelost', 'bucket', 'SLD-AG'] },
          { label: 'Kompenzacije', href: '/saldakonti?tab=compensation', keywords: ['kompenzacije', 'prebijanje', 'SLD-KP'] },
          { label: 'Kartica komitenta', href: '/saldakonti/kartica', keywords: ['kartica komitenta', 'kartica partnera', 'analitika komitenta', 'SLD-KK'] },
          { label: 'Kursne razlike', href: '/saldakonti/kursne-razlike', keywords: ['kursne razlike', 'revalorizacija', 'devizno', 'kurs', 'SLD-KR'] },
        ],
      },
      // Faza 4: Banka & plaćanja (izvodi, priprema plaćanja, virmani)
      { label: 'Banka & plaćanja', href: '/placanja', icon: Building2, requires: PERMISSIONS.PLACANJA_READ, keywords: ['banka', 'izvod', 'virman', 'nalog za placanje', 'priprema placanja'] },
      // XL: Blagajna (gotovinski dnevnik — uplatnice/isplatnice)
      { label: 'Blagajna', href: '/blagajna', icon: Wallet, requires: PERMISSIONS.BLAGAJNA_READ, keywords: ['blagajna', 'gotovina', 'uplatnica', 'isplatnica', 'kasa'] },
      // XL: Obračun kamate (zatezna/ugovorna)
      { label: 'Kamata', href: '/kamata', icon: Percent, requires: PERMISSIONS.KAMATA_READ, keywords: ['kamata', 'zatezna', 'kamatni list', 'obracun kamate'] },
      // Faza 6: PDV & POPDV
      {
        label: 'PDV & POPDV',
        href: '/pdv',
        icon: ShieldCheck,
        requires: PERMISSIONS.PDV_READ,
        keywords: ['pdv', 'popdv', 'pppdv', 'kif', 'kuf', 'kepu'],
        // 4 taba strane (`TABS` u pdv/page.tsx = izvor istine) + preseljena podruta registra
        // stopa. Sve na `pdv.read` — strana per-tab gate-ove nema.
        children: [
          { label: 'KIF (izlazni)', href: '/pdv?tab=kif', keywords: ['kif', 'izlazni racuni', 'knjiga izlaznih faktura', 'PDV-KIF'] },
          { label: 'KUF (ulazni)', href: '/pdv?tab=kuf', keywords: ['kuf', 'ulazni racuni', 'knjiga ulaznih faktura', 'PDV-KUF'] },
          { label: 'POPDV obračun', href: '/pdv?tab=popdv', keywords: ['popdv', 'pppdv', 'obracun pdv', 'aop', 'PDV-PO'] },
          { label: 'KEPU', href: '/pdv?tab=kepu', keywords: ['kepu', 'knjiga evidencije prometa', 'PDV-KE'] },
          // Talas 1D: registar poreskih stopa (efektivno datiranje)
          { label: 'Poreske stope', href: '/pdv/stope', keywords: ['poreske stope', 'tarife', 'pdv stopa', 'stopa', 'PDV-ST'] },
        ],
      },
      // T3: dashboard naplate (DSO, aging heatmap, top dužnici)
      { label: 'Naplata', href: '/naplata', icon: Percent, requires: PERMISSIONS.SALDAKONTI_READ, keywords: ['naplata', 'dso', 'aging', 'duznici', 'dospelo'] },
      // Faza 7: Završni račun (bilansi, APR)
      { label: 'Završni račun', href: '/zavrsni-racun', icon: CheckCircle2, requires: PERMISSIONS.ZR_READ, keywords: ['bilans', 'zavrsni racun', 'apr', 'popdv'] },
    ],
  },
  {
    id: 'sistem',
    title: 'Sistem',
    icon: SlidersHorizontal,
    modules: [
      // Podešavanja (3.0 TALAS D) — RBAC admin konzola + matični + sistem.
      // Vidljivost (F1 nalaz 2, presuda §3.11): modul se vidi ako uloga sme BAR JEDAN tab —
      // admin/menadzment/pm/leadpm vide punu konzolu, a SVAKI prijavljen korisnik vidi modul
      // sa jedinim detetom „Izgled" (`profile.self` ima svaka uloga). `requiresAny` je UNIJA
      // `requires` vrednosti dece (drži se u koraku sa `children` ispod); `requires` ostaje
      // KONZERVATIVNI fallback za potrošača koji bi još radio `!requires || can(requires)`.
      {
        label: 'Podešavanja',
        href: '/podesavanja',
        icon: SlidersHorizontal,
        requires: PERMISSIONS.SETTINGS_ORG_PROFILE,
        requiresAny: [
          PERMISSIONS.SETTINGS_USERS,
          PERMISSIONS.SETTINGS_ORG_PROFILE,
          PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA,
          PERMISSIONS.SETTINGS_SYSTEM,
          PERMISSIONS.SETTINGS_AUDIT,
          PERMISSIONS.PROFILE_SELF,
        ],
        keywords: ['podesavanja', 'settings', 'rbac', 'izgled', 'tema'],
        // PODMENIJI F1 (§3.11): svih 14 tabova, svaki sa SVOJOM permisijom — ogledalo
        // `TAB_DEFS` iz podesavanja/page.tsx (izvor istine je strana, ne ovaj model).
        // Korisnik bez ijedne settings.* permisije vidi u podmeniju SAMO „Izgled", a klik na
        // sam modul strana koriguje na prvi dostupan tab (guard efekat u podesavanja/page.tsx).
        children: [
          { label: 'Korisnici', href: '/podesavanja?tab=korisnici', requires: PERMISSIONS.SETTINGS_USERS, keywords: ['korisnici', 'nalozi', 'users', 'POD-KO'] },
          { label: 'Uloge i dozvole', href: '/podesavanja?tab=uloge', requires: PERMISSIONS.SETTINGS_USERS, keywords: ['uloge', 'dozvole', 'permisije', 'role', 'rbac', 'POD-UL'] },
          { label: 'Grid urednici', href: '/podesavanja?tab=grid', requires: PERMISSIONS.SETTINGS_USERS, keywords: ['grid', 'urednici', 'editori', 'POD-GR'] },
          { label: 'Organizacija', href: '/podesavanja?tab=organizacija', requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['organizacija', 'sektori', 'radne jedinice', 'POD-OR'] },
          { label: 'Matični podaci', href: '/podesavanja?tab=masters', requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['maticni podaci', 'sifarnici', 'masters', 'POD-MP'] },
          { label: 'Vrednosti firme', href: '/podesavanja?tab=vrednosti', requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['vrednosti', 'kultura', 'POD-VR'] },
          { label: 'Očekivanja', href: '/podesavanja?tab=ocekivanja', requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['ocekivanja', 'POD-OC'] },
          { label: 'Kompetencije', href: '/podesavanja?tab=kompetencije', requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['kompetencije', 'vestine', 'POD-KM'] },
          { label: 'Predmeti', href: '/podesavanja?tab=predmet', requires: PERMISSIONS.SETTINGS_PREDMET_AKTIVACIJA, keywords: ['predmeti', 'aktivacija predmeta', 'POD-PR'] },
          { label: 'Notifikacije', href: '/podesavanja?tab=notifikacije', requires: PERMISSIONS.SETTINGS_SYSTEM, keywords: ['notifikacije', 'obavestenja', 'pravila', 'POD-NO'] },
          { label: 'Integracije', href: '/podesavanja?tab=integracije', requires: PERMISSIONS.SETTINGS_SYSTEM, keywords: ['integracije', 'servisi', 'POD-IN'] },
          { label: 'Audit log', href: '/podesavanja?tab=audit', requires: PERMISSIONS.SETTINGS_AUDIT, keywords: ['audit', 'log', 'revizija', 'POD-AU'] },
          { label: 'Sistem', href: '/podesavanja?tab=sistem', requires: PERMISSIONS.SETTINGS_SYSTEM, keywords: ['sistem', 'verzija', 'POD-SI'] },
          { label: 'Izgled', href: '/podesavanja?tab=izgled', requires: PERMISSIONS.PROFILE_SELF, keywords: ['izgled', 'tema', 'dark', 'sidebar', 'raspored', 'POD-IZ'] },
        ],
      },
      // Zahtevi — AI PM modul (bug/dorada/nova funkcija + Decision Log). Domen „Sistem"
      // (presuda §13.5); vidljivost = zahtevi.read (svima; row-scope u servisu sužava na svoje).
      { label: 'Zahtevi', href: '/zahtevi', icon: Lightbulb, requires: PERMISSIONS.ZAHTEVI_READ, keywords: ['zahtevi', 'ideje', 'bug', 'greska', 'predlog', 'dorada', 'inbox'] },
      // „Komitenti" (/customers) je UKLONJEN 29.07.2026 — ekran je ujedinjen sa
      // „Matični podaci → Komitenti" (/komitenti); ruta /customers je sad samo
      // preusmerenje, a ključne reči su preseljene u novu stavku.
      { label: 'Predmeti', href: '/projects', icon: Briefcase, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['predmeti', 'projekti'] },
      { label: 'Sinhronizacije', href: '/syncs', icon: RefreshCw, requires: PERMISSIONS.SYNC_READ, keywords: ['sync', 'sinhronizacija'] },
    ],
  },
];

// ------------------------------------------------------------------ helperi

/**
 * Pathname deo href-a iz modela — href SME da nosi query (`/montaza?view=gantt`) i hash.
 * SVA poređenja ruta (`matchesRoute`, `findDomainByPath`, `isWideRoute`, `findModuleByPath`)
 * rade nad ovim delom; query se poredi zasebno (`hrefQueryMatches`), jer `usePathname()`
 * nikad ne nosi query (PLAN_NAV_PODMENIJI §4.1).
 */
export function hrefPath(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/** Query parovi iz href-a (prazno kad href nema query). */
function hrefQueryPairs(href: string): [string, string][] {
  const q = href.indexOf('?');
  if (q === -1) return [];
  const raw = href.slice(q + 1).split('#')[0];
  return Array.from(new URLSearchParams(raw).entries());
}

/**
 * Da li tekući query (`search`, npr. „?view=neusaglasenosti&id=7") sadrži SVE parove iz
 * href-a. Href bez query-ja = uvek true. Višak parametara u URL-u NE smeta (deep-link `?id=`
 * ili „potrošeni" parametri) — traži se podskup, ne jednakost.
 */
export function hrefQueryMatches(href: string, search: string): boolean {
  const want = hrefQueryPairs(href);
  if (want.length === 0) return true;
  const have = new URLSearchParams(search);
  return want.every(([k, v]) => have.get(k) === v);
}

/** Ruta modula je „aktivna" za pathname ako je tačan pogodak ili prefiks (podruta). */
function matchesRoute(pathname: string, href: string): boolean {
  const path = hrefPath(href);
  return pathname === path || pathname.startsWith(path + '/');
}

/**
 * Svi moduli domena (direktne stavke + sve pod-grupe), spljošteno u jedan niz.
 * Redosled: prvo direktne stavke, pa pod-grupe redom (unutar grupe njihov redosled).
 * NE dedup-uje `crosslisted` module — dedup po `href`-u je briga globalnih listi
 * (Ctrl+K paleta) koje spajaju SVE domene. Sidebar/hub prikazuju grupe kao odeljke.
 */
export function allModules(domain: NavDomain): NavModule[] {
  const grouped = domain.groups?.flatMap((g) => g.modules) ?? [];
  return [...domain.modules, ...grouped];
}

/**
 * RBAC predikat za jedan modul — JEDAN izvor istine za vidljivost (sidebar, hub,
 * paleta). `requiresAny` (OR) ima prednost nad `requires` (single); bez ijednog =
 * uvek vidljiv. Backend je izvor istine; ovo krije afordanse, guard čuva rute.
 */
export function canAccessNavModule(
  module: NavModule,
  can: (permission: Permission) => boolean,
): boolean {
  if (module.requiresAny && module.requiresAny.length > 0) {
    return module.requiresAny.some((p) => can(p));
  }
  return !module.requires || can(module.requires);
}

/**
 * Domen kome pripada trenutna ruta (prefiks-match po href-u; najduži pogodak
 * pobeđuje kad se rute preklapaju). Obuhvata i module iz pod-grupa. `external`
 * stavke (kiosk) se preskaču — nisu klasične rute unutar AppShell-a. Sidebar ga
 * forsira otvorenim (F1); za `crosslisted` rutu pobeđuje PRVI domen po redosledu
 * modela (Tehnologija ispred Logistike).
 */
export function findDomainByPath(pathname: string): NavDomain | undefined {
  let best: { domain: NavDomain; len: number } | undefined;
  for (const domain of NAV_DOMAINS) {
    for (const m of allModules(domain)) {
      if (m.external) continue;
      const len = hrefPath(m.href).length;
      if (matchesRoute(pathname, m.href) && (!best || len > best.len)) {
        best = { domain, len };
      }
    }
  }
  return best?.domain;
}

/** Da li je ruta „široka" (Gantt) — sidebar se auto-sklanja pri ulasku (F1). */
export function isWideRoute(pathname: string): boolean {
  return NAV_DOMAINS.some((d) =>
    allModules(d).some((m) => m.wide && !m.external && matchesRoute(pathname, m.href)),
  );
}

/**
 * Da li je stavka „aktivna" (aria-current=„page") na datoj ruti, KAD se renderuje unutar
 * domena `ownerDomainId`. Tačan pogodak href-a je uslov kao i dosad; dodatno, `crosslisted`
 * modul (npr. „Lokacije delova" u Tehnologiji I Logistici) sme biti aktivan SAMO u svom
 * pobedničkom domenu (findDomainByPath — prvi po redosledu modela), da se u layout-u B
 * (sve sekcije otvorene) i drugde ne upale DVE „trenutne" stavke odjednom (a11y: jedan
 * aria-current; ODLUKE #33 — dupli aktiv je tretiran kao defekt).
 */
export function isNavModuleActive(
  pathname: string,
  module: NavModule,
  ownerDomainId: string,
  search = '',
): boolean {
  if (pathname !== hrefPath(module.href)) return false;
  // Stavka sa query href-om (npr. „Gantt" = /montaza?view=gantt) je aktivna samo kad su svi
  // njeni parovi u tekućem URL-u — inače bi svih 5 montažnih redova bilo aktivno odjednom.
  if (!hrefQueryMatches(module.href, search)) return false;
  if (module.crosslisted) return findDomainByPath(pathname)?.id === ownerDomainId;
  return true;
}

/**
 * Da li je PODSTAVKA (`NavSubItem`) aktivna: pathname jednak + svi query parovi iz href-a
 * prisutni u tekućem URL-u (PLAN_NAV_PODMENIJI §4.1). Kad je podstavka aktivna, ONA nosi
 * `aria-current="page"`, a roditeljski red samo stil (jedan aria-current — ODLUKA #33).
 */
export function isNavSubItemActive(pathname: string, search: string, item: NavSubItem): boolean {
  return pathname === hrefPath(item.href) && hrefQueryMatches(item.href, search);
}

/**
 * Da li tekuća ruta „pripada" modulu (tačan pogodak ili podruta, bez obzira na query) —
 * uslov za AUTO-RAZGRANAVANJE podmenija (paritet sa accordion-om domena: aktivni je otvoren).
 */
export function isNavModuleRouteCurrent(pathname: string, module: NavModule): boolean {
  return !module.external && matchesRoute(pathname, module.href);
}

/**
 * Podstavke modula koje uloga sme da vidi. Dete BEZ `requires` nasleđuje roditeljev gate
 * (roditelj je već filtriran `canAccessNavModule`-om), dete SA `requires` se gejtuje strože
 * (admin tabovi). Bez dece → prazan niz (pozivalac tada ne renderuje chevron).
 */
export function visibleNavChildren(
  module: NavModule,
  can: (permission: Permission) => boolean,
): NavSubItem[] {
  if (!module.children?.length) return [];
  return module.children.filter((c) => !c.requires || can(c.requires));
}

/**
 * Tooltip za „↗" marker. Spoljašnji cilj (pogonski /kiosk) i unakrsna (crosslisted) kopija
 * dele isti glif (vizuelni paritet sa mockup-om, gde „↗" znači „isti link na dva mesta"),
 * ali znače različito — hover tekst ih razdvaja bez menjanja izgleda (DS §8: afordansa u
 * tooltip-u). Vraća undefined za obične stavke (bez markera).
 */
export function navModuleMarkerTitle(module: NavModule): string | undefined {
  if (module.external) return 'Otvara pogonski prikaz (kiosk)';
  if (module.crosslisted) return 'Ista stavka je i u drugom odeljku';
  return undefined;
}

/**
 * Modul po tačnom href-u (hub/paleta vuku label/icon/requires odavde). Za `crosslisted`
 * href vraća PRVU pojavu po redosledu modela (isti label/icon/requires u svim kopijama).
 */
export function findModuleByHref(href: string): NavModule | undefined {
  for (const domain of NAV_DOMAINS) {
    for (const m of allModules(domain)) {
      if (m.href === href) return m;
    }
  }
  return undefined;
}

/**
 * Najbliži modul za datu rutu (tačan pogodak ili prefiks; najduži href pobeđuje kao u
 * `findDomainByPath`) — za podrute (npr. /work-orders/123) vraća „Radni nalozi". `external`
 * stavke (kiosk) se preskaču. Koristi ga AI widget da opiše trenutni ekran korisniku.
 */
export function findModuleByPath(pathname: string): NavModule | undefined {
  let best: { module: NavModule; len: number } | undefined;
  for (const domain of NAV_DOMAINS) {
    for (const m of allModules(domain)) {
      if (m.external) continue;
      const len = hrefPath(m.href).length;
      if (matchesRoute(pathname, m.href) && (!best || len > best.len)) {
        best = { module: m, len };
      }
    }
  }
  return best?.module;
}

/**
 * Kratka, čitljiva oznaka trenutnog ekrana za AI asistenta (plutajući widget, zahtev
 * 003/26): naziv modula + ruta (npr. „Sastanci (/sastanci)"), pa domen ako modul nije
 * nađen, pa sirov pathname kao fallback. Backend je ubacuje u system prompt.
 */
export function screenContextForPath(pathname: string): string {
  const mod = findModuleByPath(pathname);
  // PODRUTA koja je PODSTAVKA modula (F2 pregrupisanje: /saldakonti/kursne-razlike,
  // /pdv/stope, /izvodi/kursna-lista, /saldakonti/kartica) ima svoje ime — bez ovoga bi je
  // AI opisao kao roditelja („Saldakonti"), jer `findModuleByPath` hvata prefiks. Poređenje je
  // po PUNOM href-u, pa deca sa query-jem (pogledi) ovde namerno ne prolaze — pathname ne
  // kaže koji je tab otvoren.
  const sub = mod?.children?.find((c) => c.href === pathname);
  if (sub) return `${sub.label} (${sub.href})`;
  // Stavka sa query href-om je POGLED modula (npr. /montaza?view=gantt), a sam pathname ne
  // kaže koji je pogled otvoren — tada je pošteniji naziv domena nego nasumičan pogled.
  if (mod && hrefPath(mod.href) === mod.href) return `${mod.label} (${mod.href})`;
  const dom = findDomainByPath(pathname);
  if (dom) return `${dom.title} (${pathname})`;
  return pathname;
}

/**
 * Razreši listu omiljenih href-ova (zahtev 010/26) na vidljive NavModule-e:
 *  • RBAC filter (`canAccessNavModule`) — href koji korisnik ne sme da vidi se izostavlja
 *    (ali ostaje u storage-u; pozivalac čuva sirovu listu);
 *  • nepostojeći href (preimenovan/uklonjen modul) se tiho ignoriše (findModuleByHref → undefined);
 *  • dedup po href-u (crosslisted modul = jedna stavka — findModuleByHref vraća prvu pojavu).
 * Redosled = redosled u `hrefs` (redosled dodavanja u omiljeno).
 */
export function resolveFavoriteModules(
  hrefs: string[],
  can: (permission: Permission) => boolean,
): NavModule[] {
  const out: NavModule[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    if (seen.has(href)) continue;
    const m = findModuleByHref(href);
    if (!m || !canAccessNavModule(m, can)) continue;
    seen.add(href);
    out.push(m);
  }
  return out;
}
