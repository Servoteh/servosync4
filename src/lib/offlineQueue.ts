/**
 * Offline queue za premeštanja (paritet 1.0 services/offlineQueue.js).
 *
 * Kad radnik skenira/unese premeštanje dok je uređaj bez mreže, payload
 * (`MovementVars`) se upisuje u localStorage i automatski šalje na prvi `online`
 * event (ili ručnim klikom na „⏳ N čeka" badge). Idempotencija: svaki payload
 * već nosi `clientEventUuid` (generisan u formi jednom); DB fn drži partial
 * UNIQUE indeks pa retry istog UUID-a ne pravi duplikat.
 *
 * localStorage (ne IndexedDB): očekivano <100 malih zapisa; sinhroni API
 * umanjuje race sa UI-em (isti razlog kao 1.0).
 */

import { postMovement, type MovementVars } from '@/api/lokacije';

const STORAGE_KEY = 'loc.offlineQueue.v1';
const MAX_QUEUE_SIZE = 500;
const MAX_ATTEMPTS = 10;

export interface QueueEntry {
  id: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  payload: MovementVars;
}

export interface FlushResult {
  ok: number;
  failed: number;
  dropped: number;
  busy?: boolean;
}

function readQueue(): QueueEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as QueueEntry[]) : [];
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return [];
  }
}

function writeQueue(queue: QueueEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (e) {
    // Quota — u najgorem slučaju gubimo NOVI unos, ne stare.
    console.error('[offlineQueue] write failed', e);
  }
  notify();
}

function genId(): string {
  return ('Q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)).toUpperCase();
}

/**
 * Ubaci premeštanje u queue. Payload MORA već nositi `clientEventUuid`
 * (forma ga generiše jednom — ključ idempotencije za retry).
 */
export function enqueueMovement(payload: MovementVars): QueueEntry {
  const queue = readQueue();
  if (queue.length >= MAX_QUEUE_SIZE) {
    throw new Error(`Queue pun (${MAX_QUEUE_SIZE}) — sinhronizuj prvo postojeće pre novog unosa.`);
  }
  const entry: QueueEntry = {
    id: genId(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    payload,
  };
  queue.push(entry);
  writeQueue(queue);
  return entry;
}

export function listPendingMovements(): QueueEntry[] {
  return readQueue();
}

export function countPendingMovements(): number {
  return readQueue().length;
}

export function clearPendingMovements(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notify();
}

function removeEntry(id: string): void {
  const queue = readQueue();
  const next = queue.filter((e) => e.id !== id);
  if (next.length !== queue.length) writeQueue(next);
}

function persistEntry(entry: QueueEntry): void {
  const queue = readQueue();
  const idx = queue.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    queue[idx] = entry;
    writeQueue(queue);
  }
}

/**
 * Fatalna greška = retry ne pomaže (validacija / dozvole / neaktivan roditelj).
 * 2.0 BE javlja greške kao HTTP status + poruku (apiFetch baca) — klasifikujemo
 * po statusu/kodu iz poruke. Mrežni pad (fetch throw bez statusa) je transientan.
 */
function isFatalError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    // 5xx = server privremeno; 408/429 = retry; ostalo 4xx = trajna (bad payload/authz).
    if (status >= 500) return false;
    if (status === 408 || status === 429) return false;
    return true;
  }
  const msg = String((err as { message?: string } | null)?.message ?? err ?? '').toLowerCase();
  // Bez statusa: mrežne/timeout poruke = transient; sve ostalo tretiramo kao transient
  // (bezbednije zadržati u queue-u nego tiho odbaciti; MAX_ATTEMPTS je gornja brana).
  return /\b(bad_|not_authorized|not_authenticated|parent_inactive|validation|invalid)\b/.test(msg);
}

let _flushInProgress = false;

/** Pokušaj flush svih redova. Serijalizovano (online auto + ručni klik ne paralelno). */
export async function flushPendingMovements(): Promise<FlushResult> {
  if (_flushInProgress) return { ok: 0, failed: 0, dropped: 0, busy: true };
  _flushInProgress = true;
  try {
    return await flushInner();
  } finally {
    _flushInProgress = false;
  }
}

async function flushInner(): Promise<FlushResult> {
  const queue = readQueue();
  let ok = 0;
  let failed = 0;
  let dropped = 0;

  for (const entry of queue) {
    if (entry.attempts >= MAX_ATTEMPTS) {
      console.error('[offlineQueue] dropping entry (max attempts)', entry);
      removeEntry(entry.id);
      dropped += 1;
      continue;
    }
    entry.attempts += 1;
    try {
      await postMovement(entry.payload); // uspeh (uklj. idempotent replay) → ukloni
      removeEntry(entry.id);
      ok += 1;
    } catch (e) {
      entry.lastError = e instanceof Error ? e.message : String(e);
      if (isFatalError(e)) {
        console.warn('[offlineQueue] dropping due to fatal error', entry.lastError);
        removeEntry(entry.id);
        dropped += 1;
      } else {
        persistEntry(entry);
        failed += 1;
      }
    }
  }
  return { ok, failed, dropped };
}

// ── Reaktivni sloj (subscribe) — badge se osvežava bez pollinga ──────────────

type Listener = () => void;
const listeners = new Set<Listener>();
function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

/** Pretplata na promene queue-a (badge count). Vraća unsubscribe. */
export function subscribeQueue(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Auto-flush na povratak mreže ─────────────────────────────────────────────

let _autoFlushWired = false;
/** Instalira `online` listener (idempotentno). Poziva se iz UI mount-a. */
export function installAutoFlush(): void {
  if (_autoFlushWired || typeof window === 'undefined') return;
  _autoFlushWired = true;
  window.addEventListener('online', () => {
    if (countPendingMovements() === 0) return;
    void flushPendingMovements().catch((e) => console.error('[offlineQueue] auto-flush failed', e));
  });
  window.addEventListener('storage', (e) => {
    // Drugi tab je promenio queue → osveži badge u ovom tabu.
    if (e.key === STORAGE_KEY) notify();
  });
}
