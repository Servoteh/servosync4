'use client';

import { useMemo } from 'react';
import { useAttendanceNow, useDirectory } from '@/api/kadrovska';
import { normalize } from '@/lib/fuzzy';
import { sv } from '../common';
import { STATUS_META } from './helpers';

/**
 * Deljeni izvor „prisustva UŽIVO" — jedini spoj imenika i `v_attendance_now`.
 * Koriste ga DESKTOP prikaz (Kadrovska → Radni sati → Prisustvo → Uživo) i
 * MOBILNA ruta `/mob/prisustvo` (zahtev 019/26), da status/filter semantika ne
 * bi živela u dve kopije. Podaci: `GET /kadrovska/attendance/now` (gate
 * `kadrovska.attendance`) + `GET /kadrovska/directory`.
 */

export type StatusFilter = 'svi' | 'prisutan' | 'pauza' | 'odsutan';

/** Filter dugmad (redosled je isti na desktopu i na telefonu). */
export const LIVE_SEGMENTS: { key: StatusFilter; label: string }[] = [
  { key: 'svi', label: 'Svi' },
  { key: 'prisutan', label: 'Prisutni' },
  { key: 'pauza', label: 'Pauza' },
  { key: 'odsutan', label: 'Odsutni' },
];

/** Jedan red UŽIVO liste = zaposleni (iz imenika) + poslednji prolaz (ako ga ima). */
export interface LiveRow {
  employeeId: string;
  fullName: string;
  department: string;
  status: StatusFilter;
  noPunch24h: boolean;
  eventTs: string | null;
  direction: string | null;
  terminalName: string;
}

export interface LiveCounts {
  prisutan: number;
  pauza: number;
  odsutan: number;
}

/** Tajmaut „uživo" upita — telefon na slaboj mreži ne sme da visi u „Učitavam…". */
const LIVE_TIMEOUT_MS = 15_000;

/**
 * Merge: AKTIVNI zaposleni iz imenika ⨝ v_attendance_now — ko nema prolaz u 24 h
 * prikazan je kao „Odsutan / bez prolaza u 24 h" (paritet 1.0 `_rows()`).
 *
 * ⚠️ `GET /kadrovska/directory` NAMERNO vraća i neaktivne (BE #30: nameMap mora da
 * razreši imena istorijskih redova), a `v_attendance_now` ih nema — bez filtera bi
 * svaki bivši zaposleni ispao „odsutan" i naduvao brojač. Zato se filtrira na mestu
 * upotrebe, kao na ostalim ekranima („load all, filter at use site").
 *
 * ⚠️ Dok „uživo" snimak NIJE stigao (prvi fetch pao ili još traje) lista je PRAZNA —
 * sintetisati „svi odsutni" iz samog imenika je lažan podatak (izgleda kao da u
 * firmi nema nikoga). UI to razlikuje preko `hasSnapshot`.
 *
 * `enabled=false` (nema prava / još se čekaju dozvole) ne ispaljuje zahteve.
 */
export function useLiveAttendance(enabled = true) {
  const dirQ = useDirectory(enabled, LIVE_TIMEOUT_MS);
  const nowQ = useAttendanceNow(enabled, LIVE_TIMEOUT_MS);

  const hasSnapshot = !!nowQ.data;
  const hasDirectory = !!dirQ.data;

  const rows: LiveRow[] = useMemo(() => {
    const now = nowQ.data?.data;
    if (!now) return []; // nema snimka → nema prikaza (ne izmišljaj „svi odsutni")
    const dir = dirQ.data?.data ?? [];
    const byEmp = new Map(now.map((r) => [sv(r, 'employee_id'), r]));
    return dir
      .filter((e) => sv(e, 'is_active') !== 'false')
      .map((e): LiveRow => {
        const id = sv(e, 'id');
        const r = byEmp.get(id);
        const status = (r ? sv(r, 'status') : 'odsutan') as StatusFilter;
        return {
          employeeId: id,
          fullName: sv(e, 'full_name'),
          department: sv(e, 'department'),
          status: STATUS_META[status] ? status : 'odsutan',
          noPunch24h: !r,
          eventTs: r ? sv(r, 'event_ts') || null : null,
          direction: r ? sv(r, 'direction') || null : null,
          terminalName: r ? sv(r, 'terminal_name') : '',
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'sr'));
  }, [dirQ.data, nowQ.data]);

  const counts: LiveCounts = useMemo(() => countByStatus(rows), [rows]);

  return {
    rows,
    counts,
    /** True tek kad je bar jedan „uživo" snimak stigao (inače je lista prazna s razlogom). */
    hasSnapshot,
    hasDirectory,
    isLoading: dirQ.isLoading || nowQ.isLoading,
    isFetching: dirQ.isFetching || nowQ.isFetching,
    isError: dirQ.isError || nowQ.isError,
    /** Offline (TanStack pauzira upit dok nema mreže) — nije greška, nego čekanje. */
    isPaused: dirQ.isPaused || nowQ.isPaused,
    /**
     * Svežina PRIKAZA = starije od dva vremena (i imenik i snimak stoje iza liste).
     * 0 = prikaza još nema, pa zaglavlje ne sme da tvrdi „osveženo".
     */
    updatedAt:
      hasSnapshot && hasDirectory ? Math.min(nowQ.dataUpdatedAt, dirQ.dataUpdatedAt) : 0,
    /** Await-able: pozivalac zna kad je RUČNO osvežavanje stvarno gotovo. */
    reload: async () => {
      await Promise.all([dirQ.refetch(), nowQ.refetch()]);
    },
  };
}

/** Brojači po statusu nad DATIM redovima (pozivalac bira da li su pretraženi ili svi). */
export function countByStatus(rows: LiveRow[]): LiveCounts {
  const prisutan = rows.filter((r) => r.status === 'prisutan').length;
  const pauza = rows.filter((r) => r.status === 'pauza').length;
  return { prisutan, pauza, odsutan: rows.length - prisutan - pauza };
}

/** Pretraga po imenu i prezimenu — bez dijakritike („Milosevic" nalazi „Milošević"). */
export function searchLiveRows(rows: LiveRow[], query: string): LiveRow[] {
  const q = normalize(query.trim());
  if (!q) return rows;
  return rows.filter((r) => normalize(r.fullName).includes(q));
}

/** Filter statusa + pretraga (identično na oba ekrana). */
export function filterLiveRows(rows: LiveRow[], status: StatusFilter, query: string): LiveRow[] {
  const searched = searchLiveRows(rows, query);
  return status === 'svi' ? searched : searched.filter((r) => r.status === status);
}
