'use client';

import { useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useJournalEntry,
  GL_STATUS,
  type GlStatus,
  type JournalEntryDetail,
  type LedgerEntry,
} from '@/api/glavna-knjiga';

/**
 * Glavna knjiga — detalj naloga (DESIGN_SYSTEM §4 obrazac „Master–detalj"):
 * zaglavlje (label–vrednost) + tabela stavki (konto/komitent/duguje/potražuje/opis)
 * + provera ravnoteže ΣDuguje = ΣPotražuje. Data isključivo kroz
 * `@/api/glavna-knjiga` hook-ove; sve od kit komponenti i tokena.
 *
 * TASTATURA: Esc = nazad na listu.
 */

function statusMeta(status: GlStatus): { tone: Tone; label: string } {
  switch (status) {
    case GL_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case GL_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    case GL_STATUS.LOCKED:
      return { tone: 'neutral', label: 'Zaključan' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Decimal-string → number (zarez/tačka tolerantno); prazno/neparsivo → 0. */
function toNumber(value: string | null | undefined): number {
  if (value == null || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const lineColumns: Column<LedgerEntry>[] = [
  {
    key: 'accountCode',
    header: 'Konto',
    render: (l) => <span className="tnums font-semibold text-ink">{l.accountCode}</span>,
  },
  {
    key: 'analyticalCode',
    header: 'Komitent',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{l.analyticalCode ?? '—'}</span>,
  },
  {
    key: 'description',
    header: 'Opis',
    render: (l) => <span className="text-ink-secondary">{l.description ?? '—'}</span>,
  },
  {
    key: 'debit',
    header: 'Duguje',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.debit)}</span>,
  },
  {
    key: 'credit',
    header: 'Potražuje',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.credit)}</span>,
  },
];

export default function GlavnaKnjigaDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useJournalEntry(validId);
  const doc = query.data?.data ?? null;
  const error = query.error as Error | null;
  const notFound =
    validId != null && !query.isLoading && !query.error && query.data == null;

  const goBack = useCallback(() => router.push('/glavna-knjiga'), [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={doc ? `Nalog ${doc.number}` : 'Nalog glavne knjige'}
        count={doc ? statusMeta(doc.status).label : undefined}
        actions={
          <Button variant="ghost" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Nazad
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {error.message}
          </div>
        )}

        {query.isLoading ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : notFound || !doc ? (
          <EmptyState
            title="Nalog nije pronađen"
            hint="Nalog je možda obrisan ili nemaš pristup. Vrati se na dnevnik."
          />
        ) : (
          <>
            <JournalHeader doc={doc} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              <DataTable
                columns={lineColumns}
                rows={doc.lines}
                rowKey={(l) => l.id}
                empty={
                  <EmptyState
                    title="Nalog nema stavki"
                    hint="Stavke nastaju knjiženjem dokumenta u glavnu knjigu."
                  />
                }
              />
              <BalanceCheck lines={doc.lines} />
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Zaglavlje naloga — label/vrednost mreža (DESIGN_SYSTEM §5 „kartica po redu"). */
function JournalHeader({ doc }: { doc: JournalEntryDetail }) {
  const s = statusMeta(doc.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Broj">
          <span className="tnums font-semibold text-ink">{doc.number}</span>
        </Field>
        <Field label="Vrsta naloga">
          <span className="text-ink">{doc.orderTypeCode}</span>
        </Field>
        <Field label="Godina">
          <span className="tnums text-ink">{doc.year}</span>
        </Field>
        <Field label="Status">
          <StatusBadge tone={s.tone} label={s.label} />
        </Field>
        <Field label="Datum">
          <span className="text-ink">{formatDate(doc.documentDate)}</span>
        </Field>
        <Field label="Broj stavki">
          <span className="tnums text-ink">{doc.lines.length}</span>
        </Field>
      </dl>
    </section>
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

/**
 * Provera ravnoteže naloga: ΣDuguje mora biti = ΣPotražuje (dvojno knjiženje).
 * Prikazuje zbirove + status pilulu (uravnotežen / u neravnoteži sa razlikom).
 */
function BalanceCheck({ lines }: { lines: LedgerEntry[] }) {
  const totalDebit = lines.reduce((acc, l) => acc + toNumber(l.debit), 0);
  const totalCredit = lines.reduce((acc, l) => acc + toNumber(l.credit), 0);
  const diff = totalDebit - totalCredit;
  // Zaokruženje na 2 decimale pre poređenja (Decimal-string može nositi šum).
  const balanced = Math.abs(diff) < 0.005;

  return (
    <div className="flex flex-wrap items-center justify-end gap-6 rounded-panel border border-line bg-surface-2 px-5 py-3">
      <div className="text-right">
        <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Σ Duguje
        </div>
        <div className="tnums text-md font-semibold text-ink">{formatDecimal(totalDebit)}</div>
      </div>
      <div className="text-right">
        <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Σ Potražuje
        </div>
        <div className="tnums text-md font-semibold text-ink">{formatDecimal(totalCredit)}</div>
      </div>
      {balanced ? (
        <StatusBadge tone="success" label="Uravnotežen" />
      ) : (
        <StatusBadge tone="danger" label={`Razlika ${formatDecimal(diff)}`} />
      )}
    </div>
  );
}
