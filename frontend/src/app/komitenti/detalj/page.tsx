'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { formatDate, formatDateTime, formatDecimal } from '@/lib/format';
import {
  useKomitent,
  codeRefLabel,
  salespersonLabel,
  type CustomerContact,
  type CustomerDeliveryLocation,
  type CustomerDetail,
} from '@/api/masters';

/**
 * Kartica komitenta — pun matični slog (57 BigBit kolona), grupisan po sekcijama iz
 * `backend/docs/migration/BIGBIT_KOMITENTI.md` §1. Čist pregled: `customers` je BigBit
 * cache i piše ga samo `customer.syncer.ts` (BACKEND_RULES §3) — nema akcija izmene.
 *
 * ⚠️ STATIČKA RUTA `?id=N`, ne `[id]` segment (static export; isti razlog kao kod
 * artikla). Id se čita iz `window.location.search`, nikad kroz `useSearchParams`.
 *
 * DVA SLOJA (odluka 29.07.2026): bez `masters.read` odgovor NEMA račune, rabate,
 * proviziju, maržu, limit, uslove plaćanja, PDV/GLN/CRF ni audit — vraća isti
 * bezbedan podskup koji je nekad prikazivao stariji ekran `/customers` (sada ugašen
 * i preusmeren ovamo). Ekran zato izostavlja cele sekcije kojih u odgovoru nema i u
 * zaglavlju nosi oznaku „Ograničen prikaz". Redakciju radi backend, ne ovaj fajl.
 *
 * CHILD KOLEKCIJE (Talas B): „Kontakt osobe" (`KomitentiKontaktOsobe`) i „Mesta isporuke"
 * (`MestaIsporuke`) dolaze iz BigBit `.mdb`-a kroz `backend/tools/bigbit-bridge`. Oba su
 * u BAZNOM sloju (operativni podaci). Dok bridge ne odradi prvi prolaz kolekcije su
 * prazne — tada se sekcija UOPŠTE NE CRTA (prazna tabela izgleda kao izgubljen podatak).
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

/**
 * Sekcija sa tabelom (child kolekcije iz BigBit-a). Za razliku od `Section`, telo nije
 * `dl` nego `DataTable`, koja nosi sopstveni okvir panela — zato ovde nema `rounded-panel`
 * (dupli okvir), samo naslov istog ranga kao u ostalim sekcijama.
 */
function TableSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Kontakt osobe (`KomitentiKontaktOsobe`) — podrazumevana je označena i ide prva
 * (redosled presuđuje backend). Prazan podatak je „—", nikad prazna ćelija.
 */
const CONTACT_COLUMNS: Column<CustomerContact>[] = [
  {
    key: 'contactPerson',
    header: 'Ime',
    render: (r) => (
      <span className="flex flex-wrap items-center gap-2">
        <span className={r.isDefault ? 'font-semibold text-ink' : undefined}>
          {txt(r.contactPerson)}
        </span>
        {r.isDefault && <StatusBadge tone="info" label="Podrazumevani" />}
      </span>
    ),
  },
  { key: 'phone', header: 'Telefon', render: (r) => <span className="tnums">{txt(r.phone)}</span> },
  {
    key: 'mobile',
    header: 'Mobilni',
    render: (r) => <span className="tnums">{txt(r.mobile)}</span>,
  },
  { key: 'fax', header: 'Faks', render: (r) => <span className="tnums">{txt(r.fax)}</span> },
  { key: 'email', header: 'Email', render: (r) => txt(r.email) },
];

/**
 * Mesta isporuke (`MestaIsporuke`) — GLN je PO LOKACIJI (ne komitentov) i regulatorno
 * je bitan za SEF e-fakturu, pa ima svoju kolonu.
 */
const DELIVERY_COLUMNS: Column<CustomerDeliveryLocation>[] = [
  {
    key: 'name',
    header: 'Naziv',
    render: (r) => (
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{txt(r.name)}</span>
        {r.locationNumber && <span className="tnums text-ink-disabled">{r.locationNumber}</span>}
      </span>
    ),
  },
  {
    key: 'city',
    header: 'Mesto',
    render: (r) => (
      <span>
        {txt(r.city)}
        {r.postalCode ? <span className="tnums text-ink-disabled"> {r.postalCode}</span> : null}
      </span>
    ),
  },
  { key: 'address', header: 'Adresa', render: (r) => txt(r.address) },
  { key: 'gln', header: 'GLN', render: (r) => <span className="tnums">{txt(r.gln)}</span> },
  {
    key: 'active',
    header: 'Aktivno',
    render: (r) =>
      r.active ? (
        <StatusBadge tone="success" label="Aktivno" />
      ) : (
        <StatusBadge tone="neutral" label="Neaktivno" />
      ),
  },
];

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

