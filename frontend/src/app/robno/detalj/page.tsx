'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useIdParam, listHref } from '@/lib/use-id-param';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { UndoToast } from '@/components/undo-toast';
import { ShippingPanel } from './shipping-panel';
import { TransferPanel } from './transfer-panel';
import { formatDate, formatDecimal } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useStockDocument,
  useCalculate,
  usePost,
  useLockDocument,
  useDeleteStockItem,
  useRestoreStockItem,
  useStockDocumentPdf,
  useGoodsReceiptReportPdf,
  openPdf,
  printVariantsForKind,
  ROBNO_PRINT_LABEL,
  ROBNO_STATUS,
  ROBNO_KIND,
  type RobnoStatus,
  type RobnoKind,
  type RobnoPrintVariant,
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
  // Statička ruta `/robno/detalj?id=N` (static export — vidi use-id-param).
  const { id: validId, resolved: idResolved } = useIdParam();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const query = useStockDocument(validId);
  const doc = query.data?.data ?? null;
  const error = query.error as Error | null;
  // „Nema id-a u URL-u" je isto što i „nije pronađen" — ali tek pošto se URL pročita.
  const notFound =
    (idResolved && validId == null) ||
    (validId != null && !query.isLoading && !query.error && query.data == null);

  const calculate = useCalculate();
  const post = usePost();
  const lock = useLockDocument();
  const deleteItem = useDeleteStockItem();
  const restoreItem = useRestoreStockItem();

  // Poslednje meko-obrisana stavka (za „Poništi" toast). null = nema aktivnog undo prozora.
  const [pending, setPending] = useState<{ itemLineId: number; label: string } | null>(
    null,
  );

  // Povratak na listu VRAĆA I FILTERE (`listHref` čita poslednje stanje
  // liste) — bez toga se posle svakog otvorenog dokumenta gubio filter i strana.
  const goBack = useCallback(() => router.push(listHref('/robno')), [router]);

  // Proknjižen (booked) = ima nalog GK (journalEntryId) — uslov za zaključavanje.
  const isBooked = doc != null && doc.journalEntryId != null;
  const isLocked = doc?.status === ROBNO_STATUS.LOCKED;

  // Stavke se mogu brisati/vraćati SAMO dok dokument nije proknjižen ni zaključan
  // (mora se poklopiti sa backend guardom `assertItemMutable`).
  const canEditItems =
    doc != null &&
    doc.journalEntryId == null &&
    doc.status !== ROBNO_STATUS.LOCKED &&
    doc.status !== ROBNO_STATUS.POSTED;

  const onDeleteItem = useCallback(
    (it: StockDocumentItem) => {
      if (!doc) return;
      deleteItem.mutate(
        { docId: doc.id, itemLineId: it.id },
        {
          onSuccess: () =>
            setPending({ itemLineId: it.id, label: `Stavka #${it.lineNo}` }),
          onError: (e) => toast((e as Error).message),
        },
      );
    },
    [doc, deleteItem],
  );

  const onUndoDelete = useCallback(() => {
    if (!doc || !pending) return;
    restoreItem.mutate(
      { docId: doc.id, itemLineId: pending.itemLineId },
      {
        onSuccess: () => {
          setPending(null);
          toast('Brisanje poništeno.');
        },
        onError: (e) => {
          setPending(null);
          toast((e as Error).message);
        },
      },
    );
  }, [doc, pending, restoreItem]);

  const onDismissUndo = useCallback(() => setPending(null), []);

  // Kolone stavki + akciona kolona „Obriši" (samo kad je dokument izmenljiv).
  const itemColumnsWithActions = useMemo<Column<StockDocumentItem>[]>(() => {
    if (!canEditItems) return itemColumns;
    return [
      ...itemColumns,
      {
        key: 'actions',
        header: '',
        align: 'right',
        render: (it) => (
          <Button
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteItem(it);
            }}
            loading={
              deleteItem.isPending && deleteItem.variables?.itemLineId === it.id
            }
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            Obriši
          </Button>
        ),
      },
    ];
  }, [canEditItems, onDeleteItem, deleteItem.isPending, deleteItem.variables]);

  const onLock = useCallback(() => {
    if (!doc) return;
    if (
      !window.confirm(
        `Zaključati dokument ${doc.documentNumber}? Zaključan dokument se više ne može kalkulisati ni ponovo knjižiti — prelazi u pregled.`,
      )
    )
      return;
    lock.mutate(doc.id, { onSuccess: () => toast('Dokument zaključan.') });
  }, [doc, lock]);

  // Primarna akcija zavisi od statusa — jedan handler za Ctrl+S.
  // Proknjižen a nezaključan → zaključaj; inače DRAFT→kalkuliši, CALCULATED→knjiži.
  const primaryAction = useCallback(() => {
    if (!doc) return;
    if (isLocked) return;
    if (isBooked) {
      onLock();
    } else if (doc.status === ROBNO_STATUS.DRAFT) {
      calculate.mutate(doc.id);
    } else if (doc.status === ROBNO_STATUS.CALCULATED) {
      post.mutate(doc.id);
    }
  }, [doc, isBooked, isLocked, onLock, calculate, post]);

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
    (lock.error as Error | null)?.message ??
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
            {doc && <PrintActions doc={doc} />}
            {doc && (
              <PrimaryActions
                doc={doc}
                calculate={calculate}
                post={post}
                lock={lock}
                onLock={onLock}
              />
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
            title="Dokument nije pronađen"
            hint={
              validId == null
                ? 'Adresa nema ispravan broj dokumenta (?id=). Vrati se na radnu listu i otvori dokument iz liste.'
                : 'Dokument je možda obrisan ili nemaš pristup. Vrati se na radnu listu.'
            }
          />
        ) : (
          <>
            <DocumentHeader doc={doc} />

            {/* Prenos: obe strane para + storno. Detalj jedne strane bez druge ne
                govori gde je roba otišla. */}
            <TransferPanel doc={doc} />

            {/* Uslovi otpreme — polja koja štampa otpremnica. Dok su prazna, papir
                ostavlja liniju za ručni upis (ranije je štampao izmišljene konstante). */}
            <ShippingPanel doc={doc} />

            <section className="space-y-2">
              <h2 className="text-md font-semibold text-ink">Stavke</h2>
              <DataTable
                columns={itemColumnsWithActions}
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

      {pending && (
        <UndoToast
          key={pending.itemLineId}
          message={`${pending.label} obrisana.`}
          onUndo={onUndoDelete}
          onDismiss={onDismissUndo}
          undoing={restoreItem.isPending}
        />
      )}
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
      {/* Napomena se prikazuje i menja u panelu „Uslovi otpreme" (ShippingPanel) —
          ovde je ranije stajala kopija bez načina da se upiše, jer kolone `note`
          uopšte nije bilo (FE tip ju je deklarisao, baza nije imala polje). */}
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
 * Štampa dokumenta — izbor obrasca (kad ih vrsta dokumenta ima više) + „Štampaj".
 * Ulaz (UL) nudi Prijemnicu i Kalkulaciju (obrazac KL), izlaz (IZ) Izdatnicu i
 * Otpremnicu (bez cena, za vozača). PDF se otvara u novom tabu — ruta traži
 * Authorization header, pa ide kroz `apiBlob`, ne kroz običan link.
 */
function PrintActions({ doc }: { doc: StockDocumentDetail }) {
  const variants = printVariantsForKind(doc.kind);
  const [variant, setVariant] = useState<RobnoPrintVariant>(variants[0]);
  const pdf = useStockDocumentPdf();
  const receiptReport = useGoodsReceiptReportPdf();

  // Promena vrste dokumenta (novi detalj) vraća izbor na podrazumevani obrazac.
  useEffect(() => {
    setVariant(variants[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.kind]);

  return (
    <div className="flex items-center gap-2">
      {variants.length > 1 && (
        <div className="w-52">
          <Select
            aria-label="Obrazac štampe"
            value={variant}
            onChange={(e) => setVariant(e.target.value as RobnoPrintVariant)}
            options={variants.map((v) => ({ value: v, label: ROBNO_PRINT_LABEL[v] }))}
          />
        </div>
      )}
      {/* `trackPrint` = ovo JESTE štampa: backend upisuje trag i od drugog primerka
          papir nosi žig „KOPIJA". Otvaranje dokumenta se ne broji. */}
      <Button
        variant="secondary"
        loading={pdf.isPending}
        title={`Štampa: ${ROBNO_PRINT_LABEL[variant]} — svaka štampa se beleži; ponovljena nosi oznaku „KOPIJA"`}
        onClick={() =>
          pdf.mutate({ id: doc.id, variant, trackPrint: true }, {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
          })
        }
      >
        <Printer className="h-4 w-4" aria-hidden />
        Štampaj
      </Button>
      {/* Pregled je odvojen od štampe upravo zato da ne troši primerak. */}
      <Button
        variant="ghost"
        loading={pdf.isPending}
        title="Otvori PDF radi provere — ne beleži se kao štampa i ne nosi oznaku „KOPIJA”"
        onClick={() =>
          pdf.mutate({ id: doc.id, variant }, {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Pregled nije uspeo: ${(e as Error).message}`),
          })
        }
      >
        Pregled
      </Button>
      {/* Zapisnik o prijemu je ODVOJEN dokument od prijemnice (poredi naručeno sa
          primljenim + nalaz kontrole), pa ima svoje dugme, ne stavku u meniju. */}
      {doc.kind === ROBNO_KIND.UL && (
        <Button
          variant="secondary"
          loading={receiptReport.isPending}
          title="Zapisnik o prijemu robe (kvantitativno-kvalitativni) — poređenje sa narudžbenicom + prazne kolone za nalaz kontrole"
          onClick={() =>
            receiptReport.mutate(doc.id, {
              onSuccess: (blob) => openPdf(blob),
              onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
            })
          }
        >
          <Printer className="h-4 w-4" aria-hidden />
          Zapisnik o prijemu
        </Button>
      )}
    </div>
  );
}

/**
 * Status-uslovljena dugmad: DRAFT → Kalkuliši; CALCULATED (bez naloga) → Knjiži;
 * proknjižen (ima nalog GK) a nezaključan → Zaključaj. Zaključan dokument nema akciju.
 */
function PrimaryActions({
  doc,
  calculate,
  post,
  lock,
  onLock,
}: {
  doc: StockDocumentDetail;
  calculate: ReturnType<typeof useCalculate>;
  post: ReturnType<typeof usePost>;
  lock: ReturnType<typeof useLockDocument>;
  onLock: () => void;
}) {
  if (doc.status === ROBNO_STATUS.LOCKED) return null;
  // Proknjižen dokument (journalEntryId) se ne re-knjiži — jedina akcija je zaključavanje.
  if (doc.journalEntryId != null) {
    return (
      <Button variant="secondary" onClick={onLock} loading={lock.isPending}>
        Zaključaj
      </Button>
    );
  }
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
