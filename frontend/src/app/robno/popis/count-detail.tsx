'use client';

import { toast } from '@/lib/toast';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Printer } from 'lucide-react';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Tabs } from '@/components/ui-kit/tabs';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useInventoryCount,
  useInventoryDifferences,
  useUpdateCountItem,
  useFinalizeInventoryCount,
  POPIS_STATUS,
  type PopisStatus,
  type InventoryCountItem,
  type DifferenceItem,
  type FinalizeResult,
} from '@/api/inventory';
import { useInventoryCountPdf, openPdf } from '@/api/robno';

/** POPIS status -> { tone, label } (kanonska mapa DESIGN_SYSTEM 7). */
export function popisStatusMeta(status: PopisStatus): { tone: Tone; label: string } {
  switch (status) {
    case POPIS_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case POPIS_STATUS.COUNTING:
      return { tone: 'info', label: 'Popisivanje' };
    case POPIS_STATUS.POSTED:
      return { tone: 'success', label: 'Zakljucen' };
    default:
      return { tone: 'neutral', label: status };
  }
}

type DetailView = 'items' | 'differences';

const DETAIL_TABS = [
  { key: 'items' as const, label: 'Stavke' },
  { key: 'differences' as const, label: 'Razlike' },
];

/** Znak razlike -> token boje (visak = success, manjak = danger, 0 = neutral). */
function signClass(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n === 0) return 'text-ink-secondary';
  return n > 0 ? 'text-status-success' : 'text-status-danger';
}

/**
 * Editabilna celija Popisano: inline broj koji PATCH-uje na blur/Enter, samo u
 * statusu COUNTING (knjigovodstveno stanje je uvek readonly). Lokalno stanje se
 * resetuje kad server vrati novu vrednost (posle invalidacije). Klik ne sme da
 * aktivira red tabele (stopPropagation).
 */
function CountedCell({
  countId,
  item,
  editable,
}: {
  countId: number;
  item: InventoryCountItem;
  editable: boolean;
}) {
  const update = useUpdateCountItem();
  const [value, setValue] = useState(item.countedQuantity ?? '');

  useEffect(() => {
    setValue(item.countedQuantity ?? '');
  }, [item.countedQuantity]);

  if (!editable) {
    return <span className="tnums text-ink">{formatDecimal(item.countedQuantity)}</span>;
  }

  const commit = () => {
    const trimmed = String(value).trim();
    if (trimmed === '') return;
    const n = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) return;
    if (Number(item.countedQuantity) === n) return;
    update.mutate({ countId, itemId: item.itemId, countedQuantity: n });
  };

  return (
    <input
      type="number"
      step="0.001"
      min="0"
      inputMode="decimal"
      aria-label="Popisana kolicina"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="tnums h-8 w-24 rounded-control border border-line bg-surface px-2 text-right text-sm text-ink focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] disabled:bg-surface-2"
      disabled={update.isPending}
    />
  );
}

/**
 * Detalj popisa (panel po selekciji -- NE [id] ruta). Zaglavlje (broj, datum,
 * magacin, status) + Tabs: Stavke (editabilno Popisano u COUNTING) i Razlike
 * (book/counted/diff/vrednost + zbirovi VISAK/MANJAK). Dugme Zakljuci popis
 * kreira VISAK/MANJAK robne dokumente i prikazuje njihove id-eve; disabled kad
 * je popis POSTED. Idiom: robno/saldakonti postojeci paneli.
 */
