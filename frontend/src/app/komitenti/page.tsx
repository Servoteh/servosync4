'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { formatNumber } from '@/lib/format';
import { useListQueryState, useZapamcenaPozicijaListe } from '@/lib/use-id-param';
import { useKomitenti, codeRefLabel, salespersonLabel, type CustomerRow } from '@/api/masters';

/**
 * Matični podaci — Komitenti (obrazac „Lista", DESIGN_SYSTEM §4.1): pretraga u
 * komandnoj traci (naziv / PIB / mesto) + gusta tabela sa server-side paginacijom.
 *
 * Podatak je BigBit cache (`customers`). Unos i izmena imaju pun ekran
 * (`/komitenti/nov`, `/komitenti/detalj?id=N&rezim=izmena`), ali su ZAKLJUČANI
 * odlukom vlasnika od 26.07.2026 — backend na upis vraća 409 BIGBIT_OWNED_READ_ONLY.
 * Detalj je STATIČKA ruta `?id=N` (nikad `[id]` segment — static export).
 */

const PAGE_SIZE = 50;

/** `SearchBox` nema sopstveni debounce, a `setValues` piše kroz `router.replace`. */
const KUCANJE_MS = 300;

const columns: Column<CustomerRow>[] = [
  {
    key: 'id',
    header: 'Šifra',
    align: 'right',
    numeric: true,
    render: (k) => <span className="tnums font-semibold text-ink">{k.id}</span>,
  },
  {
    key: 'name',
    header: 'Naziv',
    render: (k) => <span className="text-ink">{k.name}</span>,
  },
  {
    key: 'city',
    header: 'Mesto',
    render: (k) => <span className="text-ink-secondary">{k.city || '—'}</span>,
  },
  {
    key: 'taxId',
    header: 'PIB',
    align: 'right',
    numeric: true,
    render: (k) => <span className="tnums text-ink-secondary">{k.taxId || '—'}</span>,
  },
  {
    key: 'codeType',
    header: 'Vrsta šifre',
    render: (k) => (
      <span className="text-ink-secondary">{codeRefLabel(k.codeType) ?? k.codeTypeCode ?? '—'}</span>
    ),
  },
  {
    key: 'salesperson',
    header: 'Prodavac',
    render: (k) => (
      <span className="text-ink-secondary">{salespersonLabel(k.salesperson) ?? '—'}</span>
    ),
  },
];

export default function KomitentiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  /**
   * Pretraga i strana žive U URL-u (frontend/CLAUDE.md §12) — povratak sa kartice
   * komitenta vraća listu tačno kakvu je korisnik ostavio. Do 07.08.2026 su oboje bili
   * goli `useState`, pa je remount strane brisao I pretragu I stranu: nad šifarnikom od
   * desetina hiljada komitenata to je doslovno „vrati me na početnu stranu".
   * Imena `trazi`/`strana` prate `/artikli`, `/nabavka`, `/robno`, `/izvodi`.
   */
  const { values, resolved, setValues } = useListQueryState({ trazi: '', strana: '1' });
  const page = Math.max(1, Number(values.strana) || 1);

  // Kucanje ostaje trenutno na ekranu, a URL se ažurira tek posle KUCANJE_MS — inače bi
  // svaki otkucani karakter bio jedan `router.replace`.
  const [trazi, setTrazi] = useState(values.trazi);
  useEffect(() => {
    setTrazi(values.trazi);
  }, [values.trazi]);
  useEffect(() => {
    if (trazi === values.trazi) return;
    const t = setTimeout(() => setValues({ trazi, strana: '1' }), KUCANJE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trazi]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Alt+N = nov zapis u aktivnom modulu (DESIGN_SYSTEM §8). Ne otima kucanje u polju.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      const cilj = e.target as HTMLElement | null;
      const tag = cilj?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      router.push('/komitenti/nov');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const list = useKomitenti(
    { page, pageSize: PAGE_SIZE, q: values.trazi.trim() || undefined },
    { enabled: resolved },
  );

  // Čita se PRE kapije prijave: `useZapamcenaPozicijaListe` je hook i ne sme iza `return`.
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  /**
   * MESTO U LISTI. Strana i pretraga su u URL-u, ali skrol nije: `PAGE_SIZE` je 50, što je
   * oko 1.750 px, pa je referent koji je sa strane 4 otvorio 40. red posle „Nazad" stajao
   * na vrhu te strane i ponovo skrolovao ceo put. Isti defekt kao na `/robno`.
   *
   * `potpis` uključuje i `strana`, pa promena strane uredno vraća skrol na vrh (novi
   * sadržaj — vrh je tačno mesto). `straneUKesu: 1` je pošteno za serverski paginiranu
   * listu: grana „odustani" se tada nikad ne pali, pa restauracija ne može da okine
   * nijedan dodatni zahtev. `resolved` je uslov jer se prvi render dešava sa
   * PODRAZUMEVANIM filterima — bez njega bi se skrol vraćao nad tuđim redovima.
   *
   * Skrol-okvir je STRANA (`flex-1 … overflow-auto`), a ne `DataTable`: tabela ovde nema
   * `maxHeight`, pa `scrollRef` ne bi imao šta da uhvati — hook traži samo element sa
   * `scrollTop`, pa `okvirRef` ide na `div`.
   */
  const { okvirRef } = useZapamcenaPozicijaListe({
    kljuc: '/komitenti',
    potpis: JSON.stringify(values),
    spremno: resolved && rows.length > 0,
    straneUKesu: list.data ? 1 : 0,
    redova: rows.length,
  });

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
        title="Komitenti"
        // `resolved` iz istog razloga kao `enabled` na upitu: dok pretraga iz adrese nije
        // pročitana, keš pod PODRAZUMEVANIM ključem vraća broj NEFILTRIRANE liste.
        count={resolved && meta ? `${formatNumber(meta.total)} komitenata` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <SearchBox
              value={trazi}
              onChange={setTrazi}
              placeholder="Naziv, PIB, mesto…"
            />
            {/* Na 360 px ostaje samo ikona — naslov i pretraga imaju prednost (§11). */}
            <Button
              onClick={() => router.push('/komitenti/nov')}
              title="Nov komitent (Alt+N)"
              aria-label="Nov komitent"
              className="max-sm:w-9 max-sm:px-0"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Nov komitent</span>
            </Button>
          </div>
        }
      />

      <div ref={okvirRef} className="flex-1 space-y-4 overflow-auto p-6">
        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a — unos i izmena su zaključani odlukom od 26.07.2026 (ekran unosa
          objašnjava šta uraditi)
        </p>

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(k) => k.id}
          // Dok upit čeka filtere iz adrese `isLoading` je `false`, pa bi tabela na tren
          // nacrtala „Nema komitenata".
          loading={!resolved || list.isLoading}
          onRowActivate={(k) => router.push(`/komitenti/detalj?id=${k.id}`)}
          empty={
            <EmptyState
              title="Nema komitenata"
              hint="Promeni pretragu ili proveri da je BigBit sync popunio šifarnik komitenata."
            />
          }
        />

        {/* I pager čeka `resolved`: pre toga `meta` opisuje tuđi (podrazumevani) ključ, pa
            bi „Prethodna/Sledeća" pomerala stranu nad brojem koji ne pripada ovoj listi. */}
        {resolved && meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setValues({ strana: String(Math.max(1, page - 1)) })}
            onNext={() => setValues({ strana: String(Math.min(meta.totalPages, page + 1)) })}
          />
        )}
      </div>
    </AppShell>
  );
}
