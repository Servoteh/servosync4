'use client';

// Sidebar v2 (F1 SIDEBAR_HUB) — „Harmonika": accordion po domenima + tri režima
// (full / rail / hidden) kao korisničko podešavanje, Ctrl+B toggle, hover-ivica,
// off-canvas < 1024px (hamburger u PageHeader-u) i auto-sklanjanje na „wide" (Gantt)
// rutama uz pin. Izvor navigacije = NAV_DOMAINS (F0, jedan izvor istine); RBAC filter
// i vizuelni jezik su IDENTIČNI današnjim — nove su samo afordanse sklanjanja/rail.
// AppShell zadržava javni API `{ children }` (19 stranica ga uvozi) i montira se per-page.
//
// PODMENIJI F0 (PLAN_NAV_PODMENIJI §5): modul sme da ima `children` (pogledi/tabovi) —
// red dobija chevron, podstavke se renderuju uvučene ispod njega u sva tri layouta, a u
// rail režimu ugnježdene u flyout panelu domena. Href podstavke sme da nosi query, pa se
// aktivnost računa nad pathname + query (`useCurrentSearch`).

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
  ArrowUpRight,
  Bell,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  LogOut,
  Menu,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Star,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import {
  NAV_DOMAINS,
  allModules,
  canAccessNavModule,
  findDomainByPath,
  isNavModuleActive,
  isNavModuleRouteCurrent,
  isNavSubItemActive,
  isWideRoute,
  navModuleMarkerTitle,
  resolveFavoriteModules,
  screenContextForPath,
  visibleNavChildren,
  type NavDomain,
  type NavModule,
  type NavSubGroup,
  type NavSubItem,
} from '@/lib/navigation';
import { PERMISSIONS } from '@/lib/permissions';
import { useNavFavorites } from '@/lib/use-nav-favorites';
import { FavStar } from '@/components/ui-kit/fav-star';
import {
  useUiPrefs,
  setSidebarMode,
  toggleSidebar as toggleSidebarMode,
  setOpenDomains,
  setOpenModules,
  toggleDomain,
  toggleModule,
  pushRecentModule,
  type SidebarMode,
  type SidebarLayout,
} from '@/lib/use-ui-prefs';
import { NAV_EVENT, emitNavEvent, type NavEventDetail } from '@/lib/use-query-tab';
import { isModifiedNavClick, type NavClickLike } from '@/lib/nav-click';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadNotificationsCount,
  type AppNotification,
} from '@/api/notifications';
import { CommandPalette } from '@/components/ui-kit/command-palette';
import { AiWidget } from '@/components/ui-kit/ai-widget';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { notificationBadge, resolveNotificationRoute } from '@/lib/notifications-nav';
import { toast } from '@/lib/toast';
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

/** Slug sintetičkog „Omiljeno" domena u rail režimu (nije prava ruta — samo flyout grupa). */
const FAVORITES_DOMAIN_ID = '__favorites';

/**
 * Tekući query string („?view=gantt") — potreban za highlight podstavki podmenija, jer
 * `usePathname()` NIKAD ne nosi query (PLAN_NAV_PODMENIJI §4.1), a `useSearchParams()` je
 * zabranjen pod static export-om (bailout na Suspense). Čita se `window.location.search` —
 * isti obrazac koji strane već koriste za deep-link.
 *
 * SSR-safe: prvi paint je '' (isto na serveru i klijentu → nema hydration mismatch-a), pa se
 * koriguje u efektu. Osvežava se na promenu rute, `popstate` (nazad/napred) i na custom
 * event `servosync:nav` (F1 kanal, `use-query-tab.ts`).
 *
 * Event sme da nosi `detail.href` — cilj navigacije koja se TEK dešava (klik na podstavku:
 * `onClick` prethodi promeni URL-a). Tada se query čita iz href-a, ali samo ako je pathname
 * isti; za drugu rutu se poruka ignoriše, jer promena pathname-a ionako ponovo pokreće efekat
 * i tada je `window.location` već tačan. Bez detalja = URL je već ažuran (`replaceState` iz
 * strane) → čita se `window.location`.
 */
function useCurrentSearch(pathname: string): string {
  const [search, setSearch] = useState('');
  useEffect(() => {
    const read = () => setSearch(window.location.search);
    read();
    const onNav = (e: Event) => {
      const href = (e as CustomEvent<NavEventDetail>).detail?.href;
      if (!href) {
        read();
        return;
      }
      try {
        const url = new URL(href, window.location.origin);
        if (url.pathname === window.location.pathname) setSearch(url.search);
      } catch {
        /* neispravan href — zadrži tekući query */
      }
    };
    window.addEventListener('popstate', read);
    window.addEventListener(NAV_EVENT, onNav);
    return () => {
      window.removeEventListener('popstate', read);
      window.removeEventListener(NAV_EVENT, onNav);
    };
  }, [pathname]);
  return search;
}

