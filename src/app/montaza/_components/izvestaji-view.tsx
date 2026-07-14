'use client';

import { useState } from 'react';
import { Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useReports,
  useAiModel,
  useSetAiModel,
  MONTAZA_STATUS_LABELS,
  MONTAZA_AI_MODELS,
  type ReportRow,
} from '@/api/plan-montaze';
import { ReportDetail } from './report-detail';
import { ReportCreate } from './report-create';

export function IzvestajiView({ canManage }: { canManage: boolean }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const reports = useReports({ q: q.trim() || undefined, status: status || undefined });
  const rows = reports.data?.data ?? [];

  const columns: Column<ReportRow>[] = [
    { key: 'broj', header: 'Broj', render: (r) => <span className="font-medium text-ink">{r.broj_izvestaja ?? '—'}</span> },
    { key: 'datum', header: 'Datum', render: (r) => <span className="tnums text-xs">{formatDate(r.datum_rada)}</span> },
    { key: 'predmet', header: 'Predmet', render: (r) => r.predmet_broj ?? '—' },
    { key: 'klijent', header: 'Klijent', render: (r) => r.klijent ?? '—' },
    { key: 'lokacija', header: 'Lokacija', render: (r) => r.lokacija ?? '—' },
    { key: 'autor', header: 'Autor', render: (r) => r.autor_ime ?? '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone="info" label={MONTAZA_STATUS_LABELS[r.status] ?? r.status} />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Broj / predmet / klijent…" />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Svi statusi</option>
          {Object.entries(MONTAZA_STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <span className="text-sm text-ink-secondary">{rows.length} izveštaja</span>
        <div className="ml-auto flex gap-2">
          <Can permission={PERMISSIONS.MONTAZA_AI_ADMIN}>
            <Button variant="ghost" onClick={() => setAiOpen(true)}>
              <Settings className="h-4 w-4" /> AI model
            </Button>
          </Can>
          <Can permission={PERMISSIONS.MONTAZA_IZVESTAJI}>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> Novi izveštaj
            </Button>
          </Can>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={reports.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        empty={<EmptyState title="Nema izveštaja" hint="Kreiraj prvi izveštaj montera." />}
      />

      {openId && <ReportDetail id={openId} onClose={() => setOpenId(null)} canManage={canManage} />}
      <ReportCreate open={creating} onClose={() => setCreating(false)} />
      {aiOpen && <AiModelDialog onClose={() => setAiOpen(false)} />}
    </div>
  );
}

function AiModelDialog({ onClose }: { onClose: () => void }) {
  const q = useAiModel();
  const set = useSetAiModel();
  const current = q.data?.data?.model ?? '';
  const [model, setModel] = useState(current);

  return (
    <Dialog
      open
      onClose={onClose}
      title="AI model (izveštaji)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button
            onClick={async () => {
              await set.mutateAsync({ model: model || current });
              onClose();
            }}
            loading={set.isPending}
            disabled={!model}
          >
            Sačuvaj
          </Button>
        </>
      }
    >
      <select
        value={model || current}
        onChange={(e) => setModel(e.target.value)}
        className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
      >
        {MONTAZA_AI_MODELS.map((m) => (
          <option key={m} value={m}>{m}</option>
        ))}
      </select>
      <p className="mt-2 text-xs text-ink-secondary">Trenutno: {current || '—'}</p>
    </Dialog>
  );
}
