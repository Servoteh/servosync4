'use client';

import { Check, ChevronDown, ChevronRight, Monitor, Moon, Palette, Sun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUiPrefs, type SidebarLayout, type ThemePref } from '@/lib/use-ui-prefs';

// ============================================================================
// Izgled — lične UI preference (SIDEBAR_THEME_SPEC §5). Vidljivo SVAKOM prijavljenom
// (tab-permisija profile.self). Dve celine:
//   (a) Izgled menija — 3 karte A/B/C sa mini vizuelnim preview-om (mali sidebar
//       sličica); klik primeni ODMAH (setSidebarLayout), „Preporučeno" na C.
//   (b) Tema — segmented Sistemska/Svetla/Tamna (setTheme) + živi swatch trenutne teme.
// Sve preko dizajn-tokena (nijedan sirov hex) + lucide ikone; radi u light i dark.
// Izbor se pamti u localStorage (use-ui-prefs) — per-uređaj, nije server-side.
//
// Napomena o swatch-evima teme: naši tokeni su reaktivni na temu (menjaju vrednost sa
// data-theme), pa se statični „svetli" i „tamni" kvadratić NE mogu prikazati istovremeno
// bez fiksnih (netokenskih) boja. Zato je po-opciji indikator = ikona (Monitor/Sun/Moon),
// a preview celokupne palete je jedan živi red koji se prebojava na izbor teme.
// ============================================================================

interface LayoutOption {
  value: SidebarLayout;
  title: string;
  desc: string;
  recommended?: boolean;
}

const LAYOUTS: LayoutOption[] = [
  { value: 'A', title: 'Hijerarhija', desc: 'Klasičan accordion — domeni se otvaraju i zatvaraju.' },
  { value: 'B', title: 'Sekcije', desc: 'Sve sekcije otvorene, gusto — za brzo skeniranje.' },
  { value: 'C', title: 'Premium', desc: 'Krupnije ikone, aktivna stavka kao kartica.', recommended: true },
];

interface ThemeOption {
  value: ThemePref;
  label: string;
  hint: string;
  Icon: LucideIcon;
}

const THEMES: ThemeOption[] = [
  { value: 'system', label: 'Sistemska', hint: 'Prati podešavanje uređaja', Icon: Monitor },
  { value: 'light', label: 'Svetla', hint: 'Uvek svetle boje', Icon: Sun },
  { value: 'dark', label: 'Tamna', hint: 'Uvek tamne boje', Icon: Moon },
];

