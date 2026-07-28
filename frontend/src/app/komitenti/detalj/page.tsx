'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDateTime, formatDecimal } from '@/lib/format';
import { useKomitent, codeRefLabel, salespersonLabel, type CustomerDetail } from '@/api/masters';
import { MaticniEkran } from '@/app/artikli/_forma/polja';
import { BRANA_KOMITENT } from '@/app/artikli/_forma/pravila';
import {
  NEPOKRIVENO_KOMITENT,
  SEKCIJE_KOMITENT,
  vrednostiIzKomitenta,
} from '../_forma/komitent-polja';

/**
 * Kartica komitenta — pun matični slog (57 BigBit kolona), grupisan po sekcijama iz
 * `backend/docs/migration/BIGBIT_KOMITENTI.md` §1.
 *
 * Dva režima na istoj ruti: `pregled` (kartica) i `izmena` (pun ekran, `?rezim=izmena`).
 * Izmena je ZAKLJUČANA odlukom vlasnika od 26.07.2026 — `customers` piše samo sync, a
 * `CustomerSyncer` u delta prolazu prepisuje svih 56 mapiranih polja, pa bi ispravka
 * tiho nestala čim neko u BigBitu takne tog komitenta (v. `BRANA_KOMITENT`).
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment (static export; isti razlog kao kod
 * artikla). Id se čita iz `window.location.search`, nikad kroz `useSearchParams`.
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

function txt(v: string | number | null | undefined): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function num(v: number | string | null | undefined, maxFrac = 2): ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  return <span className="tnums">{formatDecimal(v, maxFrac)}</span>;
}

function bool(v: boolean | null | undefined): ReactNode {
  if (v === null || v === undefined) return '—';
  return v ? 'Da' : 'Ne';
}

type PibState = 'empty' | 'placeholder' | 'valid' | 'invalid';

/**
 * Kontrolna cifra srpskog PIB-a (mod 11,10) — port `DobarPIB` iz BigBit VBA
 * (`LIB_PIB.bas`, opisan u BIGBIT_KOMITENTI.md §3.1): prefiks „SR" se skida, prvih
 * 8 cifara je osnova, 9. je kontrolna.
 *
 * `XX_<šifra>` je BigBit placeholder za komitente BEZ PIB-a (§5.1, ubacuje ga transfer
 * upit da `tax_id NOT NULL` ne pukne) — to NIJE greška podatka, pa se prikazuje zasebno.
 * Indikator je informativan; BigBit ni sam ne blokira snimanje neispravnog PIB-a (§4).
 */
function pibState(pib: string | null | undefined): PibState {
  const raw = (pib ?? '').trim();
  if (!raw) return 'empty';
  if (raw.toUpperCase().startsWith('XX_')) return 'placeholder';
  const digits = raw.toUpperCase().replace(/^SR/, '');
  if (!/^\d{9}$/.test(digits)) return 'invalid';
  let k = 10;
  for (let i = 0; i < 8; i += 1) {
    k = (Number(digits[i]) + k) % 10;
    if (k === 0) k = 10;
    k = (k * 2) % 11;
  }
  const control = (11 - k) % 10;
  return control === Number(digits[8]) ? 'valid' : 'invalid';
}

function PibBadge({ state }: { state: PibState }) {
  if (state === 'empty') return null;
  if (state === 'valid') return <StatusBadge tone="success" label="Ispravan format" />;
  if (state === 'placeholder')
    return <StatusBadge tone="neutral" label="Bez PIB-a (placeholder)" />;
  return <StatusBadge tone="warn" label="Neispravan format" />;
}

