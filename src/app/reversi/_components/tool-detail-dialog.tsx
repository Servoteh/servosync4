'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import {
  newClientEventId,
  useReversiTool,
  useRestoreTool,
  useStockDelta,
  useWriteOffTool,
} from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

function ToolStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <StatusBadge tone="success" label="U upotrebi" />;
  if (status === 'lost') return <StatusBadge tone="warn" label="Izgubljen" />;
  return <StatusBadge tone="danger" label="Otpisan" />;
}

/**
 * Kartica alata (paritet 1.0 reversiToolDetail): osnovno + baterije + servisi +
 * akcije Otpiši (write-off) / Vrati u upotrebu (restore). Manage-only akcije;
 * čitanje dozvoljeno svima (reversi.read).
 */
export function ToolDetailDialog({ toolId, onClose }: { toolId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const detail = useReversiTool(toolId);
  const writeOff = useWriteOffTool();
  const restore = useRestoreTool();
  const stockDelta = useStockDelta();

  const [woOpen, setWoOpen] = useState(false);
  const [razlog, setRazlog] = useState('');
  const [woStatus, setWoStatus] = useState<'scrapped' | 'lost'>('scrapped');
  const [recQty, setRecQty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const t = detail.data?.data;

  async function doReceive() {
    if (!t || recQty <= 0) return;
    setError(null);
    try {
      await stockDelta.mutateAsync({
        clientEventId: newClientEventId(),
        toolId: t.id,
        delta: recQty,
        reason: 'RECEIPT',
        note: 'Prijem u magacin',
      });
      setRecQty(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prijem nije uspeo.');
    }
  }

  async function doWriteOff() {
    if (!t) return;
    setError(null);
    try {
      await writeOff.mutateAsync({ clientEventId: newClientEventId(), toolId: t.id, razlog: razlog.trim() || undefined, status: woStatus });
      setWoOpen(false);
      setRazlog('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Otpis nije uspeo.');
    }
  }

  async function doRestore() {
    if (!t) return;
    setError(null);
    try {
      await restore.mutateAsync({ clientEventId: newClientEventId(), toolId: t.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vraćanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open={!!toolId}
      onClose={onClose}
      title={t ? `${t.oznaka} — ${t.naziv}` : 'Kartica alata'}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div>
            {manage && t?.status === 'active' && !woOpen && (
              <Button variant="danger" onClick={() => setWoOpen(true)}>
                Otpiši / Izgubljen
              </Button>
            )}
            {manage && t && t.status !== 'active' && (
              <Button variant="secondary" loading={restore.isPending} onClick={() => void doRestore()}>
                Vrati u upotrebu
              </Button>
            )}
          </div>
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        </div>
      }
    >
      {detail.isError ? (
        <p className="text-sm text-status-danger">Kartica nije dostupna za ovu stavku (nije ručni alat).</p>
      ) : detail.isLoading || !t ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Info label="Status"><ToolStatusBadge status={t.status} /></Info>
            <Info label="Barkod">{t.barcode}</Info>
            <Info label="Serijski broj">{t.serijskiBroj ?? '—'}</Info>
            <Info label="Tip">{t.isConsumable ? 'Potrošni' : t.isQuantity ? 'Količinski' : 'Jedinica'}</Info>
            {(t.isQuantity || t.isConsumable) && <Info label="Na stanju">{formatNumber(t.totalQty)}</Info>}
            <Info label="Nabavljen">{formatDate(t.datumKupovine)}</Info>
            {t.status !== 'active' && (
              <>
                <Info label="Datum otpisa">{formatDate(t.otpisDatum)}</Info>
                <Info label="Razlog">{t.otpisRazlog ?? '—'}</Info>
              </>
            )}
          </div>

          {manage && t.status === 'active' && (t.isQuantity || t.isConsumable) && (
            <div className="flex items-end gap-2 rounded-control border border-line p-3">
              <FormField label="Prijem u magacin (+ količina)">
                <input
                  className={`${INPUT} w-28`}
                  type="number"
                  min={1}
                  value={recQty}
                  onChange={(e) => setRecQty(Math.max(1, Number(e.target.value) || 1))}
                />
              </FormField>
              <Button variant="secondary" loading={stockDelta.isPending} onClick={() => void doReceive()}>
                Primi
              </Button>
            </div>
          )}

          {woOpen && (
            <div className="space-y-2 rounded-control border border-status-danger/40 bg-status-danger-bg/40 p-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Vrsta">
                  <select className={INPUT} value={woStatus} onChange={(e) => setWoStatus(e.target.value as 'scrapped' | 'lost')}>
                    <option value="scrapped">Otpisan</option>
                    <option value="lost">Izgubljen</option>
                  </select>
                </FormField>
                <FormField label="Razlog">
                  <input className={INPUT} value={razlog} onChange={(e) => setRazlog(e.target.value)} placeholder="npr. neispravan" />
                </FormField>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setWoOpen(false)}>Otkaži</Button>
                <Button variant="danger" loading={writeOff.isPending} onClick={() => void doWriteOff()}>Potvrdi otpis</Button>
              </div>
            </div>
          )}

          <Section title="Baterije">
            {t.batteries.length === 0 ? (
              <Empty>Nema evidentiranih baterija.</Empty>
            ) : (
              t.batteries.map((b) => (
                <Row key={b.id}>
                  <span className="font-medium">{b.serijskiBroj ?? 'Baterija'}</span>
                  <span className="text-ink-secondary">{b.kapacitet ?? ''}</span>
                  <span className="ml-auto text-xs text-ink-secondary">{formatDate(b.datumNabavke)}</span>
                </Row>
              ))
            )}
          </Section>

          <Section title="Servisi i popravke">
            {t.services.length === 0 ? (
              <Empty>Nema evidentiranih servisa.</Empty>
            ) : (
              t.services.map((s) => (
                <Row key={s.id}>
                  <span className="tnums text-ink-secondary">{formatDate(s.datum)}</span>
                  <span className="font-medium">{s.tip}</span>
                  <span className="flex-1 text-ink-secondary">{s.opis ?? ''}</span>
                  <span className="tnums">{s.trosak != null ? formatNumber(Number(s.trosak)) : ''}</span>
                </Row>
              ))
            )}
          </Section>

          {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className="text-ink">{children}</div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <div className="space-y-1 rounded-control border border-line p-2">{children}</div>
    </section>
  );
}
function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-3 text-sm">{children}</div>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-ink-secondary">{children}</p>;
}
