'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useInvoice,
  useInvoicePdf,
  openPdf,
  useCreateInvoiceFromProforma,
  usePostInvoice,
  SALES_STATUS,
  SALES_DOCUMENT_TYPE,
  type InvoiceDetail,
  type InvoiceItem,
} from '@/api/sales';
import {
  useEnqueue,
  useSefOutboxForInvoice,
  SEF_STATUS,
  type SefStatus,
} from '@/api/sef';
import { salesStatusMeta, DOCUMENT_TYPE_LABEL } from '../page';

/**
 * Fakturisanje — detalj računa (DESIGN_SYSTEM §4 obrazac „Master–detalj"): zaglavlje
 * (label–vrednost) + tabela stavki sa cenama i PDV-om. Status-uslovljena dugmad:
 * „Napravi račun iz predračuna" (from-proforma; DRAFT predračun PON/PROF), „Knjiži"
 * (post; DRAFT račun) i „Pošalji na SEF" (enqueue; knjižena domaća faktura koja još
 * nije u SEF redu). Postojeći SEF status fakture (outbox) se prikazuje kao badge sa
 * skokom na /sef. Data isključivo kroz `@/api/sales` i `@/api/sef` hook-ove; sve od
 * kit komponenti i tokena.
 *
 * TASTATURA: Ctrl+S = primarna akcija tekućeg statusa (prepiši/knjiži), Esc = nazad.
 */

/** Draft predračun/ponuda (PON/PROF) → nudi prepis (carry-over) u level-0 račun. */
const PROFORMA_TYPES = new Set<string>([
  SALES_DOCUMENT_TYPE.PON,
  SALES_DOCUMENT_TYPE.PROF,
]);

/** Ciljne level-0 vrste za prepis predračuna → račun (backend carry-over). */
const TARGET_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: SALES_DOCUMENT_TYPE.IFR, label: 'Račun — roba (IFR)' },
  { value: SALES_DOCUMENT_TYPE.IFGP, label: 'Račun — gotov proizvod (IFGP)' },
  { value: SALES_DOCUMENT_TYPE.IFUSL, label: 'Račun — usluga (IFUSL)' },
  { value: SALES_DOCUMENT_TYPE.IZVRO, label: 'Izvoz — roba (IZVRO)' },
  { value: SALES_DOCUMENT_TYPE.IZVGP, label: 'Izvoz — gotov proizvod (IZVGP)' },
  { value: SALES_DOCUMENT_TYPE.IZVUS, label: 'Izvoz — usluga (IZVUS)' },
];

/** SEF outbox status → StatusBadge meta (kanonska mapa §7, SEF domen — 1:1 sa /sef). */
function sefStatusMeta(status: SefStatus): { tone: Tone; label: string } {
  switch (status) {
    case SEF_STATUS.PENDING:
      return { tone: 'warn', label: 'U redu' };
    case SEF_STATUS.SENT:
      return { tone: 'info', label: 'Poslato' };
    case SEF_STATUS.DELIVERED:
      return { tone: 'success', label: 'Isporučeno' };
    case SEF_STATUS.REJECTED:
      return { tone: 'danger', label: 'Odbijeno' };
    case SEF_STATUS.CANCELLED:
      return { tone: 'neutral', label: 'Stornirano' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** SEF statusi u kojima je faktura već „u toku" — ne nudi ponovni enqueue (izbegni duplikat). */
const IN_FLIGHT_SEF = new Set<SefStatus>([
  SEF_STATUS.PENDING,
  SEF_STATUS.SENT,
  SEF_STATUS.DELIVERED,
]);

const itemColumns: Column<InvoiceItem>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{it.lineNo}</span>,
  },
  {
    key: 'description',
    header: 'Artikal / opis',
    render: (it) => (
      <span className="text-ink">
        {it.description ?? (it.itemId != null ? `#${it.itemId}` : '—')}
      </span>
    ),
  },
  {
    key: 'quantity',
    header: 'Količina',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.quantity, 4)}</span>,
  },
  {
    key: 'unitPrice',
    header: 'Cena',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.unitPrice)}</span>,
  },
  {
    key: 'discountPercent',
    header: 'Rabat %',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{formatDecimal(it.discountPercent)}</span>,
  },
  {
    key: 'vatBase',
    header: 'Osnovica',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.vatBase)}</span>,
  },
  {
    key: 'vatAmount',
    header: 'PDV',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.vatAmount)}</span>,
  },
  {
    key: 'lineTotal',
    header: 'Ukupno',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums font-semibold text-ink">{formatDecimal(it.lineTotal)}</span>,
  },
];

