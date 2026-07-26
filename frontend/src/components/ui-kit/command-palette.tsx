'use client';

// Ctrl+K komandna paleta (F3 SIDEBAR_HUB) — globalna pretraga i skok na modul.
// Samostalna komponenta: kontrolisana kroz `open`/`onOpenChange`, sa OPCIONIM
// vlastitim hotkey listenerom (`hotkey`, default true). Integrator (F1 shell) je
// montira; ako sam registruje globalni Ctrl+K, prosledi `hotkey={false}`.
//
// Dijalog obrazac je pozajmljen iz `dialog.tsx` (isti vizuelni jezik: surface,
// border-line, rounded-panel, senka), ali top-anchored (~top 18vh) i uži (max-w-xl)
// jer je paleta, ne modalna forma. Izvor stavki = NAV_DOMAINS (isti RBAC filter kao
// sidebar: stavka uz `can(requires)`). Bez novih zavisnosti.

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import {
  NAV_DOMAINS,
  allModules,
  canAccessNavModule,
  visibleNavChildren,
  type NavModule,
  type NavSubItem,
} from '@/lib/navigation';
import { useUiPrefs } from '@/lib/use-ui-prefs';
import { useNavFavorites } from '@/lib/use-nav-favorites';
import { fuzzyScore } from '@/lib/fuzzy';

/**
 * Jedan red palete — modul ILI njegova podstavka (pogled/tab, PLAN_NAV_PODMENIJI §4.2).
 * Podstavka se prikazuje kao „Modul: Podstavka" („Montaža: Gantt") i vodi na svoj pun href
 * (sa query-jem); MRU i „Omiljeno" ostaju na nivou modula (F0) — otud `moduleHref`.
 */
interface Entry {
  /** Cilj navigacije — pun href (sme da nosi query). Ujedno ključ za dedup. */
  href: string;
  /** Prikazna labela („Montaža: Gantt" za podstavku). */
  label: string;
  icon: LucideIcon;
  domainTitle: string;
  /** Tekst za fuzzy rangiranje: labele + domen + keywords (uklj. T-kod šifre). */
  meta: string;
  /** Href RODITELJSKOG modula — MRU/omiljeno ostaju na nivou modula. */
  moduleHref: string;
}

function moduleEntry(module: NavModule, domainTitle: string): Entry {
  return {
    href: module.href,
    label: module.label,
    icon: module.icon,
    domainTitle,
    meta: `${module.label} ${domainTitle} ${(module.keywords ?? []).join(' ')}`,
    moduleHref: module.href,
  };
}

function subItemEntry(module: NavModule, item: NavSubItem, domainTitle: string): Entry {
  return {
    href: item.href,
    label: `${module.label}: ${item.label}`,
    icon: module.icon,
    domainTitle,
    // I roditeljeve reči ulaze u metu: „odrzavanje" mora naći „Održavanje: Kvarovi".
    meta: `${module.label} ${item.label} ${domainTitle} ${(module.keywords ?? []).join(' ')} ${(item.keywords ?? []).join(' ')}`,
    moduleHref: module.href,
  };
}

// Red u prikazu: nenavigabilni naslov grupe ili navigabilna stavka (sa svojim
// rednim brojem `index` radi ↑/↓ selekcije i aria-activedescendant-a).
type PaletteRow =
  | { kind: 'header'; key: string; title: string }
  | { kind: 'item'; key: string; index: number; entry: Entry };

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Interni globalni Ctrl+K / Cmd+K listener. Isključi ako shell sam registruje. */
  hotkey?: boolean;
}

