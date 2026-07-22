'use client';

// Info režim (PLAN_INFO_VODIC_2026-07) — generički vodič za nove korisnike: „i"
// oznake uz polja/akcije (HelpSpot) + vođena tura (HelpTour). Ovaj fajl drži STANJE
// režima (context + tastatura + pamćenje), a HelpSpot/HelpTour su odvojene kit
// komponente koje ga čitaju. Provider se montira PO MODULU (wrap u page.tsx) — pilot
// (Zahtevi) ne dira ostatak aplikacije. Bez novih zavisnosti.
//
// Pamćenje (localStorage, pilot — BE preferenca pri rollout-u):
//   • servosync.help.enabled            — globalni izbor korisnika (uklj./isklj.)
//   • servosync.help.seen.<modul>       — je li se auto-on baner već pojavio za modul
// Auto-on: prvi ulazak u modul (nema `seen`) i korisnik nije globalno ugasio pomoć →
// režim se sam upali + baner „Novi ste ovde?". Gašenje upisuje `enabled=false`.
//
// Tastatura: Shift+? pali/gasi (mrtvo dok se kuca u input/textarea/contenteditable);
// Esc slojevito zatvara (tura → oblačić → režim), a modalne dijaloge NE dira (oni
// imaju svoj Esc). Listener je u CAPTURE fazi da preduhitri „Esc = nazad" na stranici.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { HelpCircle, Play } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface HelpEntry {
  title: string;
  text: string;
}
export type HelpRegistry = Record<string, HelpEntry>;

export interface HelpContextValue {
  /** Modul za koji je režim montiran (npr. „zahtevi"). */
  moduleKey: string;
  /** Da li je info režim uključen (markeri vidljivi). */
  active: boolean;
  toggle: () => void;
  setActive: (v: boolean) => void;
  /** Registar tekstova pomoći (title/text) po id-u — puni ga modul. */
  entry: (id: string) => HelpEntry | undefined;
  /** Jedini otvoren oblačić (single-open); HelpSpot ga postavlja. */
  openSpotId: string | null;
  setOpenSpotId: (id: string | null) => void;
  /** Vođena tura. */
  tourOpen: boolean;
  startTour: () => void;
  stopTour: () => void;
  /** Auto-on baner „Novi ste ovde?". */
  showBanner: boolean;
  dismissBanner: () => void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

const LS_ENABLED = 'servosync.help.enabled';
const seenKey = (m: string) => `servosync.help.seen.${m}`;

// localStorage može da baci (privatni režim / blokiran u iframe-u) — uvek kroz guard.
function lsGet(k: string): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(k) : null;
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

/** Fokus u polju za unos → prečica „?" se ignoriše (korisnik kuca znak pitanja). */
function isEditableTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || typeof n.tagName !== 'string') return false;
  const tag = n.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') return true;
  if (n.isContentEditable) return true;
  return false;
}

export function HelpProvider({
  moduleKey,
  registry,
  children,
  /** false = režim ne čita/ne piše localStorage (npr. /dev/ui katalog). */
  persist = true,
  /** Početno stanje kad se ne pamti (katalog demo). */
  defaultActive = false,
}: {
  moduleKey: string;
  registry: HelpRegistry;
  children: ReactNode;
  persist?: boolean;
  defaultActive?: boolean;
}) {
  const [active, setActiveState] = useState(defaultActive);
  const [openSpotId, setOpenSpotId] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [showBanner, setShowBanner] = useState(false);

  // Ref-ovi za capture keydown listener (registruje se jednom, ne sme nositi ustajalo stanje).
  const activeRef = useRef(active);
  activeRef.current = active;
  const openSpotRef = useRef(openSpotId);
  openSpotRef.current = openSpotId;
  const tourRef = useRef(tourOpen);
  tourRef.current = tourOpen;

  const persistEnabled = useCallback(
    (v: boolean) => {
      if (persist) lsSet(LS_ENABLED, v ? 'true' : 'false');
    },
    [persist],
  );
  const markSeen = useCallback(() => {
    if (persist) lsSet(seenKey(moduleKey), '1');
  }, [persist, moduleKey]);

  const setActive = useCallback(
    (v: boolean) => {
      setActiveState(v);
      persistEnabled(v);
      markSeen();
      if (!v) {
        setOpenSpotId(null);
        setShowBanner(false);
      }
    },
    [persistEnabled, markSeen],
  );

  const toggle = useCallback(() => setActive(!activeRef.current), [setActive]);

  const startTour = useCallback(() => {
    setActiveState(true);
    persistEnabled(true);
    markSeen();
    setShowBanner(false);
    setOpenSpotId(null);
    setTourOpen(true);
  }, [persistEnabled, markSeen]);

  const stopTour = useCallback(() => setTourOpen(false), []);
  const dismissBanner = useCallback(() => setShowBanner(false), []);

  // Mount po modulu: auto-on odluka + „?tour=1" deep-link (start ture posle navigacije).
  useEffect(() => {
    if (!persist) return; // katalog demo: ostani na defaultActive, bez pamćenja
    // Deep-link start ture (npr. „Provedi me" iz liste vodi na /zahtevi/novi?tour=1).
    let wantTour = false;
    try {
      const sp = new URLSearchParams(window.location.search);
      if (sp.get('tour') === '1') {
        wantTour = true;
        sp.delete('tour');
        const qs = sp.toString();
        window.history.replaceState(
          null,
          '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
        );
      }
    } catch {
      /* ignore */
    }

    if (wantTour) {
      setActiveState(true);
      persistEnabled(true);
      markSeen();
      setTourOpen(true);
      return;
    }

    const seen = lsGet(seenKey(moduleKey));
    const enabled = lsGet(LS_ENABLED);
    if (!seen) {
      // Prvi ulazak u modul: auto-on (osim ako je korisnik globalno ugasio pomoć).
      if (enabled !== 'false') {
        setActiveState(true);
        persistEnabled(true);
        setShowBanner(true);
      }
      markSeen();
    } else if (enabled === 'true') {
      // Vraća se korisnik koji je pomoć ostavio uključenu.
      setActiveState(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleKey, persist]);

  // Tastatura (capture): Shift+? toggle; Esc slojevito zatvara.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '?') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isEditableTarget(e.target)) return; // mrtvo dok se kuca
        e.preventDefault();
        setActive(!activeRef.current);
        return;
      }
      if (e.key === 'Escape') {
        // Slojevito, najviši sloj prvi. Kad obradimo — gutamo (stopImmediatePropagation)
        // da „Esc = nazad" na stranici ne odradi istovremeno.
        if (tourRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setTourOpen(false);
          return;
        }
        if (openSpotRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setOpenSpotId(null);
          return;
        }
        // Modalni dijalog/paleta imaju svoj Esc — ne diramo ih.
        if (
          typeof document !== 'undefined' &&
          document.querySelector('[role="dialog"][aria-modal="true"]')
        ) {
          return;
        }
        if (activeRef.current) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setActive(false);
          return;
        }
        // Režim isključen i ništa naše nije otvoreno → prepusti stranici (nazad).
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setActive]);

  const entry = useCallback((id: string) => registry[id], [registry]);

  const value: HelpContextValue = {
    moduleKey,
    active,
    toggle,
    setActive,
    entry,
    openSpotId,
    setOpenSpotId,
    tourOpen,
    startTour,
    stopTour,
    showBanner,
    dismissBanner,
  };

  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

