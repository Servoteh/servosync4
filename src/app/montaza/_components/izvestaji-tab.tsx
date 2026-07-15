'use client';

// Izveštaji montera — lista + detalj + create-wizard + „Poveži predmet" (increment 4).

import { useState } from 'react';
import { FileDown, ImageIcon, Plus, Link2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDmy } from '@/lib/plan-montaze/date';
import { IZVESTAJ_STATUS, IZVESTAJ_STATUS_TONE, IZVESTAJ_AI_MODELI } from '@/lib/plan-montaze/constants';
import {
  useMontazaReports,
  useMontazaReport,
  useLinkPredmet,
  useMontazaAiModel,
  useSetMontazaAiModel,
  fetchPhotoSignedUrl,
  fetchReportPdfUrl,
  type IzvestajRow,
} from '@/api/plan-montaze';
import { IzvestajWizard } from './izvestaj-wizard';
import { PredmetPicker } from './predmet-picker';

const STATUS_FILTERS = [
  { key: '', label: 'Svi' },
  ...Object.entries(IZVESTAJ_STATUS).map(([key, label]) => ({ key, label })),
];

function statusBadge(code: string) {
  return <StatusBadge tone={IZVESTAJ_STATUS_TONE[code] ?? 'neutral'} label={IZVESTAJ_STATUS[code] ?? code} />;
}

