'use client';

// Persistirane UI preference shell-a (F0 SIDEBAR_HUB) — režim sidebara, otvoreni
// domeni i poslednje korišćeni moduli. Modul-level store sa subscriberima: bell,
// paleta i shell dele ISTO stanje u istom tabu (svaki hook se pretplati na store).
//
// SSR-safe za static export (`output: "export"`): stanje kreće od default-a (isto na
// serveru i pri prvom klijentskom paint-u → nema hydration mismatch-a), pa se tek u
// `useEffect` po mount-u učita iz localStorage-a (prihvatljiv kratak flash). localStorage
// se NIKAD ne čita u render putanji. Sav pristup je u try/catch (privatni režim ume da
// baci na `getItem`/`setItem`).

import { useEffect, useSyncExternalStore } from 'react';

export type SidebarMode = 'full' | 'rail' | 'hidden';

/** Vizuelni layout PUNOG sidebara (ortogonalno na `SidebarMode` full/rail/hidden). */
export type SidebarLayout = 'A' | 'B' | 'C';

/** Izbor teme za CELU aplikaciju. `system` → prati OS (prefers-color-scheme). */
export type ThemePref = 'system' | 'light' | 'dark';

export interface UiPrefs {
  /** Trenutni režim sidebara. */
  sidebar: SidebarMode;
  /** Prethodni režim — za Ctrl+B toggle (tekući ↔ prethodni). */
  sidebarPrev: SidebarMode;
  /** Vizuelni layout punog sidebara (A hijerarhija / B sekcije / C premium). Default 'C'. */
  sidebarLayout: SidebarLayout;
  /** Tema aplikacije (system/light/dark). Default 'light' za bezbedan prvi izlazak dark
   *  moda (niko sa tamnim OS-om ne dobija dark neočekivano; dark je pun izbor u Podešavanjima). */
  theme: ThemePref;
  /** Ručno otvoreni domeni u accordion-u (stabilni slug-ovi NavDomain.id). */
  openDomains: string[];
  /** Poslednje korišćeni moduli (href-ovi, MRU, max 8) — „Brzo"/Ctrl+K. */
  recentModules: string[];
}

interface UiStore extends UiPrefs {
  /** true tek posle učitavanja iz localStorage-a; prvi paint = false (bez tranzicija). */
  hydrated: boolean;
}

const KEYS = {
  sidebar: 'servosync.ui.sidebar',
  sidebarPrev: 'servosync.ui.sidebarPrev',
  layout: 'servosync.ui.layout',
  theme: 'servosync.ui.theme',
  openDomains: 'servosync.ui.openDomains',
  recentModules: 'servosync.ui.recentModules',
} as const;

const RECENT_MAX = 8;

const DEFAULTS: UiPrefs = {
  sidebar: 'full',
  sidebarPrev: 'full',
  sidebarLayout: 'C',
  theme: 'light',
  openDomains: [],
  recentModules: [],
};

// Stabilna referenca za SSR snapshot (useSyncExternalStore zahteva istu vrednost).
const SERVER_SNAPSHOT: UiStore = { ...DEFAULTS, hydrated: false };

let state: UiStore = { ...DEFAULTS, hydrated: false };
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // privatni režim / blokiran storage
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* privatni režim / blokiran storage — preference ostaju samo u memoriji */
  }
}

function isMode(v: unknown): v is SidebarMode {
  return v === 'full' || v === 'rail' || v === 'hidden';
}

function isLayout(v: unknown): v is SidebarLayout {
  return v === 'A' || v === 'B' || v === 'C';
}

function isTheme(v: unknown): v is ThemePref {
  return v === 'system' || v === 'light' || v === 'dark';
}

/**
 * Primeni temu na <html data-theme> — side-effect (guard window/document za SSR/static
 * export). `system` UKLANJA atribut (prepušta odluku @media prefers-color-scheme), a
 * `light`/`dark` ga postavljaju (toggle nadjačava media). Isti izvor kao no-flash skript
 * u layout.tsx — da store i DOM ostanu saglasni i posle hydrate-a.
 */
function applyTheme(theme: ThemePref): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

function parseStringArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')
      ? (parsed as string[])
      : null;
  } catch {
    return null;
  }
}

