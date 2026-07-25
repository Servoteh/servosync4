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
 * datum obavezan i podrazumevano „danas". Backend odbija drugo označavanje (409).
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
  const [amount, setAmount] = useState(() => String(Number(advance.grossTotal)));

  const parsed = Number(amount);
  const valid = paidAt !== '' && Number.isFinite(parsed) && parsed > 0;
  const err = (markPaid.error as Error | null)?.message ?? null;
  const isIncoming = advance.direction === ADVANCE_DIRECTION.IN;

  const submit = () => {
    if (!valid || markPaid.isPending) return;
    markPaid.mutate(
      { id: advance.id, direction: advance.direction, paidAt, amount: parsed },
      {
        onSuccess: (res) => {
          const period = `${String(res.data.taxPeriodMonth).padStart(2, '0')}/${res.data.taxPeriodYear}`;
          onDone({
            tone: 'success',
            msg: isIncoming
              ? `Avans ${advance.documentNumber} je označen kao plaćen — pretporez ${formatDecimal(res.data.vatAmount)} ${advance.currency} priznat u poreskom periodu ${period}.`
              : `Avans ${advance.documentNumber} je označen kao naplaćen — PDV ${formatDecimal(res.data.vatAmount)} ${advance.currency} u poreskom periodu ${period}.`,
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

        <dl className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2 p-3 text-sm">
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
          <div className="w-44">
            <FormField
              label="Naplaćen iznos"
              required
              hint="Bruto; može biti i delimičan."
            >
              <Input
                type="number"
                step="0.01"
                min="0"
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

  // Konačni računi istog komitenta (level 0). Filtriramo klijentski: avans/ponuda/
  // predračun/revers nisu konačan račun, a već vezan račun se ne nudi ponovo.
  const invoices = useInvoices({
    customerId: advance.partnerId ?? '',
    pageSize: 100,
  });
  const options = useMemo(() => {
    const rows = invoices.data?.data ?? [];
    return rows
      .filter((inv) => !NON_FINAL_TYPES.has(inv.documentType) && inv.level === 0)
      .map((inv) => ({
        value: String(inv.id),
        label: `${inv.documentNumber} — ${formatDate(inv.documentDate)} — ${formatDecimal(inv.grossTotal)} ${inv.currency}`,
      }));
  }, [invoices.data]);

  const parsed = Number(finalInvoiceId);
  const valid = Number.isInteger(parsed) && parsed > 0;
  const err = (link.error as Error | null)?.message ?? null;

  const submit = () => {
    if (!valid || link.isPending) return;
    link.mutate(
      { advanceId: advance.id, direction: advance.direction, finalInvoiceId: parsed },
      {
        onSuccess: (res) => {
          onDone({
            tone: 'success',
            msg:
              `Avans ${advance.documentNumber} je vezan na konačni račun — umanjenje ` +
              `${formatDecimal(res.data.appliedAmount)} ${advance.currency}.` +
              (res.data.reversalEntryId
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
          poništava. Avans se sme iskoristiti samo jednom.
        </p>

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
