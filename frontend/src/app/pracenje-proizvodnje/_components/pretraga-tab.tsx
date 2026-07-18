'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { useSearchDelovi } from '@/api/pracenje';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEBOUNCE_MS = 300;

/** Status lansiranja RN-a (1.0 lansiranBadge) — SVRHA pretrage. */
function LansiranBadge({ r }: { r: Record<string, unknown> }) {
  if (r.lansiran) {
    return <StatusBadge tone="success" label="Lansiran" />;
  }
  const st = String(r.rn_status ?? 'nije lansiran');
  const suffix = st && st !== 'lansiran' ? ` · ${st}` : '';
  return <StatusBadge tone="warn" label={`Nije lansiran${suffix}`} />;
}

/**
 * Pretraga delova (search_proizvodnja_delovi) → otvara RN drill-down. Živi RPC vraća
 * `bigtehn_work_order_id` (bigint MES id) i `rn_id` (uuid Faza-2 RN, NULL za bigtehn pogodak).
 * MES pogodak (rn_id uuid) ide direktno; inače ensure-from-bigtehn preko bigtehn_work_order_id.
 * 7 kolona sa statusom lansiranja + brojač + debounce + error/retry (SH-02/03).
 */
export function PretragaTab({
  onOpenRnBigtehn,
  onOpenRnUuid,
}: {
  onOpenRnBigtehn: (bigtehnRnId: string) => void;
  onOpenRnUuid: (rnId: string) => void;
}) {
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useSearchDelovi(q);
  const rows = search.data?.data ?? [];
  const term = q.trim();

  // Auto-fokus na ulazak.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce 300ms (Enter preskače — vidi onKeyDown).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQ(input), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input]);

  function runNow() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQ(input);
  }

  function openRow(r: Record<string, unknown>) {
    const rnId = r.rn_id;
    if (typeof rnId === 'string' && UUID_RE.test(rnId)) {
      onOpenRnUuid(rnId);
      return;
    }
    const wo = r.bigtehn_work_order_id;
    if (wo != null && wo !== '') {
      onOpenRnBigtehn(String(wo));
      return;
    }
    // Nema ni uuid RN ni bigtehn id — ne može da se otvori (SH-03).
    toast('Ovaj red nema RN broj — otvori preko predmeta u Praćenju.');
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runNow();
              }
            }}
            placeholder="RN broj · crtež · TP/operacija · naziv dela…"
            className="w-72 bg-transparent text-sm text-ink placeholder:text-ink-disabled focus:outline-none"
            autoComplete="off"
          />
        </div>
        {term.length >= 2 && !search.isLoading && !search.isError && (
          <span className="text-sm text-ink-secondary">{rows.length} rezultata</span>
        )}
      </div>

      {term.length < 2 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-12 text-center">
          <Search className="mx-auto mb-2 h-6 w-6 text-ink-disabled" aria-hidden />
          <div className="text-sm font-medium text-ink">Pretraži deo</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-ink-secondary">
            Unesi RN broj, broj crteža, oznaku/naziv operacije (TP) ili naziv dela. Rezultat pokazuje da li je RN{' '}
            <strong className="text-ink">lansiran</strong> u proizvodnju ili ne.
          </p>
        </div>
      ) : search.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Pretraga…</div>
      ) : search.isError ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center">
          <p className="text-sm text-status-danger">
            Greška pri pretrazi{search.error instanceof Error ? `: ${search.error.message}` : ''}.
          </p>
          <Button variant="secondary" onClick={() => search.refetch()} className="mt-3">
            Pokušaj ponovo
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          Nema rezultata. Proveri broj crteža / RN / naziv.
        </div>
      ) : (
        <div className="max-h-[min(70vh,760px)] overflow-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">RN</th>
                <th className="px-3 py-1.5">Crtež</th>
                <th className="px-3 py-1.5">Naziv dela</th>
                <th className="px-3 py-1.5">TP / operacije</th>
                <th className="px-3 py-1.5">Koordinator</th>
                <th className="px-3 py-1.5">Rok isporuke</th>
                <th className="px-3 py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rev = r.revision ? ` (rev ${String(r.revision)})` : '';
                const srcHint = r.source === 'bigtehn';
                return (
                  <tr
                    key={i}
                    className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    onClick={() => openRow(r)}
                    title="Otvori praćenje RN-a"
                  >
                    <td className="px-3 py-1.5">
                      <span className="font-semibold text-ink">{String(r.rn_broj ?? '—')}</span>
                      {srcHint && <span className="ml-1 text-2xs text-ink-disabled">· BigTehn (MES)</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.drawing_no ? (
                        <>
                          {String(r.drawing_no)}
                          {rev && <span className="text-ink-disabled">{rev}</span>}
                        </>
                      ) : (
                        <span className="text-ink-disabled">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {String(r.naziv ?? '—')}
                      {r.sifra_pozicije ? <span className="text-ink-disabled"> ({String(r.sifra_pozicije)})</span> : null}
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-1.5 text-xs text-ink-secondary" title={r.tp ? String(r.tp) : undefined}>
                      {r.tp ? String(r.tp) : <span className="text-ink-disabled">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs">{r.koordinator ? String(r.koordinator) : <span className="text-ink-disabled">—</span>}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.datum_isporuke ? String(r.datum_isporuke) : <span className="text-ink-disabled">—</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      <LansiranBadge r={r} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
