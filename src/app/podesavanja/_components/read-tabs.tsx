'use client';

import { useState } from 'react';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDateTime } from '@/lib/format';
import { useAuditLog } from '@/api/podesavanja';

// Organizacija (struktura + opis pozicije) preseljena u `organizacija-tab.tsx` (WRITE — P8).
// Vrednosti firme → `company-profile-tab.tsx`; Očekivanja → `expectations-tab.tsx` (Drop 2).
// Okvir kompetencija (pregled + „Uredi okvir") preseljen u `kompetencije-tab.tsx` (WRITE — P10).

// Podešavanje predmeta (WRITE) preseljen u `predmet-aktivacija-tab.tsx` — vidi `PredmetAktivacijaTab`.

// ------------------------------------------------------------------ Audit log

const AUDIT_ACTION_TONE: Record<string, Tone> = { INSERT: 'success', UPDATE: 'info', DELETE: 'danger' };

/** Tabele pokrivene v_settings_audit_log (paritet 1.0 SETTINGS_AUDIT_TABLE_LABELS). */
const AUDIT_TABLE_LABELS: Record<string, string> = {
  user_roles: 'Korisnici (uloge)',
  predmet_aktivacija: 'Podešavanje predmeta',
};
const AUDIT_ACTIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;
const AUDIT_PAGE_STEP = 100;
const AUDIT_MAX = 500;

export function AuditTab() {
  // Filteri po tabeli i akciji su BE parametri (server-strano nad celim skupom).
  // „Učitaj još” = rast `pageSize` 100→500 na jednoj strani (paritet 1.0 limit rasta).
  const [tableName, setTableName] = useState('');
  const [action, setAction] = useState('');
  const [pageSize, setPageSize] = useState(AUDIT_PAGE_STEP);

  const q = useAuditLog({ tableName: tableName || undefined, action: action || undefined, page: 1, pageSize });
  const fetched = q.data?.data ?? [];
  const total = q.data?.meta?.pagination?.total ?? 0;

  const rows = fetched;

  // Ima još ako smo dobili punu stranu, ima ukupno više I nismo na maksimumu.
  const canLoadMore = fetched.length >= pageSize && pageSize < AUDIT_MAX && fetched.length < total;

  function resetPage() {
    setPageSize(AUDIT_PAGE_STEP);
  }

  return (
    <div className="space-y-3">
      {/* Toolbar filtera */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">
          Tabela
          <select
            value={tableName}
            onChange={(e) => {
              setTableName(e.target.value);
              resetPage();
            }}
            className="rounded-control border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          >
            <option value="">Sve</option>
            {Object.entries(AUDIT_TABLE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">
          Akcija
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="rounded-control border border-line bg-surface px-2 py-1.5 text-sm text-ink"
          >
            <option value="">Sve</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            resetPage();
            void q.refetch();
          }}
          disabled={q.isFetching}
          className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-60"
        >
          Osveži
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="Nema zapisa u audit logu"
          hint={action || tableName ? 'Nema zapisa za izabrani filter.' : undefined}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                  <th className="px-3 py-2">Vreme</th>
                  <th className="px-3 py-2">Tabela</th>
                  <th className="px-3 py-2">Akcija</th>
                  <th className="px-3 py-2">Zapis</th>
                  <th className="px-3 py-2">Polja</th>
                  <th className="px-3 py-2">Ko</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line-soft">
                    <td className="px-3 py-1.5 tnums text-ink-secondary">{r.changed_at ? formatDateTime(r.changed_at) : '—'}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{AUDIT_TABLE_LABELS[r.table_name ?? ''] ?? r.table_name}</td>
                    <td className="px-3 py-1.5">
                      {r.action && <StatusBadge tone={AUDIT_ACTION_TONE[r.action] ?? 'neutral'} label={r.action} />}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-secondary">{(r.record_id ?? '').toString().slice(0, 40)}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-secondary">{(r.diff_keys ?? r.changed_fields ?? []).slice(0, 6).join(', ')}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{r.actor_email ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-ink-secondary">
              {rows.length} prikazano{total > rows.length ? ` od ${total}` : ''}
              {!canLoadMore ? ' · kraj liste' : ''}
            </span>
            {canLoadMore && (
              <button
                type="button"
                onClick={() => setPageSize((n) => Math.min(n + AUDIT_PAGE_STEP, AUDIT_MAX))}
                disabled={q.isFetching}
                className="rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-60"
              >
                Učitaj još
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
// Sistem tab (AI modeli, WRITE) živi u `system-tab.tsx` — vidi `SistemTab`.
