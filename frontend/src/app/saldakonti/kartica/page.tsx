'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useIdParam } from '@/lib/use-id-param';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { CustomerPicker } from '@/components/customer-picker';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  usePartnerCard,
  usePartnerCardPdf,
  openPdf,
  type PartnerCardRow,
} from '@/api/saldakonti';

/**
 * Kartica komitenta (Talas 2 §A1). Obrazac „Lista" (DESIGN_SYSTEM §4.1): izbor
 * komitenta (CustomerPicker) + period/konto filter → hronološke stavke glavne
 * knjige sa running saldo kolonom. Sažetak (početno stanje / Σ duguje / Σ
 * potražuje / saldo) u traci iznad tabele + štampa PDF. Data isključivo kroz
 * `@/api/saldakonti` hook-ove; sve od kit komponenti i tokena.
 *
 * Zatvaranje kartice (saldo) se slaže sa saldom otvorenih stavki partnera
 * (smoke §2) — obim je isti (saldakonto konti).
 */
export default function KarticaKomitentaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [partner, setPartner] = useState<{ id: number; name: string } | null>(null);
  // DEEP-LINK `?partnerId=N` — sa uparene stavke izvoda se dolazi dugmetom
  // „Kartica". Do sada se taj parametar NIJE čitao: ekran bi se otvorio prazan,
  // pa je knjigovođa zaključivao da komitent nema prometa ili da kartica ne radi.
  // Ime se dopunjuje čim pretraga vrati komitenta (ispod).
  const { id: linkedPartnerId } = useIdParam('partnerId');
  useEffect(() => {
    if (linkedPartnerId != null) {
      setPartner((prev) => prev ?? { id: linkedPartnerId, name: '' });
    }
  }, [linkedPartnerId]);
  const [accountCode, setAccountCode] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Primenjeni period/konto (dugme „Primeni") — odvojeno od unosa da svaki
  // pritisak tastera ne okida upit nad ledger pogledom. Partner se primenjuje
  // odmah pri izboru iz pickera.
  const [applied, setApplied] = useState<{ accountCode: string; from: string; to: string }>({
    accountCode: '',
    from: '',
    to: '',
  });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const card = usePartnerCard({
    partnerId: partner?.id ?? null,
    accountCode: applied.accountCode.trim() || undefined,
    from: applied.from || undefined,
    to: applied.to || undefined,
  });

  const pdf = usePartnerCardPdf();

  const data = card.data?.data;
  const rows = data?.rows ?? [];

  function applyFilters() {
    setApplied({ accountCode, from, to });
  }

  function clearFilters() {
    setAccountCode('');
    setFrom('');
    setTo('');
    setApplied({ accountCode: '', from: '', to: '' });
  }

  const columns: Column<PartnerCardRow>[] = [
    {
      key: 'postingDate',
      header: 'Datum',
      render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.postingDate)}</span>,
    },
    {
      key: 'konto',
      header: 'Konto',
      render: (r) => <span className="tnums text-ink-secondary">{r.accountCode}</span>,
    },
    {
      key: 'dokument',
      header: 'Dokument',
      render: (r) => {
        const nalog = `${r.orderTypeCode}-${r.journalNumber}`;
        return (
          <span className="tnums text-ink">
            {r.documentNumber ?? '—'}
            <span className="text-ink-disabled"> · {nalog}</span>
          </span>
        );
      },
    },
    {
      key: 'description',
      header: 'Opis',
      render: (r) => <span className="text-ink-secondary">{r.description ?? '—'}</span>,
    },
    {
      key: 'debit',
      header: 'Duguje',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums text-ink">
          {Number(r.debit) !== 0 ? formatDecimal(r.debit) : '—'}
        </span>
      ),
    },
    {
      key: 'credit',
      header: 'Potražuje',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums text-ink">
          {Number(r.credit) !== 0 ? formatDecimal(r.credit) : '—'}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Saldo',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.balance)}</span>,
    },
  ];

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const countLabel = data ? `${rows.length} stavki` : undefined;

  return (
    <AppShell>
      <PageHeader title="Kartica komitenta" count={countLabel} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Komitent
            <div className="w-72">
              <CustomerPicker onSelect={(id, name) => setPartner(id != null ? { id, name: name ?? '' } : null)} />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Konto
            <input
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              placeholder="Svi"
              inputMode="numeric"
              className="tnums h-9 w-32 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Od
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="tnums h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Do
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="tnums h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>

          <Button type="submit" variant="secondary">
            Primeni
          </Button>

          {(applied.accountCode !== '' || applied.from !== '' || applied.to !== '') && (
            <Button type="button" variant="ghost" onClick={clearFilters}>
              Očisti
            </Button>
          )}
        </form>

        {card.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(card.error as Error).message}
          </div>
        )}

        {pdf.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(pdf.error as Error).message}
          </div>
        )}

        {partner == null ? (
          <EmptyState
            title="Izaberi komitenta"
            hint="Kucaj naziv ili PIB komitenta da se prikaže njegova kartica (hronološke stavke i saldo)."
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span className="text-ink">
                  {partner.name} <span className="text-ink-disabled">#{partner.id}</span>
                </span>
                {data && (
                  <>
                    <span className="text-ink-secondary">
                      Početno stanje:{' '}
                      <span className="tnums font-semibold text-ink">
                        {formatDecimal(data.opening)}
                      </span>
                    </span>
                    <span className="text-ink-secondary">
                      Duguje:{' '}
                      <span className="tnums font-semibold text-ink">
                        {formatDecimal(data.totalDebit)}
                      </span>
                    </span>
                    <span className="text-ink-secondary">
                      Potražuje:{' '}
                      <span className="tnums font-semibold text-ink">
                        {formatDecimal(data.totalCredit)}
                      </span>
                    </span>
                    <span className="text-ink-secondary">
                      Saldo:{' '}
                      <span className="tnums font-semibold text-ink">
                        {formatDecimal(data.closing)}
                      </span>
                    </span>
                  </>
                )}
              </div>

              <Button
                type="button"
                variant="secondary"
                loading={pdf.isPending}
                disabled={partner == null}
                title="Štampa kartice komitenta (PDF)"
                onClick={() =>
                  partner != null &&
                  pdf.mutate(
                    {
                      partnerId: partner.id,
                      accountCode: applied.accountCode.trim() || undefined,
                      from: applied.from || undefined,
                      to: applied.to || undefined,
                    },
                    { onSuccess: openPdf },
                  )
                }
              >
                Štampa PDF
              </Button>
            </div>

            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.ledgerEntryId}
              loading={card.isLoading}
              empty={
                <EmptyState
                  title="Nema stavki"
                  hint="Za izabranog komitenta nema proknjiženih stavki u izabranom periodu."
                />
              }
            />
          </>
        )}
      </div>
    </AppShell>
  );
}
