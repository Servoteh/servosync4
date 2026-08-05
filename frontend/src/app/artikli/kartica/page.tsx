'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Warehouse } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Input } from '@/components/ui-kit/form-field';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { ExportCsvButton } from '@/components/export-csv-button';
import type { CsvColumn } from '@/lib/table-csv';
import { cn } from '@/lib/cn';
import { listHref, useIdParam } from '@/lib/use-id-param';
import { useQueryTab } from '@/lib/use-query-tab';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import { useArtikal } from '@/api/masters';
import {
  useKarticaNarudzbine,
  useKarticaProfakture,
  useKarticaRobno,
  useMagacinOpcije,
  KARTICA_SKROL_KAPA,
  type GoodsCardRow,
  type OrdersCardRow,
  type ProformaCardRow,
} from '@/api/lager';

/**
 * KARTICA ARTIKLA — tri kartice jednog artikla iz BigBita, na jednom ekranu:
 *
 *   • ROBNO KRETANJE  — knjižen promet (`Level 0`) sa tekućim stanjem; slaže se sa
 *     kolonom STANJE u lager listi.
 *   • PROFAKTURE      — ponude, predračuni, rezervacije i otpremnice (`Level ≥ 250`);
 *     redovi sa oznakom „rezerviše" su tačno ono što u lageru umanjuje SLOBODNO.
 *   • NARUDŽBINE      — trebovanja (BigBit `T_Trebovanja`) koja sadrže artikal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * 🔴 ODAKLE PODACI — i šta se promenilo 05.08.2026
 * ─────────────────────────────────────────────────────────────────────────────────────
 * Ekran je do sad čitao 4.0 native robno (`/robno/item-card`, pravo `robno.read`) i zato
 * je celo pravo `robno.read` bilo uslov za pristup. Te tabele su na produkciji PRAZNE
 * (`stock_documents = 0`, mereno 04.08.2026) — kartica je legitimno bila prazna za svaki
 * artikal, a robno se i dalje vodi isključivo u BigBit-u.
 *
 * Sada kartica čita OGLEDALO BigBita (`/v1/artikli/:id/kartica-*`, pravo `directory.read`
 * — isto pravo koje nosi i lista artikala), pa je i uslov za pristup isti kao za ostatak
 * modula matičnih podataka. 4.0 knjiženja se nisu izgubila: isti pregled sa štampom stoji
 * na ekranu Robno / magacin (`/robno`, `ItemCardPanel`), a ovde je link ka njemu za
 * korisnike koji to pravo imaju.
 *
 * ⚠️ REDOVI NISU KLIKABILNI, i to je namerno. `documentId` je BigBit `IDDok` iz ogledala,
 * a `/robno/detalj?id=N` čita 4.0 `stock_documents` — isti broj u drugoj tabeli. Klik bi
 * otvarao tuđi dokument ili 404, pa dokumenta iz ogledala nemaju svoju stranu dok se roba
 * ne preseli u 4.0.
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment: dinamički segmenti NE rade na static
 * exportu (`output: "export"`) — klijentska navigacija traži neizvezen prerender pa
 * hard-404 (incident 22.07). Id se čita kroz `useIdParam()` iz `window.location`, NIKAD
 * kroz `useSearchParams` (on bi tražio Suspense oko cele strane). Iz istog razloga i
 * magacin dolazi kao `?magacin=N` — lager lista tako otvara karticu baš onog magacina
 * čiji je red kliknut.
 */

type KarticaTab = 'robno' | 'profakture' | 'narudzbine';

const TABOVI: TabItem<KarticaTab>[] = [
  { key: 'robno', label: 'Robno kretanje' },
  { key: 'profakture', label: 'Profakture i rezervacije' },
  { key: 'narudzbine', label: 'Narudžbine' },
];

const VALIDNI_TABOVI = TABOVI.map((t) => t.key);

/**
 * Visina skrol-okvira tabele — `dvh`, nikad `vh` (DESIGN_SYSTEM §11.4): `100vh` je na
 * iOS-u veliki viewport, pa bi dno tabele završilo pod trakom Safarija.
 *
 * Dve vrednosti jer robno kretanje iznad tabele nosi i panel sa zbirovima (~6rem), a
 * druge dve kartice ne nose ništa — jedna zajednička visina bi njima ostavila prazan
 * pojas na dnu ekrana.
 */
