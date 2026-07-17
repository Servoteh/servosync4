'use client';

// Sidebar v2 (F1 SIDEBAR_HUB) — „Harmonika": accordion po domenima + tri režima
// (full / rail / hidden) kao korisničko podešavanje, Ctrl+B toggle, hover-ivica,
// off-canvas < 1024px (hamburger u PageHeader-u) i auto-sklanjanje na „wide" (Gantt)
// rutama uz pin. Izvor navigacije = NAV_DOMAINS (F0, jedan izvor istine); RBAC filter
// i vizuelni jezik su IDENTIČNI današnjim — nove su samo afordanse sklanjanja/rail.
// AppShell zadržava javni API `{ children }` (19 stranica ga uvozi) i montira se per-page.

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  Bell,
  ChevronRight,
  Eye,
  LogOut,
  Menu,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import {
  NAV_DOMAINS,
  findDomainByPath,
  isWideRoute,
  type NavDomain,
  type NavModule,
} from '@/lib/navigation';
import {
  useUiPrefs,
  setSidebarMode,
  toggleSidebar as toggleSidebarMode,
  toggleDomain,
  pushRecentModule,
  type SidebarMode,
} from '@/lib/use-ui-prefs';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationsCount,
  type AppNotification,
} from '@/api/notifications';
import { CommandPalette } from '@/components/ui-kit/command-palette';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';

// ------------------------------------------------------------------ AppShellContext

/**
 * Shell izlaže usko stanje potomcima. PageHeader zna samo „da li sidebar ima svoju
 * kolonu" (→ hamburger) i „kako da ga otvori". null kada stranica nema AppShell
 * (kiosk/login) — potrošači tada rade graceful bez njega. Ovde je i predviđeno mesto
 * za montiranje Ctrl+K palete (F3, drugi agent) — kontekst je namerno čist.
 */
export interface AppShellContextValue {
  /** Sidebar trenutno nema svoju kolonu (mobilni / „hidden" režim / „wide" ruta). */
  sidebarHidden: boolean;
  /** Otvori sidebar kao overlay (poziva hamburger u PageHeader-u). */
  openSidebar: () => void;
  /** Otvori Ctrl+K paletu (vidljiva afordansa u PageHeader-u — DS §4/§8). */
  openPalette: () => void;
  /**
   * Runtime „wide" zahtev sa stranice (npr. Gantt pogled unutar modula sa više
   * pogleda) — sidebar se auto-sklanja dok je true. Koristi <WideMode/> helper.
   */
  setWideOverride: (wide: boolean) => void;
  /**
   * PageHeader se prijavljuje da postoji (nosi hamburger). Ako NIJEDAN nije
   * montiran (npr. /ai), shell renderuje sopstvenu plutajuću afordansu da
   * korisnik na mobilnom/hidden režimu ne ostane bez ulaza u navigaciju.
   * Vraća unregister funkciju.
   */
  registerHeaderAffordance: () => () => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

/** Čitaj stanje shell-a (PageHeader i buduće komponente). null van AppShell-a. */
export function useAppShell(): AppShellContextValue | null {
  return useContext(AppShellContext);
}

/**
 * Zvonce za PageHeader — montira se kad sidebar nema kolonu (mobilni/„hidden"/wide),
 * da notifikacije (badge nepročitanih) ne nestanu sa ekrana; paritet sa starim
 * shell-om gde je zvonce bilo vidljivo na svakoj stranici.
 */
export function HeaderBell() {
  const { user } = useAuth();
  return <NotificationBell enabled={!!user} variant="header" />;
}

/**
 * Deklarativni „wide" zahtev sa stranice: dok je montiran sa `active`, sidebar se
 * auto-sklanja (za Gantt poglede unutar modula sa više pogleda — npr. /montaza
 * ?view=gantt|total; cela ruta ne sme biti `wide` jer ima i tabelarne poglede).
 * Renderuje se kao dete AppShell-a: <WideMode active={view === 'gantt'} />.
 */
export function WideMode({ active }: { active: boolean }) {
  const shell = useAppShell();
  const set = shell?.setWideOverride;
  useEffect(() => {
    if (!set) return;
    set(active);
    return () => set(false);
  }, [active, set]);
  return null;
}

// ------------------------------------------------------------------ režimi (prikazne mape)

// Ciklus dugmeta u vrhu (full → rail → hidden → full). Ctrl+B toggle i persist su u
// use-ui-prefs; ovde su samo ikona + naziv + sledeći u ciklusu za prikaz.
const MODE_NEXT: Record<SidebarMode, SidebarMode> = { full: 'rail', rail: 'hidden', hidden: 'full' };
const MODE_ICON: Record<SidebarMode, LucideIcon> = { full: PanelLeftClose, rail: PanelLeftOpen, hidden: PanelLeft };
const MODE_LABEL: Record<SidebarMode, string> = { full: 'pun', rail: 'traka', hidden: 'skriven' };

/** Hover-intent i grace tajmeri za rail flyout (ms) — otvaranje/zatvaranje bez trzaja. */
const HOVER_INTENT_MS = 250;

/** Fokus prsten na tamnom sidebaru (kit obrazac iz button.tsx, sidebar varijanta tokena). */
const SB_FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-sidebar)]';

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
  handover_drafts: '/nacrti',
  drawing_handovers: '/handovers',
};

