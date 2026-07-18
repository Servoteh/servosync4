'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, ChevronRight, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  usePatchAkcija,
  useSastanci,
  useSastanakFull,
  useSetMyRsvp,
  useUpdateAktivnost,
  type Sastanak,
} from '@/api/sastanci';
import {
  AkcijaStatusBadge,
  formatDatum,
  formatVreme,
  SastanakStatusBadge,
} from '../../sastanci/_components/common';

/** Mobilni Sastanci (/m/sastanci) — lista → detalj (read + RSVP/status/obrađeno).
 *  Deep-link `?open=<id>` (paritet 1.0 mySastanci). Vidljivost = sastanci.read. */
export default function MobileSastanciPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    if (id) setOpenId(id);
  }, []);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return openId ? (
    <MobileDetail id={openId} myEmail={user.email} onBack={() => setOpenId(null)} />
  ) : (
    <MobileList onOpen={setOpenId} />
  );
}

function MobileList({ onOpen }: { onOpen: (id: string) => void }) {
  const listQ = useSastanci({ pageSize: 300 });
  const rows = listQ.data?.data ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const { predstojeci, prosli } = useMemo(() => {
    const p: Sastanak[] = [];
    const past: Sastanak[] = [];
    for (const s of rows) {
      const d = String(s.datum).slice(0, 10);
      if (d >= today && s.status !== 'zakljucan' && s.status !== 'otkazan') p.push(s);
      else past.push(s);
    }
    p.sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
    return { predstojeci: p, prosli: past.slice(0, 60) };
  }, [rows, today]);

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <h1 className="text-base font-semibold text-ink">Sastanci</h1>
      </header>
      <div className="space-y-4 p-3">
        <Section title="Predstojeći" items={predstojeci} onOpen={onOpen} loading={listQ.isLoading} empty="Nema predstojećih sastanaka." />
        <Section title="Prošli" items={prosli} onOpen={onOpen} loading={false} empty="Nema prošlih sastanaka." />
      </div>
    </div>
  );
}

function Section({ title, items, onOpen, loading, empty }: { title: string; items: Sastanak[]; onOpen: (id: string) => void; loading: boolean; empty: string }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">{title}</h2>
      {loading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-disabled">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id}>
              <button onClick={() => onOpen(s.id)} className="flex w-full items-center gap-2 rounded-panel border border-line bg-surface px-3 py-2.5 text-left">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{s.naslov}</div>
                  <div className="tnums text-xs text-ink-secondary">{formatDatum(s.datum)} · {formatVreme(s.vreme)}</div>
                </div>
                <SastanakStatusBadge status={s.status} />
                <ChevronRight className="h-4 w-4 text-ink-disabled" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MobileDetail({ id, myEmail, onBack }: { id: string; myEmail: string; onBack: () => void }) {
  const fullQ = useSastanakFull(id);
  const rsvp = useSetMyRsvp();
  const patchAkcija = usePatchAkcija();
  const updateAkt = useUpdateAktivnost();

  const sast = fullQ.data?.data;
  const locked = sast?.status === 'zakljucan' || sast?.status === 'otkazan';
  const mine = sast?.ucesnici.find((u) => u.email.toLowerCase() === myEmail.toLowerCase());

  return (
    <div className="min-h-screen bg-app">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-3">
        <button onClick={onBack} className="rounded-control p-1.5 text-ink-secondary hover:bg-surface-2" aria-label="Nazad">
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{sast?.naslov ?? 'Sastanak'}</span>
        {sast && <SastanakStatusBadge status={sast.status} />}
      </header>

      {fullQ.isLoading ? (
        <p className="p-4 text-sm text-ink-secondary">Učitavanje…</p>
      ) : !sast ? (
        <p className="p-4 text-sm text-status-danger">Sastanak nije pronađen.</p>
      ) : (
        <div className="space-y-5 p-3">
          <p className="tnums text-sm text-ink-secondary">{formatDatum(sast.datum)} · {formatVreme(sast.vreme)}{sast.mesto ? ` · ${sast.mesto}` : ''}</p>

          {/* Moj RSVP */}
          {mine && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Moj dolazak</h2>
              <div className="flex gap-2">
                <button
                  disabled={locked || rsvp.isPending}
                  onClick={() => rsvp.mutate({ id, status: 'dolazim' })}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-control border px-3 py-2 text-sm ${mine.rsvpStatus === 'dolazim' ? 'border-status-success bg-status-success-bg text-status-success' : 'border-line text-ink'} disabled:opacity-40`}
                >
                  <Check className="h-4 w-4" aria-hidden /> Dolazim
                </button>
                <button
                  disabled={locked || rsvp.isPending}
                  onClick={() => rsvp.mutate({ id, status: 'ne_dolazim' })}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-control border px-3 py-2 text-sm ${mine.rsvpStatus === 'ne_dolazim' ? 'border-status-danger bg-status-danger-bg text-status-danger' : 'border-line text-ink'} disabled:opacity-40`}
                >
                  <X className="h-4 w-4" aria-hidden /> Ne dolazim
                </button>
              </div>
            </section>
          )}

          {/* Zapisnik — tačke read + obrađeno */}
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Zapisnik</h2>
            {sast.aktivnosti.length === 0 ? (
              <p className="text-sm text-ink-disabled">Nema tačaka.</p>
            ) : (
              sast.aktivnosti.map((a) => {
                const done = a.status === 'zavrsen';
                return (
                  <div key={a.id} className="rounded-panel border border-line bg-surface p-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{a.naslov}</span>
                      <button
                        disabled={locked || updateAkt.isPending}
                        onClick={() => updateAkt.mutate({ aktId: a.id, patch: { status: done ? 'u_toku' : 'zavrsen' } })}
                        className={`shrink-0 rounded-control border px-2 py-0.5 text-xs ${done ? 'border-status-success bg-status-success-bg text-status-success' : 'border-line text-ink-secondary'} disabled:opacity-40`}
                      >
                        {done ? '✓ Obrađeno' : 'Obradi'}
                      </button>
                    </div>
                    {a.sadrzajText && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-secondary">{a.sadrzajText}</p>}
                  </div>
                );
              })
            )}
          </section>

          {/* Akcije — status sheet (otvoren/u_toku/zavrsen) */}
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Akcioni plan</h2>
            {sast.akcije.length === 0 ? (
              <p className="text-sm text-ink-disabled">Nema akcija.</p>
            ) : (
              sast.akcije.map((a) => (
                <div key={a.id} className="rounded-panel border border-line bg-surface p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-ink">{a.naslov}</span>
                    <AkcijaStatusBadge status={a.effective_status} />
                  </div>
                  {!locked && (
                    <div className="mt-2 flex gap-1">
                      {['otvoren', 'u_toku', 'zavrsen'].map((st) => (
                        <button
                          key={st}
                          onClick={() => patchAkcija.mutate({ id: a.id, patch: { status: st } })}
                          className={`rounded-control border px-2 py-0.5 text-xs ${a.status === st ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-ink-secondary'}`}
                        >
                          {st === 'otvoren' ? 'Otvoren' : st === 'u_toku' ? 'U toku' : 'Završen'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </section>

          {/* Odluke read */}
          {sast.odluke.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-secondary">Odluke</h2>
              {sast.odluke.map((o) => (
                <div key={o.id} className="rounded-panel border border-line bg-surface p-3 text-sm text-ink">{o.naslov}</div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