function CustomerSections({ k }: { k: CustomerDetail }) {
  const pib = pibState(k.taxId);
  return (
    <>
      <Section title="Osnovno">
        <Field label="Šifra">
          <span className="tnums font-semibold">{k.id}</span>
        </Field>
        <Field label="Naziv">{txt(k.name)}</Field>
        <Field label="Skraćeni naziv">{txt(k.shortName)}</Field>
        <Field label="Poslovnica">{txt(k.branch)}</Field>
        <Field label="Vrsta šifre">{codeRefLabel(k.codeType) ?? txt(k.codeTypeCode)}</Field>
        <Field label="Sakriven u pregledu">{bool(k.hideInOverview)}</Field>
      </Section>

      <Section title="Adresa i kontakt">
        <Field label="Adresa">{txt(k.address)}</Field>
        <Field label="Mesto">{txt(k.city)}</Field>
        <Field label="Poštanski broj">{txt(k.postalCode)}</Field>
        <Field label="Država">{txt(k.country)}</Field>
        <Field label="Region">{num(k.region, 0)}</Field>
        <Field label="Telefon">{txt(k.phone)}</Field>
        <Field label="Faks">{txt(k.fax)}</Field>
        <Field label="Mobilni">{txt(k.mobile)}</Field>
        <Field label="Email">{txt(k.email)}</Field>
        <Field label="Web adresa">{txt(k.webAddress)}</Field>
        <Field label="Kontakt osoba">{txt(k.contact)}</Field>
        <Field label="Datum rođenja">{k.birthDate ? formatDate(k.birthDate) : '—'}</Field>
        <Field label="Pošta na drugu adresu">{bool(k.mailToDifferentAddress)}</Field>
        <Field label="Newsletter">{bool(k.newsletter)}</Field>
      </Section>

      <Section title="Računi">
        <Field label="Žiro račun 1">
          <span className="tnums">{txt(k.bankAccount1)}</span>
        </Field>
        <Field label="Žiro račun 2">
          <span className="tnums">{txt(k.bankAccount2)}</span>
        </Field>
        <Field label="Žiro račun 3">
          <span className="tnums">{txt(k.bankAccount3)}</span>
        </Field>
        <Field label="Uplatni račun">
          {k.paymentAccount ? (
            <span className="tnums">
              {k.paymentAccount.accountNumber}
              {k.paymentAccount.bankName ? ` — ${k.paymentAccount.bankName}` : ''}
            </span>
          ) : (
            '—'
          )}
        </Field>
      </Section>

      <Section title="Porezi i SEF">
        <div className="col-span-2">
          <Field label="PIB">
            <span className="flex flex-wrap items-center gap-2">
              <span className="tnums">{txt(k.taxId)}</span>
              <PibBadge state={pib} />
            </span>
          </Field>
        </div>
        <Field label="Ne proveravaj PIB">{bool(k.skipTaxIdValidation)}</Field>
        <Field label="Matični broj">
          <span className="tnums">{txt(k.registrationNumber)}</span>
        </Field>
        <Field label="GLN">
          <span className="tnums">{txt(k.gln)}</span>
        </Field>
        <Field label="JBKJS (javni sektor)">
          <span className="tnums">{txt(k.publicSectorId)}</span>
        </Field>
        <Field label="PDV status">{num(k.vatStatus, 0)}</Field>
        <Field label="CRF (centralni registar faktura)">{bool(k.centralInvoiceRegistry)}</Field>
        <Field label="e-Faktura: popust po stavci">{bool(k.einvoiceXmlPerItemDiscount)}</Field>
        <Field label="Fakturisanje po mestima isporuke">
          {bool(k.invoicePerDeliveryAddress)}
        </Field>
      </Section>

      <Section title="Komercijala">
        <Field label="Prodavac">{salespersonLabel(k.salesperson) ?? '—'}</Field>
        <Field label="Rabat komitenta (%)">{num(k.customerDiscount)}</Field>
        <Field label="Fiktivni rabat (%)">{num(k.fictitiousDiscount)}</Field>
        <Field label="Provizija (%)">{num(k.commissionPercent)}</Field>
        <Field label="Ručna marža (%)">{num(k.manualMarkupPercent)}</Field>
        <Field label="Cenovnik">{txt(k.priceListCode)}</Field>
        <Field label="Valuta plaćanja (dana)">{num(k.paymentTermDays, 0)}</Field>
        <Field label="Način plaćanja">{txt(k.paymentMethod)}</Field>
        <Field label="Kreditni limit">{num(k.creditLimit)}</Field>
        <Field label="Provera duga">{bool(k.checkDebt)}</Field>
        <Field label="Eksterna šifra">{txt(k.externalCode)}</Field>
        <Field label="Pantheon ID">{txt(k.pantheonId)}</Field>
        <Field label="Zaštitni kod kupca">{txt(k.buyerProtectionCode)}</Field>
        <Field label="Ruta (ID)">{num(k.routeId, 0)}</Field>
        <Field label="Vozač (šifra)">{num(k.driverId, 0)}</Field>
      </Section>

      <Section title="Napomene">
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Field label="Napomena">{txt(k.note)}</Field>
        </div>
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Field label="Napomena za salda">{txt(k.balanceNote)}</Field>
        </div>
      </Section>

      <Section title="Audit">
        <Field label="Prvi unos">{formatDateTime(k.createdAt)}</Field>
        <Field label="Uneo">{txt(k.createdBy)}</Field>
        <Field label="Poslednja izmena">{formatDateTime(k.updatedAt)}</Field>
        <Field label="Izmenio">{txt(k.updatedBy)}</Field>
        <Field label="Datum sloga">{formatDateTime(k.recordCreatedAt)}</Field>
        <Field label="Potpis">{txt(k.signature)}</Field>
      </Section>
    </>
  );
}

