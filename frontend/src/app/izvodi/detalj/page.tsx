'use client';

import { toast } from '@/lib/toast';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Plus,
  Printer,
  Pencil,
  Trash2,
  Link2,
  CreditCard,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useIdParam, listHref } from '@/lib/use-id-param';
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
  useDeleteStatement,
  useStatementPdf,
  openPdf,
  isForeignCurrency,
  STATEMENT_STATUS,
  LINE_STATUS,
  LINE_DIRECTION,
  type StatementStatus,
  type LineStatus,
  type LineDirection,
  type BankStatementDetail,
  type BankStatementLine,
  type StatementControl,
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

/**
 * Kolone tabele stavki. Za DEVIZNI izvod (E6) umeta kolone „Devizni iznos" (foreignAmount
 * u valuti izvoda) i „Kurs" (primenjeni prodajni kurs), a „Iznos" postaje „RSD protivvr."
 * (izvedena dinarska protivvrednost). Za dinarski izvod = jedna kolona „Iznos" (nepromenjeno).
 */
function buildItemColumns(currency: string | null): Column<BankStatementLine>[] {
  const foreign = isForeignCurrency(currency);
  const cur = (currency ?? 'RSD').toUpperCase();

  const cols: Column<BankStatementLine>[] = [
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
            <div className="flex items-center gap-2">
              <span className="tnums text-2xs text-ink-secondary">
                komitent #{l.matchedCustomerId}
              </span>
              <Link
                href={`/saldakonti/kartica?partnerId=${l.matchedCustomerId}`}
                className="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline"
              >
                <CreditCard className="h-3 w-3" aria-hidden />
                Kartica
              </Link>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'partnerAccount',
      header: 'Žiro',
      render: (l) => <span className="tnums text-ink-secondary">{l.partnerAccount ?? '—'}</span>,
    },
  ];

  if (foreign) {
    cols.push(
      {
        key: 'foreignAmount',
        header: `Devizni iznos (${cur})`,
        align: 'right',
        numeric: true,
        render: (l) => <span className="tnums text-ink">{formatDecimal(l.foreignAmount)}</span>,
      },
      {
        key: 'exchangeRate',
        header: 'Kurs',
        align: 'right',
        numeric: true,
        render: (l) => (
          <span className="tnums text-ink-secondary">{formatDecimal(l.exchangeRate, 6)}</span>
        ),
      },
      {
        key: 'amount',
        header: 'RSD protivvr.',
        align: 'right',
        numeric: true,
        render: (l) => <span className="tnums text-ink">{formatDecimal(l.amount)}</span>,
      },
    );
  } else {
    cols.push({
      key: 'amount',
      header: 'Iznos',
      align: 'right',
      numeric: true,
      render: (l) => <span className="tnums text-ink">{formatDecimal(l.amount)}</span>,
    });
  }

  cols.push(
    {
      key: 'direction',
      header: 'Smer',
      render: (l) => (
        <span className="text-ink">{DIRECTION_LABEL[l.direction] ?? l.direction}</span>
      ),
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
  );

  return cols;
}

