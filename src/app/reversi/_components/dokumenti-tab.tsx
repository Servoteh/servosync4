'use client';

import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { downloadCsv } from '@/lib/reversi-csv';
import {
  fetchAllReversiDocuments,
  useReversiDocument,
  useReversiDocuments,
  useReversiKpis,
  type ReversiDocument,
  type ReversiDocumentsParams,
  type ReversiKpiContext,
} from '@/api/reversi';
import { DOC_TYPE_LABEL, DocStatusBadge, LineStatusBadge } from './common';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { IssueDialog } from './issue-dialog';
import { ReturnDialog } from './return-dialog';
import { SignaturePdfActions } from './signature-pdf-actions';

const PAGE_SIZE = 50;
const ISSUED_MONTH_KEY = 'reversi:issued-month'; // paritet 1.0 REVERSI_ISSUED_MONTH

const SELECT =
  'rounded-control border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent';
const INPUT =
  'rounded-control border border-line bg-surface-2 px-2 py-1 text-sm text-ink outline-none focus:border-accent';
const ACT = 'rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink';

/** Segment statusa (RB-20) → UI ključ; mapiranje na parametre upita u `statusParams`. */
const STATUS_SEGMENTS = [
  { key: 'sve', label: 'Sve' },
  { key: 'aktivno', label: 'U toku' },
  { key: 'prekoraceno', label: 'Rok istekao' },
  { key: 'vraceno', label: 'Završeno' },
  { key: 'otkazano', label: 'Otkazano' },
] as const;
type UiStatus = (typeof STATUS_SEGMENTS)[number]['key'];

/** CSV labela statusa (RB-25 — paritet 1.0 docStatusLabels). */
const CSV_STATUS_LABEL: Record<string, string> = {
  OPEN: 'Aktivno',
  PARTIALLY_RETURNED: 'Delimično vraćeno',
  RETURNED: 'Vraćeno',
  CANCELLED: 'Otkazano',
};

/** UI status → parametri upita (prednost overdue > statuses > status, paritet 1.0). */
function statusParams(ui: UiStatus): Pick<ReversiDocumentsParams, 'status' | 'statuses' | 'overdue'> {
  switch (ui) {
    case 'aktivno':
      return { statuses: 'OPEN,PARTIALLY_RETURNED' };
    case 'vraceno':
      return { status: 'RETURNED' };
    case 'prekoraceno':
      return { overdue: true };
    case 'otkazano':
      return { status: 'CANCELLED' };
    default:
      return { status: 'ALL' };
  }
}

/** Mesec (YYYY-MM) → UTC opseg `issued_at` (RB-19, paritet 1.0 issuedRangeFromMonth). */
function issuedRangeFromMonth(ym: string): { issuedFrom?: string; issuedTo?: string } {
  if (!/^\d{4}-\d{2}$/.test(ym)) return {};
  const [ys, ms] = ym.split('-');
  const y = Number(ys);
  const mo = Number(ms);
  if (!y || !mo || mo > 12) return {};
  const start = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));
  return { issuedFrom: start.toISOString(), issuedTo: end.toISOString() };
}

