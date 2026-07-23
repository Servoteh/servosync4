'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Pencil, Trash2, Link2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useStatement,
  useMatchLines,
  usePostStatement,
  useDeleteStatementLine,
  STATEMENT_STATUS,
  LINE_STATUS,
  LINE_DIRECTION,
  type StatementStatus,
  type LineStatus,
  type LineDirection,
  type BankStatementDetail,
  type BankStatementLine,
} from '@/api/izvodi';
import { StatementLineEditor } from './statement-line-editor';
import { LinkLineDialog } from './link-line-dialog';

/**
 * Izvodi — detalj izvoda (DESIGN_SYSTEM §4 obrazac „Master–detalj"): zaglavlje
 * (label–vrednost) + tabela stavki (komitent / žiro / iznos / smer / poziv-na-broj /
 * status uparivanja). Status-uslovljena dugmad: „Upari" (IMPORTED, uparivanje) i
 * „Knjiži" (IMPORTED sa uparenim stavkama → knjiženje u GK). Data isključivo kroz
 * `@/api/izvodi` hook-ove; sve od kit komponenti i tokena.
 *
 * TASTATURA: Ctrl+S = primarna akcija tekućeg statusa (upari; kad je uparen — knjiži),
 * Esc = nazad na listu.
 */

/** Status izvoda → { tone, label } (kanonska mapa §7 „Izvodi — izvod"). */
function statementStatusMeta(status: StatementStatus): { tone: Tone; label: string } {
  switch (status) {
    case STATEMENT_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case STATEMENT_STATUS.IMPORTED:
      return { tone: 'info', label: 'Uvezen' };
    case STATEMENT_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Status stavke → { tone, label } (kanonska mapa §7 „Izvodi — stavka"). */
function lineStatusMeta(status: LineStatus): { tone: Tone; label: string } {
  switch (status) {
    case LINE_STATUS.UNMATCHED:
      return { tone: 'warn', label: 'Neupareno' };
    case LINE_STATUS.MATCHED:
      return { tone: 'info', label: 'Upareno' };
    case LINE_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjiženo' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const DIRECTION_LABEL: Record<LineDirection, string> = {
  [LINE_DIRECTION.CREDIT]: 'Priliv',
  [LINE_DIRECTION.DEBIT]: 'Odliv',
};

const itemColumns: Column<BankStatementLine>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{l.lineNo}</span>,
  },
  {
    key: 'partnerName',
    header: 'Komitent',
    render: (l) => (
      <div className="min-w-0">
        <div className="truncate text-ink">{l.partnerName ?? '—'}</div>
        {l.matchedCustomerId != null && (
          <div className="tnums text-2xs text-ink-secondary">komitent #{l.matchedCustomerId}</div>
        )}
      </div>
    ),
  },
  {
    key: 'partnerAccount',
    header: 'Žiro',
    render: (l) => <span className="tnums text-ink-secondary">{l.partnerAccount ?? '—'}</span>,
  },
  {
    key: 'amount',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.amount)}</span>,
  },
  {
    key: 'direction',
    header: 'Smer',
    render: (l) => <span className="text-ink">{DIRECTION_LABEL[l.direction] ?? l.direction}</span>,
  },
  {
    key: 'referenceNumber',
    header: 'Poziv na broj',
    render: (l) => <span className="tnums text-ink-secondary">{l.referenceNumber ?? '—'}</span>,
  },
  {
    key: 'status',
    header: 'Uparivanje',
    render: (l) => {
      const m = lineStatusMeta(l.status);
      return <StatusBadge tone={m.tone} label={m.label} />;
    },
  },
];

