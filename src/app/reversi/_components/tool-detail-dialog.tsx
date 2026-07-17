'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  newClientEventId,
  useAddToolBattery,
  useAddToolService,
  useDeleteToolBattery,
  useDeleteToolService,
  useReversiTool,
  useRestoreTool,
  useStockDelta,
  useToolDocuments,
  useToolLedger,
  useUpdateToolBattery,
  useUpdateToolService,
  useWriteOffTool,
  type ReversiToolDetail,
  type ToolBattery,
  type ToolBatteryInput,
  type ToolDocumentLine,
  type ToolLedgerRow,
  type ToolService,
  type ToolServiceInput,
} from '@/api/reversi';
import { ToolEditDialog } from './tool-edit-dialog';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

type DetailTab = 'osnovno' | 'baterije' | 'servis' | 'istorija';

/** Srpske labele tipa knjiženja zaliha (paritet 1.0 LEDGER_REASON_LABEL). */
const LEDGER_REASON_LABEL: Record<string, string> = {
  RECEIPT: 'Prijem',
  ISSUE: 'Izdato / potrošeno',
  RETURN: 'Povraćaj',
  ADJUST: 'Korekcija',
  WRITE_OFF: 'Otpis',
};

/** Tip servisa/popravke (paritet 1.0 TIP_LABEL). */
const TIP_LABEL: Record<string, string> = {
  servis: 'Servis',
  popravka: 'Popravka',
  zamena_baterije: 'Zamena baterije',
  kalibracija: 'Kalibracija',
  ostalo: 'Ostalo',
};
/** Status servisa (paritet 1.0 SRV_STATUS_LABEL). */
const SRV_STATUS_LABEL: Record<string, string> = {
  planiran: 'Planiran',
  u_toku: 'U toku',
  zavrsen: 'Završen',
  otkazan: 'Otkazan',
};
/** Status baterije → ton + labela (paritet 1.0 BAT_STATUS_LABEL). */
const BAT_STATUS: Record<string, { tone: Tone; label: string }> = {
  active: { tone: 'success', label: 'Ispravna' },
  scrapped: { tone: 'neutral', label: 'Otpisana' },
  lost: { tone: 'warn', label: 'Izgubljena' },
};

const TIP_OPTIONS: { value: NonNullable<ToolServiceInput['tip']>; label: string }[] = [
  { value: 'servis', label: 'Servis' },
  { value: 'popravka', label: 'Popravka' },
  { value: 'zamena_baterije', label: 'Zamena baterije' },
  { value: 'kalibracija', label: 'Kalibracija' },
  { value: 'ostalo', label: 'Ostalo' },
];
const SRV_STATUS_OPTIONS: { value: NonNullable<ToolServiceInput['status']>; label: string }[] = [
  { value: 'planiran', label: 'Planiran' },
  { value: 'u_toku', label: 'U toku' },
  { value: 'zavrsen', label: 'Završen' },
  { value: 'otkazan', label: 'Otkazan' },
];
const BAT_STATUS_OPTIONS: { value: NonNullable<ToolBatteryInput['status']>; label: string }[] = [
  { value: 'active', label: 'Ispravna' },
  { value: 'scrapped', label: 'Otpisana' },
  { value: 'lost', label: 'Izgubljena' },
];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Nabavna vrednost / trošak → „X din" (paritet 1.0 fmtDin). */
function fmtDin(n: string | number | null | undefined): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return `${v.toLocaleString('sr-RS', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} din`;
}

/**
 * Garancija badge (RB-05, paritet 1.0 garancijaBadge): `<0` = istekla (danger),
 * `≤30 d` = ističe za N d (warn), inače važi do (success). Računa se KLIJENTSKI iz
 * `garancijaDo` (BE ga vraća u findOneTool payload-u).
 */
