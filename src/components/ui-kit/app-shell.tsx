'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  Bell,
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
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationsCount,
  type AppNotification,
} from '@/api/notifications';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';

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
      { label: 'Realizacija', href: '/tech-processes', icon: Workflow, requires: PERMISSIONS.TEHNOLOGIJA_READ },
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
    // MES domen (PLAN_MODULA_MES_3.0 §4) — prvi stanovnik: Reversi (3.0 pilot);
    // Održavanje (CMMS) i Energetika/SCADA ulaze seobom u 3.0-D.
    title: 'Oprema i energija',
    items: [
      { label: 'Reversi', href: '/reversi', icon: Wrench, requires: PERMISSIONS.REVERSI_READ },
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

// ------------------------------------------------------------------ zvonce (D8 notifikacije)

/** Tip notifikacije → StatusBadge (kanonska mapa, DESIGN_SYSTEM §7). */
const NOTIFICATION_BADGE: Record<string, { tone: Tone; label: string }> = {
  'kontrola.skart': { tone: 'danger', label: 'Škart' },
  'kontrola.dorada': { tone: 'warn', label: 'Dorada' },
  'primopredaja.nova': { tone: 'info', label: 'Primopredaja' },
  'primopredaja.preuzeta': { tone: 'info', label: 'Preuzeta izrada' },
};

/** refTable → ruta modula (navigacija na klik; bez deep-linka — lista modula). */
const NOTIFICATION_ROUTE: Record<string, string> = {
  work_orders: '/work-orders',
  handover_drafts: '/handovers',
  drawing_handovers: '/handovers',
};

/**
 * Zvonce sa brojem nepročitanih (polling 30 s) + panel sa inbox-om. Backend
 * filtrira po radniku iz JWT-a (users.worker_id) — nalog bez vezanog radnika
 * ima prazan inbox. Klik na stavku = označi pročitanom + skok na modul.
 */
function NotificationBell({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const unreadQ = useUnreadNotificationsCount(enabled);
  const listQ = useNotifications(enabled && open);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();

  const unread = unreadQ.data?.data.unread ?? 0;
  const rows = listQ.data?.data ?? [];

  // Esc + klik van panela zatvaraju (tastatura je deo definicije gotovog, §7).
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open]);

  function onActivate(n: AppNotification) {
    if (!n.readAt) markRead.mutate(n.id);
    const route = n.refTable ? NOTIFICATION_ROUTE[n.refTable] : undefined;
    if (route) router.push(route);
    setOpen(false);
  }

  if (!enabled) return null;

  return (
    <div ref={rootRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifikacije (${unread} nepročitanih)` : 'Notifikacije'}
        aria-expanded={open}
        className="relative rounded-control p-1.5 text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active"
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span
            className="tnums absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 text-2xs font-semibold text-sidebar-ink-active"
            aria-hidden
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-2 top-[var(--command-bar-height)] z-50 w-96 max-w-[calc(100vw-16px)] rounded-panel border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="text-base font-semibold text-ink">Notifikacije</span>
            {unread > 0 && (
              <button
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="rounded-control px-2 py-1 text-xs font-medium text-accent hover:bg-accent-subtle disabled:opacity-50"
              >
                Označi sve
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {listQ.isLoading ? (
              <div className="px-4 py-6 text-center text-sm text-ink-secondary">Učitavanje…</div>
            ) : listQ.error ? (
              <div className="px-4 py-6 text-center text-sm text-status-danger">
                Greška pri učitavanju notifikacija.
              </div>
            ) : rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-secondary">
                Nema notifikacija.
              </div>
            ) : (
              rows.map((n) => {
                const badge = NOTIFICATION_BADGE[n.type];
                return (
                  <button
                    key={n.id}
                    onClick={() => onActivate(n)}
                    className={cn(
                      'block w-full border-b border-line-soft px-4 py-2.5 text-left hover:bg-surface-2',
                      !n.readAt && 'bg-accent-subtle',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {badge ? (
                        <StatusBadge tone={badge.tone} label={badge.label} />
                      ) : (
                        <StatusBadge tone="neutral" label={n.type} />
                      )}
                      <span className="tnums ml-auto shrink-0 text-xs text-ink-secondary">
                        {formatDateTime(n.createdAt)}
                      </span>
                    </div>
                    <p className={cn('mt-1 text-sm text-ink', !n.readAt && 'font-medium')}>
                      {n.message}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
        <div className="flex h-[var(--command-bar-height)] items-center justify-between px-5 text-md font-semibold text-sidebar-ink-active">
          ServoSync
          <NotificationBell enabled={!!user} />
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