const VISINA_TABELE_SA_ZBIROM = 'calc(100dvh - 30rem)';
const VISINA_TABELE = 'calc(100dvh - 24rem)';

/** Količina u srpskom formatu, 3 decimale (BigBit vodi kilaže i metraže). */
function kol(v: string | null | undefined): string {
  return formatDecimal(v, 3);
}

/** Datum po kom je red rangiran: datum knjiženja, a bez njega datum isprave. */
function datumReda(postingDate: string | null, documentDate: string | null): string | null {
  return postingDate ?? documentDate;
}

/** Komitent reda — naziv, pa gola šifra, pa crtica (šifra bez naziva je i dalje trag). */
function komitent(name: string | null, id: number | null): string {
  if (name) return name;
  return id ? `#${id}` : '—';
}

/** Boja količine: minus je crven jer je radna stavka. */
function bojaKolicine(v: string | null): string {
  return Number(v) < 0 ? 'text-status-danger' : 'text-ink';
}

/** CSV vrednost količine/cene — decimalni zarez, jer Excel sr inače čita tekst. */
const csvDec = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : v.replace('.', ',');

// ─────────────────────────────────────────────────────────── kolone: robno kretanje

const robnoColumns: Column<GoodsCardRow>[] = [
  {
    key: 'date',
    header: 'Datum',
    render: (r) => (
      <span
        className="whitespace-nowrap text-ink-secondary"
        title={
          r.postingDate && r.documentDate && r.postingDate !== r.documentDate
            ? `Datum isprave: ${formatDate(r.documentDate)}`
            : undefined
        }
      >
        {formatDate(datumReda(r.postingDate, r.documentDate))}
      </span>
    ),
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => (
      <span className="tnums whitespace-nowrap font-semibold text-ink" title={r.description ?? undefined}>
        {r.documentNumber ?? `#${r.documentId}`}
      </span>
    ),
  },
  {
    // Vrsta dokumenta je BigBit šifra (UFROB, IFR, UVOZ, POPIS…) i korisnici je čitaju
    // kao takvu — ne prevodi se. Smer stoji uz nju jer se iz šifre ne vidi uvek.
    key: 'documentType',
    header: 'Vrsta',
    render: (r) => (
      <span className="whitespace-nowrap text-ink">
        {r.documentType}{' '}
        <span className="text-2xs text-ink-secondary">{r.isInflow ? 'ulaz' : 'izlaz'}</span>
      </span>
    ),
  },
  {
    key: 'customer',
    header: 'Komitent',
    render: (r) => {
      const ime = komitent(r.customerName, r.customerId);
      return (
        <span className="block max-w-[16rem] truncate text-ink-secondary" title={ime}>
          {ime}
        </span>
      );
    },
  },
  {
    key: 'warehouse',
    header: 'Magacin',
    render: (r) => <span className="whitespace-nowrap text-ink-secondary">{r.warehouse.name}</span>,
  },
  {
    key: 'quantityIn',
    header: 'Ulaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      Number(r.quantityIn) !== 0 ? (
        <span className="tnums text-ink">{kol(r.quantityIn)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'quantityOut',
    header: 'Izlaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      Number(r.quantityOut) !== 0 ? (
        <span className="tnums text-ink">{kol(r.quantityOut)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    // Tekuće stanje računa backend (kreće od `openingBalance`) — ne rekonstruiše se ovde.
    key: 'balance',
    header: 'Stanje',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className={cn('tnums font-semibold', bojaKolicine(r.balance))}>{kol(r.balance)}</span>
    ),
  },
  {
    key: 'purchasePriceNet',
    header: 'Nabavna',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.purchasePriceNet)}</span>,
  },
  {
    key: 'actualWholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums text-ink-secondary">{formatDecimal(r.actualWholesalePrice)}</span>
    ),
  },
];

