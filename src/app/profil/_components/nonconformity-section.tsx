'use client';

import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import { NONCONFORMITY_STATUS, NONCONFORMITY_TYPE } from '@/api/kvalitet';
import {
  useMyNonconformities,
  type MyNonconformityMonth,
  type MyNonconformityReport,
} from '@/api/kvalitet-mine';
import { Section } from './section';

/**
 * Moj profil → „Neusaglašenosti" (K3, MODULE_SPEC_kontrola_kvaliteta.md §6).
 * Radnik vidi SVOJE škartove/dorade (izveštaji gde je među izvršiocima). Scope
 * presuđuje server; `linked=false` ili prazno → diskretna poruka (nema tuđih
 * podataka). Read-only sekcija — bez ijedne mutacije.
 */

const YEAR = new Date().getFullYear();

/** Poslednjih 6 kalendarskih meseci (zaključno sa tekućim), za mini pregled. */
function last6Months(): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    out.push({ key, label: m.toLocaleDateString('sr-Latn', { month: 'short' }) });
  }
  return out;
}

/** Zbir komada tekuće godine za dati tip (iz mesečnog agregata). */
function yearPieces(monthly: MyNonconformityMonth[], type: number): number {
  return monthly
    .filter((m) => m.type === type && m.month.startsWith(String(YEAR)))
    .reduce((sum, m) => sum + m.pieces, 0);
}

export function NonconformitySection() {
  const q = useMyNonconformities();
  const data = q.data?.data;

  const months = useMemo(() => last6Months(), []);
  const monthlyPieces = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of data?.monthly ?? []) {
      map.set(m.month, (map.get(m.month) ?? 0) + m.pieces);
    }
    return months.map((mm) => ({ ...mm, pieces: map.get(mm.key) ?? 0 }));
  }, [data?.monthly, months]);

  const reports = data?.reports ?? [];
  const empty = !data?.linked || reports.length === 0;
  const scrapYear = data ? yearPieces(data.monthly, NONCONFORMITY_TYPE.SCRAP) : 0;
  const reworkYear = data ? yearPieces(data.monthly, NONCONFORMITY_TYPE.REWORK) : 0;
  const maxPieces = Math.max(1, ...monthlyPieces.map((m) => m.pieces));

  return (
    <Section
      icon={<AlertTriangle className="h-4 w-4 text-status-warn" />}
      title="Neusaglašenosti"
      badge={
        !empty ? (
          <span className="tnums rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">
            {formatNumber(reports.length)}
          </span>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <p className="text-sm text-ink-disabled">Učitavanje…</p>
      ) : empty ? (
        <p className="text-sm text-ink-disabled">Nema evidentiranih neusaglašenosti.</p>
      ) : (
        <div className="space-y-4">
          {/* Stat kartice — tekuća godina */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-panel border border-line bg-surface px-3 py-2">
              <div className="text-xs text-ink-secondary">Škart ({YEAR})</div>
              <div className="tnums text-lg font-semibold text-status-danger">
                {formatNumber(scrapYear)} <span className="text-sm font-normal text-ink-secondary">kom</span>
              </div>
            </div>
            <div className="rounded-panel border border-line bg-surface px-3 py-2">
              <div className="text-xs text-ink-secondary">Dorada ({YEAR})</div>
              <div className="tnums text-lg font-semibold text-status-warn">
                {formatNumber(reworkYear)} <span className="text-sm font-normal text-ink-secondary">kom</span>
              </div>
            </div>
          </div>

          {/* Poslednjih ~10 izveštaja */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
                <th className="py-1.5">Datum</th>
                <th className="py-1.5">Br. izveštaja</th>
                <th className="py-1.5">RN</th>
                <th className="py-1.5">Deo</th>
                <th className="py-1.5 text-right">Kom</th>
                <th className="py-1.5">Tip</th>
              </tr>
            </thead>
            <tbody>
              {reports.slice(0, 10).map((r) => (
                <ReportRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>

          {/* Mini 6-mesečni pregled (css bar) */}
          <div>
            <div className="mb-1.5 text-2xs uppercase tracking-[0.08em] text-ink-disabled">
              Poslednjih 6 meseci (kom)
            </div>
            <div className="space-y-1">
              {monthlyPieces.map((m) => (
                <div key={m.key} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-xs capitalize text-ink-secondary">{m.label}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-line-soft">
                    <div
                      className={cn('h-full rounded-full', m.pieces > 0 ? 'bg-status-warn' : 'bg-transparent')}
                      style={{ width: `${(m.pieces / maxPieces) * 100}%` }}
                    />
                  </div>
                  <span className="tnums w-8 shrink-0 text-right text-xs text-ink-secondary">
                    {m.pieces > 0 ? formatNumber(m.pieces) : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function ReportRow({ r }: { r: MyNonconformityReport }) {
  const isScrap = r.type === NONCONFORMITY_TYPE.SCRAP;
  const isDraft = r.status !== NONCONFORMITY_STATUS.CONFIRMED;
  return (
    <tr className="border-b border-line-soft">
      <td className="py-1.5 tnums text-ink-secondary">{formatDate(r.reportDate)}</td>
      <td className="py-1.5">
        {r.reportNumber ? (
          <span className="tnums text-ink">{r.reportNumber}</span>
        ) : isDraft ? (
          <StatusBadge tone="warn" label="Nacrt" />
        ) : (
          '—'
        )}
      </td>
      <td className="py-1.5 tnums text-ink-secondary">{r.identNumber || '—'}</td>
      <td className="py-1.5 text-ink">{r.partName || '—'}</td>
      <td className="py-1.5 tnums text-right text-ink">{formatNumber(r.quantity)}</td>
      <td className="py-1.5">
        <span className={isScrap ? 'text-status-danger' : 'text-status-warn'}>
          {isScrap ? 'Škart' : 'Dorada'}
        </span>
      </td>
    </tr>
  );
}