export function CountDetail({ countId }: { countId: number }) {
  const router = useRouter();
  const can = useCan();
  const canWrite = can(PERMISSIONS.ROBNO_WRITE);
  const canPost = can(PERMISSIONS.ROBNO_POST);

  const [view, setView] = useState<DetailView>('items');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<FinalizeResult | null>(null);

  const detail = useInventoryCount(countId);
  const differences = useInventoryDifferences(countId, view === 'differences');
  const finalize = useFinalizeInventoryCount();
  const pdf = useInventoryCountPdf();

  // Reset lokalnog stanja pri promeni selektovanog popisa.
  useEffect(() => {
    setView('items');
    setResult(null);
    setConfirmOpen(false);
  }, [countId]);

  const count = detail.data?.data ?? null;
  const items = count?.items ?? [];
  const diff = differences.data?.data ?? null;
  // BE `differences.items` nosi SVE stavke (i nula-diff); u tabu Razlike prikazujemo
  // samo stavke sa stvarnom razlikom (broj = summary.surplusCount + shortageCount).
  const diffRows = (diff?.items ?? []).filter((r) => Number(r.diff) !== 0);

  const status = count?.status ?? POPIS_STATUS.DRAFT;
  const isPosted = status === POPIS_STATUS.POSTED;
  const editable = status === POPIS_STATUS.COUNTING && canWrite;

  /**
   * DOKUMENTI RAZLIKE — izvor je SERVER, `result` je samo trenutna dopuna.
   *
   * `result` je odgovor upravo izvrsenog zakljucivanja i zivi u `useState`: povratak sa
   * dokumenta viska remontira stranu i brise ga, pa je nestajalo dugme za MANJAK — popis
   * koji je dao i visak i manjak ostavljao je magacionera bez ijednog puta do drugog
   * dokumenta, a upravo zbog tog drugog se i vraca. Detalj popisa sada nosi oba id-a
   * (`stock_documents.inventory_count_id`), pa dugmad prezivljavaju i povratak, i
   * osvezavanje, i otvaranje popisa na drugoj masini.
   *
   * `result` ostaje prvi u redu samo zato sto invalidacija detalja stigne kadar-dva
   * kasnije — bez njega bi dugmad na tren treperila odmah po zakljucivanju. Vazi SAMO za
   * svoj popis: efekat koji ga cisti pri promeni `countId` radi tek posle prvog rendera,
   * pa bi bez ove provere klik na drugi popis na tren nudio dokument prethodnog.
   */
  const svez = result?.countId === countId ? result : null;
  const visakDocId = svez?.visakDocId ?? count?.visakDocId ?? null;
  const manjakDocId = svez?.manjakDocId ?? count?.manjakDocId ?? null;
  // Odmah po zakljucivanju traka se prikazuje i kad razlika nije bilo (poruka „Bez viska /
  // Bez manjka" je potvrda da je radnja prosla); kasnije samo ako dokument stvarno postoji.
  const prikaziDokumente =
    svez != null || (isPosted && (visakDocId != null || manjakDocId != null));

  const itemColumns: Column<InventoryCountItem>[] = [
    {
      key: 'item',
      header: 'Artikal',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{r.itemName ?? `#${r.itemId}`}</div>
          <div className="tnums text-2xs text-ink-secondary">{r.itemCode ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'bookQuantity',
      header: 'Knjigovodstveno',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.bookQuantity, 3)}</span>,
    },
    {
      key: 'countedQuantity',
      header: 'Popisano',
      align: 'right',
      numeric: true,
      render: (r) => <CountedCell countId={countId} item={r} editable={editable} />,
    },
    {
      key: 'price',
      header: 'Cena',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.price)}</span>,
    },
  ];

  const diffColumns: Column<DifferenceItem>[] = [
    {
      key: 'item',
      header: 'Artikal',
      render: (r) => <span className="text-ink">{r.naziv ?? `#${r.itemId}`}</span>,
    },
    {
      key: 'book',
      header: 'Knjigovodstveno',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.book, 3)}</span>,
    },
    {
      key: 'counted',
      header: 'Popisano',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.counted, 3)}</span>,
    },
    {
      key: 'diff',
      header: 'Razlika',
      align: 'right',
      numeric: true,
      render: (r) => <span className={`tnums ${signClass(r.diff)}`}>{formatDecimal(r.diff, 3)}</span>,
    },
    {
      key: 'price',
      header: 'Cena',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.price)}</span>,
    },
    {
      key: 'diffValue',
      header: 'Vrednost razlike',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className={`tnums font-semibold ${signClass(r.diffValue)}`}>
          {formatDecimal(r.diffValue)}
        </span>
      ),
    },
  ];

  const meta = popisStatusMeta(status);
  const finalizeErr = (finalize.error as Error | null)?.message ?? null;

  function runFinalize() {
    finalize.mutate(countId, {
      onSuccess: (res) => {
        setResult(res.data);
        setConfirmOpen(false);
      },
    });
  }

  return (
    <section className="space-y-4 rounded-panel border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 className="text-md font-semibold text-ink">
            Popis {count ? count.countNumber : `#${countId}`}
          </h2>
          {count && (
            <>
              <span className="text-sm text-ink-secondary">{formatDate(count.countDate)}</span>
              <span className="tnums text-sm text-ink-secondary">Magacin #{count.warehouseId}</span>
              <StatusBadge tone={meta.tone} label={meta.label} />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Popisna lista je ZAKONSKI obrazac — dve varijante iz istog šablona:
              „prazna" ide na teren (bez knjigovodstvenog stanja i cena, sa bar kodom),
              „popunjena" nosi razlike višak/manjak i zbirove. */}
          <Button
            variant="secondary"
            disabled={!count}
            loading={pdf.isPending && pdf.variables?.variant === 'prazna'}
            title="Popisna lista za teren — bez knjigovodstvenog stanja i cena, sa bar kodom i praznim poljima"
            onClick={() =>
              pdf.mutate(
                { id: countId, variant: 'prazna' },
                {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
          },
              )
            }
          >
            <Printer className="h-4 w-4" aria-hidden />
            Prazna lista
          </Button>
          <Button
            variant="secondary"
            disabled={!count}
            loading={pdf.isPending && pdf.variables?.variant === 'popunjena'}
            title="Popisna lista sa knjigovodstvenim stanjem, popisanim količinama, viškom/manjkom i zbirovima"
            onClick={() =>
              pdf.mutate(
                { id: countId, variant: 'popunjena' },
                {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
          },
              )
            }
          >
            <Printer className="h-4 w-4" aria-hidden />
            Štampaj popisnu listu
          </Button>

        {canPost && (
          <Button
            variant="primary"
            disabled={isPosted || !count}
            loading={finalize.isPending}
            title={
              isPosted
                ? 'Popis je vec zakljucen'
                : 'Zakljucivanjem se iz razlika kreiraju VISAK i MANJAK robni dokumenti'
            }
            onClick={() => setConfirmOpen(true)}
          >
            Zakljuci popis
          </Button>
        )}
        </div>
      </div>

      {pdf.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(pdf.error as Error).message}
        </div>
      )}

      {detail.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(detail.error as Error).message}
        </div>
      )}

      {prikaziDokumente && (
        <div className="space-y-2 rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success">
          <div className="font-medium">Popis je zakljucen. Kreirani robni dokumenti:</div>
          <div className="flex flex-wrap gap-2">
            {visakDocId != null ? (
              <Button
                variant="secondary"
                onClick={() => router.push(`/robno/detalj?id=${visakDocId}&izvor=popis`)}
              >
                Visak (dokument #{visakDocId})
              </Button>
            ) : (
              <span className="text-ink-secondary">Bez viska</span>
            )}
            {manjakDocId != null ? (
              <Button
                variant="secondary"
                onClick={() => router.push(`/robno/detalj?id=${manjakDocId}&izvor=popis`)}
              >
                Manjak (dokument #{manjakDocId})
              </Button>
            ) : (
              <span className="text-ink-secondary">Bez manjka</span>
            )}
          </div>
        </div>
      )}

      {finalizeErr && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {finalizeErr}
        </div>
      )}

      <Tabs tabs={DETAIL_TABS} value={view} onChange={setView} ariaLabel="Popis pogledi" />

      {view === 'items' ? (
        <>
          {status === POPIS_STATUS.COUNTING && !canWrite && (
            <div className="text-xs text-ink-secondary">
              Nemate pravo izmene popisanih kolicina (potrebna dozvola robno.write).
            </div>
          )}
          <DataTable
            columns={itemColumns}
            rows={items}
            rowKey={(r) => r.id}
            loading={detail.isLoading}
            empty={
              <EmptyState
                title="Nema stavki"
                hint="Stavke popisa se predpunjavaju knjigovodstvenim stanjem magacina pri kreiranju."
              />
            }
          />
        </>
      ) : (
        <>
          {differences.error && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {(differences.error as Error).message}
            </div>
          )}

          {diff && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="text-ink-secondary">
                VISAK:{' '}
                <span className="tnums font-semibold text-status-success">
                  {formatDecimal(diff.summary.surplusValue)}
                </span>
              </span>
              <span className="text-ink-secondary">
                MANJAK:{' '}
                <span className="tnums font-semibold text-status-danger">
                  {formatDecimal(diff.summary.shortageValue)}
                </span>
              </span>
              <span className="text-ink-secondary">
                {formatNumber(diff.summary.surplusCount + diff.summary.shortageCount)} stavki sa
                razlikom
              </span>
            </div>
          )}

          <DataTable
            columns={diffColumns}
            rows={diffRows}
            rowKey={(r) => r.itemId}
            loading={differences.isLoading}
            empty={
              <EmptyState
                title="Nema razlika"
                hint="Razlika je nula za sve stavke, ili popisane kolicine jos nisu unete."
              />
            }
          />
        </>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Zakljuci popis"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={finalize.isPending}>
              Otkazi
            </Button>
            <Button onClick={runFinalize} loading={finalize.isPending}>
              Zakljuci popis
            </Button>
          </div>
        }
      >
        <p className="text-sm text-ink-secondary">
          Zakljucivanjem popisa iz razlika se kreiraju VISAK i MANJAK robni dokumenti, a popis
          prelazi u status Zakljucen. Radnja se ne moze poništiti.
        </p>
      </Dialog>
    </section>
  );
}