const robnoCsv: CsvColumn<GoodsCardRow>[] = [
  { header: 'Datum', value: (r) => datumReda(r.postingDate, r.documentDate) ?? '' },
  { header: 'Datum isprave', value: (r) => r.documentDate ?? '' },
  { header: 'Dokument', value: (r) => r.documentNumber ?? `#${r.documentId}` },
  { header: 'Vrsta', value: (r) => r.documentType },
  { header: 'Smer', value: (r) => (r.isInflow ? 'ulaz' : 'izlaz') },
  { header: 'Komitent', value: (r) => r.customerName ?? '' },
  { header: 'Magacin', value: (r) => r.warehouse.name },
  { header: 'Ulaz', value: (r) => csvDec(r.quantityIn) },
  { header: 'Izlaz', value: (r) => csvDec(r.quantityOut) },
  { header: 'Stanje', value: (r) => csvDec(r.balance) },
  { header: 'Nabavna', value: (r) => csvDec(r.purchasePriceNet) },
  { header: 'VP cena', value: (r) => csvDec(r.actualWholesalePrice) },
  { header: 'Opis', value: (r) => r.description ?? '' },
];

// ────────────────────────────────────────────────────────────── kolone: profakture

const profaktureColumns: Column<ProformaCardRow>[] = [
  {
    key: 'date',
    header: 'Datum',
    render: (r) => (
      <span className="whitespace-nowrap text-ink-secondary">
        {formatDate(datumReda(r.postingDate, r.documentDate))}
      </span>
    ),
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => (
      <span className="tnums whitespace-nowrap font-semibold text-ink" title={r.description ?? undefined}>
        {r.documentNumber ?? `#${r.documentId}`}
      </span>
    ),
  },
  {
    key: 'documentType',
    header: 'Vrsta',
    render: (r) => (
      <span className="whitespace-nowrap text-ink" title={`BigBit Level ${r.level}`}>
        {r.documentType}
      </span>
    ),
  },
  {
    // „Rezerviše" je OSOBINA dokumenta, ne njegov status — zato „DA"/crtica, a ne
    // `StatusBadge` pilula (isti postupak kao kolona PPD na listi artikala, §7 se ne tiče).
    key: 'isReservation',
    header: 'Rezerviše',
    render: (r) =>
      r.isReservation ? (
        <span className="font-semibold text-status-warn" title="Ovaj red umanjuje SLOBODNO u lager listi">
          DA
        </span>
      ) : (
        <span className="text-ink-disabled" title="Zapisan dokument koji ne drži robu">
          —
        </span>
      ),
  },
  {
    key: 'customer',
    header: 'Komitent',
    render: (r) => {
      const ime = komitent(r.customerName, r.customerId);
      return (
        <span className="block max-w-[16rem] truncate text-ink-secondary" title={ime}>
          {ime}
        </span>
      );
    },
  },
  {
    key: 'warehouse',
    header: 'Magacin',
    render: (r) => <span className="whitespace-nowrap text-ink-secondary">{r.warehouse.name}</span>,
  },
  {
    key: 'quantity',
    header: 'Količina',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className={cn('tnums font-semibold', bojaKolicine(r.quantity))}>{kol(r.quantity)}</span>
    ),
  },
  {
    key: 'actualWholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="tnums text-ink-secondary">{formatDecimal(r.actualWholesalePrice)}</span>
    ),
  },
  {
    key: 'discountPercent',
    header: 'Rabat %',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.discountPercent)}</span>,
  },
];

const profaktureCsv: CsvColumn<ProformaCardRow>[] = [
  { header: 'Datum', value: (r) => datumReda(r.postingDate, r.documentDate) ?? '' },
  { header: 'Dokument', value: (r) => r.documentNumber ?? `#${r.documentId}` },
  { header: 'Vrsta', value: (r) => r.documentType },
  { header: 'Level', value: (r) => r.level },
  { header: 'Rezerviše', value: (r) => (r.isReservation ? 'DA' : '') },
  { header: 'Komitent', value: (r) => r.customerName ?? '' },
  { header: 'Magacin', value: (r) => r.warehouse.name },
  { header: 'Količina', value: (r) => csvDec(r.quantity) },
  { header: 'VP cena', value: (r) => csvDec(r.actualWholesalePrice) },
  { header: 'Rabat %', value: (r) => csvDec(r.discountPercent) },
  { header: 'Opis', value: (r) => r.description ?? '' },
];

// ────────────────────────────────────────────────────────────── kolone: narudžbine

