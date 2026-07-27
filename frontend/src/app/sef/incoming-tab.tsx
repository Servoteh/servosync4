'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Textarea } from '@/components/ui-kit/textarea';
import { FormField } from '@/components/ui-kit/form-field';
import { formatDate, formatDecimal } from '@/lib/format';
import { ApiError } from '@/api/client';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useSefIncoming,
  usePullIncoming,
  useAcceptIncoming,
  useRejectIncoming,
  useSefIncomingPdf,
  openPdf,
  canDecideIncoming,
  SEF_INCOMING_STATUS,
  type SefIncoming,
  type SefIncomingStatus,
} from '@/api/sef';
import { StatusTimelineDialog } from './status-timeline';

/**
 * SEF ulazne (dobavljačke) e-fakture — Talas 1E stavka E1 (odluka O3). Sekcija na
 * /sef stranici pored postojećeg izlaznog outbox-a. Obrazac „Lista" (DESIGN_SYSTEM
 * §4.1): filter (status) + gusta tabela sa akcijama po redu + „Preuzmi sa SEF-a"
 * (pull). Data isključivo kroz `@/api/sef` hook-ove; sve od kit komponenti i tokena.
 *
 * STATUSI (kanonska mapa §7): NEW=info, SEEN=neutral, ACCEPTED=success, REJECTED=danger.
 * ROK (daysLeft do zakonskog 15-dnevnog roka): danger ≤3 dana / istekao, warn ≤7,
 * neutral inače — samo za neodlučene (NEW/SEEN).
 *
 * AKCIJE (guard-uslovljene, samo NEW/SEEN): „Prihvati" (SEF_SEND, confirm), „Odbij"
 * (SEF_CANCEL, dijalog sa obaveznim razlogom). „Preuzmi sa SEF-a" (SEF_READ, sinhro).
 * Backend presuđuje; ovde se afordanse samo kriju/gase.
 *
 * DEDUP: kolona „Već postoji" (alreadyExists) upozorava da je faktura već u KUF
 * evidenciji (BigBit paritet) — spečava dvostruko knjiženje.
 */