export default function FakturisanjeDetailPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useInvoice(validId);
  const doc = query.data ?? null;
  const error = query.error as Error | null;
  const notFound =
    validId != null && !query.isLoading && !query.error && query.data == null;

  const fromProforma = useCreateInvoiceFromProforma();
  const post = usePostInvoice();
  const pdf = useInvoicePdf();
  const enqueue = useEnqueue();

  const canWrite = can(PERMISSIONS.SALES_WRITE);
  const canPost = can(PERMISSIONS.SALES_POST);
  const canSefSend = can(PERMISSIONS.SEF_SEND);
  const canSefRead = can(PERMISSIONS.SEF_READ);

  // Ciljna vrsta prepisa (predračun → račun). Default IFR (roba u zemlji).
  const [targetType, setTargetType] = useState<string>(SALES_DOCUMENT_TYPE.IFR);
  // SEF feedback (enqueue uspeh/greška) — nezavisan od carry-over/knjiži bannera.
  const [sefBanner, setSefBanner] = useState<{ tone: 'success' | 'danger'; msg: string } | null>(
    null,
  );

  const isProformaDraft =
    !!doc &&
    doc.status === SALES_STATUS.DRAFT &&
    PROFORMA_TYPES.has(doc.documentType);
  const isPostableInvoice =
    !!doc &&
    doc.status === SALES_STATUS.DRAFT &&
    !PROFORMA_TYPES.has(doc.documentType);

  // SEF izlaz (backend enqueue guard): samo knjižena (level 0), domaća (ne izvoz),
  // ni draft ni stornirana faktura sme na SEF.
  const isSefEligible =
    !!doc &&
    doc.level === 0 &&
    !doc.isExport &&
    doc.status !== SALES_STATUS.DRAFT &&
    doc.status !== SALES_STATUS.CANCELLED;

  // Postojeći outbox red(ovi) za ovu fakturu — status prikaz + guard protiv duplog enqueue-a.
  const sefOutbox = useSefOutboxForInvoice(validId, canSefRead && isSefEligible);
  const sefRows = sefOutbox.data?.data ?? [];
  const latestSefRow = sefRows[0] ?? null;
  const activeSefRow = sefRows.find((r) => IN_FLIGHT_SEF.has(r.status)) ?? null;

  const goBack = useCallback(() => router.push('/fakturisanje'), [router]);

  const doFromProforma = useCallback(() => {
    if (!doc || !canWrite || !isProformaDraft) return;
    fromProforma.mutate(
      { id: doc.id, targetType },
      { onSuccess: (created) => router.push(`/fakturisanje/${created.id}`) },
    );
  }, [doc, canWrite, isProformaDraft, fromProforma, targetType, router]);

  const doPost = useCallback(() => {
    if (!doc || !canPost || !isPostableInvoice) return;
    post.mutate(doc.id);
  }, [doc, canPost, isPostableInvoice, post]);

  const doEnqueue = useCallback(() => {
    if (!doc || !canSefSend || !isSefEligible) return;
    setSefBanner(null);
    enqueue.mutate(doc.id, {
      onSuccess: () =>
        setSefBanner({
          tone: 'success',
          msg: 'Faktura je stavljena u SEF red (status U redu). Slanje se pokreće na stranici SEF e-fakture.',
        }),
      onError: (e) =>
        setSefBanner({
          tone: 'danger',
          msg: e instanceof Error ? e.message : 'Slanje na SEF nije uspelo — pokušaj ponovo.',
        }),
    });
  }, [doc, canSefSend, isSefEligible, enqueue]);

  // Ctrl+S = primarna akcija zavisna od statusa; Esc = nazad na listu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        goBack();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isProformaDraft) doFromProforma();
        else if (isPostableInvoice) doPost();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, isProformaDraft, isPostableInvoice, doFromProforma, doPost]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const actionError =
    (fromProforma.error as Error | null)?.message ??
    (post.error as Error | null)?.message ??
    null;

  return (
    <AppShell>
      <PageHeader
        title={doc ? `Račun ${doc.documentNumber}` : 'Račun'}
        count={doc ? salesStatusMeta(doc.status).label : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>

            {doc && (
              <Button
                variant="secondary"
                loading={pdf.isPending}
                onClick={() =>
                  pdf.mutate({ id: doc.id }, { onSuccess: (blob) => openPdf(blob) })
                }
              >
                <Printer className="h-4 w-4" aria-hidden />
                Štampaj
              </Button>
            )}

            {isProformaDraft && canWrite && (
              <div className="flex items-center gap-2">
                <div className="w-56">
                  <Select
                    value={targetType}
                    onChange={(e) => setTargetType(e.target.value)}
                    options={TARGET_TYPE_OPTIONS}
                    aria-label="Ciljna vrsta računa"
                  />
                </div>
                <Button onClick={doFromProforma} loading={fromProforma.isPending}>
                  Napravi račun iz predračuna
                </Button>
              </div>
            )}

            {isPostableInvoice && canPost && (
              <Button onClick={doPost} loading={post.isPending}>
                Knjiži
              </Button>
            )}

            {doc && isSefEligible && canSefRead && latestSefRow && (
              <div className="flex items-center gap-2">
                <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  SEF
                </span>
                <StatusBadge
                  tone={sefStatusMeta(latestSefRow.status).tone}
                  label={sefStatusMeta(latestSefRow.status).label}
                />
                <Button
                  variant="ghost"
                  onClick={() => router.push('/sef')}
                  title="Otvori SEF e-fakture"
                >
                  Prikaži na SEF-u
                </Button>
              </div>
            )}

            {doc && isSefEligible && canSefSend && !activeSefRow && !sefOutbox.isLoading && (
              <Button onClick={doEnqueue} loading={enqueue.isPending}>
                <Send className="h-4 w-4" aria-hidden />
                Pošalji na SEF
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {error.message}
          </div>
        )}
        {actionError && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {actionError}
          </div>
        )}
        {sefBanner && (
          <div
            className={
              sefBanner.tone === 'success'
                ? 'rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success'
                : 'rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger'
            }
          >
            {sefBanner.msg}
          </div>
        )}

        {query.isLoading ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : notFound || !doc ? (
          <EmptyState
            title="Račun nije pronađen"
            hint="Račun je možda obrisan ili nemaš pristup. Vrati se na radnu listu."
          />
        ) : (
          <>
            <InvoiceHeader doc={doc} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              <DataTable
                columns={itemColumns}
                rows={doc.items}
                rowKey={(it) => it.id}
                empty={
                  <EmptyState
                    title="Račun nema stavki"
                    hint="Stavke se dodaju pri kreiranju predračuna."
                  />
                }
              />
              <InvoiceTotals doc={doc} />
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Zaglavlje računa — label/vrednost mreža (DESIGN_SYSTEM §5). */
function InvoiceHeader({ doc }: { doc: InvoiceDetail }) {
  const s = salesStatusMeta(doc.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Broj">
          <span className="tnums font-semibold text-ink">{doc.documentNumber}</span>
        </Field>
        <Field label="Tip">
          <span className="text-ink">{DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType}</span>
        </Field>
        <Field label="Status">
          <StatusBadge tone={s.tone} label={s.label} />
        </Field>
        <Field label="Nivo">
          <span className="tnums text-ink">{doc.level === 250 ? 'Predračun (250)' : 'Knjižen (0)'}</span>
        </Field>
        <Field label="Kupac">
          <span className="tnums text-ink">{doc.customerId ?? '—'}</span>
        </Field>
        <Field label="Datum izdavanja">
          <span className="text-ink">{formatDate(doc.documentDate)}</span>
        </Field>
        <Field label="Valuta (rok)">
          <span className="text-ink">{formatDate(doc.dueDate)}</span>
        </Field>
        <Field label="Valuta">
          <span className="text-ink">{doc.currency}</span>
        </Field>
        <Field label="Izvoz">
          {doc.isExport ? (
            <StatusBadge tone="info" label="Da" />
          ) : (
            <span className="text-ink-disabled">Ne</span>
          )}
        </Field>
        <Field label="Nalog GK">
          <span className="tnums text-ink">{doc.journalEntryId ?? '—'}</span>
        </Field>
        <Field label="Robni dokument">
          <span className="tnums text-ink">{doc.stockDocumentId ?? '—'}</span>
        </Field>
        <Field label="Broj stavki">
          <span className="tnums text-ink">{doc.items.length}</span>
        </Field>
      </dl>
      {doc.note && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Napomena
          </dt>
          <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{doc.note}</dd>
        </div>
      )}
    </section>
  );
}

/** Zbirni iznosi računa (osnovica / PDV / za plaćanje). */
function InvoiceTotals({ doc }: { doc: InvoiceDetail }) {
  return (
    <div className="flex justify-end">
      <dl className="w-full max-w-xs space-y-1 rounded-panel border border-line bg-surface-2 p-4 text-sm">
        <TotalRow label="Osnovica" value={`${formatDecimal(doc.netTotal)} ${doc.currency}`} />
        <TotalRow label="PDV" value={`${formatDecimal(doc.vatTotal)} ${doc.currency}`} />
        <div className="mt-1 border-t border-line pt-1">
          <TotalRow
            label="Za plaćanje"
            value={`${formatDecimal(doc.grossTotal)} ${doc.currency}`}
            strong
          />
        </div>
      </dl>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className={strong ? 'tnums font-semibold text-ink' : 'tnums text-ink'}>{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
