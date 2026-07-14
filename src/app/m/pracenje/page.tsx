'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  usePredmeti,
  usePredmetIzvestaj,
  useUpsertOverride,
  normalizePredmeti,
  normalizeIzvestaj,
  type PredmetRow,
} from '@/api/pracenje';

/** Mobilni Praćenje (/m/pracenje) — aktivni predmeti → pozicije + ručni override statusa. */
export default function MobilePracenjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [predmet, setPredmet] = useState<{ id: number; label: string } | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <main className="min-h-screen bg-app p-3">
      {predmet ? (
        <PozicijeMobile itemId={predmet.id} label={predmet.label} onBack={() => setPredmet(null)} />
      ) : (
        <PredmetiMobile onOpen={(id, label) => setPredmet({ id, label })} />
      )}
    </main>
  );
}

function PredmetiMobile({ onOpen }: { onOpen: (id: number, label: string) => void }) {
  const q = usePredmeti();
  const predmeti = useMemo(() => normalizePredmeti(q.data?.data), [q.data]);
  return (
    <div>
      <h1 className="mb-3 text-md font-semibold text-ink">Praćenje</h1>
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : predmeti.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema aktivnih predmeta.</p>
      ) : (
        <div className="space-y-2">
          {predmeti.map((p: PredmetRow) => (
            <button
              key={String(p.predmet_item_id ?? p.broj_predmeta)}
              onClick={() => p.predmet_item_id && onOpen(Number(p.predmet_item_id), String(p.broj_predmeta ?? ''))}
              className="block w-full rounded-panel border border-line bg-surface p-3 text-left"
            >
              <div className="text-sm font-medium text-ink">{p.broj_predmeta ?? '—'}</div>
              <div className="truncate text-xs text-ink-secondary">{p.naziv_predmeta ?? ''} · {p.komitent ?? ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PozicijeMobile({ itemId, label, onBack }: { itemId: number; label: string; onBack: () => void }) {
  const q = usePredmetIzvestaj(itemId);
  const rows = useMemo(() => normalizeIzvestaj(q.data?.data), [q.data]);
  const override = useUpsertOverride();
  const can = useCan();
  const canManage = can(PERMISSIONS.PRACENJE_MANAGE);

  return (
    <div>
      <button onClick={onBack} className="mb-3 flex items-center gap-1 text-sm text-accent">
        <ArrowLeft className="h-4 w-4" /> Nazad
      </button>
      <h1 className="mb-3 text-md font-semibold text-ink">Predmet {label}</h1>
      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema pozicija.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const node = String(r.node_id ?? '');
            const done = Number(r.kompletirano_za_lot ?? 0);
            const req = Number(r.required_for_lot ?? 0);
            const complete = req > 0 && done >= req;
            return (
              <div key={node} className="rounded-panel border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{r.naziv_pozicije ?? r.naziv_dela ?? '—'}</span>
                  <StatusBadge tone={complete ? 'success' : done === 0 ? 'neutral' : 'info'} label={`${done}/${req}`} />
                </div>
                <div className="mt-0.5 text-xs text-ink-secondary">{r.ident_broj ?? ''} · {r.broj_crteza ?? r.crtez_drawing_no ?? ''}</div>
                {canManage && (
                  <div className="mt-2">
                    <select
                      value={r.status_override ?? ''}
                      onChange={(e) =>
                        override.mutate({ itemId, bigtehnRnId: node, rnId: r.rn_id ?? undefined, status: e.target.value })
                      }
                      className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink"
                    >
                      <option value="">Auto status</option>
                      <option value="u_radu">U radu</option>
                      <option value="kompletirano">Kompletirano</option>
                      <option value="nije_zapoceto">Nije započeto</option>
                    </select>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