/** SEF ulazni status → { tone, label } (kanonska mapa §7). */
function statusMeta(status: SefIncomingStatus): { tone: Tone; label: string } {
  switch (status) {
    case SEF_INCOMING_STATUS.NEW:
      return { tone: 'info', label: 'Novo' };
    case SEF_INCOMING_STATUS.SEEN:
      return { tone: 'neutral', label: 'Pregledano' };
    case SEF_INCOMING_STATUS.ACCEPTED:
      return { tone: 'success', label: 'Prihvaćeno' };
    case SEF_INCOMING_STATUS.REJECTED:
      return { tone: 'danger', label: 'Odbijeno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const STATUS_OPTIONS: { value: SefIncomingStatus; label: string }[] = [
  { value: SEF_INCOMING_STATUS.NEW, label: 'Novo' },
  { value: SEF_INCOMING_STATUS.SEEN, label: 'Pregledano' },
  { value: SEF_INCOMING_STATUS.ACCEPTED, label: 'Prihvaćeno' },
  { value: SEF_INCOMING_STATUS.REJECTED, label: 'Odbijeno' },
];

/** Preostalo dana do roka → { tone, label } (danger ≤3/istekao, warn ≤7, inače neutral). */
function deadlineMeta(daysLeft: number | null): { tone: Tone; label: string } {
  if (daysLeft == null) return { tone: 'neutral', label: '—' };
  if (daysLeft < 0) return { tone: 'danger', label: 'Istekao' };
  if (daysLeft <= 3) return { tone: 'danger', label: daysLabel(daysLeft) };
  if (daysLeft <= 7) return { tone: 'warn', label: daysLabel(daysLeft) };
  return { tone: 'neutral', label: daysLabel(daysLeft) };
}

function daysLabel(d: number): string {
  if (d === 0) return 'Danas';
  if (d === 1) return '1 dan';
  return `${d} dana`;
}

function existsTitle(r: SefIncoming): string {
  return r.matchedKufEntryId != null
    ? `Faktura je već u KUF evidenciji (KUF stavka #${r.matchedKufEntryId}).`
    : 'Faktura je već u KUF evidenciji.';
}

type NoticeTone = 'danger' | 'success' | 'info';

function noticeClasses(tone: NoticeTone): string {
  switch (tone) {
    case 'danger':
      return 'border-status-danger/40 bg-status-danger-bg text-status-danger';
    case 'success':
      return 'border-status-success/40 bg-status-success-bg text-status-success';
    default:
      return 'border-status-info/40 bg-status-info-bg text-status-info';
  }
}

export function IncomingTab() {
  const { can } = useAuth();

  const [statusFilter, setStatusFilter] = useState<SefIncomingStatus | ''>('');
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string } | null>(null);
  /** id reda čija je akcija u toku — da se gasi samo taj red. */
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectRow, setRejectRow] = useState<SefIncoming | null>(null);
  /** ulazna faktura čija se status-istorija (timeline) trenutno prikazuje. */
  const [timelineRow, setTimelineRow] = useState<SefIncoming | null>(null);

  const canPull = can(PERMISSIONS.SEF_READ);
  const canAccept = can(PERMISSIONS.SEF_SEND);
  const canReject = can(PERMISSIONS.SEF_CANCEL);

  const list = useSefIncoming({ status: statusFilter });
  const rows = list.data?.data ?? [];

  const pull = usePullIncoming();
  const accept = useAcceptIncoming();
  const reject = useRejectIncoming();
  // Štampa ulazne e-fakture — čitljiv prikaz UBL-a (dokument koji ide u KUF dosije).
  const incomingPdf = useSefIncomingPdf();

  async function runPrint(row: SefIncoming): Promise<void> {
    setNotice(null);
    setBusyId(row.id);
    try {
      openPdf(await incomingPdf.mutateAsync(row.id));
    } catch (e) {
      setNotice({
        tone: 'danger',
        text: e instanceof ApiError ? e.message : 'Štampa nije uspela — pokušaj ponovo.',
      });
    } finally {
      setBusyId(null);
    }
  }

  async function runPull(): Promise<void> {
    setNotice(null);
    try {
      const res = await pull.mutateAsync();
      const { dryRun, totalIds, created, skipped, note } = res.data;
      if (dryRun) {
        setNotice({
          tone: 'info',
          text: note ?? 'DRY-RUN: probni prolaz — ništa nije preuzeto sa SEF-a.',
        });
      } else if (created === 0) {
        setNotice({
          tone: 'info',
          text:
            totalIds === 0
              ? 'Nema ulaznih faktura na SEF-u.'
              : `Nema novih ulaznih faktura (ukupno na SEF-u: ${totalIds}, sve već preuzeto).`,
        });
      } else {
        setNotice({
          tone: 'success',
          text: `Preuzeto novih: ${created} (ukupno na SEF-u: ${totalIds}, preskočeno ${skipped}).`,
        });
      }
    } catch (e) {
      setNotice({
        tone: 'danger',
        text: e instanceof ApiError ? e.message : 'Preuzimanje nije uspelo — pokušaj ponovo.',
      });
    }
  }

  async function runAccept(row: SefIncoming): Promise<void> {
    const warn = row.alreadyExists
      ? '\n\nUPOZORENJE: ova faktura je već u KUF evidenciji.'
      : '';
    const ok = window.confirm(
      `Prihvatiti fakturu ${row.invoiceNumber} (${row.supplierName})?${warn}`,
    );
    if (!ok) return;
    setNotice(null);
    setBusyId(row.id);
    try {
      await accept.mutateAsync(row.id);
      setNotice({ tone: 'success', text: `Faktura ${row.invoiceNumber} je prihvaćena.` });
    } catch (e) {
      setNotice({
        tone: 'danger',
        text: e instanceof ApiError ? e.message : 'Prihvatanje nije uspelo — pokušaj ponovo.',
      });
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject(comment: string): Promise<void> {
    if (!rejectRow) return;
    const row = rejectRow;
    setNotice(null);
    setBusyId(row.id);
    try {
      await reject.mutateAsync({ id: row.id, comment });
      setNotice({ tone: 'success', text: `Faktura ${row.invoiceNumber} je odbijena.` });
      setRejectRow(null);
    } catch (e) {
      setNotice({
        tone: 'danger',
        text: e instanceof ApiError ? e.message : 'Odbijanje nije uspelo — pokušaj ponovo.',
      });
    } finally {
      setBusyId(null);
    }
  }

  function renderDeadline(r: SefIncoming) {
    if (r.acceptDeadline == null && r.daysLeft == null) {
      return <span className="text-ink-disabled">—</span>;
    }
    // Terminalni statusi (ACCEPTED/REJECTED): samo datum roka, bez alarma.
    if (!canDecideIncoming(r.status)) {
      return <span className="text-ink-secondary">{formatDate(r.acceptDeadline)}</span>;
    }
    const m = deadlineMeta(r.daysLeft);
    return (
      <div className="flex flex-col items-start gap-0.5">
        <StatusBadge tone={m.tone} label={m.label} />
        {r.acceptDeadline && (
          <span className="text-2xs text-ink-disabled">{formatDate(r.acceptDeadline)}</span>
        )}
      </div>
    );
  }

  const columns: Column<SefIncoming>[] = [
    {
      key: 'supplier',
      header: 'Dobavljač',
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.supplierName}</div>
          <div className="tnums text-2xs text-ink-secondary">PIB {r.supplierPib}</div>
        </div>
      ),
    },
    {
      key: 'invoiceNumber',
      header: 'Broj',
      render: (r) => <span className="tnums font-semibold text-ink">{r.invoiceNumber}</span>,
    },
    {
      key: 'issueDate',
      header: 'Datum',
      render: (r) => <span className="text-ink-secondary">{formatDate(r.issueDate)}</span>,
    },
    {
      key: 'totalAmount',
      header: 'Iznos',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums font-semibold text-ink">
          {formatDecimal(r.totalAmount)}{' '}
          <span className="text-2xs font-normal text-ink-secondary">{r.currency}</span>
        </span>
      ),
    },
    {
      key: 'vatAmount',
      header: 'PDV',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.vatAmount)}</span>,
    },
    {
      key: 'deadline',
      header: 'Rok',
      render: (r) => renderDeadline(r),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = statusMeta(r.status);
        const title =
          r.status === SEF_INCOMING_STATUS.REJECTED && r.rejectComment
            ? r.rejectComment
            : undefined;
        return (
          <span title={title}>
            <StatusBadge tone={s.tone} label={s.label} />
          </span>
        );
      },
    },
    {
      key: 'exists',
      header: 'Već postoji',
      render: (r) =>
        r.alreadyExists ? (
          <span
            className="inline-flex items-center gap-1 text-status-warn"
            title={existsTitle(r)}
          >
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <span className="text-2xs">u KUF</span>
          </span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Akcije',
      align: 'right',
      render: (r) => {
        const busy = busyId === r.id;
        const decidable = canDecideIncoming(r.status);
        return (
          <div className="flex items-center justify-end gap-2">
            {decidable && canAccept && (
              <Button
                variant="secondary"
                loading={busy && accept.isPending}
                disabled={busy}
                onClick={() => runAccept(r)}
                title="Prihvati fakturu (odgovor SEF-u)"
              >
                Prihvati
              </Button>
            )}
            {decidable && canReject && (
              <Button
                variant="danger"
                loading={busy && reject.isPending}
                disabled={busy}
                onClick={() => setRejectRow(r)}
                title="Odbij fakturu (obavezan razlog)"
              >
                Odbij
              </Button>
            )}
            <Button
              variant="ghost"
              loading={busy && incomingPdf.isPending}
              disabled={busy}
              onClick={() => void runPrint(r)}
              title="Štampa ulazne e-fakture (čitljiv prikaz UBL-a sa SEF-a)"
            >
              Štampa
            </Button>
            <Button
              variant="ghost"
              onClick={() => setTimelineRow(r)}
              title="Prikaži istoriju statusa"
            >
              Istorija
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Status
          <div className="w-48">
            <Select
              placeholder="Svi"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as SefIncomingStatus | '')}
              options={STATUS_OPTIONS}
            />
          </div>
        </label>

        {statusFilter !== '' && (
          <button
            onClick={() => setStatusFilter('')}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}

        {canPull && (
          <div className="ml-auto self-end">
            <Button onClick={runPull} loading={pull.isPending} title="Sinhronizuj ulazne fakture sa SEF-a">
              Preuzmi sa SEF-a
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <div className={`rounded-panel border px-4 py-3 text-sm ${noticeClasses(notice.tone)}`}>
          {notice.text}
        </div>
      )}

      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
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
            title="Nema ulaznih faktura"
            hint={
              canPull
                ? 'Klikni Preuzmi sa SEF-a da povučeš nove dobavljačke fakture.'
                : 'Ulazne fakture se preuzimaju sa SEF-a.'
            }
          />
        }
      />

      {rejectRow && (
        <RejectDialog
          row={rejectRow}
          saving={reject.isPending}
          onClose={() => setRejectRow(null)}
          onSubmit={submitReject}
        />
      )}

      {timelineRow && (
        <StatusTimelineDialog
          title={`SEF istorija — ${timelineRow.invoiceNumber}`}
          incomingId={timelineRow.id}
          onClose={() => setTimelineRow(null)}
        />
      )}
    </div>
  );
}