export default function IzvodDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useStatement(validId);
  const doc = query.data ?? null;
  const error = query.error as Error | null;
  const notFound = validId != null && !query.isLoading && !query.error && query.data == null;

  const match = useMatchLines();
  const post = usePostStatement();
  const deleteLine = useDeleteStatementLine();

  // Ručni unos/izmena stavke (BigBit paritet). editorLine=null → dodavanje.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorLine, setEditorLine] = useState<BankStatementLine | null>(null);
  const openAdd = useCallback(() => {
    setEditorLine(null);
    setEditorOpen(true);
  }, []);
  const openEdit = useCallback((l: BankStatementLine) => {
    setEditorLine(l);
    setEditorOpen(true);
  }, []);

  // Ručno povezivanje stavke sa otvorenom stavkom saldakonta (BigBit „Poveži po BrDok").
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkLine, setLinkLine] = useState<BankStatementLine | null>(null);
  const openLink = useCallback((l: BankStatementLine) => {
    setLinkLine(l);
    setLinkOpen(true);
  }, []);

  const goBack = useCallback(() => router.push('/izvodi'), [router]);

  // Primarna akcija zavisi od statusa: uvezen bez uparenih → upari; sa uparenim → knjiži.
  const primaryAction = useCallback(() => {
    if (!doc || doc.status !== STATEMENT_STATUS.IMPORTED) return;
    const hasMatched = doc.lines.some((l) => l.status === LINE_STATUS.MATCHED);
    if (hasMatched) post.mutate({ id: doc.id });
    else match.mutate(doc.id);
  }, [doc, match, post]);

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
    (match.error as Error | null)?.message ?? (post.error as Error | null)?.message ?? null;

  return (
    <AppShell>
      <PageHeader
        title={doc ? `Izvod ${doc.statementNumber}` : 'Bankovni izvod'}
        count={doc ? statementStatusMeta(doc.status).label : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={goBack}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>
            {doc && <PrimaryActions doc={doc} match={match} post={post} />}
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
            title="Izvod nije pronađen"
            hint="Izvod je možda obrisan ili nemaš pristup. Vrati se na listu izvoda."
          />
        ) : (
          <>
            <StatementHeader doc={doc} />

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-md font-semibold text-ink">Stavke</h2>
                {doc.status !== STATEMENT_STATUS.POSTED && (
                  <Button variant="secondary" onClick={openAdd}>
                    <Plus className="h-4 w-4" aria-hidden />
                    Dodaj stavku
                  </Button>
                )}
              </div>
              <DataTable
                columns={
                  doc.status === STATEMENT_STATUS.POSTED
                    ? itemColumns
                    : [
                        ...itemColumns,
                        {
                          key: 'akcije',
                          header: '',
                          align: 'right',
                          render: (l: BankStatementLine) => (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                onClick={() => openLink(l)}
                                aria-label="Poveži stavku sa otvorenom stavkom"
                              >
                                <Link2 className="h-4 w-4" aria-hidden />
                              </Button>
                              <Button
                                variant="ghost"

                                onClick={() => openEdit(l)}
                                aria-label="Izmeni stavku"
                              >
                                <Pencil className="h-4 w-4" aria-hidden />
                              </Button>
                              <Button
                                variant="ghost"
                               
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Obrisati stavku ${l.lineNo} (${formatDecimal(l.amount)})?`,
                                    )
                                  )
                                    deleteLine.mutate({ id: doc.id, lineId: l.id });
                                }}
                                aria-label="Obriši stavku"
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                              </Button>
                            </div>
                          ),
                        } as Column<BankStatementLine>,
                      ]
                }
                rows={doc.lines}
                rowKey={(l) => l.id}
                empty={
                  <EmptyState
                    title="Izvod nema stavki"
                    hint="Stavke se pune parsiranjem TXT-a pri uvozu ili ručnim unosom stavke."
                  />
                }
              />
            </section>

            <StatementLineEditor
              statementId={doc.id}
              line={editorLine}
              open={editorOpen}
              onClose={() => setEditorOpen(false)}
            />

            <LinkLineDialog
              statementId={doc.id}
              line={linkLine}
              open={linkOpen}
              onClose={() => setLinkOpen(false)}
            />
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Zaglavlje izvoda — label/vrednost mreža (DESIGN_SYSTEM §5). */
function StatementHeader({ doc }: { doc: BankStatementDetail }) {
  const s = statementStatusMeta(doc.status);
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Žiro račun">
          <span className="tnums text-ink">{doc.bankAccount}</span>
        </Field>
        <Field label="Broj izvoda">
          <span className="tnums font-semibold text-ink">{doc.statementNumber}</span>
        </Field>
        <Field label="Datum">
          <span className="text-ink">{formatDate(doc.statementDate)}</span>
        </Field>
        <Field label="Status">
          <StatusBadge tone={s.tone} label={s.label} />
        </Field>
        <Field label="Otvaranje">
          <span className="tnums text-ink">
            {formatDecimal(doc.openingBalance)} {doc.currency}
          </span>
        </Field>
        <Field label="Zatvaranje">
          <span className="tnums text-ink">
            {formatDecimal(doc.closingBalance)} {doc.currency}
          </span>
        </Field>
        <Field label="Broj stavki">
          <span className="tnums text-ink">{doc.lines.length}</span>
        </Field>
        <Field label="Fajl">
          <span className="truncate text-ink-secondary">{doc.importedFileName ?? '—'}</span>
        </Field>
      </dl>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/**
 * Status-uslovljena dugmad. IMPORTED: „Upari" (uvek) + „Knjiži" (kad je bar jedna
 * stavka MATCHED). Proknjižen izvod nema akcija ovde.
 */
function PrimaryActions({
  doc,
  match,
  post,
}: {
  doc: BankStatementDetail;
  match: ReturnType<typeof useMatchLines>;
  post: ReturnType<typeof usePostStatement>;
}) {
  if (doc.status !== STATEMENT_STATUS.IMPORTED) return null;
  const hasMatched = doc.lines.some((l) => l.status === LINE_STATUS.MATCHED);
  return (
    <>
      <Button variant="secondary" onClick={() => match.mutate(doc.id)} loading={match.isPending}>
        Upari
      </Button>
      <Button
        onClick={() => post.mutate({ id: doc.id })}
        loading={post.isPending}
        disabled={!hasMatched}
      >
        Knjiži
      </Button>
    </>
  );
}
