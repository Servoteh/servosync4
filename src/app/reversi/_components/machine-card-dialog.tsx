'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useAddMachineHead,
  useCuttingByMachine,
  useDeleteMachineHead,
  useMachineDocuments,
  useMachineHeads,
  useUpdateMachineHead,
  type MachineHead,
  type MachineHeadInput,
  type MachineRow,
} from '@/api/reversi';
import { IssueDialog } from './issue-dialog';
import { DocStatusBadge } from './common';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Status glave → ton + labela (paritet 1.0 HEAD_STATUS_LABEL/HEAD_STATUS_CLS). */
const HEAD_STATUS: Record<string, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Aktivna' },
  SERVIS: { tone: 'warn', label: 'Na servisu' },
  OTPISANA: { tone: 'neutral', label: 'Otpisana' },
};
const HEAD_STATUS_OPTIONS: { value: NonNullable<MachineHeadInput['status']>; label: string }[] = [
  { value: 'ACTIVE', label: 'Aktivna' },
  { value: 'SERVIS', label: 'Na servisu' },
  { value: 'OTPISANA', label: 'Otpisana' },
];

/**
 * Kartica mašine (paritet 1.0 `renderMachineDetailPage`) — Dialog sa naslaganim
 * sekcijama: Osnovno (RB-55, čita se iz reda liste — nema machine-by-code rute),
 * Rezni alat na mašini (RB-56 — klasa + operateri), Glave (RB-57 CRUD, manage) i
 * Istorija izdavanja (RB-58). „Izdaj na ovu mašinu" (RB-54) otvara Izdaj dijalog sa
 * preselektovanom mašinom. Podaci mašine se uređuju u Podešavanja → Mašine.
 */
