'use client';

import { useState } from 'react';
import { Pencil, Trash2, CalendarPlus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  newClientEventId,
  useCreateTemplate,
  useDeleteTemplate,
  useInstantiateTemplate,
  useTemplates,
  useUpdateTemplate,
  type Template,
  type TemplateRow,
} from '@/api/sastanci';
import { CADENCE_LABEL, formatDatum, INPUT_CLS, SASTANAK_TIP_LABEL, tableEmpty } from './common';
import { useDetailNav } from './detail-nav';

/** Šabloni sastanaka + instanciranje (paritet 1.0 sabloni/templatesModal). */
export function SabloniTab() {
  const nav = useDetailNav();
  const tplQ = useTemplates();
  const instantiate = useInstantiateTemplate();
  const delM = useDeleteTemplate();
  const [modal, setModal] = useState<Template | null | undefined>(undefined);

  const rows = tplQ.data?.data ?? [];

  const cols: Column<TemplateRow>[] = [
    { key: 'naziv', header: 'Naziv', render: (r) => <span className="font-medium">{r.naziv}</span> },
    { key: 'tip', header: 'Tip', render: (r) => <span className="text-ink-secondary">{SASTANAK_TIP_LABEL[r.tip] ?? r.tip}</span> },
    { key: 'cad', header: 'Ponavljanje', render: (r) => <span className="text-ink-secondary">{CADENCE_LABEL[r.cadence] ?? r.cadence}</span> },
    {
      key: 'poslednji',
      header: (
        <span title="Poslednji već održan termin ove serije (otkazani se ne računaju). Prepoznaje se po naslovu koji je jednak nazivu šablona.">
          Poslednji sastanak
        </span>
      ),
      render: (r) =>
        r.poslednjiSastanak ? (
          <button
            type="button"
            className="tnums text-accent hover:underline"
            title="Otvori sastanak"
            onClick={(e) => {
              e.stopPropagation();
              if (r.poslednjiSastanakId) nav.open(r.poslednjiSastanakId);
            }}
          >
            {formatDatum(r.poslednjiSastanak)}
          </button>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'sledeci',
      header: (
        <span title="Sledeći termin po ritmu šablona — isti datum koji dodeljuje dugme „Zakaži po šablonu“. Neaktivan šablon i ritam „Bez ponavljanja“ nemaju sledeći termin.">
          Sledeći termin
        </span>
      ),
      render: (r) =>
        r.sledeciTermin ? (
          <span className="tnums text-ink-secondary">{formatDatum(r.sledeciTermin)}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    { key: 'active', header: 'Aktivan', render: (r) => <StatusBadge tone={r.isActive ? 'success' : 'neutral'} label={r.isActive ? 'Aktivan' : 'Neaktivan'} /> },
    {
      key: 'akcije',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            title="Zakaži po šablonu"
            className="rounded-control border border-line p-1 text-accent hover:bg-surface-2"
            onClick={async () => {
              const res = await instantiate.mutateAsync({ id: r.id, clientEventId: newClientEventId() });
              if (res.data?.id) nav.open(res.data.id);
            }}
          >
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button title="Uredi" className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setModal(r)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button title="Obriši" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { if (confirm('Obrisati šablon?')) delM.mutate({ id: r.id }); }}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setModal(null)}>+ Novi šablon</Button>
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={tplQ.isLoading}
        onRowActivate={(r) => setModal(r)}
        empty={tableEmpty(tplQ.isError, 'Nema šablona', 'Napravi šablon za sastanke koji se ponavljaju.')}
      />
      {modal !== undefined && <TemplateModal edit={modal} onClose={() => setModal(undefined)} />}
    </div>
  );
}

function TemplateModal({ edit, onClose }: { edit?: Template | null; onClose: () => void }) {
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const [naziv, setNaziv] = useState(edit?.naziv ?? '');
  const [tip, setTip] = useState(edit?.tip ?? 'sedmicni');
  const [mesto, setMesto] = useState(edit?.mesto ?? '');
  const [cadence, setCadence] = useState(edit?.cadence ?? 'weekly');
  const [cadenceDow, setCadenceDow] = useState(edit?.cadenceDow ?? 1);
  const [cadenceDom, setCadenceDom] = useState(edit?.cadenceDom ?? 1);
  const [vreme, setVreme] = useState(edit?.vreme ? String(edit.vreme).slice(11, 16) : '09:00');
  const [isActive, setIsActive] = useState(edit?.isActive ?? true);
  const [ucesnici, setUcesnici] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!naziv.trim()) return setError('Naziv je obavezan.');
    const parsedUcesnici = ucesnici
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [email, ...rest] = l.split(/\s+/);
        return { email, label: rest.join(' ') || undefined };
      });
    const body = {
      naziv: naziv.trim(),
      tip,
      mesto: mesto.trim() || undefined,
      cadence,
      cadenceDow,
      cadenceDom,
      vreme: vreme || undefined,
      isActive,
      ...(parsedUcesnici.length ? { ucesnici: parsedUcesnici } : {}),
    };
    try {
      if (edit) await update.mutateAsync({ id: edit.id, patch: body });
      else await create.mutateAsync({ clientEventId: newClientEventId(), ...body });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? 'Izmena šablona' : 'Novi šablon'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending || update.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Naziv" required>
          <input className={INPUT_CLS} value={naziv} onChange={(e) => setNaziv(e.target.value)} autoFocus />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tip">
            <select className={INPUT_CLS} value={tip} onChange={(e) => setTip(e.target.value)}>
              {Object.entries(SASTANAK_TIP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Mesto">
            <input className={INPUT_CLS} value={mesto} onChange={(e) => setMesto(e.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Ponavljanje">
            <select className={INPUT_CLS} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              {Object.entries(CADENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </FormField>
          <FormField label="Vreme">
            <input className={INPUT_CLS} type="time" value={vreme} onChange={(e) => setVreme(e.target.value)} />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Dan u nedelji (0=ned, 1=pon…)">
            <input className={INPUT_CLS} type="number" min={0} max={6} value={cadenceDow} onChange={(e) => setCadenceDow(Number(e.target.value))} />
          </FormField>
          <FormField label="Dan u mesecu (1–31)">
            <input className={INPUT_CLS} type="number" min={1} max={31} value={cadenceDom} onChange={(e) => setCadenceDom(Number(e.target.value))} />
          </FormField>
        </div>
        <FormField label="Učesnici (email [ime] — jedan po redu)">
          <textarea className={INPUT_CLS} rows={3} value={ucesnici} onChange={(e) => setUcesnici(e.target.value)} placeholder={edit ? '(ostavi prazno da ne menjaš)' : 'ime@servoteh.com Pera Perić'} />
        </FormField>
        <label className="flex items-center gap-1.5 text-sm text-ink">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Aktivan
        </label>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
