'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate, formatDecimal } from '@/lib/format';
import { useCustomersLookup, type CustomerLookup } from '@/api/lookups';
import { useTaxRates } from '@/api/tax-rates';
import { useInvoices, SALES_DOCUMENT_TYPE } from '@/api/sales';
import {
  ADVANCE_DIRECTION,
  useCreateAdvanceByContract,
  advanceRemainderCents,
  advanceUnpaidCents,
  centsToAmount,
  decimalToCents,
  useLinkAdvanceToFinal,
  useMarkAdvancePaid,
  useRecordIncomingAdvance,
  type Advance,
} from '@/api/avansi';

/**
 * Dijalozi ekrana avansa (obrazac „Forma" u modalu — DESIGN_SYSTEM §4.3):
 *   - `MarkPaidDialog`        — označi naplatu/plaćanje avansa (poreski period po tom datumu)
 *   - `LinkFinalDialog`       — veži avans na konačni račun (storno PDV-a avansa)
 *   - `IncomingAdvanceDialog` — evidentiraj ULAZNI avansni račun dobavljača
 *
 * TASTATURA: Ctrl+S potvrdi, Esc otkaži (Dialog zatvara na Esc).
 */

/** Banner koji ekran prikazuje posle uspešne akcije. */
export type Banner = { tone: 'success' | 'warn' | 'danger'; msg: string };

/** Danas kao `YYYY-MM-DD` (vrednost za `<input type="date">`). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Vrste koje NISU konačan račun — avans se na njih ne veže. */
const NON_FINAL_TYPES = new Set<string>([
  SALES_DOCUMENT_TYPE.AVR,
  SALES_DOCUMENT_TYPE.PON,
  SALES_DOCUMENT_TYPE.PROF,
  SALES_DOCUMENT_TYPE.REV,
]);

// ─────────────────────────────────────────────────────────── označi naplatu

/**
 * Označavanje naplate avansa. Poreski efekat (obaveza po izdatom / pretporez po
 * primljenom avansu) nastaje TEK OVDE, i to u periodu po datumu naplate — zato je
 * datum obavezan i podrazumevano „danas".
 *
 * IZLAZNI avans se naplaćuje u RATAMA (backend `markAdvancePaid` sabira uplate i
 * svaka rata knjiži svoj PDV), pa je podrazumevani iznos NENAPLAĆEN OSTATAK, a
 * zbir preko bruto iznosa avansa se odbija pre slanja. ULAZNI se plaća jednokratno
 * (drugi poziv → 409, pretporez se ne priznaje dvaput).
 */
