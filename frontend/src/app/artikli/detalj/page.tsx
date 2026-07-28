'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDateTime, formatDecimal } from '@/lib/format';
import { useArtikal, codeRefLabel, type ItemDetail } from '@/api/masters';

/**
 * Kartica artikla — pun matični slog (67 BigBit kolona), grupisan po sekcijama iz
 * `backend/docs/migration/BIGBIT_ARTIKLI.md` §1. Čist pregled: `items` je BigBit
 * cache i piše ga samo sync (BACKEND_RULES §3), pa ekran nema nijednu akciju izmene.
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment: dinamički segmenti NE rade na static
 * exportu (`output: "export"`) — klijentska navigacija traži neizvezen prerender pa
 * hard-404 (incident 22.07). Id se čita iz `window.location.search` u `useEffect`-u,
 * NIKAD kroz `useSearchParams` (on bi tražio Suspense oko cele strane).
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <h2 className="mb-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {title}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
        {children}
      </dl>
    </section>
  );
}

/** Tekst ili „—" (prazan string se tretira kao odsutan). */
function txt(v: string | number | null | undefined): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

/** Broj sa srpskim formatom; 0 se prikazuje (nije „—"). */
function num(v: number | string | null | undefined, maxFrac = 2): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  return <span className="tnums">{formatDecimal(v, maxFrac)}</span>;
}

function bool(v: boolean | null | undefined): ReactNode {
  if (v === null || v === undefined) return '—';
  return v ? 'Da' : 'Ne';
}

/**
 * Putanja do fajla na fajl-serveru (`SlikaSimbolaLink` / `PDFLink` / `WordLokacija`).
 * BIGBIT_ARTIKLI.md §3.3: kolone su STRING PUTANJE (UNC), ne BLOB — i nije potvrđeno
 * da je taj share dostupan sa novog stacka. Zato se prikazuje SAMO tekst putanje sa
 * ikonom, bez `<img>`/`<a>` (učitavanje bi u najboljem slučaju tiho palo).
 */
function pathValue(v: string | null | undefined): ReactNode {
  if (!v) return '—';
  return (
    <span className="inline-flex min-w-0 items-start gap-1.5" title={v}>
      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
      <span className="break-all text-ink-secondary">{v}</span>
    </span>
  );
}