// ------------------------------------------------------------------ zvonce (D8 notifikacije)

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

  /**
   * Klik na stavku panela (C20). Tri stvari koje su ranije falile:
   *
   * 1) `emitNavEvent(route)` PRE `router.push` — zvonce stoji na SVAKOJ strani, pa je klik
   *    često navigacija na stranu na kojoj korisnik VEĆ jeste. Next tada ne remount-uje
   *    stranu (query nije deo ključa za remount), a `router.push` ne okida `popstate` —
   *    adresa se promeni, ekran ostane isti. `servosync:nav` je kućni kanal kojim sidebar i
   *    paleta javljaju cilj (`useQueryTab`/`useIdParam` ga slušaju); bez njega
   *    `/odrzavanje?tab=masine` ne prebaci tab, a to je 4 izmerena klika koja su ljude
   *    ostavila na tabu „Pregled".
   * 2) Rute za `quality_events` i `app_switches` (v. `lib/notifications-nav.ts`).
   * 3) Poruka kad rute NEMA. Tiho zatvaranje panela izgleda kao da je akcija uspela —
   *    gore je od greške, jer korisnik ne zna da treba da traži drugim putem.
   */
  function onActivate(n: AppNotification) {
    if (!n.readAt) markRead.mutate(n.id);
    const route = resolveNotificationRoute(n.refTable, n.refId);
    setOpen(false);
    if (!route) {
      toast('Ovo obaveštenje nema ekran na koji vodi — označeno je pročitanim.');
      return;
    }
    emitNavEvent(route);
    router.push(route);
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
                const badge = notificationBadge(n.type);
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
                      <StatusBadge tone={badge.tone} label={badge.label} />
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

// ------------------------------------------------------------------ nav stavke (full)

/**
 * Klik na nav stavku. `mruHref` je href MODULA — MRU („Nedavno") i „Omiljeno" ostaju na nivou
 * modula (F0), pa podstavka prosleđuje RODITELJEV href. `navHref` je stvarni cilj navigacije
 * (podstavka nosi query, npr. `/odrzavanje?tab=kvarovi`); shell ga javlja kroz `servosync:nav`
 * da bi strana koja ostaje montirana promenila tab (PLAN_NAV_PODMENIJI §4.3). Bez njega se
 * podrazumeva `mruHref` (obični redovi modula — href reda JESTE cilj).
 *
 * Događaj klika je PRVI argument i nije opcion namerno: nav event sme da se emituje samo za
 * običan levi klik (v. `lib/nav-click.ts`). Ctrl/⌘-klik na podstavku otvara nov tab, a tekuća
 * strana mora da ostane na svom pogledu — nov `<Link>` koji zaboravi da prosledi događaj ne
 * prolazi `tsc`, pa gard ne može da se izgubi kao komentar.
 */
type NavigateHandler = (e: NavClickLike, mruHref: string, navHref?: string) => void;

/**
 * Podstavka modula (treći nivo — pogled/tab, PLAN_NAV_PODMENIJI §4.2) u punom sidebaru:
 * uvučena, manja (text-sm), bez ikone, u okviru sa levom linijom (vizuelni jezik
 * `SidebarSubGroup`-a). Kad je aktivna, ONA nosi `aria-current="page"` — roditeljski red
 * tada dobija samo stil (jedan aria-current po ekranu; ODLUKA #33).
 * MRU/Omiljeno ostaju na nivou modula (F0): `onNavigate` dobija RODITELJEV href.
 */
function SidebarSubItemRow({
  item,
  parentHref,
  active,
  onNavigate,
}: {
  item: NavSubItem;
  parentHref: string;
  active: boolean;
  onNavigate: NavigateHandler;
}) {
  return (
    <Link
      href={item.href}
      // MRU ide na modul, cilj navigacije je pun href podstavke (query!) — shell ga
      // emituje kao `servosync:nav`, pa strana menja tab i bez remount-a (§4.3).
      onClick={(e) => onNavigate(e, parentHref, item.href)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        // max-lg:min-h-11 = touch-meta ≥44px na <1024px (DS §11), kao i redovi modula.
        'flex min-w-0 items-center rounded-control py-1 pl-3 pr-2 text-sm max-lg:min-h-11 max-lg:py-2.5',
        active
          ? 'bg-sidebar-accent/10 font-medium text-sidebar-ink-active'
          : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
        SB_FOCUS,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </Link>
  );
}

/**
 * Modul kao stavka u punom sidebaru. Izgled zavisi od izabranog `layout` (A/B/C) i od
 * toga da li je stavka unutar imenovane pod-grupe (`inSubGroup` → dublja uvučenost).
 * Klik navigira + upisuje u MRU (recent). `external`/`crosslisted` moduli nose diskretnu
 * „↗" oznaku; external (pogonski /kiosk) se ne označava aktivnim — findDomainByPath ga
 * preskače, pa `active` za njega uvek dolazi kao false. Aktivno stanje: A/B = akcentna
 * pozadina + traka levo; C = „kartica" (akcentna pozadina + inset ring), bez trake.
 *
 * PODMENI (F0): modul sa `children` (već RBAC-filtriranim u AppShell-u) dobija chevron i
 * listu podstavki ispod sebe — AUTO-razgranatu dok je ruta modula tekuća (paritet sa
 * accordion-om domena), inače po ručnom stanju iz `useUiPrefs.openModules` (persist, jer se
 * AppShell montira per-page). Isti red se koristi u sva tri layouta (A/C accordion i B sekcije).
 */
function SidebarModuleRow({
  module,
  active,
  ariaCurrent = active,
  layout,
  inSubGroup,
  onNavigate,
  pathname = '',
  search = '',
  withChildren = true,
}: {
  module: NavModule;
  active: boolean;
  /** Da li stavka nosi `aria-current="page"` (default = `active`). Sekcija „Omiljeno"
   *  prosleđuje `false` — domenska pojava istog modula nosi jedini aria-current (a11y). */
  ariaCurrent?: boolean;
  layout: SidebarLayout;
  inSubGroup: boolean;
  onNavigate: NavigateHandler;
  /** Tekuća ruta (za aktivnu podstavku i auto-razgranavanje). */
  pathname?: string;
  /** Tekući query string (npr. „?tab=kvarovi") — aktivnost podstavke sa query href-om. */
  search?: string;
  /** Sekcija „Omiljeno" prosleđuje `false` — prečice ostaju na nivou modula (F0). */
  withChildren?: boolean;
}) {
  const Icon = module.icon;
  const marker = !!(module.external || module.crosslisted);
  const markerTitle = navModuleMarkerTitle(module);
  const { isFavorite, toggleFavorite } = useNavFavorites();
  const favorite = isFavorite(module.href);
  const { openModules, hydrated } = useUiPrefs();

  const subItems = withChildren ? (module.children ?? []) : [];
  const hasSub = subItems.length > 0;
  // Auto-razgranato dok si u modulu (kao aktivni domen u accordion-u) — tada je chevron
  // no-op, isto kao klik na naslov aktivnog domena.
  const autoOpen = hasSub && isNavModuleRouteCurrent(pathname, module);
  const subOpen = hasSub && (autoOpen || openModules.includes(module.href));
  const activeSub = hasSub ? subItems.find((c) => isNavSubItemActive(pathname, search, c)) : undefined;

  // Uvučenost: direktne stavke poravnate ispod naslova domena; stavke pod-grupe dublje.
  // C je „prostorniji", B najgušći.
  const indent = inSubGroup
    ? layout === 'C'
      ? 'pl-6'
      : 'pl-5'
    : layout === 'B'
      ? 'pl-8'
      : layout === 'C'
        ? 'pl-10'
        : 'pl-9';

  // Leva linija podmenija stoji tik ispod ikone modula (indent + pola koraka).
  const subIndent = inSubGroup
    ? layout === 'C'
      ? 'ml-7'
      : 'ml-6'
    : layout === 'B'
      ? 'ml-9'
      : layout === 'C'
        ? 'ml-11'
        : 'ml-10';

  // Red = wrapper (nosi aktivno/hover pozadinu) + nav-link (flex-1) + chevron podmenija +
  // zvezdica kao SESTRE (nijedno interaktivno ne sme biti unutar <a>). Pozadina/traka su na
  // wrapper-u da highlight pokrije ceo red uključujući zvezdicu.
  return (
    <div>
      <div
        className={cn(
          'group relative flex items-center rounded-control',
          active
            ? layout === 'C'
              ? 'bg-sidebar-accent/10 ring-1 ring-inset ring-sidebar-accent/25'
              : 'bg-sidebar-accent/10'
            : 'hover:bg-sidebar-line/60',
        )}
      >
        {/* Akcenat-traka aktivne stavke (A/B) — u C ulogu preuzima inset ring „kartice". */}
        {active && layout !== 'C' && (
          <span
            className="absolute left-2.5 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-sidebar-accent"
            aria-hidden
          />
        )}
        <Link
          href={module.href}
          onClick={(e) => onNavigate(e, module.href)}
          // Kad je aktivna PODSTAVKA, ona nosi jedini aria-current — roditelj samo stil.
          aria-current={ariaCurrent && !activeSub ? 'page' : undefined}
          title={markerTitle}
          className={cn(
            // max-lg:min-h-11 = touch-meta ≥44px na <1024px (DS §11; paritet sa hub redovima
            // u pocetna/page.tsx — off-canvas je primarna mobilna navigacija).
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-control text-base max-lg:min-h-11 max-lg:py-2.5',
            // Desni gutter za (apsolutnu) zvezdicu: rezerviši mesto SAMO kad je red omiljen
            // (popunjena zvezdica je uvek vidljiva) ili na touch-u (coarse: zvezdica je uvek
            // vidljiva). Na fine-pointer ne-omiljen red koristi punu širinu — zvezdica se na
            // hover preliva preko desne ivice bez trajno rezervisanog mesta.
            favorite ? 'pr-8' : 'pr-1 [@media(pointer:coarse)]:pr-8',
            indent,
            layout === 'C' ? 'py-2' : 'py-1.5',
            active
              ? 'font-medium text-sidebar-ink-active'
              : 'text-sidebar-ink group-hover:text-sidebar-ink-active',
            SB_FOCUS,
          )}
        >
          <Icon className={cn('h-4 w-4 shrink-0', active && 'text-sidebar-accent')} aria-hidden />
          <span className="min-w-0 flex-1 truncate">{module.label}</span>
          {marker && <ArrowUpRight className="h-3 w-3 shrink-0 text-sidebar-ink/50" aria-hidden />}
        </Link>
        {hasSub && (
          <button
            type="button"
            // Modul u kome se nalaziš je forsirano razgranat (kao aktivni domen) → no-op.
            onClick={() => {
              if (!autoOpen) toggleModule(module.href);
            }}
            aria-expanded={subOpen}
            aria-label={subOpen ? `Sakrij poglede: ${module.label}` : `Prikaži poglede: ${module.label}`}
            title={subOpen ? 'Sakrij poglede' : 'Prikaži poglede'}
            // Desna margina = mesto za APSOLUTNU zvezdicu (right-1) da se ne preklapaju:
            // 8 (32px) uz zvezdicu 7 (28px), odnosno 12 (48px) na touch-u gde zvezdica
            // naraste na 11 (44px). Sam chevron takođe ima touch-metu ≥44px (DS §11).
            className={cn(
              'mr-8 grid h-7 w-7 shrink-0 place-items-center rounded-control text-sidebar-ink/50 hover:text-sidebar-ink-active',
              'max-lg:mr-12 max-lg:h-11 max-lg:w-11',
              '[@media(pointer:coarse)]:mr-12 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
              SB_FOCUS,
            )}
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5',
                hydrated && 'transition-transform duration-150 motion-reduce:transition-none',
                subOpen && 'rotate-90',
              )}
              aria-hidden
            />
          </button>
        )}
        <FavStar variant="sidebar" favorite={favorite} onToggle={() => toggleFavorite(module.href)} />
      </div>
      {subOpen && (
        <div
          className={cn(
            'my-0.5 space-y-0.5 border-l',
            subIndent,
            layout === 'C' ? 'border-sidebar-accent/30' : 'border-sidebar-line',
          )}
        >
          {subItems.map((c) => (
            <SidebarSubItemRow
              key={c.href}
              item={c}
              parentHref={module.href}
              active={c === activeSub}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Imenovana pod-grupa (npr. „Tehnologija" ispod „Proizvodnje") u punom sidebaru — uvek
 * razgranata (bez zasebnog collapse stanja: AppShell se montira per-page pa lokalno
 * stanje ne bi preživelo navigaciju), sa akcentnim verzalnim naslovom i uvučenim
 * modulima. Leva traka: akcentna u C (premium), neutralna u A/B — pod-grupa je time
 * „jasno izdvojena" u sva tri layouta.
 */
function SidebarSubGroup({
  group,
  ownerDomainId,
  layout,
  pathname,
  search,
  onNavigate,
}: {
  group: NavSubGroup;
  /** Domen kome pod-grupa pripada — za disambiguaciju aktivne crosslisted stavke. */
  ownerDomainId: string;
  layout: SidebarLayout;
  pathname: string;
  search: string;
  onNavigate: NavigateHandler;
}) {
  const GIcon = group.icon;
  return (
    <div
      className={cn(
        'my-1 border-l',
        layout === 'B' ? 'ml-3' : 'ml-4',
        layout === 'C' ? 'border-l-2 border-sidebar-accent/30' : 'border-sidebar-line',
      )}
    >
      <div className="flex items-center gap-1.5 py-1 pl-3 pr-2 text-2xs font-bold uppercase tracking-wide text-sidebar-accent">
        <GIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{group.title}</span>
      </div>
      <div className="space-y-0.5 pb-1">
        {group.modules.map((m) => (
          <SidebarModuleRow
            key={m.href}
            module={m}
            active={isNavModuleActive(pathname, m, ownerDomainId, search)}
            layout={layout}
            inSubGroup
            onNavigate={onNavigate}
            pathname={pathname}
            search={search}
          />
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ FullBody (accordion)

interface FullBodyProps {
  domains: NavDomain[];
  /** Razrešeni omiljeni moduli (RBAC-filtrirani, deduplikovani) — sekcija „Omiljeno" na vrhu. */
  favoriteModules: NavModule[];
  pathname: string;
  /** Tekući query string („?view=gantt") — aktivnost stavki/podstavki sa query href-om. */
  search: string;
  activeDomainId?: string;
  openDomains: string[];
  /** Vizuelni layout punog sidebara (A hijerarhija / B sekcije / C premium). */
  layout: SidebarLayout;
  onNavigate: NavigateHandler;
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

/**
 * „Razgranaj sve / skupi sve" (PLAN_NAV_PODMENIJI §6.1) — diskretna kontrola u dnu PUNOG
 * sidebara (rail je nema: tamo su domeni flyout-i, nema šta da se razgranava). Jedno dugme
 * koje se prevrće po stanju: dok sve nije otvoreno nudi „Razgranaj sve" (svi domeni +
 * svi moduli sa podmenijem), a kad jeste — „Skupi sve" (moduli se skupljaju, domeni se
 * vraćaju na default; aktivni domen i aktivni modul ostaju forsirano otvoreni, kao i inače).
 * Stanje ide kroz postojeći `useUiPrefs` (`openDomains`/`openModules`) → persistuje se.
 */
function ExpandAllToggle({ domains }: { domains: NavDomain[] }) {
  const { openDomains, openModules } = useUiPrefs();

  const domainIds = domains.map((d) => d.id);
  const moduleHrefs = domains.flatMap((d) => allModules(d).filter((m) => m.children?.length).map((m) => m.href));
  // Nema šta da se razgranava (uloga ne vidi nijedan modul sa podmenijem) → bez kontrole.
  if (moduleHrefs.length === 0) return null;

  const expanded =
    domainIds.every((id) => openDomains.includes(id)) && moduleHrefs.every((h) => openModules.includes(h));

  const Icon = expanded ? ChevronsDownUp : ChevronsUpDown;
  const label = expanded ? 'Skupi sve' : 'Razgranaj sve';

  return (
    <button
      type="button"
      onClick={() => {
        setOpenDomains(expanded ? [] : domainIds);
        setOpenModules(expanded ? [] : moduleHrefs);
      }}
      title={expanded ? 'Skupi sve odeljke i podmenije' : 'Razgranaj sve odeljke i podmenije'}
      className={cn(
        'mb-2 flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-xs text-sidebar-ink/70 hover:bg-sidebar-line hover:text-sidebar-ink-active max-lg:min-h-11',
        SB_FOCUS,
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {label}
    </button>
  );
}

/** Puni sidebar: brand red (zvonce + kontrole) + accordion domena + footer. */
function FullBody(props: FullBodyProps) {
  const CycleIcon = MODE_ICON[props.mode];
  return (
    <>
      <div className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-between gap-1 px-5 text-md font-semibold text-sidebar-ink-active">
        {/* Brand vodi na hub /pocetna — dostupno SVIMA (i onima koji landuju u modul).
            onClose zatvara off-canvas overlay čak i kad smo VEĆ na /pocetna: tada se
            ruta ne menja pa [pathname] efekat (koji inače zatvara overlay) ne okine —
            isto ponašanje kao modul-linkovi preko onNavigate. U punom/rail sidebaru je
            onClose undefined (nema overlay-a) → klik samo navigira. */}
        <Link
          href="/pocetna"
          title="Početna"
          onClick={() => props.onClose?.()}
          className={cn('min-w-0 truncate rounded-control', SB_FOCUS)}
        >
          ServoSync
        </Link>
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

      {/* min-h-0 je OBAVEZAN: bez njega flex-item (nav) ima default min-height:auto,
          pa sa mnogo modula (admin vidi sve domene + 13 u Proizvodnji) NE skroluje nego
          naraste preko okvira → footer/Odjava ispadne, sadržaj se preklapa. */}
      {/* tabIndex/data-fav-focus-fallback: stabilan roditelj za fokus kad zvezdica ukloni
          POSLEDNJI omiljeni (cela sekcija „Omiljeno" nestane) — FavStar tada ovde vraća fokus
          umesto na <body> (review 010/26 §4). */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" tabIndex={-1} data-fav-focus-fallback="">
        {/* Sekcija „Omiljeno" (zahtev 010/26) — IZNAD svih domena; prikazuje se samo ako ima
            bar 1 vidljivi omiljeni modul. Redosled = redosled dodavanja. Redovi ovde NIKAD
            nisu aktivni (active=false) — domenska pojava istog modula je jedini indikator
            aktivnog (jedinstveno pravilo highlight-a; a11y aria-current, review 010/26 §3). */}
        {props.favoriteModules.length > 0 && (
          <div className="mb-1">
            <div className="flex items-center gap-2.5 px-3 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-sidebar-ink/70">
              <Star className="h-3.5 w-3.5 shrink-0 text-sidebar-accent" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Omiljeno</span>
            </div>
            <div className="space-y-0.5 pb-1">
              {props.favoriteModules.map((m) => (
                <SidebarModuleRow
                  key={m.href}
                  module={m}
                  active={false}
                  ariaCurrent={false}
                  layout={props.layout}
                  inSubGroup={false}
                  onNavigate={props.onNavigate}
                  // Prečice ostaju na nivou modula (F0) — bez podmenija u „Omiljeno".
                  withChildren={false}
                />
              ))}
            </div>
          </div>
        )}
        {props.domains.map((domain) => {
          const isActive = domain.id === props.activeDomainId;
          const DIcon = domain.icon;
          // Layout B (Sekcije): svaki domen je UVEK razgranat (statičan naslov, bez
          // toggle-a). A/C (accordion): aktivni domen je forsiran otvoren, ostali po
          // ručnom stanju (persist).
          const open =
            props.layout === 'B' || isActive || props.openDomains.includes(domain.id);

          // Telo domena: direktne stavke + imenovane pod-grupe (npr. „Tehnologija").
          const body = open ? (
            <div className="space-y-0.5 pb-1">
              {domain.modules.map((m) => (
                <SidebarModuleRow
                  key={m.href}
                  module={m}
                  active={isNavModuleActive(props.pathname, m, domain.id, props.search)}
                  layout={props.layout}
                  inSubGroup={false}
                  onNavigate={props.onNavigate}
                  pathname={props.pathname}
                  search={props.search}
                />
              ))}
              {domain.groups?.map((g) => (
                <SidebarSubGroup
                  key={g.id}
                  group={g}
                  ownerDomainId={domain.id}
                  layout={props.layout}
                  pathname={props.pathname}
                  search={props.search}
                  onNavigate={props.onNavigate}
                />
              ))}
            </div>
          ) : null;

          // Layout B: naslov domena je statična verzalna sekcija (bez dugmeta/chevrona).
          if (props.layout === 'B') {
            return (
              <div key={domain.id} className="mb-1">
                <div className="flex items-center gap-2.5 px-3 pb-1 pt-3 text-2xs font-bold uppercase tracking-wider text-sidebar-ink/70">
                  <DIcon
                    className={cn('h-3.5 w-3.5 shrink-0', isActive && 'text-sidebar-accent')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{domain.title}</span>
                </div>
                {body}
              </div>
            );
          }

          // Layout A i C: accordion (kao dosad). C = krupnija ikona domena, prostornije,
          // aktivni domen sa suptilnim akcentnim gradijentom.
          const premium = props.layout === 'C';
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
                  // max-lg:min-h-11 = touch-meta ≥44px na <1024px (DS §11; paritet sa
                  // modul-redovima i hub-om).
                  'flex w-full items-center gap-2.5 rounded-control px-3 text-base max-lg:min-h-11 max-lg:py-2.5',
                  premium ? 'py-2.5' : 'py-2',
                  isActive
                    ? premium
                      ? 'bg-gradient-to-r from-sidebar-accent/10 to-transparent text-sidebar-ink-active'
                      : 'text-sidebar-ink-active'
                    : 'text-sidebar-ink hover:bg-sidebar-line/40 hover:text-sidebar-ink-active',
                  SB_FOCUS,
                )}
              >
                <DIcon
                  className={cn(
                    premium ? 'h-5 w-5' : 'h-4 w-4',
                    'shrink-0',
                    isActive && 'text-sidebar-accent',
                  )}
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
              {body}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-line px-3 py-3">
        <ExpandAllToggle domains={props.domains} />
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

/**
 * Stavka modula unutar rail flyout-a (menuitem). Isti vizuelni jezik kao dosad
 * (rail je nedirano) + diskretna „↗" oznaka za external/crosslisted module. Deljena
 * između direktnih stavki domena i stavki pod-grupa u flyout-u.
 *
 * PODMENI (F0): podstavke se u rail režimu renderuju UGNJEŽDENO u flyout panelu — panel je
 * prolazan (hover/klik), pa nema chevron ni stanje: deca su uvek ispisana ispod roditelja.
 * `wide` rute (npr. Gantt na /montaza) sklanjaju sidebar, pa je flyout jedini put do podmenija.
 */
function FlyoutModuleLink({
  module,
  active,
  subItems = [],
  activeSubHref,
  onNavigate,
}: {
  module: NavModule;
  active: boolean;
  /** Podstavke (već RBAC-filtrirane); prazno = bez podmenija. */
  subItems?: NavSubItem[];
  /** Href aktivne podstavke — ona nosi jedini `aria-current` (roditelj tada samo stil). */
  activeSubHref?: string;
  onNavigate: NavigateHandler;
}) {
  const MIcon = module.icon;
  const marker = !!(module.external || module.crosslisted);
  const markerTitle = navModuleMarkerTitle(module);
  return (
    <>
      <Link
        href={module.href}
        role="menuitem"
        onClick={(e) => onNavigate(e, module.href)}
        aria-current={active && !activeSubHref ? 'page' : undefined}
        title={markerTitle}
        className={cn(
          'flex items-center gap-2.5 rounded-control px-2.5 py-2 text-base',
          active
            ? 'bg-sidebar-line text-sidebar-ink-active'
            : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
          SB_FOCUS,
        )}
      >
        <MIcon className={cn('h-4 w-4 shrink-0', active && 'text-sidebar-accent')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{module.label}</span>
        {marker && <ArrowUpRight className="h-3 w-3 shrink-0 text-sidebar-ink/50" aria-hidden />}
      </Link>
      {subItems.length > 0 && (
        <div className="my-0.5 ml-5 space-y-0.5 border-l border-sidebar-line">
          {subItems.map((c) => {
            const subActive = c.href === activeSubHref;
            return (
              <Link
                key={c.href}
                href={c.href}
                role="menuitem"
                // MRU/Omiljeno ostaju na nivou modula (F0) — roditeljev href; cilj
                // navigacije je pun href podstavke (§4.3, promena taba bez remount-a).
                onClick={(e) => onNavigate(e, module.href, c.href)}
                aria-current={subActive ? 'page' : undefined}
                className={cn(
                  'flex min-w-0 items-center rounded-control py-1 pl-3 pr-2 text-sm',
                  subActive
                    ? 'bg-sidebar-line font-medium text-sidebar-ink-active'
                    : 'text-sidebar-ink hover:bg-sidebar-line/60 hover:text-sidebar-ink-active',
                  SB_FOCUS,
                )}
              >
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}

/** Flyout panel jednog domena (rail režim): naslov + pin + moduli + pod-grupe. */
function RailFlyout({
  domain,
  pathname,
  search,
  pinned,
  autoFocus,
  onTogglePin,
  onClose,
  onNavigate,
}: {
  domain: NavDomain;
  pathname: string;
  search: string;
  pinned: boolean;
  /** Fokusiraj prvi modul po otvaranju — SAMO za namerno otvaranje (klik/Enter);
      hover-otvaranje ne sme da otme fokus korisniku koji npr. kuca u filter polju. */
  autoFocus: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onNavigate: NavigateHandler;
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

  // Sintetički „Omiljeno" flyout drži prečice na nivou modula (F0) — bez podmenija.
  const subItemsOf = (m: NavModule): NavSubItem[] =>
    domain.id === FAVORITES_DOMAIN_ID ? [] : (m.children ?? []);
  const activeSubHrefOf = (m: NavModule): string | undefined =>
    subItemsOf(m).find((c) => isNavSubItemActive(pathname, search, c))?.href;

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
        {domain.modules.map((m) => (
          <FlyoutModuleLink
            key={m.href}
            module={m}
            // Sintetički „Omiljeno" flyout: redovi NIKAD nisu aktivni (bez active/aria-current)
            // — jedinstveno pravilo highlight-a (review 010/26 §3); time nestaje i dupli upaljeni
            // red i nekonzistentnost crosslisted vs običnih u flyout-u.
            active={
              domain.id === FAVORITES_DOMAIN_ID
                ? false
                : isNavModuleActive(pathname, m, domain.id, search)
            }
            subItems={subItemsOf(m)}
            activeSubHref={activeSubHrefOf(m)}
            onNavigate={onNavigate}
          />
        ))}
        {domain.groups?.map((g) => {
          const GIcon = g.icon;
          return (
            <div key={g.id} className="mt-1 border-t border-sidebar-line pt-1">
              <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-0.5 text-2xs font-bold uppercase tracking-wide text-sidebar-accent">
                <GIcon className="h-3 w-3 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{g.title}</span>
              </div>
              {g.modules.map((m) => (
                <FlyoutModuleLink
                  key={m.href}
                  module={m}
                  active={isNavModuleActive(pathname, m, domain.id, search)}
                  subItems={subItemsOf(m)}
                  activeSubHref={activeSubHrefOf(m)}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
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
  search,
  activeDomainId,
  onNavigate,
}: {
  domains: NavDomain[];
  pathname: string;
  search: string;
  activeDomainId?: string;
  onNavigate: NavigateHandler;
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
                  search={search}
                  pinned={!!flyout?.pinned}
                  autoFocus={!!flyout?.focus}
                  onTogglePin={() => setFlyout((f) => (f ? { ...f, pinned: !f.pinned } : f))}
                  onClose={() => {
                    setFlyout(null);
                    focusIcon(i);
                  }}
                  onNavigate={(e, href, navHref) => {
                    onNavigate(e, href, navHref);
                    // Flyout se zatvara i na ctrl-klik: meni je odradio svoje (cilj je
                    // otvoren u novom tabu), a tekuća strana ostaje netaknuta.
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
  search: string;
  activeDomainId?: string;
  onNavigate: NavigateHandler;
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
      {/* Brand „S" vodi na hub /pocetna — paritet sa FullBody „ServoSync". Rail je
          uzak (52px): brand drži gornji kvadrat (poravnat s komandnom trakom), a
          dugme režima je premešteno u telo ispod (ponašanje nepromenjeno). */}
      <div className="flex h-[var(--command-bar-height)] shrink-0 items-center justify-center">
        <Link
          href="/pocetna"
          title="Početna"
          aria-label="Početna"
          className={cn(
            'grid h-9 w-9 place-items-center rounded-control text-md font-semibold text-sidebar-ink-active hover:bg-sidebar-line',
            SB_FOCUS,
          )}
        >
          S
        </Link>
      </div>
      {/* Bez overflow-scroll: flyout je absolute i ne sme biti odsečen (rail je kratak). */}
      <div className="flex flex-1 flex-col items-center gap-1 py-2">
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
        <NotificationBell enabled={props.bellEnabled} variant="rail" />
        <RailNav
          domains={props.domains}
          pathname={props.pathname}
          search={props.search}
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
  const { sidebar: sidebarMode, sidebarLayout, openDomains, hydrated } = useUiPrefs();
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Vidljivi domeni/moduli po ulozi — RBAC filter kroz JEDAN izvor istine
  // (`canAccessNavModule`: `requiresAny` OR ima prednost nad `requires`; npr. pogonski
  // /kiosk je vidljiv uz KVALITET_READ ILI TEHNOLOGIJA_READ). Filtriraju se i direktne
  // stavke i stavke pod-grupa; prazna pod-grupa i prazan domen se preskaču. (Backend je
  // izvor istine; ovo krije afordanse, guard i dalje čuva rute.)
  // Podstavke (podmeni, F0) se filtriraju istim prolazom: dete bez `requires` nasleđuje
  // roditeljev gate, dete sa `requires` (admin tabovi) se gejtuje strože.
  const visibleModules = (mods: NavModule[]): NavModule[] =>
    mods
      .filter((m) => canAccessNavModule(m, can))
      .map((m) => (m.children?.length ? { ...m, children: visibleNavChildren(m, can) } : m));

  const visibleDomains: NavDomain[] = NAV_DOMAINS.map((domain) => ({
    ...domain,
    modules: visibleModules(domain.modules),
    groups: domain.groups
      ?.map((g) => ({ ...g, modules: visibleModules(g.modules) }))
      .filter((g) => g.modules.length > 0),
  })).filter((domain) => domain.modules.length > 0 || (domain.groups?.length ?? 0) > 0);

  const activeDomainId = findDomainByPath(pathname)?.id;
  // Query tekućeg URL-a — highlight stavki/podstavki sa query href-om (npr. „Gantt" =
  // /montaza?view=gantt). Pathname sam ne razlikuje poglede istog modula.
  const search = useCurrentSearch(pathname);

  // Plutajući AI asistent (zahtev 003/26): vidljiv samo uz AI permisiju i van /ai strane
  // (tamo je pun prikaz — dugme bi bilo redundantno). AppShell se ne montira na
  // login/kiosk, pa se tamo ni ne pojavljuje. `screenContext` = oznaka trenutnog ekrana
  // koju backend ubacuje u system prompt (pomoć prvo oko forme na kojoj je korisnik).
  const onAiPage = pathname === '/ai' || pathname.startsWith('/ai/');
  const showAiWidget = !!user && can(PERMISSIONS.AI_CHAT) && !onAiPage;

  // Omiljeni moduli (zahtev 010/26): sirovi href-ovi iz localStorage-a razrešeni na vidljive
  // NavModule-e (RBAC filter + dedup + izostavljanje nepostojećih) — isti izvor za sekciju
  // „Omiljeno" u punom sidebaru i za sintetički „Omiljeno" flyout u rail režimu. AppShell je
  // „vlasnik" aktivnog korisnika za store (ključ po korisniku, review 010/26 §2) — montiran je
  // na svakoj stranici; `user?.id ?? null` (null dok se ne učita / na odjavi → prazna lista).
  const { favorites } = useNavFavorites(user?.id ?? null);
  const favoriteModules = resolveFavoriteModules(favorites, can);
  // Rail: „Omiljeno" kao sintetički domen na vrhu trake (Star ikona + flyout sa stavkama).
  const railDomains: NavDomain[] =
    favoriteModules.length > 0
      ? [{ id: FAVORITES_DOMAIN_ID, title: 'Omiljeno', icon: Star, modules: favoriteModules }, ...visibleDomains]
      : visibleDomains;

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
  // Klik na nav stavku: MRU na nivou modula + zatvaranje overlay-a + JAVLJANJE navigacije.
  // Emiter (F1, plan §4.3) je ono što čini podmeni upotrebljivim DOK SI VEĆ U MODULU: Next
  // ne remount-uje stranu kad se menja samo query, pa bez ovog event-a klik na „Kvarovi" sa
  // `/odrzavanje?tab=masine` ne bi uradio ništa. Cilj se šalje kao `detail.href` jer `onClick`
  // <Link>-a prethodi promeni URL-a; potrošači (`useQueryTab`, `useCurrentSearch`) ga primaju
  // samo za ISTI pathname — kod prave promene rute strana se remount-uje i čita URL sama.
  //
  // Ctrl/⌘/Shift/Alt/srednji klik = „otvori drugde": Next prepušta navigaciju browseru, pa
  // tekuća strana ne sme da se pomeri NI JEDNIM od ovih efekata (ni tab, ni MRU, ni zatvaranje
  // sidebara). Ranije je ctrl-klik na „Održavanje → Kvarovi" otvarao nov tab I prebacivao
  // stari, a adresa starog je i dalje pokazivala prethodni pogled.
  const onNavigate: NavigateHandler = (e, href, navHref) => {
    if (isModifiedNavClick(e)) return;
    pushRecentModule(href);
    setOverlayOpen(false);
    setOverlayHover(false);
    emitNavEvent(navHref ?? href);
  };

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
              favoriteModules={favoriteModules}
              pathname={pathname}
              search={search}
              activeDomainId={activeDomainId}
              openDomains={openDomains}
              layout={sidebarLayout}
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
              domains={railDomains}
              pathname={pathname}
              search={search}
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
            <div onClick={dismissOverlay} className="fixed inset-0 z-[45] bg-black/40" aria-hidden />
          )}
          <aside
            ref={overlayRef}
            onMouseLeave={overlayHover && !overlayLocked ? dismissOverlay : undefined}
            className={cn(surface, 'fixed left-0 top-0 z-50 h-full w-[var(--sidebar-width)] shadow-2xl')}
          >
            <FullBody
              domains={visibleDomains}
              favoriteModules={favoriteModules}
              pathname={pathname}
              search={search}
              activeDomainId={activeDomainId}
              openDomains={openDomains}
              layout={sidebarLayout}
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

      {/* Plutajući AI asistent (zahtev 003/26) — dole desno, non-modal; nit i otvorenost
          preživljavaju navigaciju (spoljni store u komponenti). */}
      {showAiWidget && <AiWidget screenContext={screenContextForPath(pathname)} />}
    </AppShellContext.Provider>
  );
}
