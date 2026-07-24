'use client';

// Omiljeni moduli (zahtev 010/26) — korisnik označava nav module „zvezdicom" i oni se
// prikazuju NA VRHU menija/huba. Persistencija V1: localStorage po uređaju (bez backenda).
// Isti obrazac kao use-ui-prefs.ts: modul-level store sa subscriberima (sidebar, hub i
// paleta dele ISTO stanje u istom tabu) + useSyncExternalStore.
//
// KLJUČ PO KORISNIKU (review 010/26 §2): `servosync.ui.favorites.<userId>` — na deljenoj
// mašini omiljeni jednog naloga ne cure u drugi. Store pamti aktivnog korisnika i na
// promenu userId-a RESETUJE (favorites=[]) pa re-hidrira iz novog ključa. Bez userId
// (još se učitava / odjavljen) → prazna lista, bez čitanja/pisanja. Stari ključ se NE
// briše na odjavu (ista lista se vraća pri ponovnoj prijavi).
//
// MULTI-TAB (review 010/26 §1): `storage` event (stiže SAMO u DRUGE tabove) osvežava
// listu čim drugi tab upiše; toggle radi read-before-write (baza za mutaciju = trenutni
// localStorage, ne samo in-memory) da poslednji tab ne pregazi dodavanje iz drugog taba.
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

const KEY_PREFIX = 'servosync.ui.favorites';

/** localStorage ključ omiljenih za dati nalog (po korisniku — bez curenja na deljenoj mašini). */
function keyFor(userId: number): string {
  return `${KEY_PREFIX}.${userId}`;
}

let favorites: string[] = [];
/** Nalog za koji je store trenutno hidriran (null = niko → prazna lista, bez pisanja). */
let activeUserId: number | null = null;

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

/** Učitaj listu za trenutno aktivnog korisnika iz storage-a (dedup); prazno ako ga nema. */
function loadForActive(): string[] {
  if (activeUserId == null) return [];
  const stored = parseHrefs(safeGet(keyFor(activeUserId)));
  // Dedup po href-u (očisti eventualne duplikate iz ranije verzije storage-a).
  return stored ? Array.from(new Set(stored)) : [];
}

// --- multi-tab sync: `storage` event stiže SAMO u druge tabove ---------------
let storageBound = false;
function onStorage(e: StorageEvent): void {
  if (activeUserId == null) return;
  const key = keyFor(activeUserId);
  // e.key === null → localStorage.clear() u drugom tabu (osveži sve); inače reaguj samo
  // na ključ AKTIVNOG korisnika (tuđi/nevezani ključevi se ignorišu).
  if (e.key !== null && e.key !== key) return;
  favorites = loadForActive();
  emit();
}
function ensureStorageListener(): void {
  if (storageBound || typeof window === 'undefined') return;
  storageBound = true;
  window.addEventListener('storage', onStorage);
}

/**
 * Postavi aktivnog korisnika i (re)hidriraj store. Idempotentno za isti userId (više
 * pozivalaca u istom tabu deli isti store — poziv sa istim id-em je no-op). Na promenu
 * naloga: reset (favorites=[]) + re-hydrate iz novog ključa; `null` (odjavljen/neučitan)
 * → prazna lista, bez čitanja/pisanja.
 */
function activateUser(userId: number | null): void {
  if (userId === activeUserId) return;
  activeUserId = userId;
  favorites = loadForActive();
  emit();
}

// ------------------------------------------------------------------ mutatori (store-level)

export function isFavorite(href: string): boolean {
  return favorites.includes(href);
}

/**
 * Dodaj/ukloni href iz omiljenih — nova stavka ide na KRAJ (redosled = redosled dodavanja).
 * Bez aktivnog korisnika = no-op (bez pisanja). Read-before-write: baza za mutaciju je
 * TRENUTNI localStorage (ne samo in-memory) da poslednji tab ne pregazi dodavanje koje je
 * u međuvremenu upisao drugi tab.
 */
export function toggleFavorite(href: string): void {
  if (activeUserId == null) return;
  const key = keyFor(activeUserId);
  const base = parseHrefs(safeGet(key)) ?? favorites;
  const next = base.includes(href) ? base.filter((h) => h !== href) : [...base, href];
  favorites = Array.from(new Set(next));
  safeSet(key, JSON.stringify(favorites));
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
 * Deljeno stanje omiljenih modula. `userId`:
 *  • broj/`null` → „vlasnik": postavlja aktivnog korisnika u store (reset + rehidracija na
 *    promenu; `null` = odjavljen/neučitan → prazna lista, bez pisanja). Pozivaoci sa auth
 *    kontekstom (app-shell, hub, paleta) prosleđuju `user?.id ?? null`.
 *  • izostavljen (`undefined`) → „čitač": samo se pretplati (redovi u sidebaru koji zovu hook
 *    po redu) i NE dira aktivnog korisnika — vlasnik iznad njih ga već drži.
 * Sve komponente u istom tabu dele isti store (subscribe/emit). Razrešavanje na vidljive
 * NavModule-e (RBAC + dedup + izostavljanje nepostojećih) radi `resolveFavoriteModules`.
 */
export function useNavFavorites(userId?: number | null): UseNavFavorites {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureStorageListener();
    if (userId === undefined) return; // čitač — ne dira aktivnog korisnika
    activateUser(userId);
  }, [userId]);
  return {
    favorites: list,
    isFavorite,
    toggleFavorite,
  };
}
