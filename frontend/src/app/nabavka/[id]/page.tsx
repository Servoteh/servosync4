'use client';

import { useEffect, useState, useCallback } from 'react';
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
  useNabavkaRequest,
  useSubmitRequest,
  useApproveRequest,
  useSendRfq,
  NABAVKA_REQUEST_STATUS,
  type NabavkaStatus,
  type PurchaseRequest,
  type PurchaseRequestItem,
} from '@/api/nabavka';
import { SendRfqDialog } from './send-rfq-dialog';

/**
 * Nabavka — detalj zahteva (DESIGN_SYSTEM §4 obrazac „Master–detalj"): zaglavlje
 * (label–vrednost) + tabela stavki. Status-uslovljena dugmad: Predaj (DRAFT),
 * Odobri (SUBMITTED), „Pošalji upit dobavljaču" (APPROVED). Data isključivo kroz
 * `@/api/nabavka` hook-ove; sve od kit komponenti i tokena.
 *
 * Backend nema `GET /requests/:id` — detalj se izvodi iz radne liste
 * (`useNabavkaRequest`). Status se renderuje lokalnim `statusMeta` nad postojećim
 * tonovima kanonske mape (§7), isto kao radna lista.
 *
 * TASTATURA: Ctrl+S = primarna akcija tekućeg statusa (predaj/odobri/upit),
 * Esc = nazad na listu.
 */

