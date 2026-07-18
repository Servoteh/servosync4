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
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAuth } from '@/lib/auth-context';
import { NAV_DOMAINS, allModules, canAccessNavModule, type NavModule } from '@/lib/navigation';
import { useUiPrefs } from '@/lib/use-ui-prefs';
import { fuzzyScore } from '@/lib/fuzzy';

interface Entry {
  module: NavModule;
  domainTitle: string;
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
  const { can } = useAuth();
  const { recentModules, pushRecentModule } = useUiPrefs();

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
  // se i moduli iz pod-grupa (allModules: direktne stavke + „Tehnologija" i sl.). Paleta
  // je RAVNA globalna lista pa se `crosslisted` href (npr. „Lokacije delova" u Tehnologiji
  // i Logistici) dedup-uje: prva pojava po redosledu modela pobeđuje (seenHref).
  const visible: Entry[] = [];
  const seenHref = new Set<string>();
  for (const d of NAV_DOMAINS) {
    for (const m of allModules(d)) {
      if (!canAccessNavModule(m, can) || seenHref.has(m.href)) continue;
      seenHref.add(m.href);
      visible.push({ module: m, domainTitle: d.title });
    }
  }

  const q = query.trim();
  const rows: PaletteRow[] = [];
  let counter = 0;
  const pushItem = (entry: Entry) => {
    rows.push({ kind: 'item', key: `i-${entry.module.href}`, index: counter++, entry });
  };

  if (!q) {
    // Prazan upit: prvo „Nedavno" (MRU, samo href-ovi koje korisnik sme da vidi),
    // pa ostali moduli po redosledu modela, grupisani naslovima domena.
    const byHref = new Map(visible.map((e) => [e.module.href, e]));
    const recent: Entry[] = [];
    for (const href of recentModules) {
      const e = byHref.get(href);
      if (e) recent.push(e);
    }
    const recentHrefs = new Set(recent.map((e) => e.module.href));

    if (recent.length) {
      rows.push({ kind: 'header', key: 'h-recent', title: 'Nedavno' });
      for (const e of recent) pushItem(e);
    }
    // `shown` nosi već prikazane href-ove (prvo „Nedavno", pa domeni redom) da se
    // `crosslisted` modul (isti href u dva domena) ne pojavi dvaput u paleti —
    // prvi domen po redosledu modela ga „preuzima".
    const shown = new Set(recentHrefs);
    for (const d of NAV_DOMAINS) {
      const mods = allModules(d).filter((m) => canAccessNavModule(m, can) && !shown.has(m.href));
      if (!mods.length) continue;
      rows.push({ kind: 'header', key: `h-${d.id}`, title: d.title });
      for (const m of mods) {
        shown.add(m.href);
        pushItem({ module: m, domainTitle: d.title });
      }
    }
  } else {
    // Upit: ravna rang-lista (fuzzy). Stabilan sort čuva redosled modela pri
    // izjednačenim skorovima; domen se prikazuje kao kontekst na svakom redu.
    const scored: { entry: Entry; score: number }[] = [];
    for (const e of visible) {
      const meta = `${e.module.label} ${e.domainTitle} ${(e.module.keywords ?? []).join(' ')}`;
      const score = fuzzyScore(q, meta);
      if (score !== null) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score);
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
    const href = row.entry.module.href;
    pushRecentModule(href);
    router.push(href);
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
              const Icon = row.entry.module.icon;
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
                  <span className="min-w-0 flex-1 truncate">{row.entry.module.label}</span>
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
