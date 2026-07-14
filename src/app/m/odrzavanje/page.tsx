'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ChevronRight, Search, Wrench } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useIncidents,
  useMachines,
  useVehicles,
  type MachineRow,
} from '@/api/odrzavanje';
import { IncidentStatusBadge, OpStatusBadge, SeverityBadge, f } from '../../odrzavanje/_components/common';
import { PrijavaKvaraDialog } from '../../odrzavanje/_components/prijava-kvara-dialog';
import { formatDate } from '@/lib/format';

/**
 * Mobilno Održavanje (/m/odrzavanje) — hub → lista → karton sredstva → Prijava kvara
 * (+foto). Prijava kvara = mobilni prioritet (REPORT opšte pravo). 2.0 responsive.
 */
export default function MobileOdrzavanjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<'hub' | 'masine' | 'vozila' | 'karton'>('hub');
  const [machine, setMachine] = useState<MachineRow | null>(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <main className="min-h-screen bg-app pb-24">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
        {view !== 'hub' ? (
          <button onClick={() => (view === 'karton' ? (setView('masine'), setMachine(null)) : setView('hub'))} aria-label="Nazad" className="text-ink-secondary">
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : (
          <Wrench className="h-5 w-5 text-accent" aria-hidden />
        )}
        <h1 className="text-md font-semibold text-ink">
          {view === 'hub' ? 'Održavanje' : view === 'masine' ? 'Mašine' : view === 'vozila' ? 'Vozila' : machine?.name}
        </h1>
      </header>

      {view === 'hub' && <Hub onNav={setView} onReport={() => setReporting(true)} />}
      {view === 'masine' && <MasineList onOpen={(m) => { setMachine(m); setView('karton'); }} />}
      {view === 'vozila' && <VozilaList />}
      {view === 'karton' && machine && <MasinaKarton machine={machine} onReport={() => setReporting(true)} />}

      {reporting && (
        <PrijavaKvaraDialog
          onClose={() => setReporting(false)}
          fixedMachine={view === 'karton' && machine ? { code: machine.machineCode, name: machine.name } : undefined}
        />
      )}

      {/* FAB — Prijavi kvar (uvek dostupan) */}
      {!reporting && (
        <button
          onClick={() => setReporting(true)}
          className="fixed bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full bg-status-danger px-5 py-3 text-sm font-semibold text-white shadow-lg"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden /> Prijavi kvar
        </button>
      )}
    </main>
  );
}

function Hub({ onNav, onReport }: { onNav: (v: 'masine' | 'vozila') => void; onReport: () => void }) {
  const tiles = [
    { key: 'masine' as const, label: 'Mašine', icon: Wrench },
    { key: 'vozila' as const, label: 'Vozila', icon: Wrench },
  ];
  return (
    <div className="space-y-4 p-4">
      <button onClick={onReport} className="flex w-full items-center justify-center gap-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-4 text-base font-semibold text-status-danger">
        <AlertTriangle className="h-5 w-5" aria-hidden /> Prijavi kvar
      </button>
      <div className="grid grid-cols-2 gap-3">
        {tiles.map((t) => (
          <button key={t.key} onClick={() => onNav(t.key)} className="flex flex-col items-center gap-2 rounded-panel border border-line bg-surface px-4 py-6">
            <t.icon className="h-7 w-7 text-accent" aria-hidden />
            <span className="text-sm font-medium text-ink">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MasineList({ onOpen }: { onOpen: (m: MachineRow) => void }) {
  const [q, setQ] = useState('');
  const machines = useMachines({ q, pageSize: 100 });
  const rows = machines.data?.data ?? [];
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2">
        <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Pretraga mašine…" className="w-full bg-transparent text-sm text-ink focus:outline-none" />
      </div>
      {machines.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema mašina.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((m) => (
            <button key={m.machineCode} onClick={() => onOpen(m)} className="flex w-full items-center justify-between rounded-panel border border-line bg-surface px-3 py-3 text-left">
              <div>
                <div className="tnums text-xs text-ink-secondary">{m.machineCode}</div>
                <div className="text-sm font-medium text-ink">{m.name}</div>
              </div>
              <div className="flex items-center gap-2">
                <OpStatusBadge status={m.effectiveStatus} />
                <ChevronRight className="h-4 w-4 text-ink-disabled" aria-hidden />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VozilaList() {
  const vehicles = useVehicles();
  const rows = vehicles.data?.data ?? [];
  return (
    <div className="space-y-2 p-4">
      {vehicles.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.filter((v) => !v.archived_at).map((v) => (
        <div key={v.asset_id} className="rounded-panel border border-line bg-surface px-3 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="tnums text-xs text-ink-secondary">{v.asset_code}</div>
              <div className="text-sm font-medium text-ink">{v.name}</div>
            </div>
            <OpStatusBadge status={v.status} />
          </div>
          <div className="mt-1 text-xs text-ink-secondary">
            {f(v, 'registration_plate', 'plate') ?? '—'} · {f(v, 'odometer_km') ? `${f(v, 'odometer_km')} km` : '—'}
            {f(v, 'registration_expires_at') && ` · reg. do ${formatDate(String(f(v, 'registration_expires_at')))}`}
          </div>
        </div>
      ))}
    </div>
  );
}

function MasinaKarton({ machine, onReport }: { machine: MachineRow; onReport: () => void }) {
  const inc = useIncidents({ machineCode: machine.machineCode, pageSize: 30 });
  const open = useMemo(() => (inc.data?.data ?? []).filter((i) => i.status !== 'closed' && i.status !== 'resolved'), [inc.data]);
  return (
    <div className="space-y-4 p-4">
      <div className="rounded-panel border border-line bg-surface p-3">
        <div className="flex items-center justify-between">
          <span className="tnums text-sm font-medium text-ink">{machine.machineCode}</span>
          <OpStatusBadge status={machine.effectiveStatus} />
        </div>
        <div className="mt-1 text-sm text-ink-secondary">{machine.name}</div>
        {machine.location && <div className="text-xs text-ink-disabled">Lokacija: {machine.location}</div>}
      </div>

      <button onClick={onReport} className="flex w-full items-center justify-center gap-2 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm font-semibold text-status-danger">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Prijavi kvar za ovu mašinu
      </button>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">Otvoreni kvarovi ({open.length})</h2>
        {inc.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : open.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema otvorenih kvarova.</p>
        ) : (
          <div className="space-y-2">
            {open.map((i) => (
              <div key={i.id} className="rounded-panel border border-line bg-surface px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink">{i.title}</span>
                  <SeverityBadge severity={i.severity} />
                </div>
                <div className="mt-1"><IncidentStatusBadge status={i.status} /></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
