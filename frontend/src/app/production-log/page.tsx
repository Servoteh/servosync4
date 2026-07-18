'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Undo2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import {
  useProductionLog,
  useStornoTechProcess,
  useDeleteTechProcess,
  type ProductionLogEntry,
} from '@/api/production-log';
import { useOperations, type Operation } from '@/api/structures';
import { ApiError } from '@/api/client';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';

const QUALITY_META: Record<number, { tone: Tone; label: string }> = {
  0: { tone: 'success', label: 'Dobar' },
  1: { tone: 'warn', label: 'Dorada' },
  2: { tone: 'danger', label: 'Škart' },
};

/** Storno otkucane operacije — kontra-red sa negativnim komadima. */
function StornoDialog({ entry, onClose }: { entry: ProductionLogEntry; onClose: () => void }) {
  const [pieceCount, setPieceCount] = useState(entry.pieceCount);
  const [note, setNote] = useState('');
  const storno = useStornoTechProcess();
  const err = storno.error instanceof ApiError ? storno.error.message : (storno.error as Error)?.message;
  const valid = Number.isInteger(pieceCount) && pieceCount >= 1 && pieceCount <= entry.pieceCount;

  async function submit() {
    if (!valid) return;
    try {
      await storno.mutateAsync({ id: entry.id, pieceCount, note });
      onClose();
    } catch {
      /* greška ispod */
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Storno — RN ${entry.identNumber}, op. ${entry.operationNumber}`}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={storno.isPending} disabled={!valid}>
            Storniraj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Upisuje kontra-red sa negativnim brojem komada (neto se poništava). Ne briše postojeći
          zapis. Evidentirano: <span className="tnums">{formatNumber(entry.pieceCount)}</span> kom.
        </p>
        <FormField label="Broj komada za storno" required>
          <Input
            type="number"
            min={1}
            max={entry.pieceCount}
            step={1}
            value={pieceCount || ''}
            onChange={(e) => setPieceCount(Math.floor(Number(e.target.value)))}
          />
        </FormField>
        <FormField label="Napomena">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {err && (
          <p className="text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Audited brisanje otkucane operacije (snapshot u audit_log). */
function DeleteEntryDialog({ entry, onClose }: { entry: ProductionLogEntry; onClose: () => void }) {
  const [note, setNote] = useState('');
  const del = useDeleteTechProcess();
  const err = del.error instanceof ApiError ? del.error.message : (del.error as Error)?.message;

  async function submit() {
    try {
      await del.mutateAsync({ id: entry.id, note });
      onClose();
    } catch {
      /* greška ispod */
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Obriši evidenciju — RN ${entry.identNumber}, op. ${entry.operationNumber}`}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <button
            disabled={del.isPending}
            onClick={submit}
            className="rounded-control bg-status-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {del.isPending ? 'Brisanje…' : 'Obriši'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Briše ovu otkucanu operaciju. Snimak reda se čuva u audit dnevniku (povratljivo). Koristi
          se za ispravku loše evidentiranih kucanja.
        </p>
        <FormField label="Razlog / napomena">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {err && (
          <p className="text-sm text-status-danger" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export default function ProductionLogPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [rc, setRc] = useState<Operation | null>(null);
  const [qualityTypeId, setQualityTypeId] = useState<number | ''>('');
  const [finished, setFinished] = useState<'' | 'true' | 'false'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [storno, setStorno] = useState<ProductionLogEntry | null>(null);
  const [del, setDel] = useState<ProductionLogEntry | null>(null);

  const list = useProductionLog({
    page,
    q: q.trim() || undefined,
    workCenterCode: rc?.workCenterCode,
    qualityTypeId,
    finished,
    from: from || undefined,
    to: to ? `${to}T23:59:59` : undefined,
  });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const mayWrite = can(PERMISSIONS.TEHNOLOGIJA_WRITE);
  const resetPage = () => setPage(1);
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const columns: Column<ProductionLogEntry>[] = [
    {
      key: 'identNumber',
      header: 'RN / Ident',
      render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
    },
    {
      key: 'operationNumber',
      header: 'Op.',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span>,
    },
    {
      key: 'rc',
      header: 'Radni centar',
      render: (r) => r.operation?.workCenterName ?? r.workCenterCode,
    },
    {
      key: 'worker',
      header: 'Radnik',
      render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
    },
    {
      key: 'pieceCount',
      header: 'Kom',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className={r.pieceCount < 0 ? 'tnums font-semibold text-status-danger' : 'tnums'}>
          {formatNumber(r.pieceCount)}
        </span>
      ),
    },
    {
      key: 'quality',
      header: 'Kvalitet',
      render: (r) => {
        const m = QUALITY_META[r.qualityTypeId] ?? QUALITY_META[0];
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.isProcessFinished ? (
          <StatusBadge tone="success" label="Završen" />
        ) : (
          <StatusBadge tone="info" label="Otvoren" />
        ),
    },
    {
      key: 'enteredAt',
      header: 'Evidentirano',
      render: (r) => <span className="text-ink-secondary">{formatDateTime(r.enteredAt)}</span>,
    },
  ];
  if (mayWrite) {
    columns.push({
      key: 'actions',
      header: 'Ispravke',
      align: 'right',
      render: (r) => (
        <div className="inline-flex gap-1">
          <button
            disabled={r.pieceCount <= 0}
            onClick={() => setStorno(r)}
            aria-label="Storno"
            title="Storno (kontra-red)"
            className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2 disabled:opacity-30"
          >
            <Undo2 className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            onClick={() => setDel(r)}
            aria-label="Obriši evidenciju"
            title="Obriši (audited)"
            className="rounded-control border border-line px-2 py-1 text-status-danger hover:bg-status-danger-bg"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ),
    });
  }

  return (
    <AppShell>
      <PageHeader
        title="Evidencija u proizvodnji"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="RN / ident…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <select
              value={finished}
              onChange={(e) => {
                setFinished(e.target.value as '' | 'true' | 'false');
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value="">Svi</option>
              <option value="false">Otvoreni</option>
              <option value="true">Završeni</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Kvalitet
            <select
              value={qualityTypeId}
              onChange={(e) => {
                setQualityTypeId(e.target.value === '' ? '' : Number(e.target.value));
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            >
              <option value="">Svi</option>
              <option value={0}>Dobar</option>
              <option value={1}>Dorada</option>
              <option value={2}>Škart</option>
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs text-ink-secondary">
            Radni centar
            <div className="w-56">
              <ComboBox<Operation>
                value={rc}
                onChange={(o) => {
                  setRc(o);
                  resetPage();
                }}
                useSearch={(query) => useOperations({ q: query || undefined })}
                getKey={(o) => o.workCenterCode}
                getLabel={(o) => `${o.workCenterName} (${o.workCenterCode})`}
                placeholder="Svi radni centri…"
              />
            </div>
          </div>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Od
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Do
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetPage();
              }}
              className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
            />
          </label>
          {(q || rc || qualityTypeId !== '' || finished || from || to) && (
            <button
              onClick={() => {
                setQ('');
                setRc(null);
                setQualityTypeId('');
                setFinished('');
                setFrom('');
                setTo('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {list.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema evidentiranih operacija"
              hint="Promeni filtere — ili se kucanje obavlja na kiosku (Kucanje/Kontrola)."
            />
          }
        />

        {meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
          />
        )}
      </div>

      <Can permission={PERMISSIONS.TEHNOLOGIJA_WRITE}>
        {storno && <StornoDialog entry={storno} onClose={() => setStorno(null)} />}
        {del && <DeleteEntryDialog entry={del} onClose={() => setDel(null)} />}
      </Can>
    </AppShell>
  );
}
