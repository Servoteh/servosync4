'use client';

// Omiljeni moduli (zahtev 010/26) — korisnik označava nav module „zvezdicom" i oni se
// prikazuju NA VRHU menija/huba. Persistencija V1: localStorage po uređaju (bez backenda).
// Isti obrazac kao use-ui-prefs.ts: modul-level store sa subscriberima (sidebar, hub i
// paleta dele ISTO stanje u istom tabu) + useSyncExternalStore.
//
// SSR-safe za static export (`output: "export"`): kreće od praznog niza (isto na serveru i
// pri prvom klijentskom paint-u → nema hydration mismatch-a), pa se tek u `useEffect` po
// mount-u učita iz localStorage-a. localStorage se NIKAD ne čita u render putanji; sav
// pristup je u try/catch (privatni režim ume da baci na getItem/setItem).
//
// Vrednost = JSON niz href stringova; redosled = redosled dodavanja (spec §2). Dedup po
// href-u (crosslisted moduli = jedna stavka, spec §5). Nepostojeći/nedozvoljeni href se
// NE briše iz storage-a — filtriranje na prikaz radi navigation.resolveFavoriteModules.

import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'servosync.ui.favorites';

let favorites: string[] = [];
let hydrated = false;

// Stabilna referenca za SSR/prvi snapshot (useSyncExternalStore traži istu vrednost).
const SERVER_SNAPSHOT: string[] = [];

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
    /* privatni režim / blokiran storage — ostaje samo u memoriji */
  }
}

function parseHrefs(raw: string | null): string[] | null {
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
  const stored = parseHrefs(safeGet(KEY));
  if (stored) {
    // Dedup po href-u (očisti eventualne duplikate iz ranije verzije storage-a).
    const deduped = Array.from(new Set(stored));
    favorites = deduped;
    emit();
  }
}

// ------------------------------------------------------------------ mutatori (store-level)

export function isFavorite(href: string): boolean {
  return favorites.includes(href);
}

/** Dodaj/ukloni href iz omiljenih — nova stavka ide na KRAJ (redosled = redosled dodavanja). */
export function toggleFavorite(href: string): void {
  favorites = favorites.includes(href)
    ? favorites.filter((h) => h !== href)
    : [...favorites, href];
  safeSet(KEY, JSON.stringify(favorites));
  emit();
}

// ------------------------------------------------------------------ hook

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): string[] {
  return favorites;
}

function getServerSnapshot(): string[] {
  return SERVER_SNAPSHOT;
}

export interface UseNavFavorites {
  /** Sirovi href-ovi omiljenih (redosled dodavanja) — filtriranje na prikaz radi pozivalac. */
  favorites: string[];
  isFavorite: (href: string) => boolean;
  toggleFavorite: (href: string) => void;
}

/**
 * Deljeno stanje omiljenih modula. Vraća sirovu listu href-ova (+ mutatore); sve
 * komponente u istom tabu dele isti store (subscribe/emit). Razrešavanje na vidljive
 * NavModule-e (RBAC + dedup + izostavljanje nepostojećih) radi
 * `resolveFavoriteModules` iz navigation.ts.
 */
export function useNavFavorites(): UseNavFavorites {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Učitaj iz localStorage-a po mount-u (guard u hydrateFromStorage-u → tačno jednom).
  useEffect(() => {
    hydrateFromStorage();
  }, []);
  return {
    favorites: list,
    isFavorite,
    toggleFavorite,
  };
}
