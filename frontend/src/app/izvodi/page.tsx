'use client';

import { toast } from '@/lib/toast';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useListQueryState } from '@/lib/use-id-param';
import { Printer, Upload } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useStatements,
  useImportStatement,
  useStatementPdf,
  openPdf,
  STATEMENT_STATUS,
  STATEMENT_CURRENCIES,
  type StatementStatus,
  type StatementCurrency,
  type BankStatement,
  type ImportStatementInput,
} from '@/api/izvodi';

/**
 * Izvodi (bankovni izvodi): lista izvoda (Faza 4 §B). Obrazac „Lista"
 * (DESIGN_SYSTEM §4.1): filter bar (status + žiro račun) + gusta tabela, skip/take
 * paginacija. Dugme „Uvezi izvod" otvara modal: bira se žiro račun + TXT fajl koji
 * se čita preko FileReader-a u `txtContent` string (upload TXT). Data isključivo
 * kroz `@/api/izvodi` hook-ove; sve od kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) domen „Izvodi — izvod" —
 * DRAFT=neutral, IMPORTED=info, POSTED=success.
 */

const PAGE_SIZE = 50;

/** Status izvoda → { tone, label } (kanonska mapa §7). */
export function statementStatusMeta(status: StatementStatus): { tone: Tone; label: string } {
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

const STATUS_OPTIONS: { value: StatementStatus; label: string }[] = [
  { value: STATEMENT_STATUS.DRAFT, label: 'U pripremi' },
  { value: STATEMENT_STATUS.IMPORTED, label: 'Uvezen' },
  { value: STATEMENT_STATUS.POSTED, label: 'Proknjižen' },
];

const baseColumns: Column<BankStatement>[] = [
  {
    key: 'bankAccount',
    header: 'Žiro račun',
    render: (s) => <span className="tnums text-ink">{s.bankAccount}</span>,
  },
  {
    key: 'statementNumber',
    header: 'Broj',
    render: (s) => <span className="tnums font-semibold text-ink">{s.statementNumber}</span>,
  },
  {
    key: 'statementDate',
    header: 'Datum',
    render: (s) => <span className="text-ink-secondary">{formatDate(s.statementDate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (s) => {
      const m = statementStatusMeta(s.status);
      return <StatusBadge tone={m.tone} label={m.label} />;
    },
  },
  {
    key: 'currency',
    header: 'Valuta',
    render: (s) => (
      <span className={s.currency && s.currency !== 'RSD' ? 'font-semibold text-ink' : 'text-ink-secondary'}>
        {s.currency || 'RSD'}
      </span>
    ),
  },
  {
    key: 'openingBalance',
    header: 'Otvaranje',
    align: 'right',
    numeric: true,
    render: (s) => <span className="tnums text-ink">{formatDecimal(s.openingBalance)}</span>,
  },
  {
    key: 'closingBalance',
    header: 'Zatvaranje',
    align: 'right',
    numeric: true,
    render: (s) => <span className="tnums text-ink">{formatDecimal(s.closingBalance)}</span>,
  },
  {
    key: 'lines',
    header: 'Stavki',
    align: 'right',
    numeric: true,
    render: (s) => <span className="tnums text-ink-secondary">{s._count?.lines ?? '—'}</span>,
  },
];

export default function IzvodiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  // Filteri i strana žive U URL-u (vidi `useListQueryState`) — povratak sa
  // detalja izvoda vraća listu tačno kakva je bila.
  const { values, resolved, setValues } = useListQueryState({ status: '', strana: '1' });
  const status = values.status as StatementStatus | '';
  const page = Math.max(1, Number(values.strana) || 1);
  const setStatus = (v: StatementStatus | '') =>
    setValues({ status: v, strana: '1' });
  const setPage = (updater: number | ((p: number) => number)) =>
    setValues({
      strana: String(typeof updater === 'function' ? updater(page) : updater),
    });
  const [importOpen, setImportOpen] = useState(false);
  const resetPage = () => setValues({ strana: '1' });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  /**
   * 🔴 `enabled: resolved` — upit čeka da se filteri pročitaju iz adrese (isto kao
   * `/robno`). Bez gejta prvi render gađa podrazumevani ključ, koji po pravilu VEĆ ima
   * podatke u kešu, pa ekran ispaint-uje nefiltriranu stranu 1 i tek je drugi render
   * zameni. `enabled: false` gasi ZAHTEV, ali ne i čitanje keša — zato brana ide i na
   * tabelu, brojač i pager.
   */
  const list = useStatements(
    { status, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE },
    { enabled: resolved },
  );
  // Štampa izvoda direktno iz liste (bez ulaska u detalj) — `stopPropagation` da
  // klik na dugme ne otvori i red.
  const statementPdf = useStatementPdf();
  const columns: Column<BankStatement>[] = [
    ...baseColumns,
    {
      key: 'print',
      header: 'Štampa',
      render: (s) => (
        <Button
          variant="ghost"
          aria-label={`Štampaj izvod ${s.statementNumber}`}
          title="Štampa izvoda (PDF)"
          onClick={(e) => {
            e.stopPropagation();
            statementPdf.mutate(s.id, {
            onSuccess: (blob) => openPdf(blob),
            onError: (e) => toast(`Štampa nije uspela: ${(e as Error).message}`),
          });
          }}
        >
          <Printer className="h-4 w-4" aria-hidden />
        </Button>
      ),
    },
  ];
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const hasFilter = status !== '';

  return (
    <AppShell>
      <PageHeader
        title="Izvodi"
        count={resolved && list.data ? `${formatNumber(total)} izvoda` : undefined}
        actions={
          <Button onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" aria-hidden />
            Uvezi izvod
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as StatementStatus | '');
                  resetPage();
                }}
                options={STATUS_OPTIONS}
              />
            </div>
          </label>

          {hasFilter && (
            <button
              onClick={() => {
                setStatus('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {(list.error || statementPdf.error) && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {((list.error ?? statementPdf.error) as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          onRowActivate={(s) => router.push(`/izvodi/detalj?id=${s.id}`)}
          // Dok upit čeka filtere iz adrese `isLoading` je `false`, pa bi tabela na tren
          // nacrtala „Nema izvoda".
          loading={!resolved || list.isLoading}
          empty={
            <EmptyState
              title="Nema izvoda"
              hint="Uvezi bankovni izvod (TXT) dugmetom „Uvezi izvod“ u zaglavlju."
            />
          }
        />

        {/* I pager čeka `resolved`: pre toga `totalPages` opisuje tuđi (podrazumevani)
            ključ, pa bi „Prethodna/Sledeća" pomerala stranu nad brojem koji nije ovaj. */}
        {resolved && totalPages > 1 && (
          <Pager
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        )}
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(id) => {
          setImportOpen(false);
          router.push(`/izvodi/detalj?id=${id}`);
        }}
      />
    </AppShell>
  );
}

/**
 * Modal za uvoz izvoda. TXT fajl se bira preko `<input type="file">` i čita
 * FileReader-om (`readAsText`) u `txtContent` string koji ide u telo POST /izvodi.
 * Žiro račun / broj izvoda / datum su ručni unos (nema server lookup-a žiro računa).
 */
function ImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (id: number) => void;
}) {
  const importMut = useImportStatement();

  const [bankAccount, setBankAccount] = useState('');
  const [statementNumber, setStatementNumber] = useState('');
  const [statementDate, setStatementDate] = useState('');
  const [currency, setCurrency] = useState<StatementCurrency>('RSD');
  const [fileName, setFileName] = useState('');
  const [txtContent, setTxtContent] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset polja pri svakom otvaranju (svež unos, bez zaostalog fajla).
  useEffect(() => {
    if (open) {
      setBankAccount('');
      setStatementNumber('');
      setStatementDate('');
      setCurrency('RSD');
      setFileName('');
      setTxtContent('');
      setReadError(null);
      importMut.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setReadError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setFileName('');
      setTxtContent('');
      return;
    }
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      // FileReader.readAsText → result je string (TXT fiksne kolone).
      setTxtContent(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => setReadError('Greška pri čitanju fajla.');
    reader.readAsText(file);
  };

  // TXT je opcion: bez fajla se kreira PRAZAN izvod za ručni unos stavki (E6 devizni
  // izvod se puni ručno — parser je RSD-only). Obavezni su samo žiro/broj/datum.
  const canSubmit =
    bankAccount.trim().length > 0 &&
    statementNumber.trim().length > 0 &&
    statementDate.length > 0 &&
    !importMut.isPending;

  const submit = () => {
    if (!canSubmit) return;
    const input: ImportStatementInput = {
      bankAccount: bankAccount.trim(),
      statementNumber: statementNumber.trim(),
      statementDate,
      txtContent: txtContent.length > 0 ? txtContent : undefined,
      fileName: fileName || undefined,
      currency,
    };
    importMut.mutate(input, {
      onSuccess: (created) => onImported(created.id),
    });
  };

  const err = readError ?? (importMut.error as Error | null)?.message ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Uvezi bankovni izvod"
      dismissable={!importMut.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={importMut.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={importMut.isPending} disabled={!canSubmit}>
            Uvezi
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label="Žiro račun" required>
          <Input
            value={bankAccount}
            onChange={(e) => setBankAccount(e.target.value)}
            placeholder="npr. 160-000000000000-00"
            className="tnums"
          />
        </FormField>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label="Broj izvoda" required>
            <Input
              value={statementNumber}
              onChange={(e) => setStatementNumber(e.target.value)}
              placeholder="npr. 42"
              className="tnums"
            />
          </FormField>
          <FormField label="Datum izvoda" required>
            <Input
              type="date"
              value={statementDate}
              onChange={(e) => setStatementDate(e.target.value)}
              className="tnums"
            />
          </FormField>
        </div>

        <FormField
          label="Valuta"
          hint={
            currency === 'RSD'
              ? 'Dinarski izvod.'
              : 'Devizni izvod — stavke se unose u valuti, RSD protivvrednost se računa po prodajnom kursu na dan izvoda.'
          }
        >
          <div className="w-40">
            <Select
              value={currency}
              onChange={(e) => {
                const next = e.target.value as StatementCurrency;
                setCurrency(next);
                // Devizni izvod ne sme nositi TXT (backend 400) — očisti već izabran fajl.
                if (next !== 'RSD') {
                  setTxtContent('');
                  setFileName('');
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }
              }}
              options={STATEMENT_CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
          </div>
        </FormField>

        {currency === 'RSD' ? (
          <FormField
            label="TXT fajl izvoda"
            hint={
              fileName
                ? `Izabran fajl: ${fileName}`
                : 'Fiksne kolone (FX Import format). Opciono — bez fajla se pravi prazan izvod za ručni unos.'
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain"
              onChange={onPickFile}
              className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-control file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-surface-2"
            />
          </FormField>
        ) : (
          <div className="rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm text-ink-secondary">
            Devizni izvod se kreira prazan i puni ručno (Dodaj stavku) — TXT uvoz
            podržava samo dinarske izvode, pa je polje sakriveno.
          </div>
        )}

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {err}
          </div>
        )}
      </div>
    </Dialog>
  );
}
