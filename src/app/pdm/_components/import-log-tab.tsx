'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useImportLog, type ImportLogRow } from '@/api/pdm';
import { formatDateTime, formatNumber } from '@/lib/format';
import { ImportDialog, type ImportKind } from './import-dialog';

const columns: Column<ImportLogRow>[] = [
  {
    key: 'importedAt',
    header: 'Datum',
    render: (r) => (
      <span className="tnums text-ink-secondary">{formatDateTime(r.importedAt)}</span>
    ),
  },
  {
    key: 'fileName',
    header: 'Fajl',
    render: (r) => (
      <div className="min-w-0">
        <span className="tnums font-medium text-ink">{r.fileName}</span>
        {r.statusMessage && (
          <span className="block truncate text-xs text-ink-disabled">{r.statusMessage}</span>
        )}
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <StatusBadge
          tone={r.success ? 'success' : 'danger'}
          label={r.success ? 'Uspešno' : 'Greška'}
        />
        {r.isCritical && <StatusBadge tone="danger" label="Kritično" />}
      </span>
    ),
  },
];

export function ImportLogTab() {
  const [page, setPage] = useState(1);
  const [success, setSuccess] = useState<'' | 'true' | 'false'>('');
  const [onlyCritical, setOnlyCritical] = useState(false);
  const [importKind, setImportKind] = useState<ImportKind | null>(null);
  const resetPage = () => setPage(1);

  const list = useImportLog({
    page,
    success,
    isCritical: onlyCritical ? 'true' : '',
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Ishod
          <select
            value={success}
            onChange={(e) => {
              setSuccess(e.target.value as '' | 'true' | 'false');
              resetPage();
            }}
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
          >
            <option value="">Svi</option>
            <option value="true">Uspešno</option>
            <option value="false">Greška</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={onlyCritical}
            onChange={(e) => {
              setOnlyCritical(e.target.checked);
              resetPage();
            }}
            className="h-4 w-4 accent-[var(--status-danger)]"
          />
          Samo kritične
        </label>
        <span className="ml-auto inline-flex items-end gap-2">
          {meta && (
            <span className="pb-1.5 text-sm text-ink-secondary">
              {formatNumber(meta.total)} zapisa
            </span>
          )}
          {/* Ručni uvoz (isti endpointi kao pdm-bridge) — samo sa pdm.import
              permisijom (backend guard vraća 403, dugmad se kriju). */}
          <Can permission={PERMISSIONS.PDM_IMPORT}>
            <Button onClick={() => setImportKind('xml')}>Uvezi XML</Button>
            <Button variant="secondary" onClick={() => setImportKind('pdf')}>
              Uvezi PDF
            </Button>
          </Can>
        </span>
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
            title="Nema zapisa o uvozu"
            hint="Promeni filtere ili sačekaj sledeći XML uvoz crteža."
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

      {importKind && (
        <ImportDialog kind={importKind} open onClose={() => setImportKind(null)} />
      )}
    </div>
  );
}