const narudzbineColumns: Column<OrdersCardRow>[] = [
  {
    key: 'orderDate',
    header: 'Datum',
    render: (r) => (
      <span className="whitespace-nowrap text-ink-secondary">{formatDate(r.orderDate)}</span>
    ),
  },
  {
    key: 'orderNumber',
    header: 'Trebovanje',
    render: (r) => (
      <span className="tnums whitespace-nowrap font-semibold text-ink" title={r.note ?? undefined}>
        {r.orderNumber ?? `#${r.orderId}`}
      </span>
    ),
  },
  {
    key: 'supplier',
    header: 'Dobavljač',
    render: (r) => {
      const ime = komitent(r.supplierName, r.supplierId);
      return (
        <span className="block max-w-[18rem] truncate text-ink-secondary" title={ime}>
          {ime}
        </span>
      );
    },
  },
  {
    key: 'orderedQuantity',
    header: 'Poručeno',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{kol(r.orderedQuantity)}</span>,
  },
  {
    key: 'receivedQuantity',
    header: 'Primljeno',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{kol(r.receivedQuantity)}</span>,
  },
  {
    // Ostatak isporuke je jedini broj zbog kog se ova kartica otvara — istaknut je, a
    // nula znači „stiglo je sve" i zato je siva, ne crna.
    key: 'remainingQuantity',
    header: 'Ostatak',
    align: 'right',
    numeric: true,
    render: (r) =>
      Number(r.remainingQuantity) !== 0 ? (
        <span className="tnums font-semibold text-status-warn">{kol(r.remainingQuantity)}</span>
      ) : (
        <span className="tnums text-ink-disabled">{kol(r.remainingQuantity)}</span>
      ),
  },
  {
    key: 'unitPrice',
    header: 'Cena',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.unitPrice)}</span>,
  },
  {
    key: 'expectedDeliveryDate',
    header: 'Očekivano',
    render: (r) => (
      <span className="whitespace-nowrap text-ink-secondary">
        {formatDate(r.expectedDeliveryDate)}
      </span>
    ),
  },
  {
    key: 'isDelivered',
    header: 'Isporučeno',
    render: (r) =>
      r.isDelivered ? (
        <span className="whitespace-nowrap text-ink" title={r.deliveryDate ?? undefined}>
          {r.deliveryDate ? formatDate(r.deliveryDate) : 'DA'}
        </span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
];

const narudzbineCsv: CsvColumn<OrdersCardRow>[] = [
  { header: 'Datum', value: (r) => r.orderDate ?? '' },
  { header: 'Trebovanje', value: (r) => r.orderNumber ?? `#${r.orderId}` },
  { header: 'Dobavljač', value: (r) => r.supplierName ?? '' },
  { header: 'Poručeno', value: (r) => csvDec(r.orderedQuantity) },
  { header: 'Primljeno', value: (r) => csvDec(r.receivedQuantity) },
  { header: 'Ostatak', value: (r) => csvDec(r.remainingQuantity) },
  { header: 'Cena', value: (r) => csvDec(r.unitPrice) },
  { header: 'Rabat %', value: (r) => csvDec(r.discountPercent) },
  { header: 'Očekivano', value: (r) => r.expectedDeliveryDate ?? '' },
  { header: 'Isporučeno', value: (r) => r.deliveryDate ?? (r.isDelivered ? 'DA' : '') },
  { header: 'Napomena', value: (r) => r.note ?? '' },
  { header: 'Opis', value: (r) => r.description ?? '' },
];

// ──────────────────────────────────────────────────────────────────── pomoćni delovi

/** Jedna vrednost u zaglavlju kartice (labela 10.5px uppercase iznad vrednosti). */
function Podatak({ labela, children }: { labela: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {labela}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

/** Kompaktna ćelija filter trake — labela 12px iznad kontrole. */
function Polje({ labela, sirina, children }: { labela: string; sirina: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {labela}
      <div className={sirina}>{children}</div>
    </label>
  );
}

/** Dugme „Nazad" — isto na kapiji i na samoj kartici. */
function DugmeNazad({ onNazad }: { onNazad: () => void }) {
  return (
    <Button variant="secondary" onClick={onNazad} title="Nazad na listu artikala (Esc)">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Nazad
    </Button>
  );
}

/** Greška upita — isti okvir na sve tri kartice. */
function Greska({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
      {(error as Error).message}
    </div>
  );
}

/**
 * Podnožje paginirane kartice: brojač + dovlačenje NA ZAHTEV + izvoz prikazanog.
 * Automatsko dovlačenje na dolazak dna se ne koristi (odskok na dodirnom ekranu okine
 * posmatrača više puta i pošalje plotun zahteva).
 */
function Podnozje<T>({
  ucitano,
  ukupno,
  naKapi,
  hasNextPage,
  isFetchingNextPage,
  onFetchNext,
  csvColumns,
  rows,
  filename,
}: {
  ucitano: number;
  ukupno: number;
  naKapi: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNext: () => void;
  csvColumns: CsvColumn<T>[];
  rows: T[];
  filename: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-sm text-ink-secondary">
        Prikazano {formatNumber(ucitano)} od {formatNumber(ukupno)}
      </span>

      {hasNextPage && (
        <Button type="button" variant="secondary" onClick={onFetchNext} loading={isFetchingNextPage}>
          Učitaj još
        </Button>
      )}

      {naKapi && (
        <span className="text-sm text-status-warn">
          Prikazano {formatNumber(KARTICA_SKROL_KAPA)} od {formatNumber(ukupno)} — suzi period
        </span>
      )}

      {/* Izvozi se ono što je UČITANO, i tako i piše — inače bi CSV izgledao kao cela kartica. */}
      <ExportCsvButton
        columns={csvColumns}
        rows={rows}
        filename={filename}
        label="Izvezi prikazano"
        title="Izvezi učitane redove kartice u CSV (Excel)"
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────── kapija

/**
 * KAPIJA: prijava i `?id=N`. Sadržaj kartice je zaseban komponent i montira se TEK kad
 * oba uslova stoje, pa nijedan upit ne krene bez artikla.
 *
 * Pravo se ovde više ne proverava izričito: sve tri kartice stoje na `directory.read`,
 * istom pravu koje nosi i sam modul matičnih podataka (`/artikli`, `/komitenti`) — a te
 * strane svoje pravo takođe ne proveravaju lokalno (nav krije afordansu, backend čuva
 * podatak). Ranija provera `robno.read` bila je uslov 4.0 robnog, koje ova strana više
 * ne čita.
 */
export default function KarticaArtiklaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const { id, resolved } = useIdParam();

  // ODAKLE SE DOŠLO — kartica ima DVA ulaza (pregled artikala i lager lista), pa „Nazad"
  // ne sme da bude fiksan: povratak na tuđu listu izgleda kao da se ekran „izgubio".
  // Lager lista zato u adresu upisuje `izvor=lager`; sve ostalo (i deljen link) vodi na
  // pregled artikala. `listHref` uz to vraća i poslednje filtere te liste.
  const [izvor, setIzvor] = useState<'artikli' | 'lager'>('artikli');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('izvor') === 'lager') setIzvor('lager');
  }, []);

  const nazadNaListu = useCallback(
    () => router.push(listHref(izvor === 'lager' ? '/artikli/lager' : '/artikli')),
    [router, izvor],
  );

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8 — Esc zatvara najviši sloj).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') nazadNaListu();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nazadNaListu]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  if (id === null) {
    return (
      <AppShell>
        <PageHeader title="Kartica artikla" actions={<DugmeNazad onNazad={nazadNaListu} />} />
        <div className="grid flex-1 place-items-center p-6">
          {/* Dok se `?id=` ne pročita iz adrese (prvi render) ne tvrdimo da fali — inače bi
              svaka kartica na tren pisala „nedostaje šifra artikla". */}
          {resolved && (
            <EmptyState
              title="Nedostaje šifra artikla"
              hint={'Otvori karticu iz lager liste ili liste artikala (desni klik na red).'}
            />
          )}
        </div>
      </AppShell>
    );
  }

  return <Kartica id={id} onNazad={nazadNaListu} />;
}