export function IzvestajiTab() {
  const canCreate = useCan()(PERMISSIONS.MONTAZA_IZVESTAJI);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useMontazaReports({ q: q || undefined, status: status || undefined });
  const rows = list.data?.data ?? [];

  if (mode === 'create') return <IzvestajWizard onClose={() => setMode('list')} />;

  const cols: Column<IzvestajRow>[] = [
    {
      key: 'broj',
      header: 'Broj',
      render: (r) => <span className="tnums font-medium text-ink">{r.broj_izvestaja || '—'}</span>,
    },
    {
      key: 'datum',
      header: 'Datum',
      render: (r) => <span className="tnums text-ink-secondary">{formatDmy(r.datum_rada) || '—'}</span>,
    },
    {
      key: 'predmet',
      header: 'Predmet / projekat',
      render: (r) => (
        <span className="text-ink">
          {r.predmet_broj ? <span className="tnums font-medium">{r.predmet_broj}</span> : null}
          {r.predmet_broj && r.naziv_projekta ? ' · ' : ''}
          <span className="text-ink-secondary">{r.naziv_projekta || (r.predmet_broj ? '' : '—')}</span>
        </span>
      ),
    },
    { key: 'klijent', header: 'Klijent', render: (r) => r.klijent || '—' },
    { key: 'lokacija', header: 'Lokacija', render: (r) => r.lokacija || '—' },
    { key: 'autor', header: 'Autor', render: (r) => <span className="text-ink-secondary">{r.autor_ime || '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r.status) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder="Broj, predmet, projekat, klijent, lokacija, autor…"
        />
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatus(f.key)}
              className={
                status === f.key
                  ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-sm text-ink-secondary">{rows.length} izveštaja</span>
        <AiModelControl />
        {canCreate && (
          <Button onClick={() => setMode('create')}>
            <Plus className="h-4 w-4" aria-hidden /> Novi izveštaj
          </Button>
        )}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
        expandedKey={openId}
        renderExpanded={(r) => <IzvestajDetalj id={r.id} row={r} />}
        empty={
          <EmptyState
            title={list.isError ? 'Greška pri učitavanju' : 'Nema izveštaja'}
            hint={
              list.isError
                ? 'Pokušajte ponovo ili proverite prijavu.'
                : 'Kad monteri počnu da unose izveštaje, pojaviće se ovde.'
            }
          />
        }
      />
    </div>
  );
}

/** Detalj izveštaja: puni tekst + fotke (signed URL na klik) + PDF + poveži predmet. */
function IzvestajDetalj({ id, row }: { id: string; row: IzvestajRow }) {
  const canManage = useCan()(PERMISSIONS.MONTAZA_IZVESTAJI);
  const detail = useMontazaReport(id);
  const link = useLinkPredmet();
  const d = detail.data?.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  async function openPhoto(photoId: string) {
    setBusy(photoId);
    try {
      const res = await fetchPhotoSignedUrl(photoId);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } finally {
      setBusy(null);
    }
  }

  async function openPdf() {
    setBusy('pdf');
    try {
      const res = await fetchReportPdfUrl(id);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } finally {
      setBusy(null);
    }
  }

  if (detail.isLoading) return <div className="p-3 text-sm text-ink-secondary">Učitavanje detalja…</div>;
  if (detail.isError || !d) return <div className="p-3 text-sm text-status-danger">Greška pri učitavanju detalja.</div>;

  const clanovi = Array.isArray(d.dodatniClanovi) ? d.dodatniClanovi : [];

  async function linkPredmet(sel: { predmet_item_id: number; predmet_broj: string; naziv_projekta: string; klijent: string } | null) {
    await link.mutateAsync({
      id,
      predmetItemId: sel ? sel.predmet_item_id : null,
      predmetBroj: sel?.predmet_broj,
      nazivProjekta: sel?.naziv_projekta,
      klijent: sel?.klijent,
    });
  }

  return (
    <div className="space-y-3 p-2">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
        <Meta label="Predmet / projekat" value={[d.predmetBroj, d.nazivProjekta].filter(Boolean).join(' — ') || '—'} />
        <Meta label="Rad od–do" value={[d.pocetakRada, d.krajRada].filter(Boolean).join(' – ') || '—'} />
        <Meta label="Klijent" value={d.klijent || '—'} />
        <Meta label="Lokacija" value={d.lokacija || '—'} />
        {clanovi.length > 0 && <Meta label="Dodatni članovi" value={clanovi.join(', ')} />}
        {canManage && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1 self-end rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden /> Poveži / ispravi predmet
          </button>
        )}
      </div>

      <Section title="Opis radova" text={d.opisRadova} />
      <Section title="Problemi" text={d.problemi} />
      <Section title="Otvorene stavke" text={d.otvoreneStavke} />

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {d.fotke.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-ink-secondary">
            <ImageIcon className="h-3.5 w-3.5" aria-hidden /> {d.fotke.length} fotki:
          </span>
        )}
        {d.fotke.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => openPhoto(f.id)}
            disabled={busy === f.id}
            className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
            title={f.opis ?? undefined}
          >
            Foto {f.redniBroj}
          </button>
        ))}
        {(d.pdfPath || row.pdf_path) && (
          <Button variant="secondary" onClick={openPdf} loading={busy === 'pdf'} className="ml-auto h-8 px-3 text-sm">
            <FileDown className="h-4 w-4" aria-hidden /> Otvori PDF
          </Button>
        )}
      </div>

      {row.sirovi_tekst && (
        <details className="text-xs text-ink-secondary">
          <summary className="cursor-pointer select-none">Sirovi tekst (pre AI obrade)</summary>
          <p className="mt-1 whitespace-pre-wrap">{row.sirovi_tekst}</p>
        </details>
      )}

      {canManage && (
        <PredmetPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(sel) => void linkPredmet(sel)}
          onClear={() => void linkPredmet(null)}
        />
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</div>
      <div className="text-ink">{value}</div>
    </div>
  );
}

/** AI model za strukturiranje izveštaja — admin-only izbor (montaza.ai_admin). */
function AiModelControl() {
  const isAdmin = useCan()(PERMISSIONS.MONTAZA_AI_ADMIN);
  const model = useMontazaAiModel();
  const setModel = useSetMontazaAiModel();
  if (!isAdmin) return null;
  const current = model.data?.data?.model ?? '';
  return (
    <label className="flex items-center gap-1 text-xs text-ink-secondary" title="AI model za strukturiranje izveštaja">
      AI:
      <select
        value={current}
        disabled={model.isLoading || setModel.isPending}
        onChange={(e) => setModel.mutate(e.target.value)}
        className="h-8 rounded-control border border-line bg-surface px-1.5 text-xs text-ink disabled:opacity-60"
      >
        {!current && <option value="">—</option>}
        {IZVESTAJ_AI_MODELI.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </label>
  );
}

function Section({ title, text }: { title: string; text: string | null }) {
  if (!text?.trim()) return null;
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{title}</div>
      <p className="whitespace-pre-wrap text-sm text-ink">{text}</p>
    </div>
  );
}
