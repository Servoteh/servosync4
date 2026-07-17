// Navigacioni model — JEDAN izvor istine za sidebar, hub i Ctrl+K paletu (F0 SIDEBAR_HUB).
// Preneto IDENTIČNO iz `NAV_SECTIONS` (app-shell.tsx) — iste stavke, iste permisije,
// isti redosled, prekopirani komentari sa odlukama (nose istoriju). NOVO u odnosu na
// staru listu: ikona domena (accordion header + rail), `wide` (Gantt auto-hide) i
// `keywords` (Ctrl+K sinonimi). NIŠTA nije dodato/menjano u permisijama ni rutama.

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
  /** Ruta „širokog" ekrana (Gantt) — sidebar se auto-sklanja (F1). */
  wide?: boolean;
  /** Dodatne reči za Ctrl+K pretragu (sinonimi, QBigTehn nazivi). */
  keywords?: string[];
}

export interface NavDomain {
  id: string; // stabilan slug: 'proizvodnja', 'montaza', ...
  title: string; // naslov sekcije kao danas
  icon: LucideIcon; // NOVO — ikona domena za accordion header i rail
  modules: NavModule[];
}

// Moduli iz DESIGN_SYSTEM.md §4. Bez href = placeholder (seli se u 3.0).
// Pogonski kiosk (/kiosk) NEMA nav stavku (12.07.2026): otvara se direktnim
// URL-om na terminalima ili preko 1.0 HUB pločica „Kucanje (pogon)" /
// „Kontrola (pogon)" (iframe deep-link); kiosk sam bira režim po skeniranoj
// operaciji (`significantForFinishing`).
// `requires` = read/akcija permisija modula (vidljivost = paritet matrice RBAC §3).
//
// Domeni = MES domeni (PLAN_MODULA_MES_3.0, 1.0 repo docs/ — Korak 1).
// ČISTO NAVIGACIONO grupisanje: rute i permisije netaknute. „Lokacije delova"
// (part-locations) je praćenje pozicija KROZ proizvodnju → domen Proizvodnja
// (1.0 „Lokacije delova" = fizičko skladištenje = budući domen Logistika).
// Komitenti/Predmeti su read-only matični podaci → Sistem (sele se u
// Komercijalu tek u 4.0). Moduli koji stižu seobom 3.0 uleću u svoje domene.
export const NAV_DOMAINS: NavDomain[] = [
  {
    id: 'proizvodnja',
    title: 'Proizvodnja',
    icon: Factory,
    modules: [
      { label: 'Evidencija u proizvodnji', href: '/production-log', icon: ListChecks, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['evidencija', 'log'] },
      { label: 'Analitika vremena', href: '/session-analytics', icon: Clock, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['vreme', 'analitika', 'sesije'] },
      { label: 'Radni nalozi', href: '/work-orders', icon: ClipboardList, requires: PERMISSIONS.RN_READ, keywords: ['rn', 'nalozi'] },
      { label: 'Operacije po prioritetu', href: '/operations-queue', icon: ListOrdered, requires: PERMISSIONS.RN_READ, keywords: ['operacije', 'prioritet', 'red'] },
      // Talas C — Plan proizvodnje (Planiranje) + Praćenje proizvodnje.
      { label: 'Planiranje', href: '/plan-proizvodnje', icon: CalendarRange, requires: PERMISSIONS.PLAN_PROIZVODNJE_READ, wide: true, keywords: ['plan', 'proizvodnja', 'gantt'] },
      { label: 'Praćenje', href: '/pracenje-proizvodnje', icon: Radar, requires: PERMISSIONS.PRACENJE_READ, keywords: ['pracenje', 'status'] },
      { label: 'CAM programiranje', href: '/cnc-programs', icon: Cpu, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['cam', 'cnc', 'program'] },
      { label: 'Završeni nalozi', href: '/completed-orders', icon: CheckCircle2, requires: PERMISSIONS.RN_READ, keywords: ['zavrseni', 'arhiva'] },
      { label: 'Realizacija', href: '/tech-processes', icon: Workflow, requires: PERMISSIONS.TEHNOLOGIJA_READ, keywords: ['tp', 'kucanje', 'tehnoloski postupak'] },
      { label: 'Kontrola kvaliteta', href: '/kvalitet', icon: ShieldCheck, requires: PERMISSIONS.KVALITET_READ, keywords: ['kk', 'skart', 'dorada', 'kontrola'] },
      { label: 'Lokacije delova', href: '/part-locations', icon: MapPin, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'pozicije'] },
      { label: 'Proizvodne strukture', href: '/structures', icon: Users, requires: PERMISSIONS.STRUKTURE_READ, keywords: ['strukture', 'bom'] },
      { label: 'MRP / Nabavka', href: '/mrp', icon: ShoppingCart, requires: PERMISSIONS.MRP_READ, keywords: ['mrp', 'nabavka'] },
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
    // Lično (3.0 TALAS D) — Moj profil je self-service agregator za svakog
    // prijavljenog (profile.self = SELECT true paritet). Top-level, van MES domena.
    id: 'licno',
    title: 'Lično',
    icon: CircleUser,
    modules: [
      { label: 'Moj profil', href: '/profil', icon: CircleUser, requires: PERMISSIONS.PROFILE_SELF, keywords: ['profil', 'moj'] },
    ],
  },
  {
    // Logistika (PLAN_MODULA_MES_3.0 §4 / MODULE_SPEC_lokacije_30 §4) — 1.0 fizičke
    // lokacije (hale/police/kavezi/mašine, loc_*) seobom Talas A. ODVOJENO od
    // „Lokacije delova" (part-locations, Proizvodnja) — QBigTehn ledger; ne stapaju se.
    id: 'logistika',
    title: 'Logistika',
    icon: Warehouse,
    modules: [
      { label: 'Lokacije', href: '/lokacije', icon: Warehouse, requires: PERMISSIONS.LOKACIJE_READ, keywords: ['lokacije', 'skladiste', 'police'] },
    ],
  },
  {
    // MES domen (PLAN_MODULA_MES_3.0 §4) — prvi stanovnik: Reversi (3.0 pilot);
    // Energetika/SCADA je seljena u Talasu E; Održavanje (CMMS) ulazi kasnije.
    id: 'oprema-energija',
    title: 'Oprema i energija',
    icon: Wrench,
    modules: [
      { label: 'Reversi', href: '/reversi', icon: Wrench, requires: PERMISSIONS.REVERSI_READ, keywords: ['reversi', 'alat'] },
      { label: 'Održavanje', href: '/odrzavanje', icon: Cog, requires: PERMISSIONS.ODRZAVANJE_READ, keywords: ['odrzavanje', 'cmms'] },
      // Energetika/SCADA — vidljiva SAMO admin+menadzment (energetika.read; paritet 1.0).
      { label: 'Energetika', href: '/energetika', icon: Zap, requires: PERMISSIONS.ENERGETIKA_READ, keywords: ['energetika', 'scada', 'struja'] },
    ],
  },
  {
    // Kadrovska (HR) — 3.0 Talas G (POSLEDNJI; PII + zarade). Vidljivost = `kadrovska.read`
    // (paritet 1.0 canAccessKadrovska). Interni tabovi/hub gejtuju stroža prava.
    id: 'kadrovska',
    title: 'Kadrovska',
    icon: IdCard,
    modules: [
      { label: 'Kadrovska', href: '/kadrovska', icon: IdCard, requires: PERMISSIONS.KADROVSKA_READ, keywords: ['kadrovska', 'hr', 'zaposleni'] },
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
  {
    id: 'sistem',
    title: 'Sistem',
    icon: SlidersHorizontal,
    modules: [
      // Podešavanja (3.0 TALAS D) — RBAC admin konzola + matični + sistem.
      // Vidljivost = settings.org_profile (admin/menadzment/pm/leadpm = 1.0
      // canAccessPodesavanja); admin-only tabovi se dodatno gejtuju u samoj strani.
      { label: 'Podešavanja', href: '/podesavanja', icon: SlidersHorizontal, requires: PERMISSIONS.SETTINGS_ORG_PROFILE, keywords: ['podesavanja', 'settings', 'rbac'] },
      { label: 'Komitenti', href: '/customers', icon: Building2, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['komitenti', 'kupci', 'klijenti'] },
      { label: 'Predmeti', href: '/projects', icon: Briefcase, requires: PERMISSIONS.DIRECTORY_READ, keywords: ['predmeti', 'projekti'] },
      { label: 'Sinhronizacije', href: '/syncs', icon: RefreshCw, requires: PERMISSIONS.SYNC_READ, keywords: ['sync', 'sinhronizacija'] },
    ],
  },
  // „Razvojna faza" domen uklonjen 17.07.2026 (Nenad): svi moduli su prešli na 2.0
  // prikaz, pa je indeks WIP modula duplirao stavke koje već žive u svojim domenima.
  // Sa njim je uklonjen i „u razvoju" badge (RAZVOJ_WIP prazan) i /razvoj strana.
];

// ------------------------------------------------------------------ helperi

/** Ruta modula je „aktivna" za pathname ako je tačan pogodak ili prefiks (podruta). */
function matchesRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

/**
 * Domen kome pripada trenutna ruta (prefiks-match po href-u; najduži pogodak
 * pobeđuje kad se rute preklapaju). Sidebar ga forsira otvorenim (F1).
 */
export function findDomainByPath(pathname: string): NavDomain | undefined {
  let best: { domain: NavDomain; len: number } | undefined;
  for (const domain of NAV_DOMAINS) {
    for (const m of domain.modules) {
      if (matchesRoute(pathname, m.href) && (!best || m.href.length > best.len)) {
        best = { domain, len: m.href.length };
      }
    }
  }
  return best?.domain;
}

/** Da li je ruta „široka" (Gantt) — sidebar se auto-sklanja pri ulasku (F1). */
export function isWideRoute(pathname: string): boolean {
  return NAV_DOMAINS.some((d) => d.modules.some((m) => m.wide && matchesRoute(pathname, m.href)));
}

/** Modul po tačnom href-u (hub/paleta vuku label/icon/requires odavde). */
export function findModuleByHref(href: string): NavModule | undefined {
  for (const domain of NAV_DOMAINS) {
    for (const m of domain.modules) {
      if (m.href === href) return m;
    }
  }
  return undefined;
}
