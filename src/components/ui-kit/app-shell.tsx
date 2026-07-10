'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Briefcase,
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  DraftingCompass,
  ListChecks,
  ListOrdered,
  LogOut,
  MapPin,
  PackageCheck,
  PencilRuler,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  ShoppingCart,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
  /** Modul je vidljiv u nav-u samo ako uloga ima ovu permisiju (AUTHZ_UNIFIED §8 Faza 2b). */
  requires?: Permission;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

// Moduli iz DESIGN_SYSTEM.md §4. Bez href = placeholder (seli se u 3.0).
// Kucanje/Kontrola vode na pogonski kiosk (full-screen terminal, bez sidebar-a);
// kiosk sam bira režim po skeniranoj operaciji (`significantForFinishing`).
// `requires` = read/akcija permisija modula (vidljivost = paritet matrice RBAC §3).
//
// Sekcije = MES domeni (PLAN_MODULA_MES_3.0, 1.0 repo docs/ — Korak 1).
// ČISTO NAVIGACIONO grupisanje: rute i permisije netaknute. „Lokacije delova"
// (part-locations) je praćenje pozicija KROZ proizvodnju → domen Proizvodnja
// (1.0 „Lokacije delova" = fizičko skladištenje = budući domen Logistika).
// Komitenti/Predmeti su read-only matični podaci → Sistem (sele se u
// Komercijalu tek u 4.0). Moduli koji stižu seobom 3.0 uleću u svoje sekcije.
const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Proizvodnja',
    items: [
      { label: 'Kucanje (pogon)', href: '/kiosk', icon: ScanLine, requires: PERMISSIONS.TEHNOLOGIJA_REPORT_WORK },
      { label: 'Kontrola (pogon)', href: '/kiosk', icon: ShieldCheck, requires: PERMISSIONS.TEHNOLOGIJA_APPROVE },
      { label: 'Evidencija u proizvodnji', href: '/production-log', icon: ListChecks, requires: PERMISSIONS.TEHNOLOGIJA_READ },
      { label: 'Analitika vremena', href: '/session-analytics', icon: Clock, requires: PERMISSIONS.TEHNOLOGIJA_READ },
      { label: 'Radni nalozi', href: '/work-orders', icon: ClipboardList, requires: PERMISSIONS.RN_READ },
      { label: 'Operacije po prioritetu', href: '/operations-queue', icon: ListOrdered, requires: PERMISSIONS.RN_READ },
      { label: 'Završeni nalozi', href: '/completed-orders', icon: CheckCircle2, requires: PERMISSIONS.RN_READ },
      { label: 'Tehnološki postupci', href: '/tech-processes', icon: Workflow, requires: PERMISSIONS.TEHNOLOGIJA_READ },
      { label: 'Lokacije delova', href: '/part-locations', icon: MapPin, requires: PERMISSIONS.LOKACIJE_READ },
      { label: 'Proizvodne strukture', href: '/structures', icon: Users, requires: PERMISSIONS.STRUKTURE_READ },
      { label: 'MRP / Nabavka', href: '/mrp', icon: ShoppingCart, requires: PERMISSIONS.MRP_READ },
    ],
  },
  {
    title: 'Projektovanje',
    items: [
      { label: 'PDM / Crteži', href: '/pdm', icon: DraftingCompass, requires: PERMISSIONS.PDM_READ },
      { label: 'Nacrti', href: '/handovers', icon: PencilRuler, requires: PERMISSIONS.PRIMOPREDAJE_READ },
      { label: 'Primopredaje', href: '/handovers', icon: PackageCheck, requires: PERMISSIONS.PRIMOPREDAJE_READ },
    ],
  },
  {
    title: 'Sistem',
    items: [
      { label: 'Komitenti', href: '/customers', icon: Building2, requires: PERMISSIONS.DIRECTORY_READ },
      { label: 'Predmeti', href: '/projects', icon: Briefcase, requires: PERMISSIONS.DIRECTORY_READ },
      { label: 'Sinhronizacije', href: '/syncs', icon: RefreshCw, requires: PERMISSIONS.SYNC_READ },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout, can } = useAuth();

  // Vidljivi moduli po ulozi. Admin ima sve permisije → vidi ceo nav.
  // (Backend je izvor istine — ovo samo krije afordanse; guard i dalje čuva rute.)
  // Sekcija se prikazuje samo ako ima bar jednu vidljivu stavku.
  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.requires || can(item.requires)),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-full flex-1">
      <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col bg-sidebar text-sidebar-ink">
        <div className="flex h-[var(--command-bar-height)] items-center px-5 text-md font-semibold text-sidebar-ink-active">
          ServoSync
        </div>
        <nav className="flex-1 px-2 py-2">
          {visibleSections.map((section, sectionIndex) => (
            <div key={section.title}>
              <div
                className={cn(
                  'px-3 pb-1 text-xs font-semibold uppercase tracking-wider text-sidebar-ink/50',
                  sectionIndex === 0 ? 'pt-1' : 'pt-4',
                )}
              >
                {section.title}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = item.href && pathname === item.href;
                  const Icon = item.icon;
                  const inner = (
                    <span
                      className={cn(
                        'flex items-center gap-2.5 rounded-control px-3 py-2 text-base',
                        active
                          ? 'bg-sidebar-line text-sidebar-ink-active'
                          : item.href
                            ? 'hover:bg-sidebar-line/60 hover:text-sidebar-ink-active'
                            : 'cursor-default text-sidebar-ink/45',
                      )}
                    >
                      <Icon
                        className={cn('h-4 w-4', active && 'text-sidebar-accent')}
                        aria-hidden
                      />
                      {item.label}
                    </span>
                  );
                  return item.href ? (
                    <Link key={item.label} href={item.href} className="block">
                      {inner}
                    </Link>
                  ) : (
                    <div key={item.label} title="Uskoro (seoba u 3.0)">
                      {inner}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-line px-3 py-3">
          <div className="truncate px-1 pb-2 text-xs text-sidebar-ink/70">
            {user?.email}
          </div>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-sm text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Odjava
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
