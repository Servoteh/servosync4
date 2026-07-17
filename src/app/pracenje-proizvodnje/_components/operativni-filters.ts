// Filter sloj Operativnog plana (GAP-PR-07) — DOSLOVNI port 1.0 filtera:
// getFilteredActivities (state/pracenjeProizvodnjeState.js:821) + hydrate/persist/URL
// (:883/:919). 11 filtera + quick preseci + Reset + persist u localStorage po RN-u +
// URL parametri (URL pobeđuje pri hidrataciji). SSR-safe (typeof window guard).

import { useCallback, useEffect, useState } from 'react';
import type { AktivnostRow } from '@/api/pracenje';

export interface OperativniFilters {
  search: string;
  odeljenja: string[];
  statusi: string[];
  prioriteti: string[];
  odgovoran: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  onlyLate: boolean;
  onlyBlocked: boolean;
  hideClosed: boolean;
  quick: string; // '' | 'visok' | 'kasni7' | 'bez_odgovornog'
}

export function defaultFilters(): OperativniFilters {
  return {
    search: '',
    odeljenja: [],
    statusi: [],
    prioriteti: [],
    odgovoran: '',
    dateFrom: '',
    dateTo: '',
    onlyLate: false,
    onlyBlocked: false,
    hideClosed: false,
    quick: '',
  };
}

const lsKey = (rnId: string) => `pracenje:${rnId}:filters`;

function splitParam(v: string | null): string[] | null {
  if (v == null) return null;
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

/** Hidratacija: defaults ← LS ← URL (URL pobeđuje), verno 1.0 hydrateFilters. */
function hydrate(rnId: string): OperativniFilters {
  const defaults = defaultFilters();
  if (typeof window === 'undefined') return defaults;
  let stored: Partial<OperativniFilters> = {};
  try {
    stored = JSON.parse(window.localStorage.getItem(lsKey(rnId)) || '{}') || {};
  } catch {
    stored = {};
  }
  const url = new URLSearchParams(window.location.search);
  return {
    ...defaults,
    ...stored,
    odeljenja: splitParam(url.get('dept')) || stored.odeljenja || [],
    statusi: splitParam(url.get('status')) || stored.statusi || [],
    prioriteti: splitParam(url.get('prioritet')) || stored.prioriteti || [],
    onlyLate: url.get('kasni') === '1' || !!stored.onlyLate,
    onlyBlocked: url.get('blokirano') === '1' || !!stored.onlyBlocked,
    hideClosed: url.get('hideClosed') === '1' || !!stored.hideClosed,
    search: url.get('q') ?? stored.search ?? '',
    odgovoran: url.get('odgovoran') ?? stored.odgovoran ?? '',
    dateFrom: url.get('od') ?? stored.dateFrom ?? '',
    dateTo: url.get('do') ?? stored.dateTo ?? '',
    quick: url.get('quick') ?? stored.quick ?? '',
  };
}

function setOrDelete(p: URLSearchParams, key: string, value: string) {
  if (value) p.set(key, value);
  else p.delete(key);
}

/** Persist u LS + sinhronizacija URL-a (bez novog history koraka — replaceState). */
function persistAndSync(rnId: string, f: OperativniFilters) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(lsKey(rnId), JSON.stringify(f));
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams(window.location.search);
  setOrDelete(params, 'q', f.search);
  setOrDelete(params, 'dept', f.odeljenja.join(','));
  setOrDelete(params, 'status', f.statusi.join(','));
  setOrDelete(params, 'prioritet', f.prioriteti.join(','));
  setOrDelete(params, 'odgovoran', f.odgovoran);
  setOrDelete(params, 'od', f.dateFrom);
  setOrDelete(params, 'do', f.dateTo);
  setOrDelete(params, 'kasni', f.onlyLate ? '1' : '');
  setOrDelete(params, 'blokirano', f.onlyBlocked ? '1' : '');
  setOrDelete(params, 'hideClosed', f.hideClosed ? '1' : '');
  setOrDelete(params, 'quick', f.quick);
  const qsStr = params.toString();
  window.history.replaceState(null, '', qsStr ? `${window.location.pathname}?${qsStr}` : window.location.pathname);
}

