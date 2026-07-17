'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { useRollbackReversals, type RollbackReversalsResult } from '@/api/reversi';
import {
  loadSessions,
  removeSession,
  type ImportSession,
} from './import-sessions';

/**
 * RC-55 — Storno bulk-import sesija reversa.
 *
 * Lista poslednjih 5 uvoza (iz `localStorage`). „Storniraj" vraća sve stavke
 * dokumenata u magacin (→ RETURNED) preko `useRollbackReversals(docIds)`, pa
 * uklanja sesiju. „Zaboravi" samo briše sesiju iz liste (bez pisanja u bazu).
 * Auto-kreirane šifre (RZN-…) ostaju u katalogu (paritet 1.0).
 */
export function ImportRollbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rollback = useRollbackReversals();
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; res: RollbackReversalsResult } | null>(null);

  // Osveži listu iz localStorage svaki put kad se modal otvori.
  useEffect(() => {
    if (open) {
      setSessions(loadSessions());
      setError(null);
      setResult(null);
      setBusyId(null);
    }
  }, [open]);

  function forget(id: string) {
    removeSession(id);
    setSessions(loadSessions());
    if (result?.id === id) setResult(null);
  }

  async function storno(s: ImportSession) {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        `Storniraj ${s.docIds.length} reverz dokumenta? Sve stavke će biti vraćene u magacin (RETURNED).`,
      );
      if (!ok) return;
    }
    setError(null);
    setResult(null);
    setBusyId(s.id);
    try {
      const res = await rollback.mutateAsync(s.docIds);
      setResult({ id: s.id, res: res.data });
      if (res.data.fail === 0) {
        removeSession(s.id);
        setSessions(loadSessions());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Storno nije uspeo.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Storno bulk importa" size="lg">
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Poslednjih {sessions.length} bulk importa reversa. „Storniraj" vraća sve stavke u magacin i
          markira dokumente kao vraćene. Auto-kreirane šifre (RZN-…) ostaju u katalogu. Sesije se pamte
          u ovom pregledaču.
        </p>

        {sessions.length === 0 && (
          <div className="rounded-control border border-line bg-surface-2 p-4 text-sm text-ink-secondary">
            Nema zapamćenih bulk importa za storno.
          </div>
        )}

        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line p-3"
            >
              <div>
                <div className="text-sm font-medium text-ink">
                  {new Date(s.finishedAt).toLocaleString('sr-Latn-RS')}
                </div>
                <div className="text-xs text-ink-secondary">
                  {s.docIds.length} dokumenata, {s.newCatalogIds.length} novih šifri ·{' '}
                  <span className="text-status-success">✓ {s.ok}</span> /{' '}
                  <span className={s.fail > 0 ? 'text-status-danger' : ''}>⚠ {s.fail}</span>
                </div>
                {result?.id === s.id && (
                  <div className="mt-1 text-xs text-ink-secondary">
                    Storno: <span className="text-status-success">{result.res.ok} vraćeno</span>
                    {result.res.fail > 0 && (
                      <span className="text-status-danger"> · {result.res.fail} neuspešno</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => forget(s.id)}
                  disabled={busyId === s.id}
                  title="Ukloni sesiju iz liste (bez stornijanja u bazi)"
                >
                  Zaboravi
                </Button>
                <Button
                  variant="danger"
                  loading={busyId === s.id}
                  disabled={busyId !== null && busyId !== s.id}
                  onClick={() => void storno(s)}
                >
                  Storniraj
                </Button>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