export function MarkPaidDialog({
  advance,
  onClose,
  onDone,
}: {
  advance: Advance;
  onClose: () => void;
  onDone: (banner: Banner) => void;
}) {
  const markPaid = useMarkAdvancePaid();
  const [paidAt, setPaidAt] = useState(today());
  const isIncoming = advance.direction === ADVANCE_DIRECTION.IN;
  // Ulazni avans nema rate — nudi se ceo bruto; izlazni nudi ono što je ostalo.
  const unpaidCents = isIncoming
    ? decimalToCents(advance.grossTotal)
    : advanceUnpaidCents(advance);
  const [amount, setAmount] = useState(() => centsToAmount(unpaidCents));

  const amountCents = decimalToCents(amount);
  const amountError =
    amount.trim() === ''
      ? 'Naplaćen iznos je obavezan.'
      : Number.isNaN(amountCents)
        ? 'Naplaćen iznos nije ispravan broj (decimale odvoji tačkom).'
        : amountCents <= 0
          ? 'Naplaćen iznos mora biti veći od 0.'
          : amountCents > unpaidCents
            ? `Zbir naplata bi prešao iznos avansnog računa — najviše ${formatDecimal(
                centsToAmount(unpaidCents),
              )} ${advance.currency}.`
            : null;
  const valid = paidAt !== '' && amountError === null;
  const err = (markPaid.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || markPaid.isPending) return;
    markPaid.mutate(
      // Iznos ide NORMALIZOVAN iz para — bez Float aritmetike nad novcem.
      {
        id: advance.id,
        direction: advance.direction,
        paidAt,
        amount: centsToAmount(amountCents),
      },
      {
        onSuccess: (res) => {
          // Poreski period vraća samo ULAZNI smer (KUF stavka); izlazni vraća
          // nalog GK. Ranije je izlazna poruka pisala „period undefined/undefined".
          const period =
            res.data.taxPeriodMonth != null && res.data.taxPeriodYear != null
              ? ` u poreskom periodu ${String(res.data.taxPeriodMonth).padStart(2, '0')}/${res.data.taxPeriodYear}`
              : '';
          const vat = res.data.vatAmount != null ? ` — PDV ${formatDecimal(res.data.vatAmount)} ${advance.currency}` : '';
          const nalog = res.data.journalEntryNumber
            ? ` Nalog ${res.data.journalEntryNumber}.`
            : '';
          // Rate: koliko avansa je ostalo nenaplaćeno posle ove uplate.
          const restCents = unpaidCents - amountCents;
          const rest =
            !isIncoming && restCents > 0
              ? ` Nenaplaćeno ostaje ${formatDecimal(centsToAmount(restCents))} ${advance.currency} — može se naplatiti u sledećoj rati.`
              : '';
          onDone({
            tone: 'success',
            msg: isIncoming
              ? `Avans ${advance.documentNumber} je označen kao plaćen${vat}${period}.`
              : `Avans ${advance.documentNumber} je označen kao naplaćen${vat}${period}.${nalog}${rest}`,
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={isIncoming ? 'Plaćanje avansa dobavljaču' : 'Naplata izdatog avansa'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={markPaid.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={markPaid.isPending} disabled={!valid}>
            Označi naplatu
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          {isIncoming
            ? 'Pretporez po avansu dobavljača priznaje se TEK PLAĆANJEM — stavka ulazi u KUF poreskog perioda po datumu plaćanja, ne po datumu računa.'
            : 'PDV obaveza po izdatom avansu nastaje NAPLATOM — stavka ulazi u KIF poreskog perioda po datumu naplate, ne po datumu računa.'}
        </p>

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <dl className="grid grid-cols-4 gap-3 rounded-panel border border-line bg-surface-2 p-3 text-sm">
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Avansni račun
            </dt>
            <dd className="tnums mt-1 font-semibold text-ink">{advance.documentNumber}</dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Bruto iznos
            </dt>
            <dd className="tnums mt-1 text-ink">
              {formatDecimal(advance.grossTotal)} {advance.currency}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Već naplaćeno
            </dt>
            <dd className="tnums mt-1 text-ink">
              {formatDecimal(advance.paidAmount)} {advance.currency}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Nenaplaćeno
            </dt>
            <dd className="tnums mt-1 font-semibold text-ink">
              {formatDecimal(centsToAmount(unpaidCents))} {advance.currency}
            </dd>
          </div>
        </dl>

        <div className="flex gap-3">
          <div className="w-44">
            <FormField label="Datum naplate" required>
              <Input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                autoFocus
              />
            </FormField>
          </div>
          <div className="w-56">
            <FormField
              label="Naplaćen iznos"
              required
              error={amountError ?? undefined}
              hint={
                isIncoming
                  ? 'Bruto iznos plaćanja.'
                  : 'Bruto; podrazumevano ceo nenaplaćen deo — smanji za delimičnu uplatu (rata).'
              }
            >
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────── veži na konačni račun

/**
 * Vezivanje avansa na konačni račun istog komitenta. Konačni račun dobija
 * „Umanjenje za primljeni avans", a PDV avansa se STORNIRA (suprotna poreska
 * stavka) da se isti porez ne prizna dvaput. Ponuđeni su samo konačni računi tog
 * komitenta (bez ponuda/predračuna/avansa).
 *
 * Veza je N:M — isti avans se deli na više računa dok se ne potroši NAPLAĆEN
 * iznos. Podrazumevani iznos odbitka je zato OSTATAK avansa (naplaćeno −
 * iskorišćeno), a prekoračenje se odbija PRE slanja istom aritmetikom koju
 * backend primenjuje pod bravom.
 */
export function LinkFinalDialog({
  advance,
  onClose,
  onDone,
}: {
  advance: Advance;
  onClose: () => void;
  onDone: (banner: Banner) => void;
}) {
  const link = useLinkAdvanceToFinal();
  const [finalInvoiceId, setFinalInvoiceId] = useState('');
  const isOutgoing = advance.direction !== ADVANCE_DIRECTION.IN;
  const remainderCents = advanceRemainderCents(advance);
  // Delimično odbijanje (samo izlazni smer): podrazumevano ceo OSTATAK avansa,
  // korisnik ga smanjuje kad avans deli na više računa.
  const [amount, setAmount] = useState(() =>
    isOutgoing ? centsToAmount(remainderCents) : '',
  );

  // Konačni računi istog komitenta (level 0). Filtriramo klijentski: avans/ponuda/
  // predračun/revers nisu konačan račun. Račun na kome je OVAJ avans već odbijen se
  // NE nudi ponovo — backend ga odbija sa 409 („već odbijen na računu…"), pa nema
  // razloga da stoji u listi. Drugi smer N:M veze (više avansa na ISTOM računu) ostaje
  // dozvoljen: filtrira se samo par (ovaj avans, taj račun).
  const invoices = useInvoices({
    customerId: advance.partnerId ?? '',
    pageSize: 100,
  });
  const alreadyApplied = useMemo(
    () => new Set((advance.applications ?? []).map((ap) => ap.invoiceId)),
    [advance.applications],
  );
  const options = useMemo(() => {
    const rows = invoices.data?.data ?? [];
    return rows
      .filter(
        (inv) =>
          !NON_FINAL_TYPES.has(inv.documentType) &&
          inv.level === 0 &&
          !alreadyApplied.has(inv.id),
      )
      .map((inv) => ({
        value: String(inv.id),
        label: `${inv.documentNumber} — ${formatDate(inv.documentDate)} — ${formatDecimal(inv.grossTotal)} ${inv.currency}`,
      }));
  }, [invoices.data, alreadyApplied]);

  const parsed = Number(finalInvoiceId);
  const invoiceChosen = Number.isInteger(parsed) && parsed > 0;

  // Prekoračenje ostatka backend već odbija sa 422 — ovde poruka mora da stigne
  // PRE slanja, jer je iznos podrazumevano ceo ostatak i korisnik ga sam menja.
  const amountCents = decimalToCents(amount);
  const amountError = !isOutgoing
    ? null
    : amount.trim() === ''
      ? 'Iznos odbitka je obavezan.'
      : Number.isNaN(amountCents)
        ? 'Iznos odbitka nije ispravan broj (decimale odvoji tačkom).'
        : amountCents <= 0
          ? 'Iznos odbitka mora biti veći od 0.'
          : amountCents > remainderCents
            ? `Iznos je veći od ostatka avansa — najviše ${formatDecimal(
                centsToAmount(remainderCents),
              )} ${advance.currency}.`
            : null;

  const valid = invoiceChosen && amountError === null;
  const err = (link.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || link.isPending) return;
    link.mutate(
      {
        advanceId: advance.id,
        direction: advance.direction,
        finalInvoiceId: parsed,
        // Normalizovano iz para (nikad Float); ulazni smer nema delimično odbijanje.
        ...(isOutgoing ? { amount: centsToAmount(amountCents) } : {}),
      },
      {
        onSuccess: (res) => {
          // Izlazni smer vraća `advanceAppliedAmount` + `payableAmount`, ulazni
          // `appliedAmount` + `reversalEntryId` — uzmi ono što stvarno stiže.
          const applied = res.data.advanceAppliedAmount ?? res.data.appliedAmount;
          const payable =
            res.data.payableAmount != null
              ? ` Za uplatu ostaje ${formatDecimal(res.data.payableAmount)} ${advance.currency}.`
              : '';
          // Ostatak avansa POSLE primene — korisnik odmah vidi ima li još šta da
          // odbije, umesto da nagađa da li je avans potrošen.
          const restCents = decimalToCents(res.data.advanceRemainingAmount);
          const rest =
            res.data.advanceRemainingAmount != null && !Number.isNaN(restCents)
              ? restCents > 0
                ? ` Ostatak avansa ${formatDecimal(res.data.advanceRemainingAmount)} ${advance.currency} — može na sledeći račun.`
                : ' Avans je time iskorišćen u celosti.'
              : '';
          onDone({
            tone: 'success',
            msg:
              `Avans ${advance.documentNumber} je vezan na konačni račun` +
              (applied != null
                ? ` — umanjenje ${formatDecimal(applied)} ${advance.currency}.`
                : '.') +
              payable +
              rest +
              (res.data.reversalEntryId || res.data.advanceClosingEntryNumber
                ? ' PDV avansa je storniran (neće se odbiti dvaput).'
                : ''),
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Veži avans na konačni račun"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={link.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={link.isPending} disabled={!valid}>
            Veži
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          Konačni račun dobija umanjenje za iznos avansa, a PDV avansa se storniranjem
          poništava. Isti avans se sme podeliti na više računa — dok se ne potroši ceo
          naplaćen iznos.
        </p>

        {/* Stanje avansa: bez njega korisnik ne vidi koliko sme da odbije, a
            podrazumevani iznos deluje kao ceo avans. */}
        <dl className="grid grid-cols-3 gap-3 rounded-panel border border-line bg-surface-2 p-3 text-sm">
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Naplaćeno
            </dt>
            <dd className="tnums mt-1 text-ink">
              {formatDecimal(advance.paidAmount)} {advance.currency}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Iskorišćeno
            </dt>
            <dd className="tnums mt-1 text-ink">
              {formatDecimal(advance.appliedAmount)} {advance.currency}
            </dd>
          </div>
          <div>
            <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Ostatak
            </dt>
            <dd className="tnums mt-1 font-semibold text-ink">
              {formatDecimal(advance.remainingAmount)} {advance.currency}
            </dd>
          </div>
        </dl>

        {(advance.applications ?? []).length > 0 && (
          <p className="text-xs text-ink-secondary">
            Već odbijen na:{' '}
            {(advance.applications ?? [])
              .map(
                (ap) =>
                  `${ap.documentNumber} — ${formatDecimal(ap.appliedAmount)} ${advance.currency}`,
              )
              .join(' · ')}
          </p>
        )}

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <FormField
          label="Konačni račun"
          required
          hint={
            invoices.isLoading
              ? 'Učitavanje računa komitenta…'
              : options.length === 0
                ? 'Za ovog komitenta nema knjiženih konačnih računa — unesi broj dokumenta ispod.'
                : 'Ponuđeni su knjiženi računi istog komitenta.'
          }
        >
          {options.length > 0 ? (
            <Select
              placeholder="Izaberi račun"
              value={finalInvoiceId}
              onChange={(e) => setFinalInvoiceId(e.target.value)}
              options={options}
            />
          ) : (
            <Input
              type="number"
              value={finalInvoiceId}
              onChange={(e) => setFinalInvoiceId(e.target.value)}
              placeholder="broj dokumenta (#)"
              autoFocus
            />
          )}
        </FormField>

        {isOutgoing && (
          <div className="w-56">
            <FormField
              label="Iznos odbitka"
              required
              error={amountError ?? undefined}
              hint="Podrazumevano ceo ostatak avansa. Smanji kad se avans deli na više računa — ostatak ostaje slobodan za sledeći račun."
            >
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={`ostatak avansa (${advance.currency})`}
              />
            </FormField>
          </div>
        )}
      </form>
    </Dialog>
  );
}

// ──────────────────────────────────────────── izlazni avans PO UGOVORU (bez predračuna)

/**
 * IZDAT avansni račun PO UGOVORU — bez predračuna.
 *
 * Backend to podržava od početka (`createAdvanceInvoice` bez `proformaId`, uz
 * obavezne kupca/iznos/osnov), i to zato što su u BigBit produkciji 2025. dva
 * NAJVEĆA avansa izdata po Ugovoru. Aplikacija je do sada imala samo ulaz sa
 * detalja PREDRAČUNA („Napravi avansni račun") — avans po ugovoru se nije mogao
 * napraviti nigde, iako ruta postoji i radi.
 *
 * GL se ovde NE dira: PDV obaveza po avansu nastaje NAPLATOM.
 */
export function OutgoingAdvanceDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (banner: Banner) => void;
}) {
  const create = useCreateAdvanceByContract();
  const rates = useTaxRates();

  const [customer, setCustomer] = useState<CustomerLookup | null>(null);
  const [amount, setAmount] = useState('');
  const [documentDate, setDocumentDate] = useState(today());
  const [basis, setBasis] = useState('');
  const [vatRateCode, setVatRateCode] = useState('3');
  const [isExport, setIsExport] = useState(false);

  const rateOptions = useMemo(
    () =>
      (rates.data?.data ?? []).map((r) => ({
        value: r.code,
        label: `${r.code} — ${formatDecimal(r.ratePct)} %${r.description ? ` (${r.description})` : ''}`,
      })),
    [rates.data],
  );

  const amountCents = decimalToCents(amount);
  const amountError =
    amount.trim() === ''
      ? null // prazno polje nije greška dok korisnik ne pokuša da pošalje
      : Number.isNaN(amountCents)
        ? 'Iznos avansa nije ispravan broj (decimale odvoji tačkom).'
        : amountCents <= 0
          ? 'Iznos avansa mora biti veći od 0.'
          : null;

  const valid =
    customer != null &&
    basis.trim() !== '' &&
    documentDate !== '' &&
    amount.trim() !== '' &&
    amountError === null;
  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || create.isPending || !customer) return;
    create.mutate(
      {
        customerId: customer.id,
        amount: centsToAmount(amountCents),
        basis: basis.trim(),
        documentDate,
        // Izvoz je uvek bez PDV-a — stopa se tada ne šalje kao izbor korisnika.
        vatRateCode: isExport ? '0' : vatRateCode,
        isExport,
      },
      {
        onSuccess: (res) => {
          onDone({
            tone: 'success',
            msg:
              `Avansni račun ${res.data.documentNumber} je napravljen ` +
              `(bruto ${formatDecimal(res.data.grossTotal)}). PDV obaveza nastaje ` +
              `tek naplatom — označi je dugmetom „Označi naplatu”.`,
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Novi avansni račun (po ugovoru)"
      size="lg"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!valid}>
            Napravi avans
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          Avans koji se izdaje bez predračuna — po ugovoru ili drugom osnovu. Iznos je
          BRUTO i razbija se na osnovicu i PDV preračunatom stopom. PDV obaveza nastaje
          NAPLATOM, ne izdavanjem računa.
        </p>

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <FormField label="Kupac" required>
          <ComboBox<CustomerLookup>
            value={customer}
            onChange={setCustomer}
            useSearch={useCustomersLookup}
            getKey={(c) => c.id}
            getLabel={(c) => c.name}
            getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
            placeholder="Kucaj naziv kupca…"
          />
        </FormField>

        <FormField
          label="Osnov avansa"
          required
          hint="Broj ugovora ili opis — ide na avansni račun kao poreski trag."
        >
          <Input
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
            maxLength={255}
            placeholder="npr. po Ugovoru br. 12/2026"
          />
        </FormField>

        <div className="flex flex-wrap gap-3">
          <div className="w-52">
            <FormField
              label="Bruto iznos"
              required
              error={amountError ?? undefined}
              hint="Osnovica + PDV."
            >
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum avansa" required>
              <Input
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
              />
            </FormField>
          </div>
          {/* Izvoz je bez PDV-a — stopa se tada ne bira (backend je fiksira na '0'). */}
          {!isExport && (
            <div className="w-56">
              <FormField label="Poreska stopa" required>
                <Select
                  placeholder={rates.isLoading ? 'Učitavanje…' : 'Izaberi stopu'}
                  value={vatRateCode}
                  onChange={(e) => setVatRateCode(e.target.value)}
                  options={rateOptions}
                />
              </FormField>
            </div>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={isExport}
            onChange={(e) => setIsExport(e.target.checked)}
            className="h-4 w-4 rounded border-line"
          />
          Izvoz (bez PDV-a)
        </label>
      </form>
    </Dialog>
  );
}

// ────────────────────────────────────────────────── evidencija ulaznog avansa

/**
 * Evidencija ULAZNOG avansnog računa dobavljača. Bez datuma plaćanja dokument samo
 * stoji evidentiran — KUF stavka i pretporez nastaju tek označavanjem plaćanja.
 */
export function IncomingAdvanceDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (banner: Banner) => void;
}) {
  const record = useRecordIncomingAdvance();
  const rates = useTaxRates();

  const [partner, setPartner] = useState<CustomerLookup | null>(null);
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentDate, setDocumentDate] = useState(today());
  const [grossAmount, setGrossAmount] = useState('');
  const [vatRateCode, setVatRateCode] = useState('');
  const [paidAt, setPaidAt] = useState('');

  const rateOptions = useMemo(
    () =>
      (rates.data?.data ?? []).map((r) => ({
        value: r.code,
        label: `${r.code} — ${formatDecimal(r.ratePct)} %${r.description ? ` (${r.description})` : ''}`,
      })),
    [rates.data],
  );

  const parsedGross = Number(grossAmount);
  const valid =
    partner != null &&
    documentNumber.trim() !== '' &&
    documentDate !== '' &&
    Number.isFinite(parsedGross) &&
    parsedGross > 0 &&
    vatRateCode !== '';
  const err = (record.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || record.isPending || !partner) return;
    record.mutate(
      {
        partnerId: partner.id,
        documentNumber: documentNumber.trim(),
        documentDate,
        grossAmount: parsedGross,
        vatRateCode,
        paidAt: paidAt || undefined,
      },
      {
        onSuccess: (res) => {
          onDone({
            tone: 'success',
            msg: res.data.vatLedgerEntryId
              ? `Ulazni avans ${res.data.documentNumber} je evidentiran i plaćen — pretporez ${formatDecimal(res.data.vatTotal)} je priznat.`
              : `Ulazni avans ${res.data.documentNumber} je evidentiran. Pretporez ${formatDecimal(res.data.vatTotal)} NIJE priznat — priznaje se tek označavanjem plaćanja.`,
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Evidentiraj ulazni avansni račun"
      size="lg"
      dismissable={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={record.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={record.isPending} disabled={!valid}>
            Evidentiraj
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        <p className="text-sm text-ink-secondary">
          Avansni račun dobavljača. Pravo na odbitak pretporeza nastaje PLAĆANJEM — dok
          datum plaćanja nije upisan, dokument stoji evidentiran bez stavke u KUF-u.
        </p>

        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <FormField label="Dobavljač" required>
          <ComboBox<CustomerLookup>
            value={partner}
            onChange={setPartner}
            useSearch={useCustomersLookup}
            getKey={(c) => c.id}
            getLabel={(c) => c.name}
            getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
            placeholder="Kucaj naziv dobavljača…"
          />
        </FormField>

        <div className="flex flex-wrap gap-3">
          <div className="w-52">
            <FormField label="Broj računa" required>
              <Input
                value={documentNumber}
                onChange={(e) => setDocumentNumber(e.target.value)}
                maxLength={30}
                placeholder="broj sa dokumenta"
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField label="Datum računa" required>
              <Input
                type="date"
                value={documentDate}
                onChange={(e) => setDocumentDate(e.target.value)}
              />
            </FormField>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="w-44">
            <FormField label="Bruto iznos" required hint="Osnovica + PDV.">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={grossAmount}
                onChange={(e) => setGrossAmount(e.target.value)}
              />
            </FormField>
          </div>
          <div className="w-56">
            <FormField label="Poreska stopa" required>
              <Select
                placeholder={rates.isLoading ? 'Učitavanje…' : 'Izaberi stopu'}
                value={vatRateCode}
                onChange={(e) => setVatRateCode(e.target.value)}
                options={rateOptions}
              />
            </FormField>
          </div>
          <div className="w-44">
            <FormField
              label="Datum plaćanja"
              hint="Ostavi prazno ako avans još nije plaćen."
            >
              <Input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </FormField>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
