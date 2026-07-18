'use client';

// Tab „Na pisanju" (Paket A t.9, Miljanov feedback) — primopredaje na pisanju
// tehnologije: status SAGLASAN + dodeljen tehnolog, nelansirane. Gore brojači
// iz GET /v1/handovers/writing-stats (ukupno · po tehnologu · po predmetu);
// ispod read-only lista (isti obrazac kao tab „Odobrene": GET
// /v1/handovers?statusId=1, server-side paginacija) sa filterima tehnolog +
// pretraga po broju crteža + predmet. Klik na red otvara postojeći detalj
// (HandoverDetailPanel) — workflow dugmad tamo ionako gate-uje permisija/status.

import { useState } from 'react';
import {
  HANDOVER_STATUS,
  useHandovers,
  useHandoverWritingStats,
  useTechnologists,
  type Handover,
  type WritingStatsProject,
} from '@/api/handovers';
import { useProjectsLookup, type ProjectLookup } from '@/api/lookups';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate, formatNumber } from '@/lib/format';
import { LegacyBadge, NativeSelect, UrgentBadge, errorBox } from './common';
import { HandoverDetailPanel } from './handover-detail';

// ─────────────────────────────────────────────────────────────── brojači

/** Kompaktan čip „labela · broj" za brojače (po tehnologu / po predmetu). */
function CountChip({ label, count }: { label: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs text-ink">
      <span className="truncate">{label}</span>
      <span className="tnums font-semibold">{formatNumber(count)}</span>
    </span>
  );
}

function projectChipLabel(p: WritingStatsProject): string {
  if (p.code && p.name) return `${p.code} — ${p.name}`;
  return p.code || p.name || 'Bez predmeta';
}

/**
 * Brojači „na pisanju" — DEFANZIVNO: endpoint je nov, pa se na 404/grešku (i
 * dok se učitava) cela sekcija TIHO sakriva, bez poruke (zadatak t.9).
 */
function WritingStatsBar() {
  const statsQuery = useHandoverWritingStats();
  const stats = statsQuery.data?.data;
  if (statsQuery.error || !stats) return null;

  return (
    <div className="space-y-2 rounded-panel border border-line bg-surface px-4 py-3">
      <p className="text-sm text-ink">
        Na pisanju tehnologije:{' '}
        <span className="tnums font-semibold">{formatNumber(stats.total)}</span>
      </p>
      {stats.byTechnologist.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">
            Po tehnologu
          </span>
          {stats.byTechnologist.map((t) => (
            <CountChip key={t.workerId} label={t.fullName ?? `#${t.workerId}`} count={t.count} />
          ))}
        </div>
      )}
      {stats.byProject.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">
            Po predmetu
          </span>
          {stats.byProject.map((p, i) => (
            <CountChip key={p.projectId ?? `none-${i}`} label={projectChipLabel(p)} count={p.count} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── lista

const columns: Column<Handover>[] = [
  {
    key: 'drawing',
    header: 'Crtež',
    // Tab nema kolonu Status (sve je SAGLASAN) — HITNO/Legacy bedž uz broj crteža.
    render: (r) => (
      <span className="inline-flex items-center gap-1.5">
        <span className="tnums font-semibold text-ink">
          {r.drawing ? `${r.drawing.drawingNumber} / ${r.drawing.revision}` : '—'}
        </span>
        {r.isUrgent && <UrgentBadge />}
        {r.isLegacy && <LegacyBadge />}
      </span>
    ),
  },
  { key: 'name', header: 'Naziv', render: (r) => r.drawing?.name || '—' },
  {
    key: 'quantity',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => (r.draftContext ? formatNumber(r.draftContext.quantityToProduce) : '—'),
  },
  {
    key: 'handoverDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.handoverDate)}</span>,
  },
  {
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

/**
 * Tab „Na pisanju" — read-only pregled (bez workflow dugmadi u koloni akcija;
 * expand detalj ih po statusu/permisiji svakako gate-uje). Lista koristi isti
 * endpoint/filter kao tab „Odobrene" (statusId=1 SAGLASAN — lansirane time
 * ispadaju); server-side filter „samo sa dodeljenim tehnologom" ne postoji,
 * pa ukupan broj u tabeli može biti ≥ brojača (legacy redovi bez tehnologa).
 */
export function WritingTab() {
  const [q, setQ] = useState('');
  const [technologistId, setTechnologistId] = useState<number | ''>('');
  const [project, setProject] = useState<ProjectLookup | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const technologists = useTechnologists();
  const list = useHandovers({
    page,
    statusId: HANDOVER_STATUS.APPROVED,
    drawingNumber: q.trim() || undefined,
    technologistId,
    projectId: project?.id ?? '',
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || technologistId !== '' || project);

  return (
    <div className="space-y-4">
      <WritingStatsBar />

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
          Tehnolog
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
        <div className="flex w-56 flex-col gap-1 text-xs text-ink-secondary">
          Predmet
          <ComboBox<ProjectLookup>
            value={project}
            onChange={(p) => {
              setProject(p);
              resetPage();
            }}
            useSearch={useProjectsLookup}
            getKey={(p) => p.id}
            getLabel={(p) => p.projectNumber}
            getSublabel={(p) => p.projectName ?? ''}
            placeholder="Svi predmeti…"
          />
        </div>
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setTechnologistId('');
              setProject(null);
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        {meta && (
          <span className="ml-auto text-sm text-ink-secondary">
            {formatNumber(meta.total)} na pisanju
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
            title="Nema primopredaja na pisanju"
            hint="Odobri primopredaju u tabu „Na čekanju” — dodeljeni tehnolog je onda vidi ovde dok piše tehnologiju."
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
