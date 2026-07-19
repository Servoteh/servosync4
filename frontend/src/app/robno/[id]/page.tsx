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
  useStockDocument,
  useCalculate,
  usePost,
  ROBNO_STATUS,
  ROBNO_KIND,
  type RobnoStatus,
  type RobnoKind,
  type StockDocumentDetail,
  type StockDocumentItem,
} from '@/api/robno';

/**
 * Robno — detalj dokumenta (DESIGN_SYSTEM §4 obrazac „Master–detalj"): zaglavlje
 * (label–vrednost) + tabela stavki sa landed (kalkulisanim) cenama. Status-uslovljena
 * dugmad: Kalkuliši (DRAFT), Knjiži (CALCULATED). Data isključivo kroz `@/api/robno`
 * hook-ove; sve od kit komponenti i tokena.
 *
 * TASTATURA: Ctrl+S = primarna akcija tekućeg statusa (kalkuliši/knjiži),
 * Esc = nazad na listu.
 */

function statusMeta(status: RobnoStatus): { tone: Tone; label: string } {
  switch (status) {
    case ROBNO_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case ROBNO_STATUS.CALCULATED:
      return { tone: 'info', label: 'Kalkulisan' };
    case ROBNO_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    case ROBNO_STATUS.LOCKED:
      return { tone: 'neutral', label: 'Zaključan' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const KIND_LABEL: Record<RobnoKind, string> = {
  [ROBNO_KIND.UL]: 'Ulaz',
  [ROBNO_KIND.IZ]: 'Izlaz',
  [ROBNO_KIND.NIV]: 'Nivelacija',
  [ROBNO_KIND.PRENOS]: 'Prenos',
  [ROBNO_KIND.VISAK]: 'Višak',
  [ROBNO_KIND.MANJAK]: 'Manjak',
};

const itemColumns: Column<StockDocumentItem>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{it.lineNo}</span>,
  },
  {
    key: 'itemId',
    header: 'Artikal',
    render: (it) => <span className="tnums text-ink">#{it.itemId}</span>,
  },
  {
    key: 'quantity',
    header: 'Količina',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.quantity, 4)}</span>,
  },
  {
    key: 'purchasePriceNet',
    header: 'Nabavna neto',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink">{formatDecimal(it.purchasePriceNet)}</span>,
  },
  {
    key: 'calculatedWholesalePrice',
    header: 'Kalkulisana VP',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums text-ink">{formatDecimal(it.calculatedWholesalePrice)}</span>
    ),
  },
  {
    key: 'actualWholesalePrice',
    header: 'Stvarna VP',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums text-ink">{formatDecimal(it.actualWholesalePrice)}</span>
    ),
  },
];

export default function RobnoDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useStockDocument(validId);
  const doc = query.data?.data ?? null;
  const error = query.error as Error | null;
  const notFound =
    validId != null && !query.isLoading && !query.error && query.data == null;

  const calculate = useCalculate();
  const post = usePost();

  const goBack = useCallback(() => router.push('/robno'), [router]);

  // Primarna akcija zavisi od statusa — jedan handler za Ctrl+S.
  const primaryAction = useCallback(() => {
    if (!doc) return;
    if (doc.status === ROBNO_STATUS.DRAFT) {
      calculate.mutate(doc.id);
    } else if (doc.status === ROBNO_STATUS.CALCULATED) {
      post.mutate(doc.id);
    }
  }, [doc, calculate, post]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        goBack();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        primaryAction();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, primaryAction]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const actionError =
    (calculate.error as Error | null)?.message ??
    (post.error as Error | null)?.message ??
    null;

  return (
    <AppShell>
      <PageHeader
        title={doc ? `Dokument ${doc.documentNumber}` : 'Robni dokument'}
        count={doc ? statusMeta(doc.status).label : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>
            {doc && (
              <PrimaryActions doc={doc} calculate={calculate} post={post} />
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

        {query.isLoading ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : notFound || !doc ? (
          <EmptyState
            title="Dokument nije pronađen"
            hint="Dokument je možda obrisan ili nemaš pristup. Vrati se na radnu listu."
          />
        ) : (
          <>
            <DocumentHeader doc={doc} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              <DataTable
                columns={itemColumns}
                rows={doc.items}
                rowKey={(it) => it.id}
                empty={
                  <EmptyState
                    title="Dokument nema stavki"
                    hint="Stavke se dodaju pri kreiranju dokumenta."
                  />
                }
              />
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Zaglavlje dokumenta — label/vrednost mreža (DESIGN_SYSTEM §5 „kartica po redu"). */
function DocumentHeader({ doc }: { doc: StockDocumentDetail }) {
  const s = statusMeta(doc.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Broj">
          <span className="tnums font-semibold text-ink">{doc.documentNumber}</span>
        </Field>
        <Field label="Tip">
          <span className="text-ink">{KIND_LABEL[doc.kind] ?? doc.kind}</span>
        </Field>
        <Field label="Status">
          <StatusBadge tone={s.tone} label={s.label} />
        </Field>
        <Field label="Kalkulisan">
          {doc.isCalculated ? (
            <StatusBadge tone="success" label="Da" />
          ) : (
            <span className="text-ink-disabled">Ne</span>
          )}
        </Field>
        <Field label="Magacin">
          <span className="tnums text-ink">{doc.warehouseId}</span>
        </Field>
        {doc.targetWarehouseId != null && (
          <Field label="Odredišni magacin">
            <span className="tnums text-ink">{doc.targetWarehouseId}</span>
          </Field>
        )}
        <Field label="Dobavljač">
          <span className="tnums text-ink">{doc.supplierId ?? '—'}</span>
        </Field>
        <Field label="Datum">
          <span className="text-ink">{formatDate(doc.documentDate)}</span>
        </Field>
        <Field label="Datum knjiženja">
          <span className="text-ink">{formatDate(doc.postingDate)}</span>
        </Field>
        <Field label="Predmet">
          <span className="tnums text-ink">{doc.projectId ?? '—'}</span>
        </Field>
        <Field label="Radni nalog">
          <span className="tnums text-ink">{doc.workOrderId ?? '—'}</span>
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
 * Status-uslovljena dugmad: DRAFT → Kalkuliši; CALCULATED → Knjiži. Proknjižen /
 * zaključan dokument nema akciju ovde.
 */
function PrimaryActions({
  doc,
  calculate,
  post,
}: {
  doc: StockDocumentDetail;
  calculate: ReturnType<typeof useCalculate>;
  post: ReturnType<typeof usePost>;
}) {
  if (doc.status === ROBNO_STATUS.DRAFT) {
    return (
      <Button onClick={() => calculate.mutate(doc.id)} loading={calculate.isPending}>
        Kalkuliši
      </Button>
    );
  }
  if (doc.status === ROBNO_STATUS.CALCULATED) {
    return (
      <Button onClick={() => post.mutate(doc.id)} loading={post.isPending}>
        Knjiži
      </Button>
    );
  }
  return null;
}