// ──────────────────────────────────────────────────────────────────────── sadržaj

function Kartica({ id, onNazad }: { id: number; onNazad: () => void }) {
  const router = useRouter();
  const { can } = useAuth();

  // Tab u URL-u (frontend/CLAUDE.md §12 + DESIGN_SYSTEM §4): lager lista otvara karticu
  // odmah na traženom tabu, a `Ctrl+D` na adresi pamti baš taj pogled.
  const [tab, setTab] = useQueryTab<KarticaTab>('tab', 'robno', { valid: VALIDNI_TABOVI });

  // Identitet artikla ide iz matičnih podataka; kartice ga takođe nose u `meta.item`, ali
  // ovaj upit je jedan i keširan, pa naslov ne treperi pri smeni tabova.
  const artikal = useArtikal(id);
  const a = artikal.data?.data;

  // Magacin stiže iz adrese (lager lista otvara karticu magacina čiji je red kliknut);
  // dalje se menja lokalno. `useIdParam` je isti čitač kao za `?id=` — prima samo
  // pozitivan dekadni ceo broj, pa prelomljen link ne bira „magacin 0".
  const { id: magacinIzUrl, resolved: magacinResolved } = useIdParam('magacin');
  const [magacin, setMagacin] = useState('');
  useEffect(() => {
    if (magacinResolved && magacinIzUrl != null) setMagacin(String(magacinIzUrl));
  }, [magacinResolved, magacinIzUrl]);

  const [od, setOd] = useState('');
  const [doDatuma, setDoDatuma] = useState('');
  const [godina, setGodina] = useState('');
  const [samoRezervacije, setSamoRezervacije] = useState(false);
  const [samoOtvorene, setSamoOtvorene] = useState(false);

  // Magacini: 4.0 šifarnik + izabrani (koji 4.0 ne mora poznavati — BigBit vozi i 44).
  // Ovde se, za razliku od lager liste, spisak NE dopunjuje iz prikazanih redova: kartica
  // je pogled na jedan artikal i magacin se bira da bi se pogled SUZIO, a magacin koji je
  // stigao iz lager liste je već u spisku preko `izabran`.
  const magacini = useMagacinOpcije([], magacin ? Number(magacin) : null);

  /** Godina iz polja — samo ispravan broj ide na server (inače podrazumevana). */
  const godinaBroj = useMemo(() => {
    const n = Number(godina);
    return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : undefined;
  }, [godina]);

  const zajednicki = useMemo(
    () => ({
      warehouseId: magacin ? Number(magacin) : undefined,
      from: od || undefined,
      to: doDatuma || undefined,
      year: godinaBroj,
    }),
    [magacin, od, doDatuma, godinaBroj],
  );

  const naslov = a ? a.name : 'Kartica artikla';
  const oznaka = a?.catalogNumber;
  const jedinica = a?.unit ?? '';

  const imaPeriod = od !== '' || doDatuma !== '';

  return (
    <AppShell>
      <PageHeader
        title={naslov}
        count={oznaka ? `Kartica artikla · ${oznaka}` : 'Kartica artikla'}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => router.push(`/artikli/detalj?id=${id}`)}
              title="Matični slog artikla (67 kolona)"
            >
              <FileText className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Detaljno artikal</span>
            </Button>
            <Button
              variant="secondary"
              onClick={() => router.push(listHref('/artikli/lager'))}
              title="Lager lista (stanje / rezervisano / slobodno)"
            >
              <Warehouse className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Lager lista</span>
            </Button>
            <DugmeNazad onNazad={onNazad} />
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={TABOVI} value={tab} onChange={setTab} ariaLabel="Kartice artikla" />

        {/* Filter traka — zajednička za sve tri kartice, uz jedan prekidač po kartici.
            Magacin narudžbine nemaju (trebovanje se piše pre nego što se zna magacin),
            pa se na tom tabu i ne prikazuje — filter koji ništa ne radi je gori od
            nepostojećeg. */}
        <div className="flex flex-wrap items-end gap-3">
          {tab !== 'narudzbine' && (
            <Polje labela="Magacin" sirina="w-56">
              <Select
                placeholder={magacini.isLoading ? 'učitavanje…' : 'svi magacini'}
                value={magacin}
                onChange={(e) => setMagacin(e.target.value)}
                options={magacini.options}
              />
            </Polje>
          )}

          <Polje labela="Od datuma" sirina="w-40">
            <Input type="date" value={od} onChange={(e) => setOd(e.target.value)} />
          </Polje>

          <Polje labela="Do datuma" sirina="w-40">
            <Input type="date" value={doDatuma} onChange={(e) => setDoDatuma(e.target.value)} />
          </Polje>

          <Polje labela="Poslovna godina" sirina="w-32">
            <Input
              type="number"
              min={1990}
              max={2100}
              value={godina}
              onChange={(e) => setGodina(e.target.value)}
              placeholder={tab === 'narudzbine' ? 'sve' : 'poslednja'}
              title={
                tab === 'narudzbine'
                  ? 'Trebovanja se podrazumevano NE seku po godini — decembarska narudžbina koja stiže u januaru je i dalje otvorena'
                  : 'Prazno = poslednja godina zatečena u ogledalu BigBita'
              }
            />
          </Polje>

          {tab === 'profakture' && (
            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={samoRezervacije}
                onChange={(e) => setSamoRezervacije(e.target.checked)}
              />
              Samo dokumenti koji rezervišu robu
            </label>
          )}

          {tab === 'narudzbine' && (
            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={samoOtvorene}
                onChange={(e) => setSamoOtvorene(e.target.checked)}
              />
              Samo neisporučeno
            </label>
          )}

          {imaPeriod && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOd('');
                setDoDatuma('');
              }}
            >
              Ceo period
            </Button>
          )}
        </div>

        {artikal.error && (
          <p className="text-sm text-ink-secondary">
            Matični podaci artikla nisu učitani — kartice rade normalno.
          </p>
        )}

        {/* `!!` jer `useQuery.error` ima tip `unknown` — gola vrednost nije ReactNode. */}
        {!!magacini.error && (
          <p className="text-sm text-ink-secondary">
            Šifarnik magacina nije učitan — kartica prikazuje sve magacine.
          </p>
        )}

        {/* Samo aktivna kartica je montirana: tri paralelna upita nad ogledalom bi se
            slala pri svakom otvaranju ekrana, a gleda se jedna. */}
        {tab === 'robno' && <TabRobno itemId={id} params={zajednicki} jedinica={jedinica} />}
        {tab === 'profakture' && (
          <TabProfakture
            itemId={id}
            params={{ ...zajednicki, onlyReservations: samoRezervacije || undefined }}
          />
        )}
        {tab === 'narudzbine' && (
          <TabNarudzbine
            itemId={id}
            params={{
              from: zajednicki.from,
              to: zajednicki.to,
              year: zajednicki.year,
              onlyOpen: samoOtvorene || undefined,
            }}
          />
        )}

        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a (noćno ogledalo, samo za čitanje) — dokumenta se otvaraju u
          BigBit-u, ne ovde.
          {can(PERMISSIONS.ROBNO_READ) && (
            <>
              {' '}
              Knjiženja u 4.0 (do cutover-a prazna) su na ekranu{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
                onClick={() => router.push('/robno')}
              >
                Robno / magacin
              </button>
              .
            </>
          )}
        </p>
      </div>
    </AppShell>
  );
}

