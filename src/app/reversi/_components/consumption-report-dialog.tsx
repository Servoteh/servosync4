'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { downloadCsv } from '@/lib/reversi-csv';
import { fetchConsumptionReport, type ConsumptionRow } from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Srpske labele tipa pokreta (paritet 1.0 CONS_REASON_LABEL). */
const REASON_LABEL: Record<string, string> = {
  RECEIPT: 'Prijem',
  ISSUE: 'Izdato / potrošeno',
  RETURN: 'Povraćaj',
  ADJUST: 'Korekcija',
  WRITE_OFF: 'Otpis',
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStart(): string {
  return `${today().slice(0, 7)}-01`;
}

function who(x: ConsumptionRow): string {
  return x.recipient_employee_name || x.recipient_department || x.recipient_company_name || '—';
}

/**
 * Magacionerski izveštaj potrošnje/pokreta zalihe (RA-39/40/41 — paritet 1.0
 * `openConsumptionReportDialog`). Period (Od/Do) + tip pokreta iz obogaćenog ledgera;
 * „Zbir po artiklu" (Σ|delta| po artiklu) + „Detalji" + CSV izvoz. Default period =
 * 1. tekućeg meseca → danas, tip = Izdato/potrošeno. Manage-only (BE `reversi.manage`).
 */
export function ConsumptionReportDialog({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [reason, setReason] = useState('ISSUE');
  const [rows, setRows] = useState<ConsumptionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (from && to && from > to) {
      setError('Datum „Od" ne sme biti posle „Do".');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetchConsumptionReport({ from, to, reason, limit: 5000 });
      setRows(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Učitavanje nije uspelo.');
      setRows(null);
    } finally {
      setLoading(false);
    }
  }

  // Zbir po artiklu (apsolutna količina pokreta) — paritet 1.0 byItem.
  const summary = useMemo(() => {
    if (!rows) return [];
    const byItem = new Map<string, { oznaka: string; naziv: string; qty: number; n: number }>();
    for (const x of rows) {
      const key = x.tool_id ?? x.oznaka ?? x.ledger_id;
      const cur = byItem.get(key) ?? { oznaka: x.oznaka ?? '', naziv: x.naziv ?? '', qty: 0, n: 0 };
      cur.qty += Math.abs(Number(x.delta) || 0);
      cur.n += 1;
      byItem.set(key, cur);
    }
    return [...byItem.values()].sort((a, b) => b.qty - a.qty);
  }, [rows]);

  function exportCsv() {
    if (!rows || rows.length === 0) {
      toast('Prvo prikaži izveštaj');
      return;
    }
    downloadCsv(
      `reversi-potrosnja-${today()}.csv`,
      ['Datum', 'Oznaka', 'Naziv', 'Tip', 'Promena', 'Stanje posle', 'Primalac', 'Dokument', 'Napomena'],
      rows.map((x) => [
        String(x.created_at || '').slice(0, 19).replace('T', ' '),
        x.oznaka ?? '',
        x.naziv ?? '',
        REASON_LABEL[x.reason] ?? x.reason,
        String(x.delta),
        String(x.balance_after),
        who(x) === '—' ? '' : who(x),
        x.doc_number ?? '',
        x.note ?? '',
      ]),
    );
    toast(`Izvezeno ${formatNumber(rows.length)} redova`);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Izveštaj potrošnje"
      size="xl2"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Zatvori
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <FormField label="Od">
            <input className={INPUT} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField label="Do">
            <input className={INPUT} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
          <FormField label="Tip">
            <select className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="ISSUE">Izdato / potrošeno</option>
              <option value="WRITE_OFF">Otpis</option>
              <option value="RECEIPT">Prijem</option>
              <option value="ALL">Sve</option>
            </select>
          </FormField>
          <Button loading={loading} onClick={() => void run()}>
            Prikaži
          </Button>
          <Button variant="secondary" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" aria-hidden /> CSV
          </Button>
        </div>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : rows == null ? (
          <p className="text-sm text-ink-secondary">Izaberi period i klikni „Prikaži".</p>
        ) : rows.length === 0 ? (
          <div className="rounded-panel border border-line bg-surface-2 p-6 text-center text-sm text-ink-secondary">
            Nema pokreta za izabrani period/tip.
          </div>
        ) : (
          <div className="space-y-4">
            <section className="space-y-1">
              <h3 className="text-sm font-semibold text-ink">Zbir po artiklu</h3>
              <div className="max-h-[30vh] overflow-auto rounded-control border border-line">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-2 text-ink-secondary">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Oznaka</th>
                      <th className="px-2 py-1 text-left font-medium">Naziv</th>
                      <th className="px-2 py-1 text-right font-medium">Količina</th>
                      <th className="px-2 py-1 text-right font-medium">Pokreta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map((s) => (
                      <tr key={`${s.oznaka}-${s.naziv}`} className="border-t border-line">
                        <td className="px-2 py-1 tnums font-medium">{s.oznaka}</td>
                        <td className="px-2 py-1">{s.naziv}</td>
                        <td className="px-2 py-1 text-right tnums font-medium">{formatNumber(s.qty)}</td>
                        <td className="px-2 py-1 text-right tnums text-ink-secondary">{s.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="space-y-1">
              <h3 className="text-sm font-semibold text-ink">Detalji ({formatNumber(rows.length)})</h3>
              <div className="max-h-[38vh] overflow-auto rounded-control border border-line">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-2 text-ink-secondary">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">Datum</th>
                      <th className="px-2 py-1 text-left font-medium">Artikal</th>
                      <th className="px-2 py-1 text-left font-medium">Tip</th>
                      <th className="px-2 py-1 text-right font-medium">Δ</th>
                      <th className="px-2 py-1 text-left font-medium">Primalac</th>
                      <th className="px-2 py-1 text-left font-medium">Dokument</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => {
                      const d = Number(x.delta) || 0;
                      return (
                        <tr key={x.ledger_id} className="border-t border-line">
                          <td className="px-2 py-1 tnums">{String(x.created_at || '').slice(0, 10)}</td>
                          <td className="px-2 py-1">
                            <span className="tnums font-medium">{x.oznaka}</span> {x.naziv}
                          </td>
                          <td className="px-2 py-1 text-ink-secondary">{REASON_LABEL[x.reason] ?? x.reason}</td>
                          <td
                            className={`px-2 py-1 text-right tnums ${
                              d > 0 ? 'text-status-success' : d < 0 ? 'text-status-danger' : ''
                            }`}
                          >
                            {d > 0 ? '+' : ''}
                            {d}
                          </td>
                          <td className="px-2 py-1">{who(x)}</td>
                          <td className="px-2 py-1 tnums text-ink-secondary">{x.doc_number ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </Dialog>
  );
}
