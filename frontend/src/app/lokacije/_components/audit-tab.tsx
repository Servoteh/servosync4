'use client';

import { useMemo } from 'react';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAllLocations, useDefinitionsAudit, type DefinitionAuditRow } from '@/api/lokacije';
import { buildLocIndex, locationKindLabel, tableEmpty, userDisplay, type LocIndex } from './common';

// ------------------------------------------------------------------ diff helpers (paritet 1.0 definitionAuditRowsHtml)

function auditWhen(iso: string | null | undefined): string {
  return String(iso ?? '').replace('T', ' ').slice(0, 16);
}

const ACTION: Record<string, { tone: Tone; label: string }> = {
  INSERT: { tone: 'success', label: 'Kreiranje' },
  UPDATE: { tone: 'info', label: 'Izmena' },
  DELETE: { tone: 'danger', label: 'Brisanje' },
};

function auditLocLabel(row: DefinitionAuditRow, locIndex: LocIndex): string {
  const data = (row.new_data ?? row.old_data ?? {}) as Record<string, unknown>;
  const id = row.record_id ?? (typeof data.id === 'string' ? data.id : undefined);
  const loc = id ? locIndex.byId.get(String(id)) : undefined;
  const code = loc?.locationCode ?? (data.location_code as string) ?? String(id ?? '').slice(0, 8);
  const name = loc?.name ?? (data.name as string) ?? '';
  const kind = locationKindLabel(loc?.locationType ?? (data.location_type as string) ?? '');
  return `${code}${name ? ` · ${name}` : ''} (${kind})`;
}

function fieldValue(data: Record<string, unknown> | null | undefined, key: string): string {
  if (!data || !(key in data)) return '—';
  const v = data[key];
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Lista izmenjenih polja (bez updated_at) — kolona „Promenjeno". */
function changedFields(row: DefinitionAuditRow): string {
  const keys = (Array.isArray(row.diff_keys) ? row.diff_keys : []).filter((k) => k !== 'updated_at');
  if (keys.length) return keys.join(', ');
  return row.action === 'INSERT' ? 'sva polja' : '—';
}

/** Strukturisan detalj (polje: pre → posle) — paritet auditDiffSummary. */
function diffSummary(row: DefinitionAuditRow): string {
  const action = row.action ?? '';
  if (action === 'INSERT') return 'Kreirano';
  if (action === 'DELETE') return 'Obrisano';
  const keys = (Array.isArray(row.diff_keys) ? row.diff_keys : []).filter((k) => k !== 'updated_at');
  if (!keys.length) return 'Bez vidljivih promena';
  return keys.map((k) => `${k}: ${fieldValue(row.old_data, k)} → ${fieldValue(row.new_data, k)}`).join('; ');
}

/** Istorija definicija (loc_locations_audit, manage) — čitljiva strukturirana tabela sa diff-om. */
export function AuditTab() {
  const q = useDefinitionsAudit(150);
  const rows = q.data?.data ?? [];
  const locs = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locs.data ?? []), [locs.data]);

  if (q.isLoading) return <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>;
  if (rows.length === 0) return tableEmpty(q.isError, 'Nema zapisa', 'Još nema zabeleženih izmena definicija hala i polica.');

  return (
    <div className="space-y-3">
      <div className="rounded-panel border border-line bg-surface-2/40 px-3 py-2.5 text-xs text-ink-secondary">
        <strong className="text-ink">Istorija definicija hala i polica.</strong> Ko je i kada dodao, promenio ili deaktivirao red u šifarniku lokacija. Ovo nije istorija premeštanja stavki.
      </div>
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left">
              {['Vreme', 'Korisnik', 'Akcija', 'Lokacija', 'Promenjeno', 'Detalj'].map((c) => (
                <th key={c} className="h-9 whitespace-nowrap px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const act = ACTION[String(r.action ?? '')] ?? { tone: 'neutral' as Tone, label: String(r.action ?? '—') };
              return (
                <tr key={(r.id as string | number) ?? i} className="border-b border-line-soft align-top hover:bg-surface-2">
                  <td className="whitespace-nowrap px-3 py-1.5 tnums text-xs text-ink-secondary">{auditWhen(r.changed_at)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink" title={r.actor_uid ?? undefined}>
                    {userDisplay(r.actor_name ?? r.actor_email, r.actor_uid)}
                  </td>
                  <td className="px-3 py-1.5"><StatusBadge tone={act.tone} label={act.label} /></td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-ink">{auditLocLabel(r, locIndex)}</td>
                  <td className="px-3 py-1.5 text-xs text-ink-secondary">{changedFields(r)}</td>
                  <td className="max-w-md px-3 py-1.5 text-xs text-ink-secondary">{diffSummary(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