// ─────────────────────────────────────────────────────────────── kartica: robno

function TabRobno({
  itemId,
  params,
  jedinica,
}: {
  itemId: number;
  params: { warehouseId?: number; from?: string; to?: string; year?: number };
  jedinica: string;
}) {
  const upit = useKarticaRobno(itemId, params);
  const redovi = upit.data?.data ?? [];
  const meta = upit.data?.meta ?? null;

  return (
    <>
      <Greska error={upit.error} />

      {/* Zaglavlje kartice: početno stanje + zbirovi + krajnje stanje. Početno stanje je
          zbir SVEGA pre `od` — bez njega bi kartica za mart pokazala „stanje 12" za
          artikal kojeg u magacinu ima 137, i to bez ijednog znaka da nešto fali. */}
      <div className="rounded-panel border border-line bg-surface p-4">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <Podatak labela="Poslovna godina">
            <span className="tnums font-semibold text-ink">{meta ? meta.year : '—'}</span>
            {meta?.yearSource === 'latest' && (
              <span className="ml-1 text-2xs text-ink-secondary">poslednja u BigBit-u</span>
            )}
            {meta?.yearSource === 'query' && (
              <span className="ml-1 text-2xs text-ink-secondary">izabrana</span>
            )}
          </Podatak>
          <Podatak labela="Početno stanje">
            <span className="tnums text-ink">{meta ? kol(meta.openingBalance) : '—'}</span>
          </Podatak>
          <Podatak labela="Ukupan ulaz">
            <span className="tnums text-ink">{meta ? kol(meta.totalIn) : '—'}</span>
          </Podatak>
          <Podatak labela="Ukupan izlaz">
            <span className="tnums text-ink">{meta ? kol(meta.totalOut) : '—'}</span>
          </Podatak>
          <Podatak labela="Krajnje stanje">
            <span className={cn('tnums font-semibold', meta ? bojaKolicine(meta.closingBalance) : 'text-ink')}>
              {meta ? kol(meta.closingBalance) : '—'} {jedinica}
            </span>
          </Podatak>
        </dl>

        {/* Odsečena kartica sme da postoji, ali ne sme da ćuti: krajnje stanje tada nije
            stanje artikla nego zbir prikazanih redova. */}
        {meta?.truncated && (
          <p className="mt-3 text-sm text-status-warn">
            Kartica je odsečena na {formatNumber(meta.limit)} redova — prikazani zbirovi važe
            samo za prikazani deo. Suzi period da bi krajnje stanje bilo tačno.
          </p>
        )}
      </div>

      <div className="min-w-0">
        <DataTable
          columns={robnoColumns}
          rows={redovi}
          rowKey={(r) => r.id}
          loading={upit.isLoading}
          stickyHeader
          frozenColumns={2}
          maxHeight={VISINA_TABELE_SA_ZBIROM}
          empty={
            <EmptyState
              title="Nema kretanja"
              hint="Za ovaj artikal nema knjiženih robnih dokumenata u izabranoj poslovnoj godini, magacinu i periodu. Proveri godinu — BigBit svaku otvara sopstvenim „Donosom po popisu“."
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-secondary">
          Prikazano {formatNumber(redovi.length)} redova
        </span>
        <ExportCsvButton
          columns={robnoCsv}
          rows={redovi}
          filename={`kartica-robno-${itemId}`}
          label="Izvezi prikazano"
          title="Izvezi prikazane redove kartice u CSV (Excel)"
        />
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────── kartica: profakture

function TabProfakture({
  itemId,
  params,
}: {
  itemId: number;
  params: {
    warehouseId?: number;
    from?: string;
    to?: string;
    year?: number;
    onlyReservations?: boolean;
  };
}) {
  const { upit, redovi, ukupno, ucitano, naKapi } = useKarticaProfakture(itemId, params);

  return (
    <>
      <Greska error={upit.error} />

      <div className="min-w-0">
        <DataTable
          columns={profaktureColumns}
          rows={redovi}
          rowKey={(r) => r.id}
          loading={upit.isLoading}
          stickyHeader
          frozenColumns={2}
          maxHeight={VISINA_TABELE}
          empty={
            <EmptyState
              title="Nema profaktura"
              hint="Za ovaj artikal nema ponuda, predračuna, rezervacija ni otpremnica u izabranom periodu. U BigBit-u su to dokumenti sa Level ≥ 250 — sve što je zapisano, a nije proknjiženo u stanje."
            />
          }
        />
      </div>

      <Podnozje
        ucitano={ucitano}
        ukupno={ukupno}
        naKapi={naKapi}
        hasNextPage={!!upit.hasNextPage}
        isFetchingNextPage={upit.isFetchingNextPage}
        onFetchNext={() => void upit.fetchNextPage()}
        csvColumns={profaktureCsv}
        rows={redovi}
        filename={`kartica-profakture-${itemId}`}
      />
    </>
  );
}

// ──────────────────────────────────────────────────────────── kartica: narudžbine

function TabNarudzbine({
  itemId,
  params,
}: {
  itemId: number;
  params: { from?: string; to?: string; year?: number; onlyOpen?: boolean };
}) {
  const { upit, redovi, ukupno, ucitano, naKapi } = useKarticaNarudzbine(itemId, params);

  return (
    <>
      <Greska error={upit.error} />

      <div className="min-w-0">
        <DataTable
          columns={narudzbineColumns}
          rows={redovi}
          rowKey={(r) => r.id}
          loading={upit.isLoading}
          stickyHeader
          frozenColumns={2}
          maxHeight={VISINA_TABELE}
          empty={
            <EmptyState
              title="Nema narudžbina"
              hint="Nijedno trebovanje u izabranom periodu ne sadrži ovaj artikal."
            />
          }
        />
      </div>

      <Podnozje
        ucitano={ucitano}
        ukupno={ukupno}
        naKapi={naKapi}
        hasNextPage={!!upit.hasNextPage}
        isFetchingNextPage={upit.isFetchingNextPage}
        onFetchNext={() => void upit.fetchNextPage()}
        csvColumns={narudzbineCsv}
        rows={redovi}
        filename={`kartica-narudzbine-${itemId}`}
      />
    </>
  );
}