function garancijaBadge(garancijaDo: string | null | undefined): { tone: Tone; label: string } | null {
  if (!garancijaDo) return null;
  const d = new Date(`${String(garancijaDo).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return null;
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  const dl = formatDate(garancijaDo);
  if (days < 0) return { tone: 'danger', label: `istekla ${dl}` };
  if (days <= 30) return { tone: 'warn', label: `ističe za ${days} d (${dl})` };
  return { tone: 'success', label: `važi do ${dl}` };
}

/** Klasifikacija „grupa · podgrupa · podpodgrupa" iz razrešenih ref-ova (RB-04). */
function classPath(t: ReversiToolDetail): string {
  const parts = [t.group?.label, t.subgroup?.label, t.subsubgroup?.label].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nesvrstano';
}

function ToolStatusBadge({ status }: { status: string }) {
  if (status === 'active') return <StatusBadge tone="success" label="U upotrebi" />;
  if (status === 'lost') return <StatusBadge tone="warn" label="Izgubljen" />;
  return <StatusBadge tone="danger" label="Otpisan" />;
}

/**
 * Kartica ručnog alata (paritet 1.0 reversiToolDetail — 4 taba: Osnovno · Baterije ·
 * Servis i popravke · Istorija). Manage-only akcije (Izmeni/Otpiši/Vrati u upotrebu +
 * CRUD baterija/servisa); čitanje dozvoljeno svima (reversi.read).
 */
export function ToolDetailDialog({ toolId, onClose }: { toolId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const detail = useReversiTool(toolId);
  const documents = useToolDocuments(toolId);
  const writeOff = useWriteOffTool();
  const restore = useRestoreTool();
  const stockDelta = useStockDelta();
  const delBattery = useDeleteToolBattery();
  const delService = useDeleteToolService();

  const [tab, setTab] = useState<DetailTab>('osnovno');
  const [woOpen, setWoOpen] = useState(false);
  const [razlog, setRazlog] = useState('');
  const [woStatus, setWoStatus] = useState<'scrapped' | 'lost'>('scrapped');
  const [woDatum, setWoDatum] = useState(today());
  const [recQty, setRecQty] = useState(1);
  const [editOpen, setEditOpen] = useState(false);
  const [batteryForm, setBatteryForm] = useState<ToolBattery | 'new' | null>(null);
  const [serviceForm, setServiceForm] = useState<ToolService | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dijalog ostaje montiran (roditelj menja samo `toolId`); resetuj sva lokalna
  // stanja pri promeni alata — inače otvoren otpis/forma sa prethodnog alata
  // „procuri" na sledeći (rizik pogrešnog otpisa / unosa na tuđu karticu).
  useEffect(() => {
    setTab('osnovno');
    setWoOpen(false);
    setRazlog('');
    setWoStatus('scrapped');
    setWoDatum(today());
    setRecQty(1);
    setEditOpen(false);
    setBatteryForm(null);
    setServiceForm(null);
    setError(null);
  }, [toolId]);

  const t = detail.data?.data;
  // RA-19/RA-20 — istorija zaliha samo za količinske/potrošne (ledger je manage-gejtovan).
  const isQty = !!(t && (t.isQuantity || t.isConsumable));
  const ledger = useToolLedger(toolId, manage && isQty && tab === 'istorija');

  async function doReceive() {
    if (!t || recQty <= 0 || stockDelta.isPending) return;
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
    if (!t || writeOff.isPending) return;
    setError(null);
    try {
      await writeOff.mutateAsync({
        clientEventId: newClientEventId(),
        toolId: t.id,
        razlog: razlog.trim() || undefined,
        datum: woDatum || undefined,
        status: woStatus,
      });
      toast('Alat otpisan');
      setWoOpen(false);
      setRazlog('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Otpis nije uspeo.');
    }
  }

  async function doRestore() {
    if (!t || restore.isPending) return;
    setError(null);
    try {
      await restore.mutateAsync({ clientEventId: newClientEventId(), toolId: t.id });
      toast('Alat vraćen u upotrebu');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vraćanje nije uspelo.');
    }
  }

  async function doDeleteBattery(id: string) {
    if (!window.confirm('Obrisati bateriju?')) return;
    setError(null);
    try {
      await delBattery.mutateAsync(id);
      toast('Baterija obrisana');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Brisanje nije uspelo.');
    }
  }

  async function doDeleteService(id: string) {
    if (!window.confirm('Obrisati servis?')) return;
    setError(null);
    try {
      await delService.mutateAsync(id);
      toast('Obrisano');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Brisanje nije uspelo.');
    }
  }

  const scrapped = !!t && t.status !== 'active';
  const gb = garancijaBadge(t?.garancijaDo);

  const nBat = t?.batteries.length ?? 0;
  const nSrv = t?.services.length ?? 0;
  const tabs: TabItem<DetailTab>[] = [
    { key: 'osnovno', label: 'Osnovno' },
    { key: 'baterije', label: nBat ? `Baterije (${nBat})` : 'Baterije' },
    { key: 'servis', label: nSrv ? `Servis i popravke (${nSrv})` : 'Servis i popravke' },
    { key: 'istorija', label: 'Istorija' },
  ];

  return (
    <>
      <Dialog
        open={!!toolId}
        onClose={onClose}
        size="xl2"
        title={t ? `${t.oznaka} — ${t.naziv}` : 'Kartica alata'}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {manage && t && !scrapped && (
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  ✎ Izmeni
                </Button>
              )}
              {manage && t && !scrapped && !woOpen && (
                <Button variant="danger" onClick={() => setWoOpen(true)}>
                  🗑 Otpiši alat
                </Button>
              )}
              {manage && t && scrapped && (
                <Button variant="secondary" loading={restore.isPending} onClick={() => void doRestore()}>
                  ♻ Vrati u upotrebu
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
            {/* Hero (RB-01): status, barkod, garancija badž, klasifikacija. */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ToolStatusBadge status={t.status} />
              {t.barcode && <span className="tnums text-ink-secondary">{t.barcode}</span>}
              {gb && <StatusBadge tone={gb.tone} label={gb.label} />}
              <span className="text-ink-secondary">· {classPath(t)}</span>
            </div>

            {/* Otpis panel (RB-12) — Vrsta + Datum otpisa + Razlog. */}
            {woOpen && (
              <div className="space-y-2 rounded-control border border-status-danger/40 bg-status-danger-bg/40 p-3">
                <h4 className="text-sm font-semibold text-ink">Otpis alata</h4>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField label="Vrsta">
                    <select className={INPUT} value={woStatus} onChange={(e) => setWoStatus(e.target.value as 'scrapped' | 'lost')}>
                      <option value="scrapped">Otpisan (rashod)</option>
                      <option value="lost">Izgubljen</option>
                    </select>
                  </FormField>
                  <FormField label="Datum otpisa">
                    <input className={INPUT} type="date" value={woDatum} onChange={(e) => setWoDatum(e.target.value)} />
                  </FormField>
                  <FormField label="Razlog">
                    <input className={INPUT} value={razlog} onChange={(e) => setRazlog(e.target.value)} placeholder="npr. neisplativa popravka, dotrajao" />
                  </FormField>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setWoOpen(false)}>Otkaži</Button>
                  <Button variant="danger" loading={writeOff.isPending} onClick={() => void doWriteOff()}>Otpiši</Button>
                </div>
              </div>
            )}

            <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Sekcije kartice alata" />

            {tab === 'osnovno' && (
              <OsnovnoTab
                t={t}
                manage={manage}
                isQty={isQty}
                recQty={recQty}
                setRecQty={setRecQty}
                receiving={stockDelta.isPending}
                onReceive={() => void doReceive()}
              />
            )}
            {tab === 'baterije' && (
              <BaterijeTab
                rows={t.batteries}
                manage={manage}
                onAdd={() => setBatteryForm('new')}
                onEdit={(b) => setBatteryForm(b)}
                onDelete={(id) => void doDeleteBattery(id)}
                deleting={delBattery.isPending}
              />
            )}
            {tab === 'servis' && (
              <ServisTab
                rows={t.services}
                nabavnaVrednost={t.nabavnaVrednost}
                manage={manage}
                onAdd={() => setServiceForm('new')}
                onEdit={(s) => setServiceForm(s)}
                onDelete={(id) => void doDeleteService(id)}
                deleting={delService.isPending}
              />
            )}
            {tab === 'istorija' && (
              <IstorijaTab
                docs={documents.data?.data ?? []}
                docsLoading={documents.isLoading}
                showLedger={manage && isQty}
                ledgerRows={ledger.data?.data ?? []}
                ledgerLoading={ledger.isLoading}
              />
            )}

            {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
          </div>
        )}
      </Dialog>

      <ToolEditDialog open={editOpen} tool={t ?? null} onClose={() => setEditOpen(false)} />
      {t && batteryForm && (
        <BatteryFormDialog
          toolId={t.id}
          row={batteryForm === 'new' ? null : batteryForm}
          onClose={() => setBatteryForm(null)}
        />
      )}
      {t && serviceForm && (
        <ServiceFormDialog
          toolId={t.id}
          row={serviceForm === 'new' ? null : serviceForm}
          onClose={() => setServiceForm(null)}
        />
      )}
    </>
  );
}

/* ─────────────────────────── Osnovno (RB-04/05/12) ─────────────────────────── */

function OsnovnoTab({
  t,
  manage,
  isQty,
  recQty,
  setRecQty,
  receiving,
  onReceive,
}: {
  t: ReversiToolDetail;
  manage: boolean;
  isQty: boolean;
  recQty: number;
  setRecQty: (n: number) => void;
  receiving: boolean;
  onReceive: () => void;
}) {
  const gb = garancijaBadge(t.garancijaDo);
  let zad: React.ReactNode = 'U magacinu';
  if (t.issuedHolder) {
    const h = t.issuedHolder;
    const who = h.recipientEmployeeName || h.recipientDepartment || h.recipientCompanyName || 'Primalac';
    zad = (
      <>
        Na reversu <span className="tnums">{h.docNumber}</span> · {who}
      </>
    );
  } else if (t.currentLocationCode) {
    zad = `Slobodan · Magacin ${t.currentLocationCode}`;
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-control border border-line p-4 text-sm sm:grid-cols-2">
        <Field label="Oznaka (gravirano)"><span className="tnums">{t.oznaka || '—'}</span></Field>
        <Field label="Barkod"><span className="tnums">{t.barcode || '—'}</span></Field>
        <Field label="Klasifikacija">{classPath(t)}</Field>
        <Field label="Tip">{t.isConsumable ? 'Potrošni' : t.isQuantity ? 'Količinski' : 'Jedinica'}</Field>
        {isQty && <Field label="Na stanju">{formatNumber(t.totalQty)}</Field>}
        <Field label="Serijski broj">{t.serijskiBroj || '—'}</Field>
        <Field label="Datum kupovine">{formatDate(t.datumKupovine)}</Field>
        <Field label="Nabavna vrednost">{fmtDin(t.nabavnaVrednost)}</Field>
        <Field label="Garancija">
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {formatDate(t.garancijaDo)}
              {t.garancijaNapomena ? ` · ${t.garancijaNapomena}` : ''}
            </span>
            {gb && <StatusBadge tone={gb.tone} label={gb.label} />}
          </span>
        </Field>
        <Field label="Punjač">
          {t.imaPunjac ? (
            <>Da{t.punjacSerijski ? <> · <span className="tnums">{t.punjacSerijski}</span></> : null}</>
          ) : (
            'Ne'
          )}
        </Field>
        <Field label="Zaduženje / lokacija">{zad}</Field>
        <div className="sm:col-span-2">
          <Field label="Napomena">{t.napomena || '—'}</Field>
        </div>
      </dl>

      {/* Blok Otpis (RB-04) — kad alat nije aktivan. */}
      {t.status !== 'active' && (
        <div className="space-y-2 rounded-control border border-status-warn/40 bg-status-warn-bg/30 p-4 text-sm">
          <h4 className="font-semibold text-ink">Otpis</h4>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            <Field label="Status"><ToolStatusBadge status={t.status} /></Field>
            <Field label="Datum otpisa">{formatDate(t.otpisDatum)}</Field>
            <div className="sm:col-span-2">
              <Field label="Razlog">{t.otpisRazlog || '—'}</Field>
            </div>
          </dl>
        </div>
      )}

      {/* Prijem u magacin (količinski/potrošni, aktivan, manage) — zadržano iz 2.0. */}
      {manage && t.status === 'active' && isQty && (
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
          <Button variant="secondary" loading={receiving} onClick={onReceive}>
            Primi
          </Button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Baterije (RB-06/07) ─────────────────────────── */

function BaterijeTab({
  rows,
  manage,
  onAdd,
  onEdit,
  onDelete,
  deleting,
}: {
  rows: ToolBattery[];
  manage: boolean;
  onAdd: () => void;
  onEdit: (b: ToolBattery) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  return (
    <div className="space-y-2 rounded-control border border-line p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-ink">Baterije ({rows.length})</h4>
        {manage && (
          <Button variant="secondary" onClick={onAdd}>
            + Dodaj bateriju
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-secondary">Nema upisanih baterija.</p>
      ) : (
        <div className="overflow-x-auto rounded-control border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface-2 text-ink-secondary">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Serijski broj</th>
                <th className="px-2 py-1 text-left font-medium">Kapacitet</th>
                <th className="px-2 py-1 text-left font-medium">Nabavljena</th>
                <th className="px-2 py-1 text-left font-medium">Status</th>
                <th className="px-2 py-1 text-left font-medium">Napomena</th>
                {manage && <th className="px-2 py-1" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const st = BAT_STATUS[b.status] ?? { tone: 'neutral' as Tone, label: b.status };
                return (
                  <tr key={b.id} className="border-t border-line">
                    <td className="px-2 py-1 tnums">{b.serijskiBroj || '—'}</td>
                    <td className="px-2 py-1">{b.kapacitet || '—'}</td>
                    <td className="px-2 py-1 tnums">{formatDate(b.datumNabavke)}</td>
                    <td className="px-2 py-1"><StatusBadge tone={st.tone} label={st.label} /></td>
                    <td className="px-2 py-1 text-ink-secondary">{b.napomena || ''}</td>
                    {manage && (
                      <td className="px-2 py-1">
                        <div className="flex justify-end gap-1">
                          <RowBtn onClick={() => onEdit(b)}>✎</RowBtn>
                          <RowBtn danger disabled={deleting} onClick={() => onDelete(b.id)}>🗑</RowBtn>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────── Servis (RB-08/09) ─────────────────────────── */

function ServisTab({
  rows,
  nabavnaVrednost,
  manage,
  onAdd,
  onEdit,
  onDelete,
  deleting,
}: {
  rows: ToolService[];
  nabavnaVrednost: string | number | null | undefined;
  manage: boolean;
  onAdd: () => void;
  onEdit: (s: ToolService) => void;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  // Trošak i isplativost broje SAMO ZAVRŠENE servise (odluka korisnika 2026-07-02).
  const ukupno = rows
    .filter((r) => r.status === 'zavrsen')
    .reduce((a, r) => a + (Number(r.trosak) || 0), 0);
  const nv = Number(nabavnaVrednost) || 0;
  const pct = nv > 0 ? Math.round((ukupno / nv) * 100) : null;

  return (
    <div className="space-y-3">
      {/* Stat kartice (RB-08). */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Broj servisa" value={String(rows.length)} />
        <StatCard label="Ukupan trošak popravki" value={fmtDin(ukupno)} />
        <StatCard label="Nabavna vrednost" value={fmtDin(nabavnaVrednost)} />
        {pct != null && (
          <StatCard
            label="Popravke / nabavna vrednost"
            value={`${pct}%`}
            hint={pct >= 60 ? 'razmisli o zameni' : 'isplativo'}
            warn={pct >= 60}
          />
        )}
      </div>

      <div className="space-y-2 rounded-control border border-line p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Servisi i popravke</h4>
          {manage && (
            <Button variant="secondary" onClick={onAdd}>
              + Dodaj servis
            </Button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-ink-secondary">Nema evidentiranih servisa.</p>
        ) : (
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-ink-secondary">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Datum</th>
                  <th className="px-2 py-1 text-left font-medium">Tip</th>
                  <th className="px-2 py-1 text-left font-medium">Opis</th>
                  <th className="px-2 py-1 text-left font-medium">Izvršilac</th>
                  <th className="px-2 py-1 text-right font-medium">Trošak</th>
                  <th className="px-2 py-1 text-left font-medium">Status</th>
                  {manage && <th className="px-2 py-1" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-t border-line">
                    <td className="px-2 py-1 tnums">{formatDate(s.datum)}</td>
                    <td className="px-2 py-1">{TIP_LABEL[s.tip] ?? s.tip}</td>
                    <td className="px-2 py-1 text-ink-secondary">{s.opis || '—'}</td>
                    <td className="px-2 py-1">{s.izvrsilac || '—'}</td>
                    <td className="px-2 py-1 text-right tnums">{fmtDin(s.trosak)}</td>
                    <td className="px-2 py-1">{SRV_STATUS_LABEL[s.status] ?? s.status}</td>
                    {manage && (
                      <td className="px-2 py-1">
                        <div className="flex justify-end gap-1">
                          <RowBtn onClick={() => onEdit(s)}>✎</RowBtn>
                          <RowBtn danger disabled={deleting} onClick={() => onDelete(s.id)}>🗑</RowBtn>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Istorija (RB-10) ─────────────────────────── */

function IstorijaTab({
  docs,
  docsLoading,
  showLedger,
  ledgerRows,
  ledgerLoading,
}: {
  docs: ToolDocumentLine[];
  docsLoading: boolean;
  showLedger: boolean;
  ledgerRows: ToolLedgerRow[];
  ledgerLoading: boolean;
}) {
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h4 className="text-sm font-semibold text-ink">Istorija zaduženja</h4>
        {docsLoading ? (
          <p className="text-xs text-ink-secondary">Učitavanje…</p>
        ) : docs.length === 0 ? (
          <p className="text-xs text-ink-secondary">Nema zaduženja za ovaj alat.</p>
        ) : (
          <div className="overflow-x-auto rounded-control border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface-2 text-ink-secondary">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">Izdato</th>
                  <th className="px-2 py-1 text-left font-medium">Dokument</th>
                  <th className="px-2 py-1 text-left font-medium">Primalac</th>
                  <th className="px-2 py-1 text-left font-medium">Stavka</th>
                  <th className="px-2 py-1 text-left font-medium">Vraćeno</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((l) => {
                  const d = l.document;
                  const who =
                    d?.recipientEmployeeName || d?.recipientDepartment || d?.recipientCompanyName || '—';
                  const st =
                    l.lineStatus === 'RETURNED' ? 'Vraćen' : l.lineStatus === 'ISSUED' ? 'Zadužen' : l.lineStatus;
                  return (
                    <tr key={l.id} className="border-t border-line">
                      <td className="px-2 py-1 tnums">{formatDate(d?.issuedAt)}</td>
                      <td className="px-2 py-1 tnums">{d?.docNumber || '—'}</td>
                      <td className="px-2 py-1">{who}</td>
                      <td className="px-2 py-1">{st}</td>
                      <td className="px-2 py-1 tnums">{d?.returnConfirmedAt ? formatDate(d.returnConfirmedAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showLedger && (
        <section className="space-y-1">
          <h4 className="text-sm font-semibold text-ink">Promene zaliha (prijem / izdavanje / otpis)</h4>
          <LedgerTable rows={ledgerRows} loading={ledgerLoading} />
        </section>
      )}
    </div>
  );
}

/** Tabela istorije pokreta zalihe (RA-20): Datum / Tip / Promena / Stanje posle / Napomena. */
function LedgerTable({ rows, loading }: { rows: ToolLedgerRow[]; loading: boolean }) {
  if (loading) return <p className="text-xs text-ink-secondary">Učitavanje istorije…</p>;
  if (rows.length === 0)
    return <p className="text-xs text-ink-secondary">Nema evidencije promene zaliha za ovaj artikal.</p>;
  return (
    <div className="max-h-64 overflow-auto rounded-control border border-line">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2 text-ink-secondary">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Datum</th>
            <th className="px-2 py-1 text-left font-medium">Tip</th>
            <th className="px-2 py-1 text-right font-medium">Promena</th>
            <th className="px-2 py-1 text-right font-medium">Stanje posle</th>
            <th className="px-2 py-1 text-left font-medium">Napomena</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = Number(r.delta) || 0;
            return (
              <tr key={r.id} className="border-t border-line">
                <td className="px-2 py-1 tnums">{String(r.createdAt ?? '').slice(0, 10)}</td>
                <td className="px-2 py-1">{LEDGER_REASON_LABEL[r.reason] ?? r.reason}</td>
                <td className={`px-2 py-1 text-right tnums ${d > 0 ? 'text-status-success' : 'text-status-danger'}`}>
                  {d > 0 ? '+' : ''}
                  {d}
                </td>
                <td className="px-2 py-1 text-right tnums">{r.balanceAfter}</td>
                <td className="px-2 py-1 text-ink-secondary">{r.note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────── Forme baterije/servis (RB-07/09) ─────────────────────────── */

function BatteryFormDialog({ toolId, row, onClose }: { toolId: string; row: ToolBattery | null; onClose: () => void }) {
  const add = useAddToolBattery();
  const upd = useUpdateToolBattery();
  const [serijskiBroj, setSerijskiBroj] = useState(row?.serijskiBroj ?? '');
  const [kapacitet, setKapacitet] = useState(row?.kapacitet ?? '');
  const [datumNabavke, setDatumNabavke] = useState(row?.datumNabavke ? String(row.datumNabavke).slice(0, 10) : '');
  const [status, setStatus] = useState<NonNullable<ToolBatteryInput['status']>>(
    (row?.status as NonNullable<ToolBatteryInput['status']>) ?? 'active',
  );
  const [napomena, setNapomena] = useState(row?.napomena ?? '');
  const [error, setError] = useState<string | null>(null);
  const pending = add.isPending || upd.isPending;

  async function submit() {
    setError(null);
    const body: ToolBatteryInput = {
      serijskiBroj: serijskiBroj.trim() || null,
      kapacitet: kapacitet.trim() || null,
      datumNabavke: datumNabavke || null,
      status,
      napomena: napomena.trim() || null,
    };
    try {
      if (row) await upd.mutateAsync({ id: row.id, patch: body });
      else await add.mutateAsync({ toolId, body });
      toast(row ? 'Sačuvano' : 'Baterija dodata');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={row ? 'Izmena baterije' : 'Nova baterija'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={pending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Serijski broj">
            <input className={INPUT} value={serijskiBroj} onChange={(e) => setSerijskiBroj(e.target.value)} placeholder="npr. 527100599" />
          </FormField>
          <FormField label="Kapacitet">
            <input className={INPUT} value={kapacitet} onChange={(e) => setKapacitet(e.target.value)} placeholder="npr. 5.0Ah" />
          </FormField>
          <FormField label="Datum nabavke">
            <input className={INPUT} type="date" value={datumNabavke} onChange={(e) => setDatumNabavke(e.target.value)} />
          </FormField>
          <FormField label="Status">
            <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as NonNullable<ToolBatteryInput['status']>)}>
              {BAT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Napomena">
          <textarea className={INPUT} rows={2} value={napomena} onChange={(e) => setNapomena(e.target.value)} />
        </FormField>
        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

function ServiceFormDialog({ toolId, row, onClose }: { toolId: string; row: ToolService | null; onClose: () => void }) {
  const add = useAddToolService();
  const upd = useUpdateToolService();
  const [datum, setDatum] = useState(row?.datum ? String(row.datum).slice(0, 10) : today());
  const [tip, setTip] = useState<NonNullable<ToolServiceInput['tip']>>(
    (row?.tip as NonNullable<ToolServiceInput['tip']>) ?? 'popravka',
  );
  const [opis, setOpis] = useState(row?.opis ?? '');
  const [izvrsilac, setIzvrsilac] = useState(row?.izvrsilac ?? '');
  const [trosak, setTrosak] = useState(row?.trosak != null ? String(row.trosak) : '');
  const [status, setStatus] = useState<NonNullable<ToolServiceInput['status']>>(
    (row?.status as NonNullable<ToolServiceInput['status']>) ?? 'zavrsen',
  );
  const [napomena, setNapomena] = useState(row?.napomena ?? '');
  const [error, setError] = useState<string | null>(null);
  const pending = add.isPending || upd.isPending;

  async function submit() {
    setError(null);
    const body: ToolServiceInput = {
      datum: datum || undefined,
      tip,
      opis: opis.trim() || null,
      izvrsilac: izvrsilac.trim() || null,
      trosak: trosak.trim() === '' ? null : Number(trosak),
      status,
      napomena: napomena.trim() || null,
    };
    try {
      if (row) await upd.mutateAsync({ id: row.id, patch: body });
      else await add.mutateAsync({ toolId, body });
      toast(row ? 'Sačuvano' : 'Servis evidentiran');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Snimanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={row ? 'Izmena servisa' : 'Novi servis / popravka'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={pending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Datum">
            <input className={INPUT} type="date" value={datum} onChange={(e) => setDatum(e.target.value)} />
          </FormField>
          <FormField label="Tip">
            <select className={INPUT} value={tip} onChange={(e) => setTip(e.target.value as NonNullable<ToolServiceInput['tip']>)}>
              {TIP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Izvršilac / servis">
            <input className={INPUT} value={izvrsilac} onChange={(e) => setIzvrsilac(e.target.value)} />
          </FormField>
          <FormField label="Trošak (din)">
            <input className={INPUT} type="number" min={0} step="0.01" value={trosak} onChange={(e) => setTrosak(e.target.value)} />
          </FormField>
          <FormField label="Status">
            <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as NonNullable<ToolServiceInput['status']>)}>
              {SRV_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Opis">
          <textarea className={INPUT} rows={2} value={opis} onChange={(e) => setOpis(e.target.value)} />
        </FormField>
        <FormField label="Napomena">
          <textarea className={INPUT} rows={2} value={napomena} onChange={(e) => setNapomena(e.target.value)} />
        </FormField>
        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}

/* ─────────────────────────── sitni pomoćnici ─────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-secondary">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

function StatCard({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className={`rounded-control border p-3 ${warn ? 'border-status-warn/40 bg-status-warn-bg/30' : 'border-line'}`}>
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className={`text-lg font-semibold tnums ${warn ? 'text-status-warn' : 'text-ink'}`}>{value}</div>
      {hint && <div className={`text-2xs ${warn ? 'text-status-warn' : 'text-ink-secondary'}`}>{hint}</div>}
    </div>
  );
}

function RowBtn({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-control border px-2 py-0.5 text-xs disabled:opacity-50 ${
        danger
          ? 'border-status-danger/40 text-status-danger hover:bg-status-danger-bg'
          : 'border-line hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  );
}