export function IzgledTab() {
  const { sidebarLayout, theme, setSidebarLayout, setTheme } = useUiPrefs();
  const activeTheme = THEMES.find((t) => t.value === theme) ?? THEMES[0];

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-control bg-surface-2 text-ink-secondary">
          <Palette className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-ink">Izgled</h2>
          <p className="text-xs text-ink-secondary">Podešavanja izgleda važe samo za tebe, na ovom uređaju.</p>
        </div>
      </div>

      {/* ── Izgled menija (layout A/B/C) ─────────────────────────────────── */}
      <section aria-labelledby="izgled-layout-h" className="space-y-3">
        <div>
          <h3 id="izgled-layout-h" className="text-sm font-semibold text-ink">
            Izgled menija
          </h3>
          <p className="text-xs text-ink-secondary">Vizuelni stil bočnog menija. Primenjuje se odmah.</p>
        </div>
        <div role="radiogroup" aria-labelledby="izgled-layout-h" className="grid gap-3 sm:grid-cols-3">
          {LAYOUTS.map((opt) => (
            <LayoutCard
              key={opt.value}
              option={opt}
              selected={sidebarLayout === opt.value}
              onSelect={() => setSidebarLayout(opt.value)}
            />
          ))}
        </div>
      </section>

      {/* ── Tema (system/light/dark) ─────────────────────────────────────── */}
      <section aria-labelledby="izgled-theme-h" className="space-y-3">
        <div>
          <h3 id="izgled-theme-h" className="text-sm font-semibold text-ink">
            Tema
          </h3>
          <p className="text-xs text-ink-secondary">Boje cele aplikacije. {activeTheme.hint}.</p>
        </div>
        <div
          role="radiogroup"
          aria-labelledby="izgled-theme-h"
          className="inline-flex flex-wrap gap-1 rounded-panel border border-line bg-surface p-1"
        >
          {THEMES.map((opt) => (
            <ThemeSegment
              key={opt.value}
              option={opt}
              selected={theme === opt.value}
              onSelect={() => setTheme(opt.value)}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-secondary">
          <span>Boje trenutne teme:</span>
          <span className="flex overflow-hidden rounded-control border border-line" aria-hidden>
            <span className="h-5 w-5 bg-app" />
            <span className="h-5 w-5 bg-surface" />
            <span className="h-5 w-5 bg-sidebar" />
            <span className="h-5 w-5 bg-accent" />
            <span className="h-5 w-5 bg-status-success" />
            <span className="h-5 w-5 bg-status-warn" />
            <span className="h-5 w-5 bg-status-danger" />
          </span>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ layout karta

/** Jedna karta izbora layouta: mini sidebar preview + naziv/opis + „Preporučeno".
 *  Native radio (sr-only) daje pun tastaturni obrazac (↑/↓ menjaju izbor u grupi). */
function LayoutCard({
  option,
  selected,
  onSelect,
}: {
  option: LayoutOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        'relative flex cursor-pointer flex-col gap-2 rounded-panel border bg-surface p-2.5 transition-colors',
        'has-[:focus-visible]:shadow-[var(--focus-ring)] has-[:focus-visible]:outline-none',
        selected ? 'border-accent' : 'border-line hover:border-ink-disabled',
      )}
    >
      <input
        type="radio"
        name="sidebar-layout"
        value={option.value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <LayoutPreview kind={option.value} />
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-ink">{option.title}</span>
            {option.recommended && (
              <span className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-2xs font-semibold text-accent">
                Preporučeno
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-secondary">{option.desc}</p>
        </div>
        <Check
          className={cn('mt-0.5 h-4 w-4 shrink-0', selected ? 'text-accent' : 'text-transparent')}
          aria-hidden
        />
      </div>
    </label>
  );
}

// ------------------------------------------------------------------ tema segment

function ThemeSegment({
  option,
  selected,
  onSelect,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const { Icon } = option;
  return (
    <label
      title={option.hint}
      className={cn(
        // Touch-meta min 44×44px na <1024px (DS §11) — isti „garant" kao hub redovi
        // (pocetna max-lg:min-h-11); na desktopu kompaktan segment (py-1.5).
        'flex cursor-pointer items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium transition-colors max-lg:min-h-11 max-lg:py-2.5',
        'has-[:focus-visible]:shadow-[var(--focus-ring)] has-[:focus-visible]:outline-none',
        selected ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
      )}
    >
      <input
        type="radio"
        name="app-theme"
        value={option.value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {option.label}
    </label>
  );
}

// ------------------------------------------------------------------ mini preview

/** Dekorativni „red teksta" u mini sidebar preview-u. */
function Line({ className }: { className?: string }) {
  return <span className={cn('block h-1.5 rounded-full', className)} />;
}

/** Aktivna stavka u A/B stilu: leva akcent-traka + blaga pozadina. */
function ActiveRow() {
  return (
    <div className="relative flex items-center rounded-sm bg-sidebar-line/70 py-1 pl-2.5">
      <span className="absolute left-0.5 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-accent" />
      <Line className="w-11 bg-sidebar-ink-active/80" />
    </div>
  );
}

/** Brand red (akcent kvadratić + naziv). */
function Brand({ big }: { big?: boolean }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5">
      <span className={cn('block shrink-0 rounded-sm bg-sidebar-accent', big ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
      <Line className="w-12 bg-sidebar-ink-active/80" />
    </div>
  );
}

/** Mini vizuelni prikaz PUNOG sidebara u datom layoutu (A/B/C) — čisto dekorativno. */
function LayoutPreview({ kind }: { kind: SidebarLayout }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none h-36 select-none overflow-hidden rounded-md bg-sidebar p-2"
    >
      {kind === 'A' && <PreviewA />}
      {kind === 'B' && <PreviewB />}
      {kind === 'C' && <PreviewC />}
    </div>
  );
}

/** A — Hijerarhija: accordion sa chevron-ima; „Tehnologija" uvučena pod-grupa. */
function PreviewA() {
  return (
    <div className="flex flex-col gap-1.5">
      <Brand />
      {/* otvoreni domen (Proizvodnja) */}
      <div className="flex items-center gap-1.5">
        <span className="block h-2.5 w-2.5 shrink-0 rounded-sm bg-sidebar-accent" />
        <Line className="w-16 bg-sidebar-ink-active/70" />
        <ChevronDown className="ml-auto h-2.5 w-2.5 shrink-0 text-sidebar-ink/50" />
      </div>
      <div className="flex items-center pl-4">
        <Line className="w-14 bg-sidebar-ink/45" />
      </div>
      {/* pod-grupa Tehnologija */}
      <div className="ml-3 flex flex-col gap-1 border-l border-sidebar-line pl-2">
        <Line className="w-9 bg-sidebar-accent/80" />
        <ActiveRow />
        <div className="pl-2">
          <Line className="w-10 bg-sidebar-ink/45" />
        </div>
      </div>
      {/* zatvoreni domen */}
      <div className="flex items-center gap-1.5">
        <span className="block h-2.5 w-2.5 shrink-0 rounded-sm bg-sidebar-ink/40" />
        <Line className="w-14 bg-sidebar-ink/45" />
        <ChevronRight className="ml-auto h-2.5 w-2.5 shrink-0 text-sidebar-ink/50" />
      </div>
    </div>
  );
}

/** B — Sekcije: sve otvoreno, bez chevron-a, verzalne oznake sekcija, gusto. */
function PreviewB() {
  return (
    <div className="flex flex-col gap-1">
      <Brand />
      <div className="flex items-center gap-1.5">
        <span className="block h-2 w-2 shrink-0 rounded-sm bg-sidebar-ink/40" />
        <Line className="w-10 bg-sidebar-ink/40" />
      </div>
      <div className="flex flex-col gap-1 pl-3.5">
        <Line className="w-14 bg-sidebar-ink/45" />
        <Line className="w-12 bg-sidebar-ink/45" />
      </div>
      <div className="ml-3 flex flex-col gap-1 border-l border-sidebar-line pl-2">
        <Line className="w-9 bg-sidebar-accent/70" />
        <ActiveRow />
        <div className="pl-2">
          <Line className="w-10 bg-sidebar-ink/45" />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="block h-2 w-2 shrink-0 rounded-sm bg-sidebar-ink/40" />
        <Line className="w-8 bg-sidebar-ink/40" />
      </div>
      <div className="pl-3.5">
        <Line className="w-12 bg-sidebar-ink/45" />
      </div>
    </div>
  );
}

/** C — Premium: krupnije ikone, aktivna stavka kao kartica (ring), jača akcent-traka. */
function PreviewC() {
  return (
    <div className="flex flex-col gap-2">
      <Brand big />
      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent/10 px-1.5 py-1">
        <span className="block h-3 w-3 shrink-0 rounded-sm bg-sidebar-accent" />
        <Line className="w-16 bg-sidebar-ink-active/70" />
      </div>
      <div className="flex items-center gap-2 pl-1.5">
        <span className="block h-2.5 w-2.5 shrink-0 rounded-sm bg-sidebar-ink/40" />
        <Line className="w-14 bg-sidebar-ink/45" />
      </div>
      <div className="ml-2 flex flex-col gap-1.5 border-l-2 border-sidebar-accent/50 pl-2">
        <Line className="w-9 bg-sidebar-accent/80" />
        <div className="flex items-center gap-1.5 rounded-md bg-sidebar-accent/15 px-1.5 py-1 ring-1 ring-inset ring-sidebar-accent/30">
          <span className="block h-2.5 w-2.5 shrink-0 rounded-sm bg-sidebar-accent" />
          <Line className="w-10 bg-sidebar-ink-active/85" />
        </div>
        <div className="flex items-center gap-1.5 px-1.5">
          <span className="block h-2.5 w-2.5 shrink-0 rounded-sm bg-sidebar-ink/40" />
          <Line className="w-9 bg-sidebar-ink/45" />
        </div>
      </div>
    </div>
  );
}