function CustomerSections({ k, commercial }: { k: CustomerDetail; commercial: boolean }) {
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
        {/* Prodavac je u baznom sloju (isto kao u starijem `directory` pregledu), pa
            stoji ovde — sekcija „Komercijala" tako ostaje čisto komercijalna. */}
        <Field label="Prodavac">{salespersonLabel(k.salesperson) ?? '—'}</Field>
        {commercial && (
          <>
            <Field label="Vrsta šifre">{codeRefLabel(k.codeType) ?? txt(k.codeTypeCode)}</Field>
            <Field label="Sakriven u pregledu">{bool(k.hideInOverview)}</Field>
          </>
        )}
      </Section>

      <Section title="Adresa i kontakt">
        <Field label="Adresa">{txt(k.address)}</Field>
        <Field label="Mesto">{txt(k.city)}</Field>
        <Field label="Poštanski broj">{txt(k.postalCode)}</Field>
        <Field label="Država">{txt(k.country)}</Field>
        <Field label="Telefon">{txt(k.phone)}</Field>
        <Field label="Faks">{txt(k.fax)}</Field>
        <Field label="Mobilni">{txt(k.mobile)}</Field>
        <Field label="Email">{txt(k.email)}</Field>
        <Field label="Web adresa">{txt(k.webAddress)}</Field>
        <Field label="Kontakt osoba">{txt(k.contact)}</Field>
        {commercial && (
          <>
            <Field label="Region">{num(k.region, 0)}</Field>
            <Field label="Datum rođenja">{k.birthDate ? formatDate(k.birthDate) : '—'}</Field>
            <Field label="Pošta na drugu adresu">{bool(k.mailToDifferentAddress)}</Field>
            <Field label="Newsletter">{bool(k.newsletter)}</Field>
          </>
        )}
      </Section>

      {/* Child kolekcije iz BigBit-a (Talas B). Prazna kolekcija = sekcije NEMA:
          `customer_contacts` / `customer_delivery_locations` su na produkciji prazne
          dok bigbit-bridge ne odradi prvi prolaz, a prazna tabela sa zaglavljem bi
          izgledala kao izgubljen podatak. Oba su u baznom sloju — vidi ih svako. */}
      {k.contacts.length > 0 && (
        <TableSection title="Kontakt osobe">
          <DataTable columns={CONTACT_COLUMNS} rows={k.contacts} rowKey={(r) => r.id} />
        </TableSection>
      )}

      {k.deliveryLocations.length > 0 && (
        <TableSection title="Mesta isporuke">
          <DataTable
            columns={DELIVERY_COLUMNS}
            rows={k.deliveryLocations}
            rowKey={(r) => r.id}
          />
        </TableSection>
      )}

      {commercial && (
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
      )}

      {/* Mešovita sekcija: PIB i matični broj su javni podaci (bazni sloj), a
          GLN/JBKJS/PDV status/CRF idu uz `masters.read`. */}
      <Section title="Porezi i SEF">
        <div className="col-span-2">
          <Field label="PIB">
            <span className="flex flex-wrap items-center gap-2">
              <span className="tnums">{txt(k.taxId)}</span>
              <PibBadge state={pib} />
            </span>
          </Field>
        </div>
        <Field label="Matični broj">
          <span className="tnums">{txt(k.registrationNumber)}</span>
        </Field>
        {commercial && (
          <>
            <Field label="Ne proveravaj PIB">{bool(k.skipTaxIdValidation)}</Field>
            <Field label="GLN">
              <span className="tnums">{txt(k.gln)}</span>
            </Field>
            <Field label="JBKJS (javni sektor)">
              <span className="tnums">{txt(k.publicSectorId)}</span>
            </Field>
            <Field label="PDV status">{num(k.vatStatus, 0)}</Field>
            <Field label="CRF (centralni registar faktura)">
              {bool(k.centralInvoiceRegistry)}
            </Field>
            <Field label="e-Faktura: popust po stavci">
              {bool(k.einvoiceXmlPerItemDiscount)}
            </Field>
            <Field label="Fakturisanje po mestima isporuke">
              {bool(k.invoicePerDeliveryAddress)}
            </Field>
          </>
        )}
      </Section>

      {commercial && (
        <Section title="Komercijala">
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
      )}

      <Section title="Napomene">
        <div className="col-span-2 sm:col-span-3 lg:col-span-2">
          <Field label="Napomena">{txt(k.note)}</Field>
        </div>
        {commercial && (
          <div className="col-span-2 sm:col-span-3 lg:col-span-2">
            <Field label="Napomena za salda">{txt(k.balanceNote)}</Field>
          </div>
        )}
      </Section>

      {commercial && (
        <Section title="Audit">
          <Field label="Prvi unos">{formatDateTime(k.createdAt)}</Field>
          <Field label="Uneo">{txt(k.createdBy)}</Field>
          <Field label="Poslednja izmena">{formatDateTime(k.updatedAt)}</Field>
          <Field label="Izmenio">{txt(k.updatedBy)}</Field>
          <Field label="Datum sloga">{formatDateTime(k.recordCreatedAt)}</Field>
          <Field label="Potpis">{txt(k.signature)}</Field>
        </Section>
      )}
    </>
  );
}

export default function KomitentDetaljPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [validId, setValidId] = useState<number | null>(null);
  const [idResolved, setIdResolved] = useState(false);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('id');
    const n = raw ? Number(raw) : NaN;
    // Komitent 0 je legitiman (Servoteh d.o.o., interni) — zato `>= 0`, ne `> 0`.
    setValidId(Number.isInteger(n) && n >= 0 ? n : null);
    setIdResolved(true);
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na listu (DESIGN_SYSTEM §8).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') router.push('/komitenti');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const q = useKomitent(validId);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const k = q.data?.data;
  // Sloj odgovora presuđuje backend (`masters.read`); ekran ga samo prati.
  const commercial = q.data?.meta.restricted === false;

  return (
    <AppShell>
      <PageHeader
        title={k ? k.name : 'Komitent'}
        count={k ? <span className="tnums">Šifra {k.id}</span> : undefined}
        actions={
          <div className="flex items-center gap-2">
            {k && !commercial && (
              <span title="Računi, rabati, provizija, limit i uslovi plaćanja traže dozvolu „masters.read“.">
                <StatusBadge tone="neutral" label="Ograničen prikaz" />
              </span>
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

        {k && <CustomerSections k={k} commercial={commercial} />}
      </div>
    </AppShell>
  );
}
