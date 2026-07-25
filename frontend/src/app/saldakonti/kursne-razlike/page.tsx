'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Dialog } from '@/components/ui-kit/dialog';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useFxRevaluationList,
  useFxRevaluationPreview,
  useFxRevaluationReverse,
  useFxRevaluationRun,
  type FxRevaluationFlaggedItem,
  type FxRevaluationItem,
  type FxRevaluationRun,
} from '@/api/saldakonti';

/**
 * KURSNE RAZLIKE — revalorizacija deviznih otvorenih stavki na dan bilansa (C2).
 * Obrazac „Lista + akcija" (DESIGN_SYSTEM §4.1): filter traka (datum preseka +
 * valuta) → „Proveri" (pregled bez upisa) → „Obračunaj kursne razlike" (knjiži
 * nalog 663/563). Ispod je lista ranijih obračuna sa akcijom „Storniraj".
 *
 * Zakonska obaveza: devizna potraživanja/obaveze se na dan bilansa preračunavaju
 * po kursu tog dana; razlika je prihod (663) ili rashod (563) perioda.
 *
 * NOVAC: Decimal stiže kao STRING — `formatDecimal` na prikazu (zarez, tabular-nums);
 * sabiranje ne radimo u pretraživaču, zbirove daje backend.
 * TASTATURA: Enter u filter traci = „Proveri"; Esc čisti pregled i zatvara dijalog.
 */

/**
 * Valute za obračun. Kratka fiksna lista → `Select` (DESIGN_SYSTEM §10; ComboBox je
 * za šifarnike sa servera). Kursna lista na backendu prima bilo koju valutu — ako
 * Servoteh počne da posluje u još nekoj, dodaje se ovde jedan red.
 */
const CURRENCIES = [
  { value: 'EUR', label: 'EUR — evro' },
  { value: 'USD', label: 'USD — američki dolar' },
  { value: 'CHF', label: 'CHF — švajcarski franak' },
  { value: 'GBP', label: 'GBP — britanska funta' },
];

const INPUT_CLASS =
  'h-9 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Podrazumevani presek = 31.12. prethodne godine (godišnje zatvaranje). */
