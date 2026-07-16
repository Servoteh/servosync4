'use client';

// Plan montaže — debounce autosave faza (port UX ugovora 1.0 services/plan.js):
// debounce 700 ms, last-write-wins (BEZ optimistic lock-a), identitet faze fiksiran
// u trenutku izmene (D-4 lekcija). U 2.0 svaka izmena = UPSERT POST /v1/montaza/phases
// (paritet 1.0 „upsert sve" buildPhasePayload); brisanje = DELETE. Status panel čita
// queued/inflight/error iz ovog hook-a.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import {
  useUpsertPhase,
  useDeletePhase,
  type UpsertPhaseVars,
  type PhaseVM,
} from '@/api/plan-montaze';
import { SAVE_DEBOUNCE_MS } from './constants';

/** PhaseVM → upsert payload (prazan datum → null; checks su uvek 8 bool). */
export function phaseVMToUpsert(vm: PhaseVM): UpsertPhaseVars {
  return {
    id: vm.id,
    projectId: vm.projectId,
    workPackageId: vm.workPackageId,
    phaseName: vm.phaseName,
    location: vm.location || undefined,
    startDate: vm.startDate || null,
    endDate: vm.endDate || null,
    responsibleEngineer: vm.responsibleEngineer,
    montageLead: vm.montageLead,
    status: vm.status,
    pct: vm.pct,
    checks: vm.checks,
    blocker: vm.blocker,
    note: vm.note,
    sortOrder: vm.sortOrder,
    phaseType: vm.phaseType,
    description: vm.description,
    linkedDrawings: vm.linkedDrawings,
    actualStartDate: vm.actualStartDate || null,
    actualEndDate: vm.actualEndDate || null,
  };
}

export interface SaveStatus {
  /** Faza sa zakazanim (debounce) snimanjem koje još nije poslato. */
  queued: number;
  /** Snimanja trenutno u letu. */
  inflight: number;
  /** Poslednja greška (poruka) ili null. */
  error: string | null;
  /** Vreme poslednjeg uspešnog snimanja (ms) ili null. */
  savedAt: number | null;
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Nemate dozvolu za izmenu ovog projekta.';
    return e.message;
  }
  return 'Greška pri snimanju.';
}

export interface PhaseAutosave {
  status: SaveStatus;
  /** Zakaži debounce snimanje (koristi se za inline izmene polja). */
  schedule: (vm: PhaseVM) => void;
  /** Snimi ODMAH (dodavanje faze, reorder, ostvareni datum) bez debounce-a. */
  saveNow: (vm: PhaseVM) => void;
  /** Isprazni sve zakazane (npr. pre promene WP-a) tako da se ništa ne izgubi. */
  flushAll: () => void;
  /** Obriši fazu (DELETE). */
  remove: (id: string) => Promise<void>;
}

export function usePhaseAutosave(): PhaseAutosave {
  const upsert = useUpsertPhase();
  const del = useDeletePhase();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, PhaseVM>());
  const inflight = useRef(0);
  const [status, setStatus] = useState<SaveStatus>({
    queued: 0,
    inflight: 0,
    error: null,
    savedAt: null,
  });

  const recount = useCallback(() => {
    setStatus((s) => ({ ...s, queued: pending.current.size, inflight: inflight.current }));
  }, []);

  const flush = useCallback(
    async (id: string) => {
      const vm = pending.current.get(id);
      if (!vm) return;
      pending.current.delete(id);
      const t = timers.current.get(id);
      if (t) {
        clearTimeout(t);
        timers.current.delete(id);
      }
      inflight.current += 1;
      recount();
      try {
        await upsert.mutateAsync(phaseVMToUpsert(vm));
        setStatus((s) => ({ ...s, error: null, savedAt: Date.now() }));
      } catch (e) {
        setStatus((s) => ({ ...s, error: errMsg(e) }));
      } finally {
        inflight.current -= 1;
        recount();
      }
    },
    [upsert, recount],
  );

  const schedule = useCallback(
    (vm: PhaseVM) => {
      pending.current.set(vm.id, vm);
      const prev = timers.current.get(vm.id);
      if (prev) clearTimeout(prev);
      timers.current.set(
        vm.id,
        setTimeout(() => void flush(vm.id), SAVE_DEBOUNCE_MS),
      );
      recount();
    },
    [flush, recount],
  );

  const saveNow = useCallback(
    (vm: PhaseVM) => {
      const prev = timers.current.get(vm.id);
      if (prev) {
        clearTimeout(prev);
        timers.current.delete(vm.id);
      }
      pending.current.set(vm.id, vm);
      void flush(vm.id);
    },
    [flush],
  );

  const flushAll = useCallback(() => {
    for (const id of [...pending.current.keys()]) void flush(id);
  }, [flush]);

  const remove = useCallback(
    async (id: string) => {
      const t = timers.current.get(id);
      if (t) {
        clearTimeout(t);
        timers.current.delete(id);
      }
      pending.current.delete(id);
      inflight.current += 1;
      recount();
      try {
        await del.mutateAsync(id);
        setStatus((s) => ({ ...s, error: null, savedAt: Date.now() }));
      } catch (e) {
        setStatus((s) => ({ ...s, error: errMsg(e) }));
      } finally {
        inflight.current -= 1;
        recount();
      }
    },
    [del, recount],
  );

  // Na unmount FLUSH (ne odbaci) sve zakazane izmene — izmena unutar debounce
  // prozora mora u bazu i kad korisnik promeni tab/pogled (1.0 D-4 ugovor:
  // module-scope tajmeri su preživljavali teardown UI-ja). Mutacija nastavlja
  // da živi na query klijentu posle unmount-a; setState posle unmount-a je no-op.
  const flushAllRef = useRef(flushAll);
  useEffect(() => {
    flushAllRef.current = flushAll;
  }, [flushAll]);
  useEffect(() => {
    const timersMap = timers.current;
    return () => {
      flushAllRef.current();
      for (const t of timersMap.values()) clearTimeout(t);
    };
  }, []);

  return { status, schedule, saveNow, flushAll, remove };
}
