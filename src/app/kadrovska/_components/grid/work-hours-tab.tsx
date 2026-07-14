'use client';

import { useMemo, useState } from 'react';
import { Trash2, Pencil, Plus, Mail } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useWorkHours,
  useDirectory,
  useGridBatchFull,
  useDeleteWorkHours,
  usePayrollNotifyRun,
  newClientEventId,
  type WorkHours,
} from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import { gridFormatSum } from '@/lib/grid-utils';

interface EditRow {
  id?: string;
  employeeId: string;
  workDate: string;
  hours: string;
  overtimeHours: string;
  projectRef: string;
  note: string;
}

/** Tab „Sati" — pojedinačni retroaktivni unosi (row-per-entry). Port workHoursTab. */
export function WorkHoursTab({ onToast }: { onToast: (m: string) => void }) {
  const { can } = useAuth();
  const editable = can(PERMISSIONS.KADROVSKA_GRID_EDIT);
  const canNotify = can(PERMISSIONS.KADROVSKA_MANAGE);
  const now = new Date();
  const [empFilter, setEmpFilter] = useState('');
  const [monthFilter, setMonthFilter] = useState('');
  const [edit, setEdit] = useState<EditRow | null>(null);

  const dirQ = useDirectory();
  const from = new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString().slice(0, 10);
  const whQ = useWorkHours({ from });
  const batch = useGridBatchFull();
  const del = useDeleteWorkHours();
  const notify = usePayrollNotifyRun();

  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of dirQ.data?.data ?? []) m.set(sv(r, 'id'), sv(r, 'full_name'));
    return m;
  }, [dirQ.data]);

  const items = whQ.data?.data ?? [];
  const filtered = useMemo(() => {
    return items.filter((w) => {
      if (empFilter && w.employeeId !== empFilter) return false;
      if (monthFilter && String(w.workDate).slice(0, 7) !== monthFilter) return false;
      return true;
    });
  }, [items, empFilter, monthFilter]);

  const totals = useMemo(() => {
    let reg = 0;
    let ot = 0;
    const days = new Set<string>();
    for (const w of filtered) {
      reg += Number(w.hours || 0);
      ot += Number(w.overtimeHours || 0);
      days.add(`${w.employeeId}|${w.workDate}`);
    }
    return { reg, ot, days: days.size };
  }, [filtered]);

  function openNew() {
    if (!editable) return;
    setEdit({ employeeId: empFilter || '', workDate: new Date().toISOString().slice(0, 10), hours: '8', overtimeHours: '0', projectRef: '', note: '' });
  }
  function openEdit(w: WorkHours) {
    setEdit({
      id: w.id,
      employeeId: w.employeeId,
      workDate: String(w.workDate).slice(0, 10),
      hours: String(w.hours ?? ''),
      overtimeHours: String(w.overtimeHours ?? ''),
      projectRef: w.projectRef ?? '',
      note: w.note ?? '',
    });
  }

  function submit() {
    if (!edit) return;
    if (!edit.employeeId || !edit.workDate) return;
    const h = parseFloat(edit.hours.replace(',', '.'));
    const ot = parseFloat(edit.overtimeHours.replace(',', '.') || '0');
    if (!isFinite(h) || h < 0 || h > 24 || ot < 0 || ot > 24) return alert('Sati i prekovremeni moraju biti 0–24.');
    batch.mutate(
      {
        clientEventId: newClientEventId(),
        rows: [
          {
            employeeId: edit.employeeId,
            workDate: edit.workDate,
            hours: h,
            overtimeHours: isFinite(ot) ? ot : 0,
            projectRef: edit.projectRef.trim() || null,
            note: edit.note.trim() || null,
          },
        ],
      },
      {
        onSuccess: () => {
          onToast(edit.id ? '✏️ Unos izmenjen' : '✅ Sati uneti');
          setEdit(null);
        },
      },
    );
  }

  function remove(w: WorkHours) {
    if (!editable) return;
    if (!window.confirm('Obrisati unos sati? Akcija je trajna.')) return;
    del.mutate({ id: w.id }, { onSuccess: () => onToast('🗑 Unos obrisan') });
  }

  function sendPayroll() {
    if (!monthFilter) return;
    const [y, m] = monthFilter.split('-').map(Number);
    if (!window.confirm(`Poslati obračun sati za ${monthFilter} svim zaposlenim koji imaju sate? Notifikacije idu u red čekanja.`)) return;
    notify.mutate(
      { year: y, month: m, clientEventId: newClientEventId() },
      { onSuccess: (r) => onToast(`📧 Upisano ${r.data ?? 0} notifikacija za ${monthFilter} — dispatch šalje u roku od 5 min`) },
    );
  }

  const cols: Column<WorkHours>[] = [
    { key: 'date', header: 'Datum', render: (w) => <span className="font-medium text-ink">{formatDate(w.workDate)}</span> },
    { key: 'emp', header: 'Zaposleni', render: (w) => nameMap.get(w.employeeId) || w.employeeId.slice(0, 8) },
    { key: 'hours', header: 'Sati', align: 'right', numeric: true, render: (w) => Number(w.hours || 0).toFixed(2) },
    { key: 'ot', header: 'Prekovremeni', align: 'right', numeric: true, render: (w) => (Number(w.overtimeHours || 0) ? `+${Number(w.overtimeHours).toFixed(2)}` : '—') },
    { key: 'proj', header: 'Projekat / Napomena', render: (w) => [w.projectRef, w.note].filter(Boolean).join(' · ') || '—' },
    {
      key: 'act',
      header: 'Akcije',
      render: (w) => (
        <div className="flex gap-1">
          <button className="rounded p-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-40" disabled={!editable} onClick={() => openEdit(w)} title="Izmeni">
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button className="rounded p-1 text-status-danger hover:bg-surface-2 disabled:opacity-40" disabled={!editable} onClick={() => remove(w)} title="Obriši">
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-3 text-sm">
          <option value="">Svi zaposleni</option>
          {[...nameMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sr')).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input type="month" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-3 text-sm" title="Mesec" />
        <span className="text-2xs text-ink-secondary">
          {filtered.length} {filtered.length === items.length ? 'unosa' : `/ ${items.length} unosa`}
        </span>
        <div className="ml-auto flex gap-2">
          {canNotify && monthFilter && (
            <Button variant="secondary" loading={notify.isPending} onClick={sendPayroll}>
              <Mail className="h-4 w-4" aria-hidden /> Pošalji obračun
            </Button>
          )}
          <Button variant="primary" disabled={!editable} onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden /> Unesi sate
          </Button>
        </div>
      </div>

      <SummaryChips
        items={[
          { label: 'Unosa (prikaz)', value: filtered.length, tone: 'accent' },
          { label: 'Redovnih sati', value: gridFormatSum(totals.reg) },
          { label: 'Prekovremenih', value: gridFormatSum(totals.ot), tone: totals.ot ? 'warn' : 'default' },
          { label: 'Dana', value: totals.days },
        ]}
      />

      <DataTable
        columns={cols}
        rows={filtered}
        rowKey={(w) => w.id}
        loading={whQ.isLoading}
        empty={<EmptyState title="Nema pojedinačnih unosa sati" hint={editable ? 'Klikni „Unesi sate" za retroaktivni unos.' : undefined} />}
      />

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? 'Izmeni unos sati' : 'Novi unos sati'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              Otkaži
            </Button>
            <Button variant="primary" loading={batch.isPending} onClick={submit}>
              Sačuvaj
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <FormField label="Zaposleni" required>
              <select value={edit.employeeId} onChange={(e) => setEdit({ ...edit, employeeId: e.target.value })} className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink">
                <option value="">— izaberi —</option>
                {[...nameMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sr')).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </FormField>
            <div className="grid grid-cols-3 gap-3">
              <FormField label="Datum" required>
                <Input type="date" value={edit.workDate} onChange={(e) => setEdit({ ...edit, workDate: e.target.value })} />
              </FormField>
              <FormField label="Sati" required>
                <Input type="number" min={0} max={24} step={0.25} value={edit.hours} onChange={(e) => setEdit({ ...edit, hours: e.target.value })} />
              </FormField>
              <FormField label="Prekovremeni">
                <Input type="number" min={0} max={24} step={0.25} value={edit.overtimeHours} onChange={(e) => setEdit({ ...edit, overtimeHours: e.target.value })} />
              </FormField>
            </div>
            <FormField label="Projekat">
              <Input value={edit.projectRef} maxLength={120} onChange={(e) => setEdit({ ...edit, projectRef: e.target.value })} placeholder="npr. INA-2025-03 ili opština Novi Sad" />
            </FormField>
            <FormField label="Napomena">
              <Textarea value={edit.note} maxLength={300} onChange={(e) => setEdit({ ...edit, note: e.target.value })} rows={2} />
            </FormField>
          </div>
        )}
      </Dialog>
    </div>
  );
}