type BellVariant = 'sidebar' | 'rail' | 'header';

/**
 * Zvonce sa brojem nepročitanih (polling 30 s) + panel sa inbox-om. Backend
 * filtrira po radniku iz JWT-a (users.worker_id) — nalog bez vezanog radnika
 * ima prazan inbox. Klik na stavku = označi pročitanom + skok na modul.
 * `variant`: 'sidebar' (brand red, panel uz levu ivicu), 'rail' (panel uz rail),
 * 'header' (svetla površina PageHeader-a kad sidebar nema kolonu — zvonce ne sme
 * da nestane sa ekrana ni u „hidden"/wide/mobilnom režimu).
 */
function NotificationBell({ enabled, variant = 'sidebar' }: { enabled: boolean; variant?: BellVariant }) {
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
  // Esc ide u capture fazi + stopPropagation: zatvara SAMO panel (najviši sloj),
  // a ne i overlay sidebar ispod njega.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, { capture: true });
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
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

  const onHeader = variant === 'header';

  return (
    <div ref={rootRef} className={cn(onHeader && 'relative')}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `Notifikacije (${unread} nepročitanih)` : 'Notifikacije'}
        aria-expanded={open}
        className={cn(
          'relative rounded-control p-1.5',
          onHeader
            ? 'text-ink-secondary hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]'
            : cn('text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active', SB_FOCUS),
        )}
      >
        <Bell className="h-4 w-4" aria-hidden />
        {unread > 0 && (
          <span
            className={cn(
              'tnums absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 text-2xs font-semibold',
              onHeader ? 'text-surface' : 'text-sidebar-ink-active',
            )}
            aria-hidden
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            'z-50 w-96 max-w-[calc(100vw-16px)] rounded-panel border border-line bg-surface shadow-lg',
            variant === 'header' && 'absolute right-0 top-full mt-1',
            variant === 'rail' && 'fixed left-[var(--sidebar-rail-width)] top-[var(--command-bar-height)]',
            variant === 'sidebar' && 'fixed left-2 top-[var(--command-bar-height)]',
          )}
        >
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

// ------------------------------------------------------------------ nav stavke

/** Modul kao stavka u accordion-u (full režim). Klik navigira + upisuje u MRU (recent). */
function ModuleLink({
  module,
  active,
  onNavigate,
}: {
  module: NavModule;
  active: boolean;
  onNavigate: (href: string) => void;
}) {
  const Icon = module.icon;
  return (
    <Link
      href={module.href}
      onClick={() => onNavigate(module.href)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-control px-3 py-2 text-base max-lg:py-2.5',
        active
          ? 'bg-sidebar-line text-sidebar-ink-active'
          : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
        SB_FOCUS,
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', active && 'text-sidebar-accent')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{module.label}</span>
    </Link>
  );
}

// ------------------------------------------------------------------ FullBody (accordion)

interface FullBodyProps {
  domains: NavDomain[];
  pathname: string;
  activeDomainId?: string;
  openDomains: string[];
  onNavigate: (href: string) => void;
  bellEnabled: boolean;
  userEmail?: string;
  onLogout: () => void;
  hydrated: boolean;
  mode: SidebarMode;
  onCycleMode: () => void;
  showModeButton: boolean;
  onClose?: () => void; // X u overlay-u
  widePinned?: boolean; // „wide" ruta: pin kontrola (samo u overlay-u)
  onToggleWidePin?: () => void;
}

/** Puni sidebar: brand red (zvonce + kontrole) + accordion domena + footer. */
function FullBody(props: FullBodyProps) {
  const CycleIcon = MODE_ICON[props.mode];
  return (
    <>
      <div className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-between gap-1 px-5 text-md font-semibold text-sidebar-ink-active">
        <span className="truncate">ServoSync</span>
        <div className="flex items-center gap-0.5">
          <NotificationBell enabled={props.bellEnabled} />
          {props.onToggleWidePin && (
            <button
              type="button"
              onClick={props.onToggleWidePin}
              aria-pressed={props.widePinned}
              aria-label={props.widePinned ? 'Otkači navigaciju' : 'Zadrži navigaciju otvorenom'}
              title={props.widePinned ? 'Otkači navigaciju' : 'Zadrži navigaciju otvorenom'}
              className={cn(
                'grid h-9 w-9 place-items-center rounded-control hover:bg-sidebar-line max-lg:h-11 max-lg:w-11',
                props.widePinned ? 'text-sidebar-accent' : 'text-sidebar-ink hover:text-sidebar-ink-active',
                SB_FOCUS,
              )}
            >
              {props.widePinned ? <PinOff className="h-4 w-4" aria-hidden /> : <Pin className="h-4 w-4" aria-hidden />}
            </button>
          )}
          {props.showModeButton && (
            <button
              type="button"
              onClick={props.onCycleMode}
              title={`Prikaz navigacije: ${MODE_LABEL[props.mode]} — klik za sledeći (Ctrl+B)`}
              aria-label="Promeni prikaz navigacije"
              className={cn(
                'grid h-9 w-9 place-items-center rounded-control text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active max-lg:h-11 max-lg:w-11',
                SB_FOCUS,
              )}
            >
              <CycleIcon className="h-4 w-4" aria-hidden />
            </button>
          )}
          {props.onClose && (
            <button
              type="button"
              onClick={props.onClose}
              title="Zatvori navigaciju"
              aria-label="Zatvori navigaciju"
              className={cn(
                'grid h-9 w-9 place-items-center rounded-control text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active max-lg:h-11 max-lg:w-11',
                SB_FOCUS,
              )}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {props.domains.map((domain) => {
          const isActive = domain.id === props.activeDomainId;
          // Aktivni domen je UVEK otvoren (forsirano); ostali po ručnom stanju (persist).
          const open = isActive || props.openDomains.includes(domain.id);
          const DIcon = domain.icon;
          return (
            <div key={domain.id}>
              <button
                type="button"
                // Aktivni domen se ne može sklopiti (forsiran) → klik je no-op.
                onClick={() => {
                  if (!isActive) toggleDomain(domain.id);
                }}
                aria-expanded={open}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-base max-lg:py-2.5',
                  isActive
                    ? 'text-sidebar-ink-active'
                    : 'text-sidebar-ink hover:bg-sidebar-line/40 hover:text-sidebar-ink-active',
                  SB_FOCUS,
                )}
              >
                <DIcon
                  className={cn('h-4 w-4 shrink-0', isActive && 'text-sidebar-accent')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-left font-medium">{domain.title}</span>
                <ChevronRight
                  className={cn(
                    'h-4 w-4 shrink-0 text-sidebar-ink/50',
                    props.hydrated && 'transition-transform duration-150 motion-reduce:transition-none',
                    open && 'rotate-90',
                  )}
                  aria-hidden
                />
              </button>
              {open && (
                <div className="space-y-0.5 pb-1">
                  {domain.modules.map((m) => (
                    <ModuleLink
                      key={m.href}
                      module={m}
                      active={props.pathname === m.href}
                      onNavigate={props.onNavigate}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-line px-3 py-3">
        {props.userEmail && (
          <div className="truncate px-1 pb-2 text-xs text-sidebar-ink/70">{props.userEmail}</div>
        )}
        <button
          type="button"
          onClick={props.onLogout}
          className={cn(
            'flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-sm text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <LogOut className="h-4 w-4" aria-hidden />
          Odjava
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ RailBody (ikone + flyout)

/** Flyout panel jednog domena (rail režim): naslov + pin + moduli. */
function RailFlyout({
  domain,
  pathname,
  pinned,
  autoFocus,
  onTogglePin,
  onClose,
  onNavigate,
}: {
  domain: NavDomain;
  pathname: string;
  pinned: boolean;
  /** Fokusiraj prvi modul po otvaranju — SAMO za namerno otvaranje (klik/Enter);
      hover-otvaranje ne sme da otme fokus korisniku koji npr. kuca u filter polju. */
  autoFocus: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLAnchorElement>('a[href]')?.focus();
  }, [autoFocus]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const links = Array.from(ref.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []);
    if (links.length === 0) return;
    const idx = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = e.key === 'ArrowDown' ? (idx + 1) % links.length : (idx - 1 + links.length) % links.length;
    links[next]?.focus();
  }

  const DIcon = domain.icon;
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={domain.title}
      onKeyDown={onKeyDown}
      className="absolute left-full top-0 z-50 w-56 rounded-panel border border-sidebar-line bg-sidebar shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b border-sidebar-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <DIcon className="h-4 w-4 shrink-0 text-sidebar-accent" aria-hidden />
          <span className="truncate text-base font-medium text-sidebar-ink-active">{domain.title}</span>
        </div>
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={pinned}
          aria-label={pinned ? 'Otkači panel' : 'Zadrži panel otvoren'}
          title={pinned ? 'Otkači panel' : 'Zadrži panel otvoren'}
          className={cn(
            'shrink-0 rounded-control p-1',
            pinned ? 'text-sidebar-accent' : 'text-sidebar-ink hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          {pinned ? <PinOff className="h-3.5 w-3.5" aria-hidden /> : <Pin className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
      <div className="max-h-[70vh] space-y-0.5 overflow-y-auto p-1.5">
        {domain.modules.map((m) => {
          const active = pathname === m.href;
          const MIcon = m.icon;
          return (
            <Link
              key={m.href}
              href={m.href}
              role="menuitem"
              onClick={() => onNavigate(m.href)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-control px-2.5 py-2 text-base',
                active
                  ? 'bg-sidebar-line text-sidebar-ink-active'
                  : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
                SB_FOCUS,
              )}
            >
              <MIcon className={cn('h-4 w-4 shrink-0', active && 'text-sidebar-accent')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Vertikalna traka ikona domena; hover-intent/klik otvara flyout tog domena. */
function RailNav({
  domains,
  pathname,
  activeDomainId,
  onNavigate,
}: {
  domains: NavDomain[];
  pathname: string;
  activeDomainId?: string;
  onNavigate: (href: string) => void;
}) {
  // Jedan flyout u datom trenutku; `pinned` ga drži otvoren uprkos mouseleave-u;
  // `focus` = otvoren namerno (klik/Enter) → autofokus prvog modula.
  const [flyout, setFlyout] = useState<{ id: string; pinned: boolean; focus: boolean } | null>(null);
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function clearTimer(t: typeof enterTimer) {
    if (t.current) {
      clearTimeout(t.current);
      t.current = null;
    }
  }
  useEffect(() => () => {
    clearTimer(enterTimer);
    clearTimer(leaveTimer);
  }, []);

  function scheduleOpen(id: string) {
    clearTimer(leaveTimer);
    clearTimer(enterTimer);
    enterTimer.current = setTimeout(() => {
      setFlyout((f) => (f && f.pinned ? f : { id, pinned: false, focus: false }));
    }, HOVER_INTENT_MS);
  }
  function scheduleClose() {
    clearTimer(enterTimer);
    clearTimer(leaveTimer);
    leaveTimer.current = setTimeout(() => {
      setFlyout((f) => (f && f.pinned ? f : null));
    }, HOVER_INTENT_MS);
  }
  function openNow(id: string, focus: boolean) {
    clearTimer(enterTimer);
    clearTimer(leaveTimer);
    setFlyout({ id, pinned: false, focus });
  }
  function focusIcon(i: number) {
    iconRefs.current[i]?.focus();
  }

  function onIconKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, i: number, id: string) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusIcon(Math.min(i + 1, domains.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusIcon(Math.max(i - 1, 0));
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault();
      openNow(id, true);
    }
  }

  return (
    <nav aria-label="Glavna navigacija" className="w-full">
      <ul className="flex flex-col items-center gap-1">
        {domains.map((domain, i) => {
          const DIcon = domain.icon;
          const isActive = domain.id === activeDomainId;
          const isOpen = flyout?.id === domain.id;
          return (
            <li
              key={domain.id}
              className="relative"
              onMouseEnter={() => scheduleOpen(domain.id)}
              onMouseLeave={scheduleClose}
            >
              <button
                ref={(el) => {
                  iconRefs.current[i] = el;
                }}
                type="button"
                title={domain.title}
                aria-label={domain.title}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={() => (isOpen ? setFlyout(null) : openNow(domain.id, false))}
                onKeyDown={(e) => onIconKeyDown(e, i, domain.id)}
                className={cn(
                  'grid h-9 w-9 place-items-center rounded-control',
                  isActive || isOpen
                    ? 'bg-sidebar-line text-sidebar-ink-active'
                    : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
                  SB_FOCUS,
                )}
              >
                <DIcon className={cn('h-5 w-5', isActive && 'text-sidebar-accent')} aria-hidden />
              </button>
              {isOpen && (
                <RailFlyout
                  domain={domain}
                  pathname={pathname}
                  pinned={!!flyout?.pinned}
                  autoFocus={!!flyout?.focus}
                  onTogglePin={() => setFlyout((f) => (f ? { ...f, pinned: !f.pinned } : f))}
                  onClose={() => {
                    setFlyout(null);
                    focusIcon(i);
                  }}
                  onNavigate={(href) => {
                    onNavigate(href);
                    setFlyout(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface RailBodyProps {
  domains: NavDomain[];
  pathname: string;
  activeDomainId?: string;
  onNavigate: (href: string) => void;
  bellEnabled: boolean;
  onLogout: () => void;
  mode: SidebarMode;
  onCycleMode: () => void;
}

/** Uzana traka: dugme režima + zvonce + ikone domena (flyout) + odjava. */
function RailBody(props: RailBodyProps) {
  const CycleIcon = MODE_ICON[props.mode];
  return (
    <>
      <div className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={props.onCycleMode}
          title={`Prikaz navigacije: ${MODE_LABEL[props.mode]} — klik za sledeći (Ctrl+B)`}
          aria-label="Promeni prikaz navigacije"
          className={cn(
            'grid h-9 w-9 place-items-center rounded-control text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <CycleIcon className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {/* Bez overflow-scroll: flyout je absolute i ne sme biti odsečen (rail je kratak). */}
      <div className="flex flex-1 flex-col items-center gap-1 py-2">
        <NotificationBell enabled={props.bellEnabled} variant="rail" />
        <RailNav
          domains={props.domains}
          pathname={props.pathname}
          activeDomainId={props.activeDomainId}
          onNavigate={props.onNavigate}
        />
      </div>
      <div className="flex shrink-0 items-center justify-center border-t border-sidebar-line py-3">
        <button
          type="button"
          onClick={props.onLogout}
          title="Odjava"
          aria-label="Odjava"
          className={cn(
            'grid h-9 w-9 place-items-center rounded-control text-sidebar-ink hover:bg-sidebar-line hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <LogOut className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ AppShell

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout, can } = useAuth();
  const { sidebar: sidebarMode, openDomains, hydrated } = useUiPrefs();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Vidljivi domeni/moduli po ulozi — RBAC filter IDENTIČAN današnjem: stavka uz
  // can(requires), prazan domen se ne prikazuje. (Backend je izvor istine; ovo krije
  // afordanse, guard i dalje čuva rute.)
  const visibleDomains = NAV_DOMAINS.map((domain) => ({
    ...domain,
    modules: domain.modules.filter((m) => !m.requires || can(m.requires)),
  })).filter((domain) => domain.modules.length > 0);

  const activeDomainId = findDomainByPath(pathname)?.id;

  // Širina ekrana: < 1024px = mobilni (uvek off-canvas). matchMedia u efektu je
  // SSR-safe za static export: prvi paint pretpostavlja desktop (isto na serveru i
  // klijentu → nema hydration mismatch-a), pa se u efektu koriguje (kratak flash ok).
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setIsDesktop(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  const mobile = !isDesktop;

  // Hover-ivica postoji samo za miš (hover + fine pointer) — na touch uređaju bi
  // 12px zona uz ivicu otimala tapove. matchMedia u efektu (SSR-safe), ne CSS
  // varijanta: uslovni render je deterministički.
  const [finePointer, setFinePointer] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const apply = () => setFinePointer(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // „wide" = ruta iz nav modela ILI runtime zahtev stranice (<WideMode/>, npr.
  // Gantt pogled unutar /montaza koji ima i tabelarne poglede).
  const [wideOverride, setWideOverride] = useState(false);
  const wide = wideOverride || isWideRoute(pathname);

  // „wide" (Gantt) rute se auto-sklanjaju; pin je RUNTIME (ne dira trajni prefs.sidebar)
  // i drži overlay zaključan otvoren za tu sesiju. Reset pri izlasku na ne-wide rutu.
  const [widePinned, setWidePinned] = useState(false);
  useEffect(() => {
    if (!wide) setWidePinned(false);
  }, [wide]);

  // Broj montiranih PageHeader-a — ako je 0, shell renderuje sopstveni plutajući
  // hamburger (stranice bez komandne trake, npr. /ai, ne smeju biti ćorsokak).
  const headerCount = useRef(0);
  const [hasHeader, setHasHeader] = useState(false);
  const registerHeaderAffordance = useCallback(() => {
    headerCount.current += 1;
    setHasHeader(true);
    return () => {
      headerCount.current -= 1;
      if (headerCount.current <= 0) setHasHeader(false);
    };
  }, []);

  // Efektivni režim za RASPORED (ne dira trajni prefs): mobilni i wide su uvek „hidden".
  const effectiveMode: SidebarMode = mobile || wide ? 'hidden' : sidebarMode;
  const sidebarHidden = effectiveMode === 'hidden';

  // Overlay: mobilni hamburger / hidden hover-ivica / wide. `hover` = otvoren prelaskom
  // miša (zatvara se na mouseleave); inače (dugme/mobilni) = scrim + klik/Esc.
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayHover, setOverlayHover] = useState(false);
  const overlayLocked = !mobile && wide && widePinned;
  const showOverlay = sidebarHidden && (overlayOpen || overlayLocked);

  // Kad sidebar dobije svoju kolonu (prelaz na full/rail, resize na desktop), zatvori overlay.
  useEffect(() => {
    if (!sidebarHidden) {
      setOverlayOpen(false);
      setOverlayHover(false);
    }
  }, [sidebarHidden]);

  // Zatvori overlay na promenu rute (klik na modul već navigira).
  useEffect(() => {
    setOverlayOpen(false);
    setOverlayHover(false);
  }, [pathname]);

  // Ctrl+B: toggle tekući ↔ prethodni režim (persist u use-ui-prefs). Globalno, ali
  // NE dok korisnik kuca (input/textarea/select/contenteditable) — za razliku od
  // Ctrl+K palete, Ctrl+B nije dokumentovana „radi svuda" prečica. Bez Shift-a
  // (Ctrl+Shift+B je browser prečica za bookmarks traku). Na mobilnom/wide, gde
  // režim nema vidljiv efekat, Ctrl+B otvara/zatvara overlay umesto da TIHO
  // prepisuje trajni pref.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === 'b' || e.key === 'B') && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.closest('input, textarea, select') || t.isContentEditable)) return;
        e.preventDefault();
        if (mobile || wide) {
          setOverlayHover(false);
          setOverlayOpen((o) => !o);
        } else {
          toggleSidebarMode();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobile, wide]);

  // Esc zatvara overlay (peek/hamburger); na wide-locked overlay-u Esc i otključava.
  // Slojevitost: dok je paleta otvorena, Esc pripada NJOJ (zatvara samo najviši sloj),
  // a ne overlay-u — inače jedan Esc sruši i paletu i pin koji je korisnik postavio.
  useEffect(() => {
    if (!showOverlay || paletteOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (overlayLocked) setWidePinned(false);
        setOverlayOpen(false);
        setOverlayHover(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showOverlay, overlayLocked, paletteOpen]);

  function dismissOverlay() {
    if (overlayLocked) setWidePinned(false);
    setOverlayOpen(false);
    setOverlayHover(false);
  }

  // Hover-otvoren overlay nema scrim → klik van njega mora eksplicitno da zatvara
  // (mouseleave ne pokriva slučaj kad miš nikad ne uđe u panel, npr. brz dijagonalni
  // prelaz preko ivice).
  const overlayRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!showOverlay || !overlayHover || overlayLocked) return;
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setOverlayOpen(false);
        setOverlayHover(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [showOverlay, overlayHover, overlayLocked]);
  function onNavigate(href: string) {
    pushRecentModule(href);
    setOverlayOpen(false);
    setOverlayHover(false);
  }

  const ctx: AppShellContextValue = {
    sidebarHidden,
    openSidebar: () => {
      setOverlayHover(false);
      setOverlayOpen(true);
    },
    openPalette: () => setPaletteOpen(true),
    setWideOverride,
    registerHeaderAffordance,
  };

  // Bez border-r — stari sidebar nije imao desnu ivicu (vizuelni paritet).
  const surface = 'flex shrink-0 flex-col bg-sidebar text-sidebar-ink';

  return (
    <AppShellContext.Provider value={ctx}>
      <div className="flex min-h-full flex-1">
        {effectiveMode === 'full' && (
          <aside className={cn(surface, 'w-[var(--sidebar-width)]')}>
            <FullBody
              domains={visibleDomains}
              pathname={pathname}
              activeDomainId={activeDomainId}
              openDomains={openDomains}
              onNavigate={onNavigate}
              bellEnabled={!!user}
              userEmail={user?.email}
              onLogout={logout}
              hydrated={hydrated}
              mode={sidebarMode}
              onCycleMode={() => setSidebarMode(MODE_NEXT[sidebarMode])}
              showModeButton
            />
          </aside>
        )}
        {effectiveMode === 'rail' && (
          <aside className={cn(surface, 'w-[var(--sidebar-rail-width)]')}>
            <RailBody
              domains={visibleDomains}
              pathname={pathname}
              activeDomainId={activeDomainId}
              onNavigate={onNavigate}
              bellEnabled={!!user}
              onLogout={logout}
              mode={sidebarMode}
              onCycleMode={() => setSidebarMode(MODE_NEXT[sidebarMode])}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {user?.readOnly && (
            <div
              role="status"
              className="flex items-center gap-2 border-b border-status-warn/30 bg-status-warn-bg px-4 py-2 text-sm text-status-warn"
            >
              <Eye className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold">Test nalog — samo pregled.</span>{' '}
                Izmene i upisi nisu dozvoljeni.
              </span>
            </div>
          )}
          {children}
        </div>
      </div>

      {/* Hover-ivica: desktop + „hidden" (uklj. wide) → prelaz miša vraća sidebar kao
          overlay. Samo pointer fine + hover (touch koristi hamburger u PageHeader-u). */}
      {!mobile && finePointer && sidebarHidden && !showOverlay && (
        <div
          onMouseEnter={() => {
            setOverlayHover(true);
            setOverlayOpen(true);
          }}
          className="fixed left-0 top-0 z-30 h-full w-3"
          aria-hidden
        />
      )}

      {/* Fallback hamburger: stranica bez PageHeader-a (npr. /ai) + sakriven sidebar
          = bez ove afordanse korisnik na touch/mobilnom nema NIKAKAV ulaz u
          navigaciju (hover-ivica je samo za miš, Ctrl+B je tastatura). */}
      {sidebarHidden && !hasHeader && !showOverlay && (
        <button
          type="button"
          onClick={ctx.openSidebar}
          title="Otvori navigaciju"
          aria-label="Otvori navigaciju"
          className={cn(
            'fixed left-2 top-2 z-30 grid h-11 w-11 place-items-center rounded-control bg-sidebar text-sidebar-ink shadow-md hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
      )}

      {/* „wide" ruta: plutajući pin „zadrži navigaciju" uz levu ivicu (dok nije
          zaključana). Samo za miš — na touch uređaju istu ulogu ima hamburger. */}
      {!mobile && finePointer && wide && !widePinned && (
        <button
          type="button"
          onClick={() => setWidePinned(true)}
          title="Zadrži navigaciju otvorenom"
          aria-label="Zadrži navigaciju otvorenom"
          className={cn(
            'fixed left-0 top-1/2 z-30 grid h-10 w-6 -translate-y-1/2 place-items-center rounded-r-panel border border-l-0 border-sidebar-line bg-sidebar text-sidebar-ink shadow-md hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <Pin className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}

      {showOverlay && (
        <>
          {!overlayHover && !overlayLocked && (
            <div onClick={dismissOverlay} className="fixed inset-0 z-40 bg-black/40" aria-hidden />
          )}
          <aside
            ref={overlayRef}
            onMouseLeave={overlayHover && !overlayLocked ? dismissOverlay : undefined}
            className={cn(surface, 'fixed left-0 top-0 z-50 h-full w-[var(--sidebar-width)] shadow-2xl')}
          >
            <FullBody
              domains={visibleDomains}
              pathname={pathname}
              activeDomainId={activeDomainId}
              openDomains={openDomains}
              onNavigate={onNavigate}
              bellEnabled={!!user}
              userEmail={user?.email}
              onLogout={logout}
              hydrated={hydrated}
              mode={sidebarMode}
              onCycleMode={() => setSidebarMode(MODE_NEXT[sidebarMode])}
              // Na wide ruti promena režima nema vidljiv efekat (wide forsira hidden)
              // a TIHO bi prepisala trajni pref — zato bez dugmeta (kao na mobilnom).
              showModeButton={!mobile && !wide}
              onClose={dismissOverlay}
              widePinned={wide && !mobile ? widePinned : undefined}
              onToggleWidePin={wide && !mobile ? () => setWidePinned((p) => !p) : undefined}
            />
          </aside>
        </>
      )}

      {/* Ctrl+K komandna paleta — jedna instanca po shell-u; hotkey listener je u
          komponenti (Ctrl/Cmd+K radi i kad je sidebar sakriven). */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </AppShellContext.Provider>
  );
}