export default function KomitentDetaljPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [validId, setValidId] = useState<number | null>(null);
  const [idResolved, setIdResolved] = useState(false);
  const [rezim, setRezim] = useState<'pregled' | 'izmena'>('pregled');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('id');
    const n = raw ? Number(raw) : NaN;
    // Komitent 0 je legitiman (Servoteh d.o.o., interni) — zato `>= 0`, ne `> 0`.
    setValidId(Number.isInteger(n) && n >= 0 ? n : null);
    setRezim(params.get('rezim') === 'izmena' ? 'izmena' : 'pregled');
    setIdResolved(true);
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8). U izmeni Esc pripada formi.
  useEffect(() => {
    if (rezim === 'izmena') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') router.push('/komitenti');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, rezim]);

  const q = useKomitent(validId);

  const [vrednosti, setVrednosti] = useState<Record<string, string> | null>(null);
  const ucitan = q.data?.data;
  useEffect(() => {
    if (ucitan) setVrednosti(vrednostiIzKomitenta(ucitan));
  }, [ucitan]);
  /** Polazni slog — po njemu se broji šta je operater dirao. */
  const polazne = useMemo(() => (ucitan ? vrednostiIzKomitenta(ucitan) : null), [ucitan]);

  /** Režim ide i u URL (`replace`) — osvežavanje strane ne izbacuje iz izmene. */
  function promeniRezim(sledeci: 'pregled' | 'izmena') {
    setRezim(sledeci);
    if (validId === null) return;
    const put = sledeci === 'izmena' ? `?id=${validId}&rezim=izmena` : `?id=${validId}`;
    window.history.replaceState(null, '', `${window.location.pathname}${put}`);
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const k = q.data?.data;

  if (rezim === 'izmena' && k && vrednosti) {
    return (
      <MaticniEkran
        naslov={`Izmena komitenta — ${k.name}`}
        oznaka={<span className="tnums">Šifra {k.id}</span>}
        brana={BRANA_KOMITENT}
        rezim="izmena"
        sekcije={SEKCIJE_KOMITENT}
        nepokriveno={NEPOKRIVENO_KOMITENT}
        vrednosti={vrednosti}
        polazneVrednosti={polazne}
        onPromena={setVrednosti}
        onIzlaz={() => {
          setVrednosti(vrednostiIzKomitenta(k));
          promeniRezim('pregled');
        }}
      />
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={k ? k.name : 'Komitent'}
        count={k ? <span className="tnums">Šifra {k.id}</span> : undefined}
        actions={
          <div className="flex items-center gap-2">
            {k && (
              <Button
                variant="secondary"
                onClick={() => promeniRezim('izmena')}
                title="Otvori pun ekran izmene (upis je zaključan — ekran objašnjava zašto)"
                aria-label="Izmeni"
                className="max-sm:w-9 max-sm:px-0"
              >
                <Pencil className="h-4 w-4" aria-hidden />
                <span className="max-sm:hidden">Izmeni</span>
              </Button>
            )}
            <Button variant="secondary" onClick={() => router.push('/komitenti')}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Nazad
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {idResolved && validId === null && (
          <EmptyState
            title="Nedostaje šifra komitenta"
            hint="Otvori komitenta iz liste komitenata."
          />
        )}

        {validId !== null && q.isLoading && (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        )}

        {validId !== null && q.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(q.error as Error).message}
          </div>
        )}

        {k && <CustomerSections k={k} />}
      </div>
    </AppShell>
  );
}