export function CommandPalette({ open, onOpenChange, hotkey = true }: CommandPaletteProps) {
  const router = useRouter();
  const { can, user } = useAuth();
  const { recentModules, pushRecentModule } = useUiPrefs();
  // Ključ omiljenih je po korisniku (review 010/26 §2) — prosledi userId (isti store kao
  // sidebar/hub; idempotentno kad je AppShell već „vlasnik").
  const { favorites } = useNavFavorites(user?.id ?? null);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  // Ref-ovi za hotkey listener (registruje se jednom; ne sme nositi ustajale props-e).
  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // Globalni Ctrl+K / Cmd+K — toggle palete. OTIMA fokus i iz input/textarea polja
  // (paleta je globalna). `preventDefault` u OBA smera: i zatvaranje mora da proguta
  // default (Firefox Ctrl+K inače skače u browser search bar).
  useEffect(() => {
    if (!hotkey) return;
    function onKey(e: KeyboardEvent) {
      // Bez Shift-a: Ctrl+Shift+K je browser prečica (Firefox konzola).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onOpenChangeRef.current(!openRef.current);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);

  // Otvaranje: očisti upit, fokusiraj polje i zapamti prethodni fokus (vrati ga na
  // zatvaranju — pristupačnost).
  useEffect(() => {
    if (!open) return;
    const prevFocused = document.activeElement as HTMLElement | null;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
    return () => prevFocused?.focus?.();
  }, [open]);

  // Svaka promena upita vraća selekciju na vrh.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Drži selektovanu stavku u vidnom polju pri kretanju tastaturom.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  // --- izgradnja liste (jeftino; ~30 modula — bez memoizacije) --------------
  // Vidljivi moduli = isti RBAC filter kao sidebar (canAccessNavModule: requiresAny OR
  // ima prednost — npr. pogonski /kiosk uz KVALITET_READ ILI TEHNOLOGIJA_READ). Iteriraju
  // se i moduli iz pod-grupa (allModules: direktne stavke + „Tehnologija" i sl.) I njihove
  // PODSTAVKE (F0 podmeniji — „Montaža: Gantt"; dete bez `requires` nasleđuje roditeljev
  // gate). Paleta je RAVNA globalna lista pa se dedup-uje po PUNOM href-u (uklj. query):
  // `crosslisted` modul (npr. „Lokacije delova" u Tehnologiji i Logistici) ostaje jednom,
  // prva pojava po redosledu modela pobeđuje (seenHref).
  const visible: Entry[] = [];
  const seenHref = new Set<string>();
  const byDomain = new Map<string, Entry[]>();
  for (const d of NAV_DOMAINS) {
    const inDomain: Entry[] = [];
    const add = (e: Entry) => {
      if (seenHref.has(e.href)) return;
      seenHref.add(e.href);
      visible.push(e);
      inDomain.push(e);
    };
    for (const m of allModules(d)) {
      if (!canAccessNavModule(m, can)) continue;
      add(moduleEntry(m, d.title));
      for (const c of visibleNavChildren(m, can)) add(subItemEntry(m, c, d.title));
    }
    if (inDomain.length) byDomain.set(d.id, inDomain);
  }

  const q = query.trim();
  const rows: PaletteRow[] = [];
  let counter = 0;
  const pushItem = (entry: Entry) => {
    rows.push({ kind: 'item', key: `i-${entry.href}`, index: counter++, entry });
  };

  if (!q) {
    // Prazan upit: prvo „Omiljeno" (zahtev 010/26), pa „Nedavno" (MRU), pa ostale stavke
    // po redosledu modela, grupisane naslovima domena. Svaka stavka se prikazuje jednom.
    // Omiljeno/MRU su na nivou MODULA (F0) — traže se po href-u modula.
    const byHref = new Map(visible.map((e) => [e.href, e]));

    // „Omiljeno" — omiljeni href-ovi koje korisnik sme da vidi, redosled dodavanja.
    const favEntries: Entry[] = [];
    for (const href of favorites) {
      const e = byHref.get(href);
      if (e) favEntries.push(e);
    }
    // `shown` nosi već prikazane href-ove (Omiljeno → Nedavno → domeni redom) da se ista
    // stavka (uklj. `crosslisted`, isti href u dva domena) ne pojavi dvaput u paleti.
    const shown = new Set<string>(favEntries.map((e) => e.href));
    if (favEntries.length) {
      rows.push({ kind: 'header', key: 'h-favorites', title: 'Omiljeno' });
      for (const e of favEntries) pushItem(e);
    }

    // „Nedavno" (MRU), bez onih već prikazanih u „Omiljeno".
    const recent: Entry[] = [];
    for (const href of recentModules) {
      const e = byHref.get(href);
      if (e && !shown.has(href)) recent.push(e);
    }
    if (recent.length) {
      rows.push({ kind: 'header', key: 'h-recent', title: 'Nedavno' });
      for (const e of recent) {
        shown.add(e.href);
        pushItem(e);
      }
    }
    for (const d of NAV_DOMAINS) {
      const entries = (byDomain.get(d.id) ?? []).filter((e) => !shown.has(e.href));
      if (!entries.length) continue;
      rows.push({ kind: 'header', key: `h-${d.id}`, title: d.title });
      for (const e of entries) {
        shown.add(e.href);
        pushItem(e);
      }
    }
  } else {
    // Upit: ravna rang-lista (fuzzy). Rangiranje po TIER-u pre svega: substring pogodak
    // (score > 0 u fuzzy — substring skorovi žive u opsegu ~1e6) UVEK pobeđuje subsequence
    // (score ≤ 0). Omiljeni (zahtev 010/26) su tie-break UNUTAR istog tier-a (ne preskaču
    // bolji tekstualni pogodak — inače bi omiljen subsequence pretekao tačan substring).
    // Na kraju sam skor. Domen se prikazuje kao kontekst na svakom redu.
    const favSet = new Set(favorites);
    const scored: { entry: Entry; score: number }[] = [];
    for (const e of visible) {
      const score = fuzzyScore(q, e.meta);
      if (score !== null) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => {
      const at = a.score > 0 ? 1 : 0;
      const bt = b.score > 0 ? 1 : 0;
      if (at !== bt) return bt - at;
      const af = favSet.has(a.entry.moduleHref) ? 1 : 0;
      const bf = favSet.has(b.entry.moduleHref) ? 1 : 0;
      if (af !== bf) return bf - af;
      return b.score - a.score;
    });
    for (const s of scored) pushItem(s.entry);
  }

  const itemCount = counter;
  const activeValid = itemCount > 0 && activeIndex >= 0 && activeIndex < itemCount;
  const activeDescId = activeValid ? optId(activeIndex) : undefined;

  function close() {
    onOpenChange(false);
  }

  function activate(index: number) {
    // Nađi entry po rednom broju (item redovi su u push redosledu = index).
    const row = rows.find((r): r is Extract<PaletteRow, { kind: 'item' }> =>
      r.kind === 'item' && r.index === index,
    );
    if (!row) return;
    // MRU pamti MODUL (F0) — i kad je izabrana podstavka; navigacija ide na pun href.
    pushRecentModule(row.entry.moduleHref);
    router.push(row.entry.href);
    close();
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (itemCount) setActiveIndex((i) => (i + 1) % itemCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (itemCount) setActiveIndex((i) => (i - 1 + itemCount) % itemCount);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeValid) activate(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      // Jedini fokusabilan element je polje — fokus trap = zadrži ga ovde.
      e.preventDefault();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 p-4"
      // mousedown umesto click: drag-selekcija teksta u polju koja se završi van
      // dijaloga NE sme da zatvori paletu (click bi se dispatch-ovao na scrim kao
      // zajedničkog pretka mousedown/mouseup meta).
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="presentation"
    >
      <div
        className="mx-auto mt-[18vh] flex w-full max-w-xl flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Komandna paleta"
      >
        {/* Polje za pretragu — fokus indikator na okvirnom redu (donja ivica accent),
            input sam nema outline (DS: fokus uvek vidljiv). */}
        <div className="flex items-center gap-2.5 border-b border-line px-4 focus-within:border-accent">
          <Search className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Pretraži module…"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={activeDescId}
            aria-autocomplete="list"
            aria-label="Pretraga modula"
            className="w-full bg-transparent py-3 text-base text-ink placeholder:text-ink-disabled focus:outline-none"
          />
        </div>

        {/* Lista rezultata */}
        <div
          id={listboxId}
          role="listbox"
          aria-label="Moduli"
          className="max-h-[50vh] overflow-y-auto py-1.5"
        >
          {itemCount === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-secondary">Nema rezultata.</div>
          ) : (
            rows.map((row) => {
              if (row.kind === 'header') {
                return (
                  <div
                    key={row.key}
                    role="presentation"
                    className="px-4 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-ink-secondary first:pt-1"
                  >
                    {row.title}
                  </div>
                );
              }
              const active = row.index === activeIndex;
              const Icon = row.entry.icon;
              return (
                <button
                  key={row.key}
                  id={optId(row.index)}
                  ref={active ? activeRef : undefined}
                  role="option"
                  aria-selected={active}
                  onClick={() => activate(row.index)}
                  // mousemove, ne mouseenter: scrollIntoView pri ↑/↓ „provlači" redove
                  // ispod nepomičnog kursora → mouseenter bi vraćao selekciju na red
                  // pod mišem i strelice nikad ne bi prošle dalje (cmdk obrazac).
                  onMouseMove={() => {
                    if (row.index !== activeIndex) setActiveIndex(row.index);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left text-base text-ink',
                    active
                      ? 'bg-accent-subtle shadow-[inset_3px_0_0_var(--accent)]'
                      : 'hover:bg-surface-2',
                  )}
                >
                  <Icon
                    className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-ink-secondary')}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{row.entry.label}</span>
                  {/* U ravnoj (fuzzy) listi domen je kontekst; u grupisanoj je već naslov. */}
                  {q && (
                    <span className="shrink-0 text-xs text-ink-secondary">
                      {row.entry.domainTitle}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Hint */}
        <div className="flex justify-end border-t border-line px-4 py-2 text-xs text-ink-secondary">
          <span>↑↓ izbor · Enter otvori · Esc zatvori</span>
        </div>
      </div>
    </div>
  );
}