export default function IzvodDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  // Statička ruta `/izvodi/detalj?id=N` (static export — vidi use-id-param).
  const { id: validId, resolved: idResolved } = useIdParam();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useStatement(validId);
  const doc = query.data ?? null;
  const error = query.error as Error | null;
  // „Nema id-a u URL-u" je isto što i „nije pronađen" — ali tek pošto se URL pročita.
  const notFound =
    (idResolved && validId == null) ||
    (validId != null && !query.isLoading && !query.error && query.data == null);

  const match = useMatchLines();
  const post = usePostStatement();
  const deleteLine = useDeleteStatementLine();
  const deleteStatement = useDeleteStatement();

  // Reset/brisanje uvezenog izvoda (samo ne-POSTED) → nazad na listu.
  const onDeleteStatement = useCallback(() => {
    if (!doc || doc.status === STATEMENT_STATUS.POSTED) return;
    if (
      !window.confirm(
        `Obrisati izvod ${doc.statementNumber} sa svim stavkama? Radnja se ne poništava.`,
      )
    )
      return;
    deleteStatement.mutate(doc.id, {
      onSuccess: () => router.push('/izvodi'),
    });
  }, [doc, deleteStatement, router]);

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

  // Štampa izvoda (PDF): zaglavlje firme, stavke, rekapitulacija stanja sa
  // kontrolom salda i potpisi. Do sada izvod nije imao nijednu štampu.
  const statementPdf = useStatementPdf();

  // Povratak na listu VRAĆA I FILTERE (`listHref` čita poslednje stanje
  // liste) — bez toga se posle svakog otvorenog dokumenta gubio filter i strana.
  const goBack = useCallback(() => router.push(listHref('/izvodi')), [router]);

  // Primarna akcija zavisi od statusa: uvezen bez uparenih → upari; sa uparenim → knjiži.
  const primaryAction = useCallback(() => {
    if (!doc || doc.status !== STATEMENT_STATUS.IMPORTED) return;
    const hasMatched = doc.lines.some((l) => l.status === LINE_STATUS.MATCHED);
    if (hasMatched) post.mutate({ id: doc.id });
    else match.mutate(doc.id);
  }, [doc, match, post]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Dok je dijalog otvoren prečice ekrana MIRUJU: bez ovoga je Esc zatvarao
      // dijalog I usput odnosio korisnika na listu (uneseni tekst nestaje), a
      // Ctrl+S je istovremeno slao obrazac dijaloga I okidao radnju ekrana.
      if (editorOpen || linkOpen) return;
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
  }, [goBack, primaryAction, editorOpen, linkOpen]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const actionError =
    (match.error as Error | null)?.message ??
    (post.error as Error | null)?.message ??
    (deleteStatement.error as Error | null)?.message ??
    (statementPdf.error as Error | null)?.message ??
    null;

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
            {doc && (
              <Button
                variant="secondary"
                title="Štampa izvoda (PDF)"
                loading={statementPdf.isPending}
                onClick={() =>
                  statementPdf.mutate(doc.id, {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
          })
                }
              >
                <Printer className="h-4 w-4" aria-hidden />
                Štampa
              </Button>
            )}
            {doc && <PrimaryActions doc={doc} match={match} post={post} />}
            {doc && doc.status !== STATEMENT_STATUS.POSTED && (
              <Button
                variant="danger"
                onClick={onDeleteStatement}
                loading={deleteStatement.isPending}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Obriši
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

        {!idResolved || (validId != null && query.isLoading) ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : error ? (
          // Greška servera NIJE „dokument ne postoji". Ranije se uz crveni baner
          // palila i poruka „možda je obrisan", pa je knjigovođa posle restarta
          // backenda tražio proknjižen dokument koji nikad nije nestao.
          <EmptyState
            title="Podatak nije učitan"
            hint="Veza sa serverom je prekinuta ili je zahtev odbijen. Osveži stranicu; ako se ponovi, javi administratoru."
          />
        ) : notFound || !doc ? (
          <EmptyState
            title="Izvod nije pronađen"
            hint={
              validId == null
                ? 'Adresa nema ispravan broj izvoda (?id=). Vrati se na listu i otvori izvod iz liste.'
                : 'Izvod je možda obrisan ili nemaš pristup. Vrati se na listu izvoda.'
            }
          />
        ) : (
          <>
            <StatementHeader doc={doc} />

            <ControlBar control={doc.control} currency={doc.currency} />

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
                    ? buildItemColumns(doc.currency)
                    : [
                        ...buildItemColumns(doc.currency),
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
              currency={doc.currency}
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

/**
 * Kontrola prometa i salda banke (B3) — traka ispod zaglavlja. Zeleno kad se očekivano
 * zatvaranje (otvaranje + prilivi − odlivi) slaže sa unetim, crveno sa razlikom kad ne.
 * Čisto UPOZORENJE — ne blokira knjiženje (backend `control.ok`). Nema kontrole (stariji
 * izvod bez polja) → ništa se ne prikazuje.
 */
function ControlBar({
  control,
  currency,
}: {
  control: StatementControl | undefined;
  currency: string;
}) {
  if (!control) return null;
  const cur = currency || 'RSD';

  // Stanja nisu uneta (oba 0) — kontrola nije merodavna. Diskretan podsetnik umesto
  // lažnog „ne slaže se" (review Batch B: uvoz ne popunjava otvaranje/zatvaranje).
  if (!control.available) {
    return (
      <div className="flex items-center gap-2 rounded-panel border border-line bg-surface-2 px-4 py-2.5 text-sm text-ink-secondary">
        <span>
          Kontrola prometa nije moguća — unesi otvaranje i zatvaranje izvoda. Promet po
          stavkama: prilivi {formatDecimal(control.totalInflow)} − odlivi{' '}
          {formatDecimal(control.totalOutflow)} {cur}.
        </span>
      </div>
    );
  }

  if (control.ok) {
    return (
      <div className="flex items-center gap-2 rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-2.5 text-sm text-status-success">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          Kontrola prometa: saldo se slaže — očekivano zatvaranje{' '}
          {formatDecimal(control.expectedClosing)} {cur}.
        </span>
      </div>
    );
  }

  return (
    <div
      className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2.5 text-sm text-status-danger"
      role="alert"
    >
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        <span>
          Kontrola prometa: saldo se NE slaže — razlika{' '}
          {formatDecimal(control.difference)} {cur}.
        </span>
      </div>
      <div className="mt-1 pl-6 text-2xs text-status-danger/90">
        Otvaranje {formatDecimal(control.openingBalance)} + prilivi{' '}
        {formatDecimal(control.totalInflow)} − odlivi {formatDecimal(control.totalOutflow)} ={' '}
        očekivano {formatDecimal(control.expectedClosing)} {cur}; uneto zatvaranje{' '}
        {formatDecimal(control.actualClosing)} {cur}. Upozorenje — knjiženje nije blokirano.
      </div>
    </div>
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
        <Field label="Valuta">
          <span
            className={
              isForeignCurrency(doc.currency)
                ? 'font-semibold text-ink'
                : 'text-ink-secondary'
            }
          >
            {doc.currency || 'RSD'}
          </span>
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