function statusMeta(status: NabavkaStatus): { tone: Tone; label: string } {
  switch (status) {
    case NABAVKA_REQUEST_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case NABAVKA_REQUEST_STATUS.SUBMITTED:
      return { tone: 'warn', label: 'Predat' };
    case NABAVKA_REQUEST_STATUS.APPROVED:
      return { tone: 'success', label: 'Odobren' };
    case NABAVKA_REQUEST_STATUS.SENT:
      return { tone: 'info', label: 'Upit poslat' };
    case NABAVKA_REQUEST_STATUS.RECEIVED:
      return { tone: 'success', label: 'Primljeno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const itemColumns: Column<PurchaseRequestItem>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (it) => <span className="tnums text-ink-secondary">{it.lineNo}</span>,
  },
  {
    key: 'description',
    header: 'Opis / artikal',
    render: (it) => (
      <span className="text-ink">
        {it.description ?? (it.articleId != null ? `Artikal #${it.articleId}` : '—')}
      </span>
    ),
  },
  {
    key: 'quantity',
    header: 'Količina',
    align: 'right',
    numeric: true,
    render: (it) => (
      <span className="tnums text-ink">
        {formatDecimal(it.quantity, 4)}
        {it.unit ? ` ${it.unit}` : ''}
      </span>
    ),
  },
  {
    key: 'createRfq',
    header: 'Upit',
    render: (it) =>
      it.createRfq ? (
        <StatusBadge tone="info" label="Za upit" />
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
];

export default function NabavkaRequestDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  const [rfqOpen, setRfqOpen] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const { request, isLoading: reqLoading, error, notFound } = useNabavkaRequest(validId);

  const submit = useSubmitRequest();
  const approve = useApproveRequest();
  const sendRfq = useSendRfq();

  const goBack = useCallback(() => router.push('/nabavka'), [router]);

  // Primarna akcija zavisi od statusa — jedan handler za Ctrl+S.
  const primaryAction = useCallback(() => {
    if (!request) return;
    if (request.status === NABAVKA_REQUEST_STATUS.DRAFT) {
      submit.mutate(request.id);
    } else if (request.status === NABAVKA_REQUEST_STATUS.SUBMITTED) {
      approve.mutate(request.id);
    } else if (request.status === NABAVKA_REQUEST_STATUS.APPROVED) {
      setRfqOpen(true);
    }
  }, [request, submit, approve]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !rfqOpen) {
        e.preventDefault();
        goBack();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !rfqOpen) {
        e.preventDefault();
        primaryAction();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, primaryAction, rfqOpen]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const mutating = submit.isPending || approve.isPending;
  const actionError =
    (submit.error as Error | null)?.message ??
    (approve.error as Error | null)?.message ??
    null;

  return (
    <AppShell>
      <PageHeader
        title={request ? `Zahtev ${request.requestNumber}` : 'Zahtev za nabavku'}
        count={request ? statusMeta(request.status).label : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>
            {request && <PrimaryActions request={request} onSendRfq={() => setRfqOpen(true)} submit={submit} approve={approve} />}
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

        {reqLoading ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : notFound || !request ? (
          <EmptyState
            title="Zahtev nije pronađen"
            hint="Zahtev je možda obrisan ili nemaš pristup. Vrati se na radnu listu."
          />
        ) : (
          <>
            <RequestHeader request={request} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              <DataTable
                columns={itemColumns}
                rows={request.items}
                rowKey={(it) => it.id}
                empty={
                  <EmptyState
                    title="Zahtev nema stavki"
                    hint="Stavke se dodaju pri kreiranju zahteva."
                  />
                }
              />
            </section>
          </>
        )}
      </div>

      {request && (
        <SendRfqDialog
          open={rfqOpen}
          onClose={() => setRfqOpen(false)}
          request={request}
          sendRfq={sendRfq}
        />
      )}
    </AppShell>
  );
}

/** Zaglavlje zahteva — label/vrednost mreža (DESIGN_SYSTEM §5 „kartica po redu"). */
function RequestHeader({ request }: { request: PurchaseRequest }) {
  const s = statusMeta(request.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Broj zahteva">
          <span className="tnums font-semibold text-ink">{request.requestNumber}</span>
        </Field>
        <Field label="Status">
          <StatusBadge tone={s.tone} label={s.label} />
        </Field>
        <Field label="Predmet">
          <span className="tnums text-ink">{request.projectId}</span>
        </Field>
        <Field label="Radni nalog">
          <span className="tnums text-ink">{request.workOrderId ?? '—'}</span>
        </Field>
        <Field label="Datum">
          <span className="text-ink">{formatDate(request.createdAt)}</span>
        </Field>
        <Field label="Inicijator">
          <span className="tnums text-ink">{request.initiatorUserId ?? '—'}</span>
        </Field>
        <Field label="Broj stavki">
          <span className="tnums text-ink">{request.items.length}</span>
        </Field>
      </dl>
      {request.note && (
        <div className="mt-4 border-t border-line-soft pt-4">
          <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Napomena
          </dt>
          <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{request.note}</dd>
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
 * Status-uslovljena dugmad: DRAFT → Predaj; SUBMITTED → Odobri; APPROVED →
 * Pošalji upit dobavljaču. Ostali statusi (SENT/RECEIVED) nemaju akciju ovde.
 */
function PrimaryActions({
  request,
  onSendRfq,
  submit,
  approve,
}: {
  request: PurchaseRequest;
  onSendRfq: () => void;
  submit: ReturnType<typeof useSubmitRequest>;
  approve: ReturnType<typeof useApproveRequest>;
}) {
  if (request.status === NABAVKA_REQUEST_STATUS.DRAFT) {
    return (
      <Button onClick={() => submit.mutate(request.id)} loading={submit.isPending}>
        Predaj na odobrenje
      </Button>
    );
  }
  if (request.status === NABAVKA_REQUEST_STATUS.SUBMITTED) {
    return (
      <Button onClick={() => approve.mutate(request.id)} loading={approve.isPending}>
        Odobri
      </Button>
    );
  }
  if (request.status === NABAVKA_REQUEST_STATUS.APPROVED) {
    const anyRfq = request.items.some((it) => it.createRfq);
    return (
      <Button onClick={onSendRfq} disabled={!anyRfq}>
        Pošalji upit dobavljaču
      </Button>
    );
  }
  return null;
}
