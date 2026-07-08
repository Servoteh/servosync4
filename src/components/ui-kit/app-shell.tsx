'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Briefcase,
  Building2,
  ClipboardList,
  DraftingCompass,
  LogOut,
  MapPin,
  PackageCheck,
  PencilRuler,
  RefreshCw,
  ShoppingCart,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
}

// Moduli iz DESIGN_SYSTEM.md §4. Bez href = placeholder (seli se u 3.0).
const NAV: NavItem[] = [
  { label: 'Radni nalozi', href: '/work-orders', icon: ClipboardList },
  { label: 'Tehnološki postupci', href: '/tech-processes', icon: Workflow },
  { label: 'PDM / Crteži', href: '/pdm', icon: DraftingCompass },
  { label: 'Nacrti', href: '/handovers', icon: PencilRuler },
  { label: 'Primopredaje', href: '/handovers', icon: PackageCheck },
  { label: 'Lokacije delova', href: '/part-locations', icon: MapPin },
  { label: 'Proizvodne strukture', href: '/structures', icon: Users },
  { label: 'MRP / Nabavka', href: '/mrp', icon: ShoppingCart },
  { label: 'Komitenti', href: '/customers', icon: Building2 },
  { label: 'Predmeti', href: '/projects', icon: Briefcase },
  { label: 'Sinhronizacije', href: '/syncs', icon: RefreshCw },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-full flex-1">
      <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col bg-sidebar text-sidebar-ink">
        <div className="flex h-[var(--command-bar-height)] items-center px-5 text-md font-semibold text-sidebar-ink-active">
          ServoSync
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map((item) => {
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
