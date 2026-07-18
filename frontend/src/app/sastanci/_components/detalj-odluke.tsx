'use client';

import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  newClientEventId,
  useCreateOdluka,
  useDeleteOdluka,
  useUpdateOdluka,
  type Odluka,
} from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { formatDatum, INPUT_CLS, tableEmpty } from './common';

/** Odluke tab — CRUD odluka sastanka (paritet 1.0 odlukeTab). */
export function DetaljOdluke({ sastanakId, odluke, canEdit }: { sastanakId: string; odluke: Odluka[]; canEdit: boolean }) {
  const delM = useDeleteOdluka();
  const [modal, setModal] = useState<Odluka | null | undefined>(undefined);

  const cols: Column<Odluka>[] = [
    { key: 'rb', header: '#', render: (r) => <span className="tnums text-ink-secondary">{r.rb ?? '—'}</span> },
    { key: 'naslov', header: 'Odluka', render: (r) => <span className="font-medium">{r.naslov}</span> },
    { key: 'ko', header: 'Odlučio', render: (r) => <span className="text-ink-secondary">{r.odlucioLabel || r.odlucioEmail || '—'}</span> },
    { key: 'datum', header: 'Datum', render: (r) => <span className="tnums text-ink-secondary">{formatDatum(r.odlukaDatum)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge tone={r.status === 'na_snazi' ? 'success' : 'neutral'} label={r.status === 'na_snazi' ? 'Na snazi' : 'Opozvana'} /> },
    ...(canEdit
      ? [{
          key: 'akcije',
          header: '',
          render: (r: Odluka) => (
            <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              <button title="Izmeni" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setModal(r)}><Pencil className="h-3.5 w-3.5" /></button>
              <button title="Obriši" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { if (confirm('Obrisati odluku?')) delM.mutate({ id: sastanakId, odlId: r.id }); }}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setModal(null)}>+ Nova odluka</Button>
        </div>
      )}
      <DataTable
        columns={cols}
        rows={odluke}
        rowKey={(r) => r.id}
        onRowActivate={canEdit ? (r) => setModal(r) : undefined}
        empty={tableEmpty(false, 'Nema odluka', 'Odluke donete na sastanku pojaviće se ovde.')}
      />
      {modal !== undefined && <OdlukaModal sastanakId={sastanakId} edit={modal} onClose={() => setModal(undefined)} />}
    </div>
  );
}

function OdlukaModal({ sastanakId, edit, onClose }: { sastanakId: string; edit?: Odluka | null; onClose: () => void }) {
  const create = useCreateOdluka();
  const update = useUpdateOdluka();
  const [naslov, setNaslov] = useState(edit?.naslov ?? '');
  const [opis, setOpis] = useState(edit?.opis ?? '');
  const [odlucio, setOdlucio] = useState<{ email: string; label?: string } | null>(
    edit?.odlucioEmail ? { email: edit.odlucioEmail, label: edit.odlucioLabel ?? undefined } : null,
  );
  const [datum, setDatum] = useState(edit?.odlukaDatum ? String(edit.odlukaDatum).slice(0, 10) : '');
  const [uticaj, setUticaj] = useState(edit?.uticaj ?? '');
  const [status, setStatus] = useState<'na_snazi' | 'opozvana'>((edit?.status as 'na_snazi' | 'opozvana') ?? 'na_snazi');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naslov.trim()) return setError('Naslov je obavezan.');
    const body = {
      opis: opis.trim() || undefined,
      odlucioEmail: odlucio?.email,
      odlucioLabel: odlucio?.label,
      odlukaDatum: datum || undefined,
      uticaj: uticaj.trim() || undefined,
      status,
    };
    try {
      if (edit) await update.mutateAsync({ id: sastanakId, odlId: edit.id, patch: { naslov: naslov.trim(), ...body } });
      else await create.mutateAsync({ id: sastanakId, clientEventId: newClientEventId(), naslov: naslov.trim(), ...body });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? 'Izmena odluke' : 'Nova odluka'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Odluka" required>
          <input className={INPUT_CLS} value={naslov} onChange={(e) => setNaslov(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Obrazloženje">
          <textarea className={INPUT_CLS} rows={2} value={opis} onChange={(e) => setOpis(e.target.value)} />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Odlučio">
            <DirectoryPicker value={odlucio} onChange={setOdlucio} />
          </FormField>
          <FormField label="Datum">
            <input className={INPUT_CLS} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Uticaj">
            <input className={INPUT_CLS} value={uticaj} onChange={(e) => setUticaj(e.target.value)} />
          </FormField>
          <FormField label="Status">
            <select className={INPUT_CLS} value={status} onChange={(e) => setStatus(e.target.value as 'na_snazi' | 'opozvana')}>
              <option value="na_snazi">Na snazi</option>
              <option value="opozvana">Opozvana</option>
            </select>
          </FormField>
        </div>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
