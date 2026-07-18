'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  usePredmeti,
  usePredmetIzvestaj,
  useUpsertOverride,
  useUpsertNapomena,
  normalizePredmeti,
  normalizeIzvestaj,
  type PredmetRow,
  type IzvestajRow,
} from '@/api/pracenje';

/** Mobilni Praćenje (/m/pracenje) — aktivni predmeti (pretraga+rok) → pozicije + pun override. */
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

function fmtRok(v: string | null | undefined): string {
  if (!v) return '';
  const iso = String(v);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDate(iso);
}

function PredmetiMobile({ onOpen }: { onOpen: (id: number, label: string) => void }) {
  const q = usePredmeti();
  const predmeti = useMemo(() => normalizePredmeti(q.data?.data), [q.data]);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return predmeti;
    return predmeti.filter(
      (r) =>
        String(r.naziv_predmeta ?? '').toLowerCase().includes(s) ||
        String(r.broj_predmeta ?? '').toLowerCase().includes(s) ||
        String(r.komitent ?? '').toLowerCase().includes(s),
    );
  }, [predmeti, search]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="mb-2">
        <label className="text-2xs uppercase tracking-wider text-ink-secondary" htmlFor="maPrSearch">🔎 Pretraga predmeta</label>
        <input
          id="maPrSearch"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="naziv, broj, komitent…"
          autoComplete="off"
          className="mt-1 h-10 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
        />
      </div>
      <h1 className="mb-2 text-md font-semibold text-ink">Aktivni predmeti ({filtered.length})</h1>
      {q.isError ? (
        <div className="py-8 text-center text-sm text-status-danger">
          Učitavanje nije uspelo.{' '}
          <button onClick={() => q.refetch()} className="underline">↻ Pokušaj ponovo</button>
        </div>
      ) : q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">{search ? 'Nema rezultata.' : 'Nema aktivnih predmeta.'}</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((p: PredmetRow) => {
            const rok = fmtRok(p.rok_zavrsetka);
            const late = p.rok_zavrsetka != null && String(p.rok_zavrsetka).slice(0, 10) < today;
            return (
              <button
                key={String(p.predmet_item_id ?? p.broj_predmeta)}
                onClick={() => p.predmet_item_id && onOpen(Number(p.predmet_item_id), String(p.broj_predmeta ?? ''))}
                className="block w-full rounded-panel border border-line bg-surface p-3 text-left"
              >
                <div className="text-sm font-medium text-ink">{p.broj_predmeta ?? '—'}</div>
                <div className="truncate text-xs text-ink-secondary">
                  {p.naziv_predmeta ?? ''} · {p.komitent ?? ''}
                  {rok ? `${late ? ' · ⚠️' : ' ·'} rok ${rok}` : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const OVR_LABEL: Record<string, string> = { u_radu: 'U radu', kompletirano: 'Kompletirano', nije_zapoceto: 'Nije započeto' };
const OVR_TONE: Record<string, 'info' | 'success' | 'neutral'> = { u_radu: 'info', kompletirano: 'success', nije_zapoceto: 'neutral' };

/** Auto-hint statusa iz statusa bitova (paritet 1.0 autoHint). */
function autoHint(r: IzvestajRow): string {
  const s = r.statusi ?? {};
  if (s.kasni) return 'kasni';
  if (s.nije_kompletirano) return 'u toku';
  const ops = Array.isArray(r.operations) ? r.operations.length : 0;
  return ops ? `${ops} operacija` : '—';
}

function PozicijeMobile({ itemId, label, onBack }: { itemId: number; label: string; onBack: () => void }) {
  const q = usePredmetIzvestaj(itemId);
  const rows = useMemo(() => normalizeIzvestaj(q.data?.data), [q.data]);
  const can = useCan();
  const canManage = can(PERMISSIONS.PRACENJE_MANAGE);
  const [sheet, setSheet] = useState<IzvestajRow | null>(null);

  return (
    <div>
      <button onClick={onBack} className="mb-3 flex items-center gap-1 text-sm text-accent">
        <ArrowLeft className="h-4 w-4" /> Nazad
      </button>
      <h1 className="mb-3 text-md font-semibold text-ink">Predmet {label}</h1>
      {q.isError ? (
        <div className="py-8 text-center text-sm text-status-danger">
          Učitavanje nije uspelo.{' '}
          <button onClick={() => q.refetch()} className="underline">↻ Pokušaj ponovo</button>
        </div>
      ) : q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema pozicija.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const node = String(r.node_id ?? '');
            const ovr = String(r.status_override ?? '');
            const indent = Math.min(Number(r.level ?? 0), 4) * 12;
            const rnLabel = (r.rn_broj as string | undefined) ?? r.rn_id ?? '';
            const hasNote = !!String(r.korisnicka_napomena ?? '').trim();
            return (
              <div key={node} className="rounded-panel border border-line bg-surface p-3" style={{ marginLeft: indent }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">{r.naziv_pozicije ?? r.naziv_dela ?? rnLabel ?? '—'}</span>
                  {ovr ? (
                    <StatusBadge tone={OVR_TONE[ovr] ?? 'neutral'} label={`${OVR_LABEL[ovr] ?? ovr} · ručno`} />
                  ) : (
                    <StatusBadge tone="neutral" label={autoHint(r)} />
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
                  {rnLabel ? <span>RN {String(rnLabel)}</span> : null}
                  <span>{r.ident_broj ?? ''} · {r.broj_crteza ?? r.crtez_drawing_no ?? ''}</span>
                  {hasNote && <span title="Ima napomenu">📝</span>}
                  {canManage && (
                    <button onClick={() => setSheet(r)} className="ml-auto rounded-control border border-line px-2 py-1 text-ink-secondary">
                      ✎ Izmeni ▾
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sheet && (
        <OverrideSheet itemId={itemId} row={sheet} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}

/** Bottom-sheet „Ručni status pozicije": status + mašinska/površinska tri-state + napomena (SH-10). */
function OverrideSheet({ itemId, row, onClose }: { itemId: number; row: IzvestajRow; onClose: () => void }) {
  const override = useUpsertOverride();
  const napomena = useUpsertNapomena();
  const node = String(row.node_id ?? '');
  const rnId = (row.rn_id as string | undefined) ?? undefined;

  const [status, setStatus] = useState(String(row.status_override ?? ''));
  const [mas, setMas] = useState<'auto' | 'da' | 'ne'>(row.masinska_done_override === true ? 'da' : row.masinska_done_override === false ? 'ne' : 'auto');
  const [pov, setPov] = useState<'auto' | 'da' | 'ne'>(row.povrsinska_done_override === true ? 'da' : row.povrsinska_done_override === false ? 'ne' : 'auto');
  const [note, setNote] = useState(String(row.korisnicka_napomena ?? ''));
  const [saving, setSaving] = useState(false);

  const triToBool = (v: 'auto' | 'da' | 'ne'): boolean | null => (v === 'da' ? true : v === 'ne' ? false : null);

  async function save() {
    setSaving(true);
    try {
      await override.mutateAsync({
        itemId,
        bigtehnRnId: node,
        rnId,
        status,
        masinska: triToBool(mas),
        povrsinska: triToBool(pov),
      });
      // Napomena samo ako je promenjena (paritet 1.0 upsert napomene pri promeni).
      if (note !== String(row.korisnicka_napomena ?? '')) {
        await napomena.mutateAsync({ itemId, bigtehnRnId: node, rnId, note });
      }
      toast('✅ Sačuvano');
      onClose();
    } catch (e) {
      const msg = e instanceof Error && /42501/.test(e.message) ? 'Nemaš pravo izmene.' : 'Greška pri čuvanju.';
      toast(`⚠ ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" role="dialog" aria-modal onClick={onClose}>
      <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-panel bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 text-sm font-semibold text-ink">Ručni status pozicije</div>
        <div className="mb-3 text-xs text-ink-secondary">{row.naziv_pozicije ?? row.rn_broj ?? row.rn_id ?? ''}</div>

        <SheetField label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-10 w-full rounded-control border border-line bg-surface px-2 text-base text-ink">
            <option value="">Auto status</option>
            <option value="u_radu">U radu</option>
            <option value="kompletirano">Kompletirano</option>
            <option value="nije_zapoceto">Nije započeto</option>
          </select>
        </SheetField>
        <TriSelect label="⚙️ Mašinska obrada" value={mas} onChange={setMas} />
        <TriSelect label="🛡 Površinska zaštita" value={pov} onChange={setPov} />
        <SheetField label="📝 Napomena">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="beleška o poziciji…" className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink" />
        </SheetField>

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-control border border-line px-3 py-2 text-sm text-ink-secondary">Otkaži</button>
          <button onClick={save} disabled={saving} className="rounded-control bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {saving ? 'Čuvam…' : 'Sačuvaj'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SheetField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-2xs uppercase tracking-wider text-ink-secondary">{label}</label>
      {children}
    </div>
  );
}

function TriSelect({ label, value, onChange }: { label: string; value: 'auto' | 'da' | 'ne'; onChange: (v: 'auto' | 'da' | 'ne') => void }) {
  return (
    <SheetField label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value as 'auto' | 'da' | 'ne')} className="h-10 w-full rounded-control border border-line bg-surface px-2 text-base text-ink">
        <option value="auto">Auto (iz prijava)</option>
        <option value="da">DA — urađeno</option>
        <option value="ne">NE — nije</option>
      </select>
    </SheetField>
  );
}
