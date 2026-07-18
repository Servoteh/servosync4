'use client';

import { useState } from 'react';
import { useHandovers, useTechnologists, type Handover } from '@/api/handovers';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';
import {
  HANDOVER_STATUS_OPTIONS,
  LegacyBadge,
  NativeSelect,
  UrgentBadge,
  errorBox,
  handoverStatusMeta,
} from './common';
import { HandoverDetailPanel } from './handover-detail';

const columns: Column<Handover>[] = [
  {
    key: 'drawing',
    header: 'Crtež',
    render: (r) => (
      <span className="tnums font-semibold text-ink">
        {r.drawing ? `${r.drawing.drawingNumber} / ${r.drawing.revision}` : '—'}
      </span>
    ),
  },
  { key: 'name', header: 'Naziv', render: (r) => r.drawing?.name || '—' },
  {
    key: 'draft',
    header: 'Nacrt',
    render: (r) => (
      <span className="tnums text-ink-secondary">{r.draftContext?.draftNumber ?? '—'}</span>
    ),
  },
  {
    // Predmet = broj predmeta po kome je crtež pušten (backend enrich).
    key: 'project',
    header: 'Predmet',
    render: (r) =>
      r.project ? (
        <span className="tnums text-ink">{r.project.projectNumber}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = handoverStatusMeta(r.statusId);
      return (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge tone={s.tone} label={s.label} />
          {/* HITNO (Paket A t.10) — uz status, ne umesto njega (DESIGN_SYSTEM §7). */}
          {r.isUrgent && <UrgentBadge />}
          {r.isLocked && <StatusBadge tone="warn" label="Zaključana" />}
          {r.isLegacy && <LegacyBadge />}
        </span>
      );
    },
  },
  {
    key: 'handoverDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.handoverDate)}</span>,
  },
  {
    // Rok izrade unet pri odobravanju (P4 §6.5.1) — null za redove bez roka.
    key: 'deadline',
    header: 'Rok',
    render: (r) =>
      r.productionDeadline ? (
        <span className="text-ink-secondary">{formatDate(r.productionDeadline)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'technologist',
    header: 'Tehnolog',
    render: (r) => <span className="text-ink-secondary">{r.technologist?.fullName ?? '—'}</span>,
  },
  {
    key: 'workOrder',
    header: 'RN',
    render: (r) =>
      r.workOrder ? (
        <span className="tnums font-semibold text-ink">{r.workOrder.identNumber}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
];

/** Tab "Sve primopredaje" — lista + filter po statusu (§6.4), expand = isti detalj/dugmad kao "Na čekanju". */
export function AllHandoversTab() {
  const [q, setQ] = useState('');
  const [statusId, setStatusId] = useState<number | ''>('');
  const [technologistId, setTechnologistId] = useState<number | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const technologists = useTechnologists();
  const list = useHandovers({
    page,
    drawingNumber: q.trim() || undefined,
    statusId,
    technologistId,
    from: from || undefined,
    to: to || undefined,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || statusId !== '' || technologistId !== '' || from || to);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Broj crteža…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Status
          <NativeSelect
            value={statusId}
            onChange={(e) => {
              setStatusId(e.target.value === '' ? '' : Number(e.target.value));
              resetPage();
            }}
          >
            <option value="">Svi</option>
            {HANDOVER_STATUS_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Za tehnologa
          <NativeSelect
            value={technologistId}
            onChange={(e) => {
              setTechnologistId(e.target.value === '' ? '' : Number(e.target.value));
              resetPage();
            }}
          >
            <option value="">Svi</option>
            {(technologists.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName ?? t.username}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Od datuma
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
          do
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
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setStatusId('');
              setTechnologistId('');
              setFrom('');
              setTo('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        {meta && (
          <span className="ml-auto text-sm text-ink-secondary">
            {formatNumber(meta.total)} zapisa
          </span>
        )}
      </div>

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <HandoverDetailPanel handover={r} />}
        empty={
          <EmptyState
            title="Nema primopredaja"
            hint="Promeni filtere ili proveri da su nacrti predati u primopredaju. Legacy istorija primopredaja stiže finalnim jednokratnim uvozom iz QBigTehn-a."
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
  );
}