/**
 * Dijalog odbijanja ulazne fakture — razlog je OBAVEZAN (vidljiv dobavljaču na
 * SEF-u). `dismissable={false}`: zatvara se samo eksplicitno (Otkaži / X) da se unos
 * ne izgubi. Submit onemogućen dok razlog nije unet.
 */
function RejectDialog({
  row,
  saving,
  onClose,
  onSubmit,
}: {
  row: SefIncoming;
  saving: boolean;
  onClose: () => void;
  onSubmit: (comment: string) => void;
}) {
  const [comment, setComment] = useState('');
  const trimmed = comment.trim();
  const canSubmit = trimmed.length > 0;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Odbijanje fakture ${row.invoiceNumber}`}
      dismissable={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button
            variant="danger"
            loading={saving}
            disabled={!canSubmit}
            onClick={() => {
              if (canSubmit) onSubmit(trimmed);
            }}
          >
            Odbij fakturu
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Dobavljač: <span className="text-ink">{row.supplierName}</span> · PIB {row.supplierPib}
        </p>
        <FormField label="Razlog odbijanja" required>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            autoFocus
            placeholder="Obrazloži zašto se faktura odbija (vidljivo dobavljaču na SEF-u)."
          />
        </FormField>
      </div>
    </Dialog>
  );
}
