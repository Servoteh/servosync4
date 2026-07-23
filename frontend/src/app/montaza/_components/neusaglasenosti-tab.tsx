'use client';

import { useEffect, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  NC_SEVERITY_LABEL,
  NC_STATUS_LABEL,
  ncSeverityTone,
  ncStatusTone,
  useNonconformities,
  type NcSeverity,
  type NcStatus,
  type Nonconformity,
} from '@/api/montaza-neusaglasenosti';
import { PrijavaNeusaglasenostiDialog } from './prijava-neusaglasenosti-dialog';
import { NeusaglasenostDetaljDialog } from './neusaglasenost-detalj-dialog';

/** Statusni segmenti (Sve + tri statusa). */
const STATUS_SEGMENTS: { key: NcStatus | ''; label: string }[] = [
  { key: '', label: 'Sve' },
  { key: 'CEKA_ANALIZU', label: NC_STATUS_LABEL.CEKA_ANALIZU },
  { key: 'U_TOKU', label: NC_STATUS_LABEL.U_TOKU },
  { key: 'ZAVRSENO', label: NC_STATUS_LABEL.ZAVRSENO },
];

const SEVERITY_OPTIONS = [
  { value: '', label: 'Sve ozbiljnosti' },
  { value: 'MALA', label: NC_SEVERITY_LABEL.MALA },
  { value: 'SREDNJA', label: NC_SEVERITY_LABEL.SREDNJA },
  { value: 'VISOKA', label: NC_SEVERITY_LABEL.VISOKA },
];

/**
 * Tab „Neusaglašenosti" u modulu Montaža (zahtev 004/26). Lista sa filterima
 * (status/ozbiljnost/pretraga) + prijava (dijalog) + detalj (dijalog). Prijavljuju svi
 * sa pristupom Montaži (montaza.neusaglasenosti.write); istragu/status vode manage role.
 */
export function NeusaglasenostiTab({ initialOpenId }: { initialOpenId?: number | null } = {}) {
  const { can } = useAuth();
  const canWrite = can(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE);

  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<NcStatus | ''>('');
  const [severity, setSeverity] = useState<NcSeverity | ''>('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(initialOpenId ?? null);
  const [prijavaOpen, setPrijavaOpen] = useState(false);

  // Debounce pretrage (300ms), reset na prvu stranu.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const list = useNonconformities({ q: q || undefined, status, severity, page });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  const cols: Column<Nonconformity>[] = [
    {
      key: 'broj',
      header: 'Broj',
      render: (r) => <span className="tnums font-medium">{r.reportNumber}</span>,
    },
    {
      key: 'predmet',
      header: 'Predmet',
      render: (r) => <span className="tnums text-ink-secondary">{r.projectNumber ?? '—'}</span>,
    },
    {
      key: 'opis',
      header: 'Opis',
      render: (r) => (
        <span className="block max-w-[22rem] truncate text-ink">{r.description}</span>
      ),
    },
    {
      key: 'ozbiljnost',
      header: 'Ozbiljnost',
      render: (r) => (
        <StatusBadge tone={ncSeverityTone(r.severity)} label={NC_SEVERITY_LABEL[r.severity]} />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge tone={ncStatusTone(r.status)} label={NC_STATUS_LABEL[r.status]} />,
    },
    {
      key: 'datum',
      header: 'Datum',
      render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.createdAt)}</span>,
    },
    {
      key: 'podnosilac',
      header: 'Podnosilac',
      render: (r) => <span className="text-ink-secondary">{r.reportedBy.fullName ?? '—'}</span>,
    },
  ];

  const emptyNode = list.isError ? (
    <EmptyState
      title="Greška pri učitavanju"
      hint="Podaci trenutno nisu dostupni. Osvežite stranicu ili pokušajte ponovo."
    />
  ) : (
    <EmptyState
      title="Nema neusaglašenosti"
      hint={
        <>
          Nijedna neusaglašenost ne odgovara filterima.
          {canWrite && (
            <span className="mt-3 block">
              <Button onClick={() => setPrijavaOpen(true)}>Prijavi neusaglašenost</Button>
            </span>
          )}
        </>
      }
    />
  );

  return (
    <div className="space-y-3">
      {/* Pretraga + primarna akcija */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Opis, predmet, RN, odeljenje…"
        />
        {canWrite && (
          <Button className="ml-auto" onClick={() => setPrijavaOpen(true)}>
            + Prijavi neusaglašenost
          </Button>
        )}
      </div>

      {/* Statusni segmenti + ozbiljnost */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {STATUS_SEGMENTS.map((s) => (
            <button
              key={s.key || 'sve'}
              type="button"
              onClick={() => {
                setStatus(s.key);
                setPage(1);
              }}
              className={
                status === s.key
                  ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="w-48">
          <Select
            options={SEVERITY_OPTIONS}
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value as NcSeverity | '');
              setPage(1);
            }}
          />
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        empty={emptyNode}
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}

      {prijavaOpen && (
        <PrijavaNeusaglasenostiDialog
          onClose={() => setPrijavaOpen(false)}
          onCreated={(id) => setOpenId(id)}
        />
      )}
      {openId != null && (
        <NeusaglasenostDetaljDialog id={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  );
}
