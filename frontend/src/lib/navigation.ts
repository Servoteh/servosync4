// Navigacioni model — JEDAN izvor istine za sidebar, hub i Ctrl+K paletu (F0 SIDEBAR_HUB).
// Reorg 18.07.2026 (Nenad, SIDEBAR_THEME_SPEC §1): domeni dobijaju POD-GRUPE.
// „Tehnologija" je imenovana pod-grupa unutar „Proizvodnje"; „Kontrola kvaliteta" je
// svoj domen (+ diskretan spoljašnji link ka pogonskom /kiosk-u); Reversi je prešao u
// „Logistiku"; PDM/Nacrti/Primopredaje su u „Projektovanju"; „Lokacije delova" je
// UNAKRSNO navedena (crosslisted) na dva mesta — Tehnologija (praćenje kroz
// proizvodnju) i Logistika (fizičko skladištenje). RUTE I PERMISIJE su NETAKNUTE u
// odnosu na prethodni model — menja se samo grupisanje/redosled i vizuelni raspored.

import {
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
  Hammer,
  IdCard,
  ListChecks,
  ListOrdered,
  MapPin,
  PackageCheck,
  PencilRuler,
  Radar,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Users,
  Warehouse,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { PERMISSIONS, type Permission } from '@/lib/permissions';

export interface NavModule {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Modul je vidljiv u nav-u samo ako uloga ima ovu permisiju (AUTHZ_UNIFIED §8 Faza 2b). */
  requires?: Permission;
  /**
   * Vidljiv ako uloga ima BILO KOJU od ovih permisija (OR). Ima prednost nad
   * `requires` kad je zadat (koristi ga `canAccessNavModule`). Za stavke koje pripadaju
   * ukrštenim krugovima — npr. pogonski /kiosk (kvalitet ILI tehnologija).
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
      { label: 'Planiranje', href: '/plan-proizvodnje', icon: CalendarRange, requires: PERMISSIONS.PLAN_PROIZVODNJE_READ, wide: true, keywords: ['plan', 'proizvodnja', 'gantt'] },
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
          { label: 'Operacije po prioritetu', href: '/operations-queue', icon: ListOrdered, requires: PERMISSIONS.RN_READ, keywords: ['operacije', 'prioritet', 'red'] },
          { label: 'CAM programiranje', href: '/cnc-programs', icon: Cpu, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['cam', 'cnc', 'program'] },
          { label: 'Završeni nalozi', href: '/completed-orders', icon: CheckCircle2, requires: PERMISSIONS.RN_READ, keywords: ['zavrseni', 'arhiva'] },
          { label: 'Evidencija u proizvodnji', href: '/production-log', icon: ListChecks, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['evidencija', 'log'] },
          { label: 'Analitika vremena', href: '/session-analytics', icon: Clock, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['vreme', 'analitika', 'sesije'] },
          { label: 'Proizvodne strukture', href: '/structures', icon: Users, requires: PERMISSIONS.STRUKTURE_READ, keywords: ['strukture', 'bom'] },
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
      { label: 'Kontrola kvaliteta', href: '/kvalitet', icon: ShieldCheck, requires: PERMISSIONS.KVALITET_READ, keywords: ['kk', 'skart', 'dorada', 'kontrola'] },
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
      { label: 'Projektni biro', href: '/pb', icon: FolderKanban, requires: PERMISSIONS.PB_READ, keywords: ['pb', 'projekti', 'kanban'] },
      { label: 'PDM / Crteži', href: '/pdm', icon: DraftingCompass, requires: PERMISSIONS.PDM_READ, keywords: ['crtez', 'bom', 'pdm', 'nacrt'] },
      // Nacrti (projektanti, gate write) i Primopredaje su ODVOJENE rute —
      // deljena ruta je palila obe stavke kao aktivne istovremeno (ODLUKE #33).
      // „Nacrti" ostaje `primopredaje.write` (radni prostor projektanata).
      // „Primopredaje" je od 16.07 vidljivo SVIM rolama (Nenad: `primopredaje.read`
      // — čist pregled ko je pustio/šta/status; mutirajuće akcije u tabovima su
      // svaka iza svog <Can> approve/write, pa read-only korisnik ne vidi dugmad).
      { label: 'Nacrti', href: '/nacrti', icon: PencilRuler, requires: PERMISSIONS.PRIMOPREDAJE_WRITE, keywords: ['nacrti', 'projektanti'] },
      { label: 'Primopredaje', href: '/handovers', icon: PackageCheck, requires: PERMISSIONS.PRIMOPREDAJE_READ, keywords: ['primopredaja', 'predaja'] },
    ],
  },
  {
    // Talas C — Montaža i servis (Plan montaže: Plan/Gantt/Ukupan Gant/Izveštaji montera).
    id: 'montaza',
    title: 'Montaža i servis',
    icon: Hammer,
    modules: [
      // BEZ `wide` na celoj ruti: /montaza ima i tabelarne poglede (hub/plan/izveštaji);
      // Gantt pogledi (?view=gantt|total) traže wide RUNTIME kroz <WideMode/> u strani.
      { label: 'Plan montaže', href: '/montaza', icon: Hammer, requires: PERMISSIONS.MONTAZA_READ, keywords: ['montaza', 'gantt', 'monteri'] },
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
      { label: 'Lokacije', href: '/lokacije', icon: Warehouse, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'skladiste', 'police'] },
      // Unakrsno (crosslisted) — primarni dom je pod-grupa „Tehnologija".
      { label: 'Lokacije delova', href: '/part-locations', icon: MapPin, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'pozicije'], crosslisted: true },
      { label: 'Reversi', href: '/reversi', icon: Wrench, requires: PERMISSIONS.REVERSI_READ, keywords: ['reversi', 'alat'] },
    ],
  },
  {
    // Oprema i energija — Održavanje (CMMS) i Energetika/SCADA.
    id: 'oprema-energija',
    title: 'Oprema i energija',
    icon: Wrench,
    modules: [
      { label: 'Održavanje', href: '/odrzavanje', icon: Cog, requires: PERMISSIONS.ODRZAVANJE_READ, keywords: ['odrzavanje', 'cmms'] },
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
      { label: 'Kadrovska', href: '/kadrovska', icon: IdCard, requires: PERMISSIONS.KADROVSKA_READ, keywords: ['kadrovska', 'hr', 'zaposleni'] },
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
      { label: 'Sastanci', href: '/sastanci', icon: CalendarClock, requires: PERMISSIONS.SASTANCI_READ, keywords: ['sastanci', 'meeting'] },
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
    modules: [
      // Postepeno (Faza po faza) — otkomentarisati modul kad je ruta+permisija spremna:
      // Traka B (SPRINT — prvi): Nabavka
      { label: 'Nabavka', href: '/nabavka', icon: PackageCheck, requires: PERMISSIONS.NABAVKA_READ, keywords: ['nabavka', 'upit', 'narudzbenica', 'dobavljac'] },
      // Traka B: RFQ kupca → predmet
      // { label: 'Upiti kupaca', href: '/rfqs', icon: ClipboardList, requires: PERMISSIONS.SALES_READ, keywords: ['rfq', 'zahtev za ponudu', 'upit kupca'] },
      // Faza 5: Predračuni & računi (izlazni, dom+izvoz)
      // { label: 'Predračuni & računi', href: '/fakturisanje', icon: ListOrdered, requires: PERMISSIONS.SALES_READ, keywords: ['faktura', 'racun', 'predracun', 'profaktura', 'izvoz'] },
      // Faza 5: e-Fakture (SEF)
      // { label: 'e-Fakture (SEF)', href: '/sef', icon: RefreshCw, requires: PERMISSIONS.SEF_READ, keywords: ['sef', 'efaktura', 'ubl'] },
      // Faza 3: Zalihe & kalkulacija (crosslisted u Logistiku)
      // { label: 'Zalihe & kalkulacija', href: '/robno', icon: Warehouse, requires: PERMISSIONS.ROBNO_READ, keywords: ['zalihe', 'lager', 'kalkulacija', 'primka', 'popis', 'nivelacija'], crosslisted: true },
    ],
  },
  {
    id: 'finansije',
    title: 'Finansije',
    icon: SlidersHorizontal,
    modules: [
      // Faza 2: Glavna knjiga
      // { label: 'Glavna knjiga', href: '/glavna-knjiga', icon: ListChecks, requires: PERMISSIONS.GL_READ, keywords: ['gk', 'nalozi', 'kontni plan', 'dnevnik', 'bruto bilans'] },
      // Faza 4: Saldakonti (otvorene stavke, IOS, kompenzacija)
      // { label: 'Saldakonti', href: '/saldakonti', icon: Users, requires: PERMISSIONS.SALDAKONTI_READ, keywords: ['otvorene stavke', 'ios', 'aging', 'kompenzacija'] },
      // Faza 4: Banka & plaćanja (izvodi, priprema plaćanja, virmani)
      // { label: 'Banka & plaćanja', href: '/placanja', icon: Building2, requires: PERMISSIONS.PLACANJA_READ, keywords: ['banka', 'izvod', 'virman', 'nalog za placanje', 'priprema placanja'] },
      // Faza 6: PDV & POPDV
      // { label: 'PDV & POPDV', href: '/pdv', icon: ShieldCheck, requires: PERMISSIONS.PDV_READ, keywords: ['pdv', 'popdv', 'pppdv', 'kif', 'kuf'] },
      // Faza 7: Završni račun (bilansi, APR)
      // { label: 'Završni račun', href: '/zavrsni-racun', icon: CheckCircle2, requires: PERMISSIONS.ZR_READ, keywords: ['bilans', 'zavrsni racun', 'apr', 'popdv'] },
    ],
  },
  {
    id: 'sistem',
    title: 'Sistem',
    icon: SlidersHorizontal,
    modules: [
      // Podešavanja (3.0 TALAS D) — RBAC admin konzola + matični + sistem.
      // Vidljivost = settings.org_profile (admin/menadzment/pm/leadpm = 1.0
      // canAccessPodesavanja); admin-only tabovi se dodatno gejtuju u samoj strani.
      { label: 'Podešavanja', href: '/podesavanja', icon: SlidersHorizontal, requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['podesavanja', 'settings', 'rbac', 'izgled', 'tema'] },
      { label: 'Komitenti', href: '/customers', icon: Building2, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['komitenti', 'kupci', 'klijenti'] },
      { label: 'Predmeti', href: '/projects', icon: Briefcase, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['predmeti', 'projekti'] },
      { label: 'Sinhronizacije', href: '/syncs', icon: RefreshCw, requires: PERMISSIONS.SYNC_READ, keywords: ['sync', 'sinhronizacija'] },
    ],
  },
];

// ------------------------------------------------------------------ helperi

/** Ruta modula je „aktivna" za pathname ako je tačan pogodak ili prefiks (podruta). */
function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
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
      if (matchesRoute(pathname, m.href) && (!best || m.href.length > best.len)) {
        best = { domain, len: m.href.length };
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
): boolean {
  if (pathname !== module.href) return false;
  if (module.crosslisted) return findDomainByPath(pathname)?.id === ownerDomainId;
  return true;
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