function defaultAsOfDate(): string {
  const now = new Date();
  const year = now.getMonth() === 11 && now.getDate() === 31 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-12-31`;
}

/** Status obračuna → ton + srpska labela (kanonska mapa §7, postojeći tonovi). */
function runMeta(status: string): { tone: Tone; label: string } {
  if (status === 'REVERSED') return { tone: 'danger', label: 'Storniran' };
  if (status === 'POSTED') return { tone: 'success', label: 'Proknjižen' };
  return { tone: 'neutral', label: status };
}

/**
 * Panel grupa koje obračun NE knjiži (više valuta u istoj grupi / nesaglasan devizni
 * par). Ove stavke ne smeju tiho da ispadnu iz bilansa — zato imaju svoj vidljiv blok
 * sa punom porukom backenda (uzrok + šta uraditi), a ne samo brojač.
 */
function FlaggedPanel({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: FxRevaluationFlaggedItem[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm">
      <p className="font-semibold text-status-warn">
        {title} ({rows.length})
      </p>
      <p className="mt-1 text-xs text-ink-secondary">{hint}</p>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r, i) => (
          <li key={`${r.accountCode}|${r.analyticalCode ?? ''}|${r.documentNumber ?? ''}|${i}`}>
            <span className="tnums font-semibold text-ink">
              {r.accountCode} · {r.analyticalCode ?? '—'} ·{' '}
              {r.documentNumber ?? 'bez broja dokumenta'}
            </span>
            {r.included && (
              <span className="ml-2 text-xs text-ink-secondary">(uključeno u obračun)</span>
            )}
            <span className="block text-ink-secondary">{r.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function KursneRazlikePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const canPost = can(PERMISSIONS.SALDAKONTI_RECONCILE);

  const [asOfDate, setAsOfDate] = useState(defaultAsOfDate);
  const [currency, setCurrency] = useState('EUR');
  const [note, setNote] = useState('');
  // Svesna odstupanja (backend ih traži eksplicitno, ne pretpostavlja):
  //   allowStaleRate = kursna lista za dan preseka nije uneta, radi se po ranijem kursu;
  //   force          = sporne grupe (nesaglasan devizni/dinarski saldo) ulaze u obračun.
  const [allowStaleRate, setAllowStaleRate] = useState(false);
  const [force, setForce] = useState(false);
  // Primenjeni presek („Proveri") — odvojen od unosa da promena polja ne okida
  // upit nad celom glavnom knjigom niti ne poništi već prikazan pregled.
  const [applied, setApplied] = useState<{
    asOfDate: string;
    currency: string;
    allowStaleRate: boolean;
    force: boolean;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<FxRevaluationRun | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [banner, setBanner] = useState<{ tone: 'success' | 'warn'; msg: string } | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const preview = useFxRevaluationPreview(applied);
  const runs = useFxRevaluationList();
  const runMutation = useFxRevaluationRun();
  const reverseMutation = useFxRevaluationReverse();

  const data = preview.data?.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const runRows = runs.data?.data ?? [];

  /** Esc = odustani od pregleda / zatvori dijaloge (DESIGN_SYSTEM §8). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirmOpen || reverseTarget) return; // Dialog sam gasi svoj Esc
      setApplied(null);
      setBanner(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmOpen, reverseTarget]);

  function check() {
    setBanner(null);
    setApplied({ asOfDate, currency, allowStaleRate, force });
  }

  function doRun() {
    if (!applied || !data) return;
    runMutation.mutate(
      {
        asOfDate: applied.asOfDate,
        currency: applied.currency,
        note: note.trim() || undefined,
        allowStaleRate: applied.allowStaleRate || undefined,
        force: applied.force || undefined,
        // Vezuje potvrdu za PREGLED koji je korisnik video — ako se kurs ili stanje
        // promene u međuvremenu, backend vraća 409 umesto tihog drugog iznosa.
        expectedRate: data.rate,
        expectedNetAmount: data.netAmount,
      },
      {
        onSuccess: (res) => {
          setConfirmOpen(false);
          setBanner({
            tone: 'success',
            msg:
              `Kursne razlike obračunate: nalog KR-${res.data.journalNumber} · ` +
              `${res.data.itemsCount} stavki · dobitak ${formatDecimal(res.data.gainAmount)} · ` +
              `gubitak ${formatDecimal(res.data.lossAmount)}.`,
          });
          setNote('');
        },
      },
    );
  }

  function doReverse() {
    if (!reverseTarget) return;
    reverseMutation.mutate(
      { runId: reverseTarget.id, reason: reverseReason.trim() || undefined },
      {
        onSuccess: () => {
          setBanner({
            tone: 'warn',
            msg:
              `Obračun od ${formatDate(reverseTarget.asOfDate)} (${reverseTarget.currency}) je storniran — ` +
              `presek je oslobođen za ponovni obračun.`,
          });
          setReverseTarget(null);
          setReverseReason('');
        },
      },
    );
  }

  const itemColumns: Column<FxRevaluationItem>[] = [
    {
      key: 'accountCode',
      header: 'Konto',
      render: (r) => <span className="tnums font-semibold text-ink">{r.accountCode}</span>,
    },
    {
      key: 'partner',
      header: 'Komitent',
      render: (r) => <span className="tnums text-ink">{r.analyticalCode ?? '—'}</span>,
    },
    {
      key: 'documentNumber',
      header: 'Dokument',
      render: (r) => <span className="tnums text-ink-secondary">{r.documentNumber ?? '—'}</span>,
    },
    {
      key: 'fxAmount',
      header: `Devizni saldo${data ? ` (${data.currency})` : ''}`,
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.fxAmount)}</span>,
    },
    {
      key: 'bookedAmount',
      header: 'Knjigovodstveno (RSD)',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.bookedAmount)}</span>,
    },
    {
      key: 'revaluedAmount',
      header: 'Po kursu na dan (RSD)',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink">{formatDecimal(r.revaluedAmount)}</span>,
    },
    {
      key: 'difference',
      header: 'Razlika',
      align: 'right',
      numeric: true,
      render: (r) => {
        const positive = Number(r.difference) > 0;
        const zero = Number(r.difference) === 0;
        return (
          <span
            className={`tnums font-semibold ${
              zero ? 'text-ink-secondary' : positive ? 'text-status-success' : 'text-status-danger'
            }`}
          >
            {formatDecimal(r.difference)}
          </span>
        );
      },
    },
    {
      key: 'target',
      header: 'Knjiži se na',
      render: (r) => {
        const diff = Number(r.difference);
        if (diff === 0) return <span className="text-ink-secondary">—</span>;
        return diff > 0 ? (
          <StatusBadge tone="success" label="663 prihod" />
        ) : (
          <StatusBadge tone="danger" label="563 rashod" />
        );
      },
    },
  ];

  const runColumns: Column<FxRevaluationRun>[] = [
    {
      key: 'asOfDate',
      header: 'Datum preseka',
      render: (r) => <span className="tnums text-ink">{formatDate(r.asOfDate)}</span>,
    },
    {
      key: 'currency',
      header: 'Valuta',
      render: (r) => <span className="font-semibold text-ink">{r.currency}</span>,
    },
    {
      key: 'rateUsed',
      header: 'Kurs',
      align: 'right',
      numeric: true,
      // Revizorski trag: kurs je mogao biti sa ranijeg dana (kursna lista za presek
      // nije uneta) — tada se datum liste ističe, jer to menja ceo obračun.
      render: (r) => {
        const stale =
          r.rateDate != null && r.rateDate.slice(0, 10) !== r.asOfDate.slice(0, 10);
        return (
          <span className="tnums text-ink">
            {formatDecimal(r.rateUsed, 6)}
            {stale && (
              <span className="block text-xs text-status-warn">
                lista {formatDate(r.rateDate)}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'itemsCount',
      header: 'Stavki',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{r.itemsCount}</span>,
    },
    {
      key: 'gainAmount',
      header: 'Dobitak (663)',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-status-success">{formatDecimal(r.gainAmount)}</span>,
    },
    {
      key: 'lossAmount',
      header: 'Gubitak (563)',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-status-danger">{formatDecimal(r.lossAmount)}</span>,
    },
    {
      key: 'journalEntryId',
      header: 'Nalog',
      render: (r) => <span className="tnums text-ink-secondary">{r.journalEntryId ?? '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const m = runMeta(r.status);
        return <StatusBadge tone={m.tone} label={m.label} />;
      },
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        canPost && r.status !== 'REVERSED' ? (
          <Button
            type="button"
            variant="ghost"
            title="Storniraj nalog kursnih razlika i oslobodi presek za ponovni obračun"
            onClick={() => {
              setReverseReason('');
              setReverseTarget(r);
            }}
          >
            Storniraj
          </Button>
        ) : null,
    },
  ];

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const hasDifference =
    data != null && items.some((i) => Number(i.difference) !== 0);

  return (
    <AppShell>
      <PageHeader
        title="Kursne razlike"
        count={data ? `${data.itemsCount} deviznih stavki` : undefined}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <p className="max-w-3xl text-sm text-ink-secondary">
          Na dan bilansa devizna potraživanja i obaveze se preračunavaju po kursu tog dana.
          Razlika između knjigovodstvene i nove protivvrednosti knjiži se kao prihod (konto
          663) odnosno rashod (konto 563). Obračun po preseku i valuti se radi jednom —
          ponovni obračun traži prethodni storno.
        </p>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            check();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Datum preseka
            <input
              type="date"
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
              className={`tnums w-44 ${INPUT_CLASS}`}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Valuta
            <span className="w-56">
              <Select
                options={CURRENCIES}
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="text-sm"
              />
            </span>
          </label>

          <label
            className="inline-flex items-center gap-2 pb-2 text-sm text-ink"
            title="Kad kursna lista za dan preseka nije uneta, obračun se radi po poslednjem ranijem kursu — datum tog kursa ostaje zapisan uz obračun."
          >
            <input
              type="checkbox"
              checked={allowStaleRate}
              onChange={(e) => setAllowStaleRate(e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Dozvoli raniji kurs
          </label>

          <label
            className="inline-flex items-center gap-2 pb-2 text-sm text-ink"
            title="Uključi i grupe kod kojih se devizni i dinarski saldo ne slažu (najčešće delimično zatvaranje knjiženo samo u dinarima)."
          >
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
              className="h-4 w-4 rounded border-line"
            />
            Uključi sporne stavke
          </label>

          <Button type="submit" variant="secondary" loading={preview.isFetching}>
            Proveri
          </Button>

          {applied && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setApplied(null);
                setBanner(null);
              }}
            >
              Očisti
            </Button>
          )}
        </form>

        {preview.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(preview.error as Error).message}
          </div>
        )}

        {runMutation.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(runMutation.error as Error).message}
          </div>
        )}

        {reverseMutation.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(reverseMutation.error as Error).message}
          </div>
        )}

        {banner && (
          <div
            className={`rounded-panel border px-4 py-3 text-sm ${
              banner.tone === 'success'
                ? 'border-status-success/40 bg-status-success-bg text-status-success'
                : 'border-status-warn/40 bg-status-warn-bg text-status-warn'
            }`}
          >
            {banner.msg}
          </div>
        )}

        {data && (
          <>
            <FlaggedPanel
              title="Grupe sa više valuta — nisu obračunate"
              hint="Stavke istog konta i komitenta bez broja dokumenta padaju u istu grupu, pa grupa nema jedinstven devizni saldo. Dopuni broj dokumenta na tim stavkama pa ponovi obračun."
              rows={data.mixedCurrencyGroups}
            />
            <FlaggedPanel
              title={
                data.forced
                  ? 'Sporne stavke — svesno UKLJUČENE u obračun'
                  : 'Sporne stavke — nisu obračunate'
              }
              hint="Devizni i dinarski saldo grupe se ne slažu sa kursom na dan. Najčešći uzrok je delimično zatvaranje knjiženo samo u dinarima (bez deviznog para) — takva razlika je iznos plaćanja, ne kursna razlika."
              rows={data.flagged}
            />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span className="text-ink-secondary">
                  Kurs ({data.currency}, srednji):{' '}
                  <span className="tnums font-semibold text-ink">
                    {formatDecimal(data.rate, 6)}
                  </span>{' '}
                  <span className={data.staleRate ? 'text-status-warn' : 'text-ink-secondary'}>
                    (kursna lista {formatDate(data.rateDate)}
                    {data.staleRate ? ' — nije dan preseka' : ''})
                  </span>
                </span>
                <span className="text-ink-secondary">
                  Dobitak (663):{' '}
                  <span className="tnums font-semibold text-status-success">
                    {formatDecimal(data.gainTotal)}
                  </span>
                </span>
                <span className="text-ink-secondary">
                  Gubitak (563):{' '}
                  <span className="tnums font-semibold text-status-danger">
                    {formatDecimal(data.lossTotal)}
                  </span>
                </span>
                <span className="text-ink-secondary">
                  Neto:{' '}
                  <span className="tnums font-semibold text-ink">
                    {formatDecimal(data.netAmount)}
                  </span>
                </span>
              </div>

              {canPost && (
                <Button
                  type="button"
                  disabled={!hasDifference}
                  title={
                    hasDifference
                      ? 'Proknjiži nalog kursnih razlika na dan preseka'
                      : 'Nema razlike za knjiženje na izabrani dan'
                  }
                  onClick={() => setConfirmOpen(true)}
                >
                  Obračunaj kursne razlike
                </Button>
              )}
            </div>

            <DataTable
              columns={itemColumns}
              rows={items}
              rowKey={(r) =>
                `${r.accountCode}|${r.analyticalCode ?? ''}|${r.documentNumber ?? ''}`
              }
              loading={preview.isLoading}
              empty={
                <EmptyState
                  title="Nema otvorenih deviznih stavki"
                  hint="Za izabranu valutu i datum preseka nema otvorenih stavki sa deviznim iznosom."
                />
              }
            />
          </>
        )}

        <div className="space-y-2 pt-2">
          <h2 className="text-md font-semibold text-ink">Raniji obračuni</h2>
          <DataTable
            columns={runColumns}
            rows={runRows}
            rowKey={(r) => r.id}
            loading={runs.isLoading}
            empty={
              <EmptyState
                title="Nema obračuna kursnih razlika"
                hint="Izaberi datum preseka i valutu, proveri pregled, pa pokreni obračun."
              />
            }
          />
        </div>
      </div>

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Obračun kursnih razlika"
        dismissable={!runMutation.isPending}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
              Otkaži
            </Button>
            <Button type="button" loading={runMutation.isPending} onClick={doRun}>
              Obračunaj i proknjiži
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink">
          <p>
            Knjiži se nalog kursnih razlika na dan{' '}
            <strong className="tnums">{applied ? formatDate(applied.asOfDate) : '—'}</strong> za
            valutu <strong>{applied?.currency}</strong>:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-ink-secondary">
            <li>
              stavki: <span className="tnums text-ink">{data?.itemsCount ?? 0}</span>
            </li>
            <li>
              prihod (663):{' '}
              <span className="tnums text-status-success">{formatDecimal(data?.gainTotal)}</span>
            </li>
            <li>
              rashod (563):{' '}
              <span className="tnums text-status-danger">{formatDecimal(data?.lossTotal)}</span>
            </li>
          </ul>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Napomena (opciono)
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="npr. godišnje zatvaranje"
              rows={2}
            />
          </label>
          {data?.staleRate && (
            <p className="text-xs text-status-warn">
              Kurs nije sa dana preseka nego sa {formatDate(data.rateDate)} — datum kursne
              liste ostaje zapisan uz obračun.
            </p>
          )}
          {data != null && data.mixedCurrencyGroups.length > 0 && (
            <p className="text-xs text-status-warn">
              {data.mixedCurrencyGroups.length} grupa sa više valuta NIJE u ovom obračunu —
              vidi spisak iznad.
            </p>
          )}
          {data != null && data.flagged.length > 0 && (
            <p className="text-xs text-status-warn">
              {data.flagged.length} spornih grupa{' '}
              {data.forced ? 'je svesno uključeno' : 'NIJE u ovom obračunu'} — vidi spisak iznad.
            </p>
          )}
          <p className="text-xs text-ink-secondary">
            Obračun se za isti presek i valutu radi samo jednom. Ispravka je moguća kroz
            storno, koji oslobađa presek za ponovni obračun.
          </p>
        </div>
      </Dialog>

      <Dialog
        open={reverseTarget != null}
        onClose={() => setReverseTarget(null)}
        title="Storno obračuna kursnih razlika"
        dismissable={!reverseMutation.isPending}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setReverseTarget(null)}>
              Otkaži
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={reverseMutation.isPending}
              onClick={doReverse}
            >
              Storniraj
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink">
          <p>
            Stornira se obračun od{' '}
            <strong className="tnums">
              {reverseTarget ? formatDate(reverseTarget.asOfDate) : '—'}
            </strong>{' '}
            ({reverseTarget?.currency}). Nalog kursnih razlika dobija protiv-nalog, a presek
            se oslobađa za ponovni obračun.
          </p>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Razlog storna (opciono)
            <Textarea
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="npr. pogrešna kursna lista"
              rows={2}
            />
          </label>
          <p className="text-xs text-ink-secondary">
            Ako je nalog u zaključanom periodu, prvo ga otključaj u glavnoj knjizi — storno
            zaključanog naloga se namerno ne dozvoljava.
          </p>
        </div>
      </Dialog>
    </AppShell>
  );
}