/** Jednokratno učitavanje iz localStorage-a po prvom mount-u (pozvano iz efekta). */
function hydrateFromStorage(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  const sidebar = safeGet(KEYS.sidebar);
  const sidebarPrev = safeGet(KEYS.sidebarPrev);
  const layout = safeGet(KEYS.layout);
  const theme = safeGet(KEYS.theme);
  const openDomains = parseStringArray(safeGet(KEYS.openDomains));
  const recentModules = parseStringArray(safeGet(KEYS.recentModules));
  const resolvedTheme = isTheme(theme) ? theme : DEFAULTS.theme;
  state = {
    sidebar: isMode(sidebar) ? sidebar : DEFAULTS.sidebar,
    sidebarPrev: isMode(sidebarPrev) ? sidebarPrev : DEFAULTS.sidebarPrev,
    sidebarLayout: isLayout(layout) ? layout : DEFAULTS.sidebarLayout,
    theme: resolvedTheme,
    openDomains: openDomains ?? DEFAULTS.openDomains,
    recentModules: recentModules ? recentModules.slice(0, RECENT_MAX) : DEFAULTS.recentModules,
    hydrated: true,
  };
  // No-flash skript (layout.tsx) je već postavio data-theme pre paint-a; re-primena
  // istog izvora drži DOM i store saglasnim (idempotentno).
  applyTheme(resolvedTheme);
  emit();
}

// ------------------------------------------------------------------ mutatori (store-level)

/** Postavi režim sidebara; prethodni pamti radi Ctrl+B toggle-a. */
export function setSidebarMode(mode: SidebarMode): void {
  if (mode === state.sidebar) return;
  const prev = state.sidebar;
  state = { ...state, sidebar: mode, sidebarPrev: prev };
  safeSet(KEYS.sidebar, mode);
  safeSet(KEYS.sidebarPrev, prev);
  emit();
}

/** Ctrl+B: vrati se na prethodni režim (tekući ↔ prethodni). Na svežem profilu su
    tekući i prethodni isti ('full'/'full') — fallback na 'hidden' da prečica nikad
    ne bude no-op (reklamirana je u tooltip-u dugmeta). */
export function toggleSidebar(): void {
  if (state.sidebarPrev === state.sidebar) {
    setSidebarMode(state.sidebar === 'hidden' ? 'full' : 'hidden');
    return;
  }
  setSidebarMode(state.sidebarPrev);
}

/** Postavi vizuelni layout punog sidebara (A/B/C) — persist. */
export function setSidebarLayout(layout: SidebarLayout): void {
  if (layout === state.sidebarLayout) return;
  state = { ...state, sidebarLayout: layout };
  safeSet(KEYS.layout, layout);
  emit();
}

/**
 * Postavi temu (system/light/dark) — persist + ODMAH primeni na <html data-theme>
 * (side-effect: bez čekanja na re-render, da HMI/observeri i CSS reaguju istog trena).
 */
export function setTheme(theme: ThemePref): void {
  state = { ...state, theme };
  safeSet(KEYS.theme, theme);
  applyTheme(theme);
  emit();
}

/** Zameni listu ručno otvorenih domena (persist). */
export function setOpenDomains(ids: string[]): void {
  state = { ...state, openDomains: ids };
  safeSet(KEYS.openDomains, JSON.stringify(ids));
  emit();
}

/** Otvori/zatvori jedan domen u accordion-u. */
export function toggleDomain(id: string): void {
  const next = state.openDomains.includes(id)
    ? state.openDomains.filter((d) => d !== id)
    : [...state.openDomains, id];
  setOpenDomains(next);
}

/** Upiši href na vrh MRU liste poslednje korišćenih modula (max 8). */
export function pushRecentModule(href: string): void {
  const next = [href, ...state.recentModules.filter((h) => h !== href)].slice(0, RECENT_MAX);
  state = { ...state, recentModules: next };
  safeSet(KEYS.recentModules, JSON.stringify(next));
  emit();
}

// ------------------------------------------------------------------ hook

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): UiStore {
  return state;
}

function getServerSnapshot(): UiStore {
  return SERVER_SNAPSHOT;
}

export interface UseUiPrefs extends UiStore {
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebar: () => void;
  setSidebarLayout: (layout: SidebarLayout) => void;
  setTheme: (theme: ThemePref) => void;
  setOpenDomains: (ids: string[]) => void;
  toggleDomain: (id: string) => void;
  pushRecentModule: (href: string) => void;
}

/**
 * Deljeno UI stanje shell-a. Vraća trenutne preference (+ `hydrated`) i mutatore.
 * Sve komponente u istom tabu dele isti store (subscribe/emit).
 */
export function useUiPrefs(): UseUiPrefs {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Učitaj iz localStorage-a po mount-u (guard u hydrateFromStorage-u → tačno jednom).
  useEffect(() => {
    hydrateFromStorage();
  }, []);
  return {
    ...prefs,
    setSidebarMode,
    toggleSidebar,
    setSidebarLayout,
    setTheme,
    setOpenDomains,
    toggleDomain,
    pushRecentModule,
  };
}