export function useOperativniFilters(rnId: string) {
  const [filters, setFilters] = useState<OperativniFilters>(() => hydrate(rnId));

  // Re-hidratacija kad se promeni RN (drill na drugi nalog).
  useEffect(() => {
    setFilters(hydrate(rnId));
  }, [rnId]);

  // Persist + URL sync na svaku promenu.
  useEffect(() => {
    persistAndSync(rnId, filters);
  }, [rnId, filters]);

  const set = useCallback(<K extends keyof OperativniFilters>(k: K, v: OperativniFilters[K]) => {
    setFilters((prev) => ({ ...prev, [k]: v }));
  }, []);

  const reset = useCallback(() => setFilters(defaultFilters()), []);

  const toggleQuick = useCallback((q: string) => {
    setFilters((prev) => ({ ...prev, quick: prev.quick === q ? '' : q }));
  }, []);

  return { filters, set, reset, toggleQuick };
}

/** DOSLOVNI port getFilteredActivities — isti redosled provera i sort po rb. */
export function filterActivities(activities: AktivnostRow[], f: OperativniFilters): AktivnostRow[] {
  const search = String(f.search || '').trim().toLowerCase();
  const eff = (a: AktivnostRow) => String((a.efektivni_status as string | undefined) || a.status || '');
  const who = (a: AktivnostRow) =>
    String(a.odgovoran || a.odgovoran_label || (a.odgovoran_radnik_id as string) || (a.odgovoran_user_id as string) || '');
  return activities
    .filter((a) => {
      if (search) {
        const hay = [a.naziv_aktivnosti, a.opis, a.broj_tp, a.kolicina_text, a.odgovoran, a.odgovoran_label, a.rizik_napomena]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      if (f.odeljenja.length && !f.odeljenja.includes(String(a.odeljenje || a.odeljenje_naziv || ''))) return false;
      if (f.statusi.length && !f.statusi.includes(eff(a))) return false;
      if (f.prioriteti.length && !f.prioriteti.includes(String(a.prioritet || ''))) return false;
      if (f.odgovoran && !who(a).toLowerCase().includes(f.odgovoran.toLowerCase())) return false;
      if (f.dateFrom && (!a.planirani_zavrsetak || a.planirani_zavrsetak < f.dateFrom)) return false;
      if (f.dateTo && (!a.planirani_zavrsetak || a.planirani_zavrsetak > f.dateTo)) return false;
      if (f.onlyLate && !a.kasni) return false;
      if (f.onlyBlocked && eff(a) !== 'blokirano') return false;
      if (f.hideClosed && eff(a) === 'zavrseno') return false;
      if (f.quick === 'visok' && String(a.prioritet || '') !== 'visok') return false;
      if (f.quick === 'kasni7' && !(a.kasni && Number(a.rezerva_dani) < -7)) return false;
      if (f.quick === 'bez_odgovornog' && (a.odgovoran || a.odgovoran_label || a.odgovoran_radnik_id || a.odgovoran_user_id)) return false;
      return true;
    })
    .sort((a, b) => Number(a.rb || 0) - Number(b.rb || 0));
}

/** Aktivni-filter sažetak (chip tekstovi). */
export function activeFilterChips(f: OperativniFilters): string[] {
  const chips: string[] = [];
  if (f.odeljenja.length) chips.push(`Odeljenja: ${f.odeljenja.join(', ')}`);
  if (f.statusi.length) chips.push(`Status: ${f.statusi.join(', ')}`);
  if (f.prioriteti.length) chips.push(`Prioritet: ${f.prioriteti.join(', ')}`);
  if (f.onlyLate) chips.push('Samo kasni');
  if (f.onlyBlocked) chips.push('Samo blokirano');
  if (f.hideClosed) chips.push('Sakrij zatvorene');
  return chips;
}