/** Obavezan kontekst (dugmad/baner koji žive uz provider). */
export function useHelpMode(): HelpContextValue {
  const ctx = useContext(HelpContext);
  if (!ctx) throw new Error('useHelpMode must be used within HelpProvider');
  return ctx;
}

/** Opcioni kontekst — HelpSpot/HelpTour su bezbedni i bez providera (čist passthrough). */
export function useHelpModeOptional(): HelpContextValue | null {
  return useContext(HelpContext);
}

/**
 * Dugme „?" za zaglavlje modula (uz PageHeader akcije): pali/gasi režim; u režimu nudi
 * i „▶ Provedi me". Na telefonu je ovo JEDINI ulaz (nema tastature). Podrazumevano
 * pokreće turu iz konteksta; `onStartTour` nadjačava (npr. skok na drugu stranicu).
 */
export function HelpToggleButton({
  onStartTour,
  className,
}: {
  onStartTour?: () => void;
  className?: string;
}) {
  const { active, toggle, startTour } = useHelpMode();
  const start = onStartTour ?? startTour;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {active && (
        <button
          type="button"
          onClick={start}
          className="inline-flex h-9 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <Play className="h-4 w-4" aria-hidden />
          Provedi me
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-pressed={active}
        title={active ? 'Isključi objašnjenja (Shift+?)' : 'Objašnjenja polja i akcija (Shift+?)'}
        aria-label={active ? 'Isključi objašnjenja' : 'Uključi objašnjenja'}
        className={cn(
          'grid h-9 w-9 place-items-center rounded-control border transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
          active
            ? 'border-accent bg-accent text-accent-fg'
            : 'border-line bg-surface text-ink-secondary hover:bg-surface-2 hover:text-ink',
        )}
      >
        <HelpCircle className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Nenametljiv baner pri prvom ulasku u modul (auto-on). „Provedi me" pokreće turu,
 * „Ugasi" isključuje režim (i pamti izbor). Sam se skloni čim korisnik odabere.
 */
export function HelpBanner({ onStartTour }: { onStartTour?: () => void }) {
  const { showBanner, dismissBanner, setActive, startTour } = useHelpMode();
  const start = onStartTour ?? startTour;
  if (!showBanner) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-panel border border-accent/40 bg-accent-subtle px-4 py-3">
      <HelpCircle className="h-5 w-5 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">Novi ste ovde?</p>
        <p className="text-xs text-ink-secondary">
          Uključili smo objašnjenja — kliknite „i" pored polja i akcija. Možemo vas i provesti
          kroz ekran.
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          dismissBanner();
          start();
        }}
        className="inline-flex h-9 items-center gap-1.5 rounded-control bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        <Play className="h-4 w-4" aria-hidden />
        Provedi me
      </button>
      <button
        type="button"
        onClick={() => setActive(false)}
        className="inline-flex h-9 items-center rounded-control px-3 text-sm font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
      >
        Ugasi
      </button>
    </div>
  );
}
