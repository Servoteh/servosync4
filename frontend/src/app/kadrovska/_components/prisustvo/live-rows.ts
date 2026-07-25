'use client';

import { useMemo } from 'react';
import { useAttendanceNow, useDirectory } from '@/api/kadrovska';
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

/**
 * Merge: SVI aktivni zaposleni (imenik) ⨝ v_attendance_now — ko nema prolaz u
 * 24 h prikazan je kao „Odsutan / bez prolaza u 24 h" (paritet 1.0 _rows()).
 * `enabled=false` (nema prava / još se čekaju dozvole) ne ispaljuje zahteve.
 */
export function useLiveAttendance(enabled = true) {
  const dirQ = useDirectory(enabled);
  const nowQ = useAttendanceNow(enabled);

  const rows: LiveRow[] = useMemo(() => {
    const dir = dirQ.data?.data ?? [];
    const now = nowQ.data?.data ?? [];
    const byEmp = new Map(now.map((r) => [sv(r, 'employee_id'), r]));
    return dir
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

  const counts: LiveCounts = useMemo(() => {
    const prisutan = rows.filter((r) => r.status === 'prisutan').length;
    const pauza = rows.filter((r) => r.status === 'pauza').length;
    return { prisutan, pauza, odsutan: rows.length - prisutan - pauza };
  }, [rows]);

  return {
    rows,
    counts,
    isLoading: dirQ.isLoading || nowQ.isLoading,
    isFetching: dirQ.isFetching || nowQ.isFetching,
    isError: dirQ.isError || nowQ.isError,
    /** Kad je poslednji put stigao „uživo" snimak (0 = još nijednom). */
    updatedAt: nowQ.dataUpdatedAt,
    reload: () => {
      void dirQ.refetch();
      void nowQ.refetch();
    },
  };
}

/** Filter statusa + pretraga po imenu i prezimenu (identično na oba ekrana). */
export function filterLiveRows(rows: LiveRow[], status: StatusFilter, query: string): LiveRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (status !== 'svi' && r.status !== status) return false;
    if (q && !r.fullName.toLowerCase().includes(q)) return false;
    return true;
  });
}