export function MachineCardDialog({ machine, onClose }: { machine: MachineRow | null; onClose: () => void }) {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const code = machine?.machine_code ?? null;

  const cutting = useCuttingByMachine(code);
  const heads = useMachineHeads(code);
  const documents = useMachineDocuments(code);
  const delHead = useDeleteMachineHead();

  const [issueOpen, setIssueOpen] = useState(false);
  const [headForm, setHeadForm] = useState<MachineHead | 'new' | null>(null);

  const cuttingRows = cutting.data?.data ?? [];
  const headRows = heads.data?.data ?? [];
  const docRows = documents.data?.data ?? [];
  const totalQty = cuttingRows.reduce((a, r) => a + (Number(r.remaining_qty) || 0), 0);

  async function doDeleteHead(id: string) {
    if (delHead.isPending) return;
    if (!window.confirm('Obrisati glavu iz evidencije?')) return;
    try {
      await delHead.mutateAsync(id);
      toast('Glava obrisana');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Brisanje nije uspelo.');
    }
  }

  return (
    <>
      <Dialog
        open={!!machine}
        onClose={onClose}
        size="xl2"
        title={machine ? `${machine.machine_code} — ${machine.name ?? ''}` : 'Mašina'}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Zatvori</Button>
            {manage && machine && (
              <Button onClick={() => setIssueOpen(true)}>Izdaj na ovu mašinu</Button>
            )}
          </div>
        }
      >
        {machine && (
          <div className="space-y-4">
            {/* Hero (RB-54) — badževi tip / arhivirana / lokacija. */}
            <div className="flex flex-wrap items-center gap-2">
              {machine.type && <StatusBadge tone="info" label={machine.type} />}
              {machine.archived_at && <StatusBadge tone="neutral" label="arhivirana" />}
              {machine.location && <span className="text-sm text-ink-secondary">📍 {machine.location}</span>}
            </div>

            {/* Osnovno (RB-55). */}
            <section className="space-y-2 rounded-control border border-line p-3">
              <h4 className="text-sm font-semibold text-ink">Osnovno</h4>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Field label="Šifra"><span className="tnums">{machine.machine_code}</span></Field>
                <Field label="Naziv">{machine.name || '—'}</Field>
                <Field label="Tip">{machine.type || '—'}</Field>
                <Field label="Proizvođač">{machine.manufacturer || '—'}</Field>
                <Field label="Model">{machine.model || '—'}</Field>
                <Field label="Serijski broj"><span className="tnums">{machine.serial_number || '—'}</span></Field>
                <Field label="God. proizvodnje">{machine.year_of_manufacture ?? '—'}</Field>
                <Field label="U pogonu od">{machine.year_commissioned ?? '—'}</Field>
                <Field label="Snaga">{machine.power_kw != null ? `${machine.power_kw} kW` : '—'}</Field>
                <Field label="Lokacija">{machine.location || '—'}</Field>
                <Field label="Napomena">{machine.notes || '—'}</Field>
              </dl>
              <p className="text-xs text-ink-secondary">Podaci mašine se uređuju u Podešavanja → Mašine.</p>
            </section>

            {/* Rezni alat na mašini (RB-56). */}
            <section className="space-y-2 rounded-control border border-line p-3">
              <h4 className="text-sm font-semibold text-ink">
                Rezni alat na mašini ({cuttingRows.length} šifri · {formatNumber(totalQty)} kom)
              </h4>
              {cutting.isLoading ? (
                <p className="text-xs text-ink-secondary">Učitavanje…</p>
              ) : cutting.isError ? (
                <p className="text-xs text-status-danger">Rezni alat trenutno nije dostupan.</p>
              ) : cuttingRows.length === 0 ? (
                <p className="text-xs text-ink-secondary">Nema reznog alata zaduženog na ovu mašinu.</p>
              ) : (
                <div className="overflow-x-auto rounded-control border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2 text-ink-secondary">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Oznaka</th>
                        <th className="px-2 py-1 text-left font-medium">Naziv</th>
                        <th className="px-2 py-1 text-left font-medium">Klasa</th>
                        <th className="px-2 py-1 text-right font-medium">Kom</th>
                        <th className="px-2 py-1 text-left font-medium">Operateri</th>
                        <th className="px-2 py-1 text-left font-medium">Poslednje izdato</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cuttingRows.map((c) => (
                        <tr key={c.catalog_id} className="border-t border-line">
                          <td className="px-2 py-1 tnums">{c.oznaka || '—'}</td>
                          <td className="px-2 py-1">{c.naziv || '—'}</td>
                          <td className="px-2 py-1 text-ink-secondary">{c.klasa || '—'}</td>
                          <td className="px-2 py-1 text-right tnums">{formatNumber(Number(c.remaining_qty ?? 0))}</td>
                          <td className="px-2 py-1 text-ink-secondary">{c.operator_names || '—'}</td>
                          <td className="px-2 py-1 tnums text-ink-secondary">{formatDate(c.last_issued_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Glave (RB-57). */}
            <section className="space-y-2 rounded-control border border-line p-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-ink">Glave ({headRows.length})</h4>
                {manage && (
                  <Button variant="secondary" onClick={() => setHeadForm('new')}>+ Dodaj glavu</Button>
                )}
              </div>
              {heads.isLoading ? (
                <p className="text-xs text-ink-secondary">Učitavanje…</p>
              ) : heads.isError ? (
                <p className="text-xs text-status-danger">Glave trenutno nisu dostupne.</p>
              ) : headRows.length === 0 ? (
                <p className="text-xs text-ink-secondary">Nema upisanih glava za ovu mašinu.</p>
              ) : (
                <div className="overflow-x-auto rounded-control border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2 text-ink-secondary">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Oznaka</th>
                        <th className="px-2 py-1 text-left font-medium">Naziv</th>
                        <th className="px-2 py-1 text-left font-medium">Tip</th>
                        <th className="px-2 py-1 text-left font-medium">Serijski</th>
                        <th className="px-2 py-1 text-left font-medium">Status</th>
                        <th className="px-2 py-1 text-left font-medium">Napomena</th>
                        {manage && <th className="px-2 py-1" />}
                      </tr>
                    </thead>
                    <tbody>
                      {headRows.map((h) => {
                        const st = HEAD_STATUS[h.status] ?? { tone: 'neutral' as Tone, label: h.status };
                        return (
                          <tr key={h.id} className="border-t border-line">
                            <td className="px-2 py-1 tnums font-medium">{h.oznaka || '—'}</td>
                            <td className="px-2 py-1">{h.naziv || '—'}</td>
                            <td className="px-2 py-1 text-ink-secondary">{h.tip || '—'}</td>
                            <td className="px-2 py-1 tnums">{h.serijskiBroj || '—'}</td>
                            <td className="px-2 py-1"><StatusBadge tone={st.tone} label={st.label} /></td>
                            <td className="px-2 py-1 text-ink-secondary">{h.napomena || ''}</td>
                            {manage && (
                              <td className="px-2 py-1">
                                <div className="flex justify-end gap-1">
                                  <RowBtn onClick={() => setHeadForm(h)}>✎</RowBtn>
                                  <RowBtn danger disabled={delHead.isPending} onClick={() => void doDeleteHead(h.id)}>🗑</RowBtn>
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
            </section>

            {/* Istorija izdavanja (RB-58). */}
            <section className="space-y-2 rounded-control border border-line p-3">
              <h4 className="text-sm font-semibold text-ink">Istorija izdavanja (poslednjih {docRows.length})</h4>
              {documents.isLoading ? (
                <p className="text-xs text-ink-secondary">Učitavanje…</p>
              ) : documents.isError ? (
                <p className="text-xs text-status-danger">Istorija trenutno nije dostupna.</p>
              ) : docRows.length === 0 ? (
                <p className="text-xs text-ink-secondary">Nema dokumenata izdatih na ovu mašinu.</p>
              ) : (
                <div className="overflow-x-auto rounded-control border border-line">
                  <table className="w-full text-xs">
                    <thead className="bg-surface-2 text-ink-secondary">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">Izdato</th>
                        <th className="px-2 py-1 text-left font-medium">Dokument</th>
                        <th className="px-2 py-1 text-left font-medium">Potpisao</th>
                        <th className="px-2 py-1 text-left font-medium">Status</th>
                        <th className="px-2 py-1 text-left font-medium">Rok</th>
                      </tr>
                    </thead>
                    <tbody>
                      {docRows.map((d) => (
                        <tr key={d.id} className="border-t border-line">
                          <td className="px-2 py-1 tnums">{formatDate(d.issuedAt)}</td>
                          <td className="px-2 py-1 tnums font-medium">{d.docNumber || '—'}</td>
                          <td className="px-2 py-1">{d.issuedToEmployeeName || d.recipientEmployeeName || '—'}</td>
                          <td className="px-2 py-1"><DocStatusBadge status={d.status} /></td>
                          <td className="px-2 py-1 tnums text-ink-secondary">{formatDate(d.expectedReturnDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </Dialog>

      {/* Izdaj na ovu mašinu (RB-54) — preselektovana mašina, skener mod. */}
      {manage && machine && (
        <IssueDialog
          open={issueOpen}
          onClose={() => setIssueOpen(false)}
          initialMachine={{ code: machine.machine_code, name: machine.name ?? undefined }}
          defaultMode="scanner"
        />
      )}

      {/* Glava — nova / izmena (RB-57). */}
      {headForm && machine && (
        <MachineHeadFormDialog
          machineCode={machine.machine_code}
          row={headForm === 'new' ? null : headForm}
          onClose={() => setHeadForm(null)}
        />
      )}
    </>
  );
}

/* ─────────────────────────── Glava — forma (RB-57) ─────────────────────────── */

function MachineHeadFormDialog({
  machineCode,
  row,
  onClose,
}: {
  machineCode: string;
  row: MachineHead | null;
  onClose: () => void;
}) {
  const add = useAddMachineHead();
  const upd = useUpdateMachineHead();
  const [oznaka, setOznaka] = useState(row?.oznaka ?? '');
  const [naziv, setNaziv] = useState(row?.naziv ?? '');
  const [tip, setTip] = useState(row?.tip ?? '');
  const [serijskiBroj, setSerijskiBroj] = useState(row?.serijskiBroj ?? '');
  const [status, setStatus] = useState<NonNullable<MachineHeadInput['status']>>(
    (row?.status as NonNullable<MachineHeadInput['status']>) ?? 'ACTIVE',
  );
  const [napomena, setNapomena] = useState(row?.napomena ?? '');
  const [error, setError] = useState<string | null>(null);
  const pending = add.isPending || upd.isPending;

  async function submit() {
    setError(null);
    if (!oznaka.trim() || !naziv.trim()) {
      setError('Oznaka i naziv su obavezni.');
      return;
    }
    const body: MachineHeadInput = {
      oznaka: oznaka.trim(),
      naziv: naziv.trim(),
      tip: tip.trim() || null,
      serijskiBroj: serijskiBroj.trim() || null,
      status,
      napomena: napomena.trim() || null,
    };
    try {
      if (row) await upd.mutateAsync({ id: row.id, patch: body });
      else await add.mutateAsync({ machineCode, body });
      toast(row ? 'Sačuvano' : 'Glava dodata');
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
      title={row ? `Izmena glave — ${row.oznaka || ''}` : `Nova glava — mašina ${machineCode}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={pending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Oznaka / šifra">
            <input className={INPUT} value={oznaka} onChange={(e) => setOznaka(e.target.value)} placeholder="npr. GL-BT40-01" />
          </FormField>
          <FormField label="Naziv">
            <input className={INPUT} value={naziv} onChange={(e) => setNaziv(e.target.value)} placeholder="npr. Ugaona glava 90°" />
          </FormField>
          <FormField label="Tip">
            <input className={INPUT} value={tip} onChange={(e) => setTip(e.target.value)} placeholder="npr. ugaona, konus BT40" />
          </FormField>
          <FormField label="Serijski broj">
            <input className={INPUT} value={serijskiBroj} onChange={(e) => setSerijskiBroj(e.target.value)} />
          </FormField>
          <FormField label="Status">
            <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value as NonNullable<MachineHeadInput['status']>)}>
              {HEAD_STATUS_OPTIONS.map((o) => (
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

/* ─────────────────────────── sitni pomoćnici ─────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-secondary">{label}</dt>
      <dd className="text-sm text-ink">{children}</dd>
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