function ItemSections({ a }: { a: ItemDetail }) {
  return (
    <>
      <Section title="Identitet">
        <Field label="Kataloški broj">
          <span className="tnums font-semibold">{a.catalogNumber}</span>
        </Field>
        <Field label="Barkod">
          <span className="tnums">{txt(a.barCode)}</span>
        </Field>
        <Field label="PLU">{num(a.plu, 0)}</Field>
        <Field label="Eksterna šifra">{txt(a.externalCode)}</Field>
        <Field label="Šifra (3.0)">
          <span className="tnums">{a.id}</span>
        </Field>
        {/* BIGBIT_ARTIKLI.md §5.1: `items.id` je QBigTehn IDENTITY, a BigBit šifra
            živi odvojeno u `external_item_id` — jedini most nazad ka BigBit-u. */}
        <Field label="BigBit šifra">
          <span className="tnums">{a.externalItemId || '—'}</span>
        </Field>
      </Section>

      <Section title="Klasifikacija">
        <Field label="Grupa">{codeRefLabel(a.group) ?? txt(a.groupCode)}</Field>
        <Field label="Podgrupa">{codeRefLabel(a.subgroup) ?? txt(a.subgroupCode)}</Field>
        <Field label="Poreklo">{codeRefLabel(a.origin) ?? txt(a.originCode)}</Field>
        <Field label="Kvalitet (ID)">{num(a.qualityTypeId, 0)}</Field>
        <Field label="Tip (HPS)">{txt(a.hps)}</Field>
        <Field label="Redosled">{num(a.sortOrder, 0)}</Field>
      </Section>

      <Section title="Cene, marže i rabati">
        <Field label="VP cena">{num(a.wholesalePrice)}</Field>
        <Field label="MP cena">{num(a.retailPrice)}</Field>
        <Field label="Devizna nabavna">{num(a.fxPurchasePrice)}</Field>
        <Field label="Devizna prodajna">{num(a.fxSalePrice)}</Field>
        <Field label="Cena za upis u cenovnik">{num(a.priceToWritePricelist)}</Field>
        <Field label="Ručna marža (%)">{num(a.manualMarkupPercent)}</Field>
        <Field label="Maks. rabat (%)">{num(a.maxDiscountPercent)}</Field>
        <Field label="Akcijski rabat (%)">{num(a.promotionDiscount)}</Field>
        <Field label="Zavisni trošak proizvodnje">{num(a.finalProcessingCost)}</Field>
        <Field label="Kalo VP (%)">{num(a.wholesaleLossPercent)}</Field>
        <Field label="Kalo MP (%)">{num(a.retailLossPercent)}</Field>
        <Field label="Minimalna količina">{num(a.minQuantity, 3)}</Field>
        <Field label="Valuta plaćanja (dana)">{num(a.paymentTermDays, 0)}</Field>
      </Section>

      <Section title="PDV i carina">
        <Field label="Tarifa robe">{txt(a.goodsTaxRateCode)}</Field>
        <Field label="Tarifa usluga">{txt(a.serviceTaxRateCode)}</Field>
        <Field label="Uvek porez na robu">{bool(a.alwaysTaxGoods)}</Field>
        <Field label="Uvek porez na usluge">{bool(a.alwaysTaxServices)}</Field>
        <Field label="Neoporezivi deo">{num(a.nonTaxablePart)}</Field>
        <Field label="Taksa">{num(a.itemFee)}</Field>
        <Field label="Akciza">{num(a.itemExcise)}</Field>
        <Field label="Carinska stopa (%)">{num(a.customsRate)}</Field>
        <Field label="Carinska tarifa">{txt(a.customsTariff)}</Field>
        <Field label="Zemlja porekla">{txt(a.originCountry)}</Field>
        <Field label="Konto (GK)">{txt(a.accountingCode)}</Field>
        {/* BIGBIT_ARTIKLI.md §4.7: `KngSifra_2` se koristi i kao „zamenska šifra". */}
        <Field label="Konto 2 / zamena">{txt(a.accountingCode2)}</Field>
      </Section>

      <Section title="Dimenzije i pakovanje">
        <Field label="Jedinica mere">{txt(a.unit)}</Field>
        <Field label="Osnovna JM">{txt(a.baseUnit)}</Field>
        <Field label="Pakovanje">{txt(a.packaging)}</Field>
        <Field label="Količina u pakovanju">{num(a.quantityInPackage, 3)}</Field>
        <Field label="Kutija">{num(a.box, 3)}</Field>
        <Field label="Transportno pakovanje">{num(a.transportPackaging, 3)}</Field>
        <Field label="Težina">{num(a.weight, 3)}</Field>
        <Field label="Težina (kg)">{num(a.weightKg, 3)}</Field>
        <Field label="Zapremina">{num(a.volume, 3)}</Field>
        <Field label="Površina">{num(a.area, 3)}</Field>
        <Field label="Debljina">{num(a.thickness, 3)}</Field>
      </Section>

      <Section title="Opisi i prevodi">
        <Field label="Naziv">{txt(a.name)}</Field>
        <Field label="Opis artikla">{txt(a.itemDescription)}</Field>
        <Field label="INO naziv">{txt(a.foreignName)}</Field>
        <Field label="INO jedinica mere">{txt(a.foreignUnit)}</Field>
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <Field label="Web opis">{txt(a.webDescription)}</Field>
        </div>
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Field label="Memo">{txt(a.memo)}</Field>
        </div>
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Field label="Napomena 2">{txt(a.note2)}</Field>
        </div>
      </Section>

      <Section title="Linkovi (putanje na fajl-serveru)">
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <Field label="Slika simbola">{pathValue(a.symbolImageLink)}</Field>
        </div>
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <Field label="PDF dokument">{pathValue(a.pdfLink)}</Field>
        </div>
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <Field label="Word dokument">{pathValue(a.wordLocation)}</Field>
        </div>
      </Section>

      <Section title="Ostalo">
        <Field label="Dobavljač (šifra)">{num(a.supplierId, 0)}</Field>
        <Field label="Proizvođač">{txt(a.manufacturer)}</Field>
        <Field label="Polica">{txt(a.shelf)}</Field>
        <Field label="Mesto izdavanja (ID)">{num(a.issuePlaceId, 0)}</Field>
        <Field label="Raster (ID)">{num(a.rasterId, 0)}</Field>
        <Field label="Ne vodi zalihe">{bool(a.notStockTracked)}</Field>
        <Field label="Aktivan">{bool(a.active)}</Field>
        <Field label="Za brisanje">{bool(a.toDelete)}</Field>
        <Field label="Datum unosa">{formatDateTime(a.createdAt)}</Field>
        <Field label="Potpis">{txt(a.signature)}</Field>
      </Section>
    </>
  );
}

export default function ArtikalDetaljPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [validId, setValidId] = useState<number | null>(null);
  const [idResolved, setIdResolved] = useState(false);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('id');
    const n = raw ? Number(raw) : NaN;
    setValidId(Number.isInteger(n) && n > 0 ? n : null);
    setIdResolved(true);
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8 — Esc zatvara najviši sloj).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') router.push('/artikli');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const q = useArtikal(validId);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const a = q.data?.data;
  const back = (
    <Button variant="secondary" onClick={() => router.push('/artikli')}>
      <ArrowLeft className="h-4 w-4" aria-hidden />
      Nazad
    </Button>
  );

  return (
    <AppShell>
      <PageHeader
        title={a ? a.name : 'Artikal'}
        count={a ? <span className="tnums">{a.catalogNumber}</span> : undefined}
        actions={
          <div className="flex items-center gap-2">
            {a && (a.active ? (
              <StatusBadge tone="success" label="Aktivan" />
            ) : (
              <StatusBadge tone="neutral" label="Neaktivan" />
            ))}
            {a?.toDelete && <StatusBadge tone="warn" label="Za brisanje" />}
            {back}
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {idResolved && validId === null && (
          <EmptyState title="Nedostaje šifra artikla" hint="Otvori artikal iz liste artikala." />
        )}

        {validId !== null && q.isLoading && (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        )}

        {validId !== null && q.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(q.error as Error).message}
          </div>
        )}

        {a && <ItemSections a={a} />}
      </div>
    </AppShell>
  );
}
