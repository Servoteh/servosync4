'use client';

// Audit istorija zaposlenog (kadrovska.admin) — paritet 1.0 employeeAuditModal.js.
// GET /reports/audit vraća CEO v_kadr_audit_log (snake_case) → filtriramo po
// employee_id klijentski. Red se širi u diff pre→posle (UPDATE) ili snapshot
// (INSERT/DELETE), sa lepim labelama polja.

import { useMemo, useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';
import { useAuditReport, type AuditLogRow } from '@/api/kadrovska';
import { AUDIT_ACTION, AUDIT_TABLE_LABELS, auditDiff, auditFieldLabel, auditFmtValue, auditIsHidden } from './shared';

export function EmployeeAuditDialog({ employeeId, employeeName, onClose }: { employeeId: string; employeeName: string; onClose: () => void }) {
  const q = useAuditReport(true);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const rows = useMemo(() => (q.data?.data ?? []).filter((r) => r.employee_id === employeeId), [q.data, employeeId]);

  function toggle(id: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`📒 Istorija izmena — ${employeeName}`}
      footer={<Button onClick={onClose}>Zatvori</Button>}
    >
      <p className="mb-3 text-sm text-ink-secondary">
        Hronologija svih izmena nad osetljivim tabelama (zarade, ugovori, GO, lekarski, sertifikati). Klikni red za detalje.
      </p>
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : q.isError ? (
        <p className="py-6 text-center text-sm text-ink-secondary">⚠ Audit log nije dostupan (potrebna admin prava).</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema audit zapisa za ovog zaposlenog.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-secondary">
                <th className="w-8 py-1.5" />
                <th className="px-2">Kada</th>
                <th className="px-2">Tabela</th>
                <th className="px-2">Akcija</th>
                <th className="px-2">Korisnik</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const act = AUDIT_ACTION[r.action] ?? { label: r.action, tone: 'neutral' as const };
                const isOpen = open.has(r.id);
                return (
                  <FragmentRow key={r.id} row={r} act={act} isOpen={isOpen} onToggle={() => toggle(r.id)} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function FragmentRow({ row, act, isOpen, onToggle }: { row: AuditLogRow; act: { label: string; tone: Tone }; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="cursor-pointer border-b border-line/60 hover:bg-surface-2" onClick={onToggle}>
        <td className="py-1.5 pl-1 text-ink-secondary">
          {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
        </td>
        <td className="px-2 font-mono text-xs text-ink-secondary">{formatDateTime(row.changed_at)}</td>
        <td className="px-2 text-ink">{AUDIT_TABLE_LABELS[row.table_name ?? ''] ?? row.table_name}</td>
        <td className="px-2">
          <StatusBadge tone={act.tone} label={act.label} />
        </td>
        <td className="px-2 text-ink-secondary">{row.actor_email || row.actor_user_id || '—'}</td>
      </tr>
      {isOpen && (
        <tr className="border-b border-line/60 bg-surface-2">
          <td colSpan={5} className="px-3 py-2">
            <AuditDetail row={row} />
          </td>
        </tr>
      )}
    </>
  );
}

function AuditDetail({ row }: { row: AuditLogRow }) {
  if (row.action === 'INSERT') return <Snapshot title="Dodate vrednosti" data={row.after_data} />;
  if (row.action === 'DELETE') return <Snapshot title="Obrisane vrednosti (poslednje stanje)" data={row.before_data} />;
  const diff = auditDiff(row.before_data, row.after_data);
  const keys = Object.keys(diff).filter((k) => !auditIsHidden(k));
  if (keys.length === 0) return <p className="text-xs text-ink-secondary">Nema vidljivih promena (tehničke kolone izostavljene).</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-ink-secondary">
          <th className="pr-3">Polje</th>
          <th className="pr-3">Pre</th>
          <th className="pr-1" />
          <th>Posle</th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <td className="pr-3 font-medium text-ink">{auditFieldLabel(k)}</td>
            <td className="pr-3 text-ink-secondary">{auditFmtValue(diff[k].before)}</td>
            <td className="pr-1 text-ink-secondary">→</td>
            <td className="text-ink">{auditFmtValue(diff[k].after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Snapshot({ title, data }: { title: string; data: Record<string, unknown> | null }) {
  const keys = Object.keys(data ?? {}).filter((k) => !auditIsHidden(k) && data![k] !== null && data![k] !== '');
  if (keys.length === 0) return <p className="text-xs text-ink-secondary">{title} — bez vidljivih polja.</p>;
  return (
    <div>
      <div className="mb-1 text-xs text-ink-secondary">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <td className="pr-3 font-medium text-ink">{auditFieldLabel(k)}</td>
              <td className="text-ink-secondary">{auditFmtValue(data![k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