function recipientLabel(d: ReversiDocument): string {
  if (d.recipientType === 'EMPLOYEE') return d.recipientEmployeeName ?? '—';
  if (d.recipientType === 'DEPARTMENT') return d.recipientDepartment ?? '—';
  return d.recipientCompanyName ?? '—';
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Prekoračen rok = aktivan revers (OPEN/PARTIALLY) sa `expected_return_date < danas` (RB-22). */
function isOverdue(d: { status: string; expectedReturnDate: string | null }): boolean {
  if (!d.expectedReturnDate) return false;
  if (d.status !== 'OPEN' && d.status !== 'PARTIALLY_RETURNED') return false;
  return d.expectedReturnDate.slice(0, 10) < todayIso();
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'warn';
}) {
  const valueCls = tone === 'success' ? 'text-status-success' : tone === 'warn' ? 'text-status-warn' : 'text-ink';
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className={`tnums mt-1 text-2xl font-semibold ${valueCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-ink-secondary">{hint}</div>}
    </div>
  );
}

/**
 * Detalji dokumenta (RB-49) u proširenom redu: zaglavlje (Primalac · Mašina · Izdato
 * · Rok · Status) + stavke sa Pribor/napomena + „Vrati…" + potpisnica PDF. Fetch se
 * dešava tek kad je red proširen (renderExpanded se zove samo za otvoren red).
 */
function DocDetail({
  id,
  manage,
  onReturn,
}: {
  id: string;
  manage: boolean;
  onReturn: (docId: string) => void;
}) {
  const detail = useReversiDocument(id);
  if (detail.isLoading) return <div className="p-1 text-sm text-ink-secondary">Učitavanje stavki…</div>;
  const doc = detail.data?.data;
  if (!doc) return <div className="p-1 text-sm text-ink-secondary">Detalji nisu dostupni.</div>;
  const overdue = isOverdue(doc);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-secondary">
        <span>
          <strong className="text-ink">Primalac:</strong> {recipientLabel(doc)}
        </span>
        {doc.recipientMachineCode && (
          <span>
            <strong className="text-ink">Mašina:</strong> <span className="tnums">{doc.recipientMachineCode}</span>
          </span>
        )}
        <span>
          <strong className="text-ink">Izdato:</strong> {formatDate(doc.issuedAt)}
        </span>
        <span className={overdue ? 'text-status-danger' : undefined}>
          <strong className={overdue ? 'text-status-danger' : 'text-ink'}>Rok:</strong>{' '}
          {formatDate(doc.expectedReturnDate)}
          {overdue && ' !'}
        </span>
        <span className="inline-flex items-center gap-1">
          <strong className="text-ink">Status:</strong> <DocStatusBadge status={doc.status} />
        </span>
      </div>

      {doc.napomena && <div className="text-xs text-ink-secondary">Napomena: {doc.napomena}</div>}

      <div className="space-y-1">
        {doc.lines.map((l) => (
          <div key={l.id} className="flex items-start gap-3 text-sm">
            <span className="min-w-28 font-medium">{l.tool?.oznaka ?? l.drawingNo ?? '—'}</span>
            <div className="flex-1">
              <div className="text-ink-secondary">{l.tool?.naziv ?? l.partName ?? ''}</div>
              {l.napomena && <div className="text-2xs text-ink-disabled">Pribor: {l.napomena}</div>}
            </div>
            <span className="tnums">
              {formatNumber(Number(l.returnedQuantity))}/{formatNumber(Number(l.quantity))} {l.unit}
            </span>
            <LineStatusBadge status={l.lineStatus} />
          </div>
        ))}
      </div>

      {manage &&
        doc.status !== 'RETURNED' &&
        doc.status !== 'CANCELLED' &&
        doc.lines.some((l) => l.lineStatus === 'ISSUED') && (
          <div className="pt-1">
            <Button variant="secondary" onClick={() => onReturn(doc.id)}>
              Vrati…
            </Button>
          </div>
        )}
      <SignaturePdfActions doc={doc} manage={manage} />
    </div>
  );
}

/**
 * Panel „Zaduženja" — lista revers dokumenata (paritet 1.0 `zaduzenjaPanel`).
 * Pokriva RB-15 (zaglavlje+akcije: CSV/Štampa/+Izdaj), RB-16 (5 KPI kartica),
 * RB-19 (filter meseca + „Svi", session-persist), RB-20 (statusni segmenti uklj.
 * „Rok istekao"/„Otkazano"), RB-21 (filter tipa), RB-22 (kolone Stavki/Rok „!"/
 * Akcije + isticanje prekoračenih), RB-25 (CSV izvoz), RB-26 (Štampa prikaza +
 * prazno stanje CTA), RB-49 (detalj sa zaglavljem+Mašinom+Pribor/napomena).
 */
export function DokumentiTab() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [uiStatus, setUiStatus] = useState<UiStatus>('sve');
  const [docType, setDocType] = useState('');
  const [issuedMonth, setIssuedMonth] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [returnDocId, setReturnDocId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // RB-19 — učitaj sačuvan mesec posle mount-a (bez hydration mismatch-a).
  useEffect(() => {
    try {
      const v = window.sessionStorage.getItem(ISSUED_MONTH_KEY);
      if (v) setIssuedMonth(v);
    } catch {
      /* sessionStorage nedostupan — mesec se prosto ne pamti */
    }
  }, []);

  // Debounce pretrage (300ms — paritet 1.0), reset na prvu stranu.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const range = issuedRangeFromMonth(issuedMonth);
  const ctx: ReversiKpiContext = {
    q: q || undefined,
    docType: docType || undefined,
    issuedFrom: range.issuedFrom,
    issuedTo: range.issuedTo,
  };

  const kpi = useReversiKpis(ctx);
  const docs = useReversiDocuments({ ...ctx, ...statusParams(uiStatus), page, pageSize: PAGE_SIZE });
  const meta = docs.data?.meta.pagination;
  const rows = docs.data?.data ?? [];

  function setMonth(v: string) {
    setIssuedMonth(v);
    setPage(1);
    try {
      window.sessionStorage.setItem(ISSUED_MONTH_KEY, v);
    } catch {
      /* nedostupan storage */
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await fetchAllReversiDocuments({ ...ctx, ...statusParams(uiStatus) });
      if (all.length === 0) {
        toast('Nema redova za izvoz');
        return;
      }
      downloadCsv(
        `reversi-dokumenti-${(issuedMonth || 'svi-meseci').replace(/-/g, '')}.csv`,
        ['Broj dokumenta', 'Datum izdavanja', 'Primalac', 'Stavki', 'Rok povraćaja', 'Status'],
        all.map((d) => [
          d.docNumber,
          formatDate(d.issuedAt),
          recipientLabel(d),
          d.lineCount,
          d.expectedReturnDate ? formatDate(d.expectedReturnDate) : '',
          CSV_STATUS_LABEL[d.status] ?? d.status,
        ]),
      );
      toast(`Izvezeno ${all.length} redova`);
    } catch {
      toast('Izvoz nije uspeo');
    } finally {
      setExporting(false);
    }
  }

  const cols: Column<ReversiDocument>[] = [
    { key: 'doc', header: 'Br. dokumenta', render: (r) => <span className="tnums font-medium">{r.docNumber}</span> },
    { key: 'type', header: 'Tip', render: (r) => DOC_TYPE_LABEL[r.docType] ?? r.docType },
    { key: 'recipient', header: 'Primalac', render: (r) => recipientLabel(r) },
    {
      key: 'lines',
      header: 'Stavki',
      align: 'right',
      render: (r) => (
        <span className="tnums inline-flex min-w-6 justify-center rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">
          {formatNumber(r.lineCount)}
        </span>
      ),
    },
    { key: 'issued', header: 'Datum izdavanja', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.issuedAt)}</span> },
    {
      key: 'due',
      header: 'Rok povraćaja',
      render: (r) => {
        const od = isOverdue(r);
        return (
          <span className={od ? 'tnums font-medium text-status-danger' : 'tnums text-ink-secondary'}>
            {formatDate(r.expectedReturnDate)}
            {od && (
              <span className="ml-1" title="Prekoračen rok" aria-label="Prekoračen rok">
                !
              </span>
            )}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', render: (r) => <DocStatusBadge status={r.status} /> },
    {
      key: 'akcije',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          className={ACT}
          title="Detalji dokumenta"
          onClick={(e) => {
            e.stopPropagation();
            setOpenId((cur) => (cur === r.id ? null : r.id));
          }}
        >
          <Eye className="h-4 w-4" aria-hidden />
        </button>
      ),
    },
  ];

  const emptyNode = docs.isError ? (
    <EmptyState
      title="Greška pri učitavanju"
      hint="Podaci trenutno nisu dostupni. Osveži stranicu ili pokušaj ponovo."
    />
  ) : (
    <EmptyState
      title="Nema reversa"
      hint={
        <>
          Nijedan dokument ne odgovara filterima. Pokušajte „Sve" ili drugu pretragu.
          {manage && (
            <span className="mt-3 block">
              <Button onClick={() => setIssueOpen(true)}>Kreiraj prvi dokument</Button>
            </span>
          )}
        </>
      }
    />
  );

  return (
    <div className="space-y-3">
      {/* RB-16 — 5 KPI stat kartica */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Aktivna zaduženja" value={formatNumber(kpi.nAkt)} hint="u radu" />
        <StatCard
          label="Prekoračen rok"
          value={formatNumber(kpi.nOver)}
          hint={kpi.nOver > 0 ? 'istekao rok' : 'nema'}
          tone={kpi.nOver > 0 ? 'warn' : undefined}
        />
        <StatCard label="Uspešno vraćeno" value={formatNumber(kpi.nRet)} hint="zatvoreno" tone="success" />
        <StatCard label="Otkazano" value={formatNumber(kpi.nCan)} hint="poništeno" />
        <StatCard
          label="Primaoci (aktivno)"
          value={`${formatNumber(kpi.nRecip)}${kpi.nRecipTrunc ? '+' : ''}`}
          hint={kpi.nRecipTrunc ? 'uzorak' : 'aktivno'}
        />
      </div>

      {/* RB-15 — pretraga + akcije (CSV / Štampa prikaza / +Izdaj) */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Broj reversa, radnik, odeljenje, firma…"
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" loading={exporting} onClick={() => void exportCsv()}>
            CSV
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            Štampa prikaza
          </Button>
          {manage && <Button onClick={() => setIssueOpen(true)}>+ Izdaj</Button>}
        </div>
      </div>

      {/* RB-19/20/21 — mesec + statusni segmenti + tip dokumenta */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <span className="text-2xs uppercase tracking-wider text-ink-secondary">Mesec</span>
          <input
            type="month"
            className={INPUT}
            value={issuedMonth}
            title="Filter meseca izdavanja"
            onChange={(e) => setMonth(e.target.value)}
          />
          <button
            type="button"
            className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
            title="Prikaži sve mesece"
            onClick={() => setMonth('')}
          >
            Svi
          </button>
        </div>
        <div className="flex gap-1">
          {STATUS_SEGMENTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setUiStatus(s.key);
                setPage(1);
              }}
              className={
                uiStatus === s.key
                  ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <select
          className={SELECT}
          value={docType}
          title="Tip dokumenta"
          onChange={(e) => {
            setDocType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Svi tipovi</option>
          <option value="TOOL">Revers alata</option>
          <option value="COOPERATION_GOODS">Kooperaciona roba</option>
        </select>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={docs.isLoading}
        rowClassName={(r) => (isOverdue(r) ? 'bg-status-danger-bg' : undefined)}
        onRowActivate={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
        expandedKey={openId}
        renderExpanded={(r) => <DocDetail id={r.id} manage={manage} onReturn={setReturnDocId} />}
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

      {manage && <IssueDialog open={issueOpen} onClose={() => setIssueOpen(false)} />}
      {manage && <ReturnDialog docId={returnDocId} onClose={() => setReturnDocId(null)} />}
    </div>
  );
}
