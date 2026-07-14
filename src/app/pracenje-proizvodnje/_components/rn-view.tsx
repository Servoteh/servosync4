'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, Lock, Unlock, CheckCircle2, ArrowUpRight, FileText, History } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Dialog } from '@/components/ui-kit/dialog';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { ApiError } from '@/api/client';
import {
  useRn,
  useOperativniPlan,
  useCanEditRn,
  usePrijave,
  useZatvoriAktivnost,
  useBlokirajAktivnost,
  useOdblokirajAktivnost,
  useAktivnostIstorija,
  fetchCrtezSignUrl,
  AKTIVNOST_STATUS_LABELS,
  type AktivnostRow,
} from '@/api/pracenje';
import { AktivnostModal } from './aktivnost-modal';
import { PromoteModal } from './promote-modal';

type RnTab = 'pozicije' | 'plan';
const RN_TABS: TabItem<RnTab>[] = [
  { key: 'pozicije', label: 'Pozicije' },
  { key: 'plan', label: 'Operativni plan' },
];

const STATUS_TONE: Record<string, Tone> = {
  nije_krenulo: 'neutral',
  u_toku: 'info',
  blokirano: 'danger',
  zavrseno: 'success',
};

function normalizeAktivnosti(data: unknown): AktivnostRow[] {
  if (Array.isArray(data)) return data as AktivnostRow[];
  if (data && typeof data === 'object') {
    const o = data as { aktivnosti?: unknown; odeljenja?: unknown };
    if (Array.isArray(o.aktivnosti)) return o.aktivnosti as AktivnostRow[];
    if (Array.isArray(o.odeljenja)) {
      const out: AktivnostRow[] = [];
      for (const od of o.odeljenja as Array<{ aktivnosti?: AktivnostRow[] }>) {
        if (Array.isArray(od.aktivnosti)) out.push(...od.aktivnosti);
      }
      return out;
    }
  }
  return [];
}

export function RnView({ rnId, onBack }: { rnId: string; onBack: () => void }) {
  const [tab, setTab] = useState<RnTab>('pozicije');
  const rn = useRn(rnId);
  const canEditQ = useCanEditRn(rnId);
  const canEdit = canEditQ.data?.data.canEdit ?? false;

  const result = rn.data?.data;
  const pozicije = (result?.pozicije ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> Nazad
        </Button>
        <h2 className="text-md font-semibold text-ink">RN {String(result?.rn_broj ?? rnId.slice(0, 8))}</h2>
        {result?.source && <StatusBadge tone="neutral" label={String(result.source)} />}
        <div className="ml-auto">
          <Tabs tabs={RN_TABS} value={tab} onChange={setTab} ariaLabel="RN tabovi" />
        </div>
      </div>

      {tab === 'pozicije' ? (
        <PozicijeTab pozicije={pozicije} loading={rn.isLoading} />
      ) : (
        <OperativniPlanTab rnId={rnId} canEdit={canEdit} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Tab1

function PozicijeTab({ pozicije, loading }: { pozicije: Array<Record<string, unknown>>; loading: boolean }) {
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);

  if (loading) {
    return <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>;
  }
  if (pozicije.length === 0) return <EmptyState title="Nema pozicija na RN-u" />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
              <th className="px-3 py-1.5">Pozicija</th>
              <th className="px-3 py-1.5">Crtež</th>
              <th className="px-3 py-1.5">Operacija</th>
              <th className="px-3 py-1.5">Napredak</th>
            </tr>
          </thead>
          <tbody>
            {pozicije.map((p, i) => {
              const done = Number(p.prijavljeno_komada ?? 0);
              const plan = Number(p.planirano_komada ?? p.kolicina_plan ?? 0);
              return (
                <tr
                  key={String(p.id ?? i)}
                  className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                  onClick={() => setSel(p)}
                >
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-ink">{String(p.naziv ?? p.sifra_pozicije ?? '—')}</div>
                    <div className="text-xs text-ink-disabled">{String(p.sifra_pozicije ?? '')}</div>
                  </td>
                  <td className="px-3 py-1.5 text-xs">{String(p.drawing_no ?? '—')}</td>
                  <td className="px-3 py-1.5 text-xs">{String(p.operacija_kod ?? p.work_center ?? '—')}</td>
                  <td className="tnums px-3 py-1.5 text-xs">
                    {plan ? `${done}/${plan}` : '—'}
                    {p.progress_pct != null ? ` (${Math.round(Number(p.progress_pct))}%)` : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <PozicijaSidePanel pozicija={sel} onClose={() => setSel(null)} />
    </div>
  );
}

function PozicijaSidePanel({ pozicija, onClose }: { pozicija: Record<string, unknown> | null; onClose: () => void }) {
  const pozId = pozicija?.id ? String(pozicija.id) : undefined;
  const prijave = usePrijave({ pozicija: pozId });
  const rows = Array.isArray(prijave.data?.data) ? (prijave.data!.data as Array<Record<string, unknown>>) : [];

  async function openCrtez() {
    const code = pozicija?.drawing_no ? String(pozicija.drawing_no) : '';
    if (!code) return;
    try {
      const res = await fetchCrtezSignUrl(code);
      window.open(res.data.url, '_blank');
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Crtež nije dostupan.');
    }
  }

  if (!pozicija) {
    return (
      <div className="rounded-panel border border-line bg-surface p-4 text-sm text-ink-disabled">
        Izaberi poziciju za prijave rada i crteže.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-panel border border-line bg-surface p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{String(pozicija.naziv ?? pozicija.sifra_pozicije ?? 'Pozicija')}</h3>
        <button onClick={onClose} className="ml-auto text-xs text-ink-secondary hover:underline">Zatvori</button>
      </div>
      {pozicija.drawing_no ? (
        <Button variant="secondary" onClick={openCrtez} className="h-8 w-full text-xs">
          <FileText className="h-3.5 w-3.5" /> Crtež {String(pozicija.drawing_no)}
        </Button>
      ) : null}
      <div>
        <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Prijave rada</div>
        {prijave.isLoading ? (
          <p className="text-xs text-ink-disabled">Učitavanje…</p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-ink-disabled">Nema prijava.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {rows.map((r, i) => (
              <li key={i} className="rounded-control border border-line px-2 py-1">
                {String(r.radnik ?? r.worker_id ?? r.ime ?? '—')} · {String(r.komada ?? r.prijavljeno_komada ?? '')} kom
                {r.started_at ? ` · ${formatDate(String(r.started_at))}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Tab2

function OperativniPlanTab({ rnId, canEdit }: { rnId: string; canEdit: boolean }) {
  const plan = useOperativniPlan(rnId);
  const aktivnosti = useMemo(() => normalizeAktivnosti(plan.data?.data), [plan.data]);
  const zatvori = useZatvoriAktivnost();
  const odblokiraj = useOdblokirajAktivnost();
  const [edit, setEdit] = useState<AktivnostRow | null | 'new'>(null);
  const [blokId, setBlokId] = useState<string | null>(null);
  const [promote, setPromote] = useState(false);
  const [histId, setHistId] = useState<string | null>(null);

  const projekatId = aktivnosti.find((a) => a.projekat_id)?.projekat_id as string | undefined;

  const grouped = useMemo(() => {
    const map = new Map<string, AktivnostRow[]>();
    for (const a of aktivnosti) {
      const key = a.odeljenje_naziv ?? a.odeljenje ?? '—';
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [aktivnosti]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink-secondary">{aktivnosti.length} aktivnosti</span>
        {canEdit && (
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setPromote(true)}>
              <ArrowUpRight className="h-4 w-4" /> Iz Sastanaka
            </Button>
            <Button onClick={() => setEdit('new')}>
              <Plus className="h-4 w-4" /> Nova aktivnost
            </Button>
          </div>
        )}
      </div>

      {plan.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : aktivnosti.length === 0 ? (
        <EmptyState title="Nema aktivnosti u operativnom planu" />
      ) : (
        grouped.map(([odeljenje, list]) => (
          <div key={odeljenje} className="rounded-panel border border-line bg-surface">
            <div className="border-b border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink">{odeljenje}</div>
            <ul>
              {list.map((a) => (
                <li key={a.id} className={cn('flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2', a.kasni && 'bg-status-danger-bg/30')}>
                  <StatusBadge tone={STATUS_TONE[a.status ?? 'nije_krenulo'] ?? 'neutral'} label={AKTIVNOST_STATUS_LABELS[a.status ?? ''] ?? a.status ?? '—'} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink">{a.naziv_aktivnosti}</div>
                    <div className="text-xs text-ink-disabled">
                      {a.odgovoran_label ?? a.odgovoran ?? '—'}
                      {a.planirani_zavrsetak ? ` · rok ${formatDate(a.planirani_zavrsetak)}` : ''}
                      {a.broj_tp ? ` · TP ${a.broj_tp}` : ''}
                    </div>
                  </div>
                  <button onClick={() => a.id && setHistId(a.id)} className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" title="Istorija">
                    <History className="h-3.5 w-3.5" />
                  </button>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => setEdit(a)}>Izmeni</Button>
                      {a.status === 'blokirano' ? (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && odblokiraj.mutate({ id: a.id })}>
                          <Unlock className="h-3.5 w-3.5" /> Odblokiraj
                        </Button>
                      ) : (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && setBlokId(a.id)}>
                          <Lock className="h-3.5 w-3.5" /> Blokiraj
                        </Button>
                      )}
                      {a.status !== 'zavrseno' && (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => a.id && zatvori.mutate({ id: a.id })}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Zatvori
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {edit !== null && (
        <AktivnostModal
          open
          onClose={() => setEdit(null)}
          rnId={rnId}
          projekatId={projekatId}
          aktivnost={edit === 'new' ? null : edit}
        />
      )}
      {blokId && <BlokModal id={blokId} onClose={() => setBlokId(null)} />}
      {promote && <PromoteModal rnId={rnId} projekat={projekatId} onClose={() => setPromote(false)} />}
      {histId && <IstorijaModal id={histId} onClose={() => setHistId(null)} />}
    </div>
  );
}

function BlokModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [razlog, setRazlog] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const blokiraj = useBlokirajAktivnost();
  return (
    <Dialog
      open
      onClose={onClose}
      title="Blokiraj aktivnost"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button
            onClick={async () => {
              if (!razlog.trim()) return setErr('Razlog je obavezan.');
              try {
                await blokiraj.mutateAsync({ id, razlog: razlog.trim() });
                onClose();
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Greška.');
              }
            }}
            loading={blokiraj.isPending}
          >
            Blokiraj
          </Button>
        </>
      }
    >
      <textarea
        value={razlog}
        onChange={(e) => setRazlog(e.target.value)}
        rows={3}
        placeholder="Razlog blokade (obavezno)…"
        className="w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink"
      />
      {err && <p className="mt-2 text-sm text-status-danger">{err}</p>}
    </Dialog>
  );
}

function IstorijaModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useAktivnostIstorija(id);
  return (
    <Dialog open onClose={onClose} title="Istorija aktivnosti">
      {q.isLoading ? (
        <div className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Blokade</div>
            {(q.data?.data.blokade ?? []).length === 0 ? (
              <p className="text-xs text-ink-disabled">Nema blokada.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(q.data?.data.blokade ?? []).map((b, i) => (
                  <li key={i} className="rounded-control border border-line px-2 py-1">
                    {String((b as Record<string, unknown>).razlog ?? (b as Record<string, unknown>).akcija ?? '—')}
                    {(b as Record<string, unknown>).created_at ? ` · ${formatDate(String((b as Record<string, unknown>).created_at))}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Audit (admin)</div>
            {(q.data?.data.audit ?? []).length === 0 ? (
              <p className="text-xs text-ink-disabled">Nema audit zapisa (ili nemate pravo).</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {(q.data?.data.audit ?? []).map((a, i) => (
                  <li key={i} className="rounded-control border border-line px-2 py-1">
                    {String((a as Record<string, unknown>).action ?? '')} · {String((a as Record<string, unknown>).actor_email ?? '')}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
