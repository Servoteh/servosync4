'use client';

// Sertifikati / licence — modal sa punim CRUD-om (paritet 1.0 certificatesModal.js).
// GET /certificates?employeeId = v_kadr_certificate_status (PER-SERTIFIKAT: id +
// status + days_to_expiry, snake_case). Mutacije nose camelCase telo.

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useCertificates,
  useCreateCert,
  useUpdateCert,
  useDeleteCert,
} from '@/api/kadrovska';
import { sv, svNum } from '../common';
import { CERT_TYPE_LABELS, ConfirmDialog, INPUT_CLS, ROW_BTN, ROW_BTN_DANGER, StatusFromView, fmtRsd, toDateInput } from './shared';

type Toast = (msg: string) => void;

interface Draft {
  id: string | null;
  certType: string;
  certName: string;
  issuer: string;
  documentNo: string;
  issuedOn: string;
  expiresOn: string;
  costRsd: string;
  documentUrl: string;
  note: string;
}
const EMPTY: Draft = { id: null, certType: 'other', certName: '', issuer: '', documentNo: '', issuedOn: new Date().toISOString().slice(0, 10), expiresOn: '', costRsd: '', documentUrl: '', note: '' };

export function CertificatesDialog({ employeeId, employeeName, canEdit, onClose }: { employeeId: string; employeeName: string; canEdit: boolean; onClose: () => void }) {
  const q = useCertificates({ employeeId }, true);
  const createM = useCreateCert();
  const updM = useUpdateCert();
  const delM = useDeleteCert();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  const notify: Toast = (m) => {
    setToast(m);
    setTimeout(() => setToast(null), 3000);
  };

  function edit(r: Record<string, unknown>) {
    setDraft({
      id: sv(r, 'id'),
      certType: sv(r, 'cert_type') || 'other',
      certName: sv(r, 'cert_name'),
      issuer: sv(r, 'issuer'),
      documentNo: sv(r, 'document_no'),
      issuedOn: toDateInput(sv(r, 'issued_on')),
      expiresOn: toDateInput(sv(r, 'expires_on')),
      costRsd: svNum(r, 'cost_rsd') ? String(svNum(r, 'cost_rsd')) : '',
      documentUrl: sv(r, 'document_url'),
      note: sv(r, 'note'),
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.certName.trim()) {
      notify('⚠ Naziv je obavezan');
      return;
    }
    if (!draft.issuedOn) {
      notify('⚠ Datum izdavanja je obavezan');
      return;
    }
    if (draft.expiresOn && draft.expiresOn < draft.issuedOn) {
      notify('⚠ „Ističe" ne može biti pre izdavanja');
      return;
    }
    const body = {
      certType: draft.certType,
      certName: draft.certName.trim(),
      issuer: draft.issuer.trim() || undefined,
      documentNo: draft.documentNo.trim() || undefined,
      issuedOn: draft.issuedOn,
      expiresOn: draft.expiresOn || undefined,
      costRsd: draft.costRsd ? Number(draft.costRsd) : undefined,
      documentUrl: draft.documentUrl.trim() || undefined,
      note: draft.note.trim() || undefined,
    };
    try {
      if (draft.id) await updM.mutateAsync({ id: draft.id, patch: body });
      else await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), ...body });
      setDraft(null);
      notify(draft.id ? '✏️ Izmenjeno' : '✅ Sačuvano');
    } catch {
      notify('⚠ Čuvanje nije uspelo');
    }
  }
  async function remove() {
    if (!delId) return;
    try {
      await delM.mutateAsync({ id: delId });
      notify('🗑 Obrisano');
    } catch {
      notify('⚠ Brisanje nije uspelo');
    }
    setDelId(null);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`📜 Sertifikati / licence — ${employeeName}`}
      footer={
        <>
          {canEdit && !draft && (
            <Button variant="secondary" onClick={() => setDraft({ ...EMPTY })}>
              + Dodaj sertifikat
            </Button>
          )}
          <Button onClick={onClose}>Zatvori</Button>
        </>
      }
    >
      <div className="space-y-4">
        {draft ? (
          <CertForm draft={draft} setDraft={setDraft} onSave={() => void save()} onCancel={() => setDraft(null)} busy={createM.isPending || updM.isPending} />
        ) : q.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Nema upisanih sertifikata.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-secondary">
                  <th className="py-1.5 pr-2">Tip / naziv</th>
                  <th className="px-2">Izdat</th>
                  <th className="px-2">Ističe</th>
                  <th className="px-2">Status</th>
                  <th className="px-2">Izdavalac</th>
                  <th className="px-2">Trošak</th>
                  {canEdit && <th className="px-2 text-right">Akcije</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={sv(r, 'id')} className="border-b border-line/60">
                    <td className="py-1.5 pr-2">
                      <div className="font-medium text-ink">{sv(r, 'cert_name') || '—'}</div>
                      <div className="text-xs text-ink-secondary">
                        {CERT_TYPE_LABELS[sv(r, 'cert_type')] ?? sv(r, 'cert_type')}
                        {sv(r, 'document_no') ? ` · ${sv(r, 'document_no')}` : ''}
                      </div>
                    </td>
                    <td className="px-2 text-ink-secondary">{formatDate(sv(r, 'issued_on'))}</td>
                    <td className="px-2 text-ink-secondary">{sv(r, 'expires_on') ? formatDate(sv(r, 'expires_on')) : 'trajno'}</td>
                    <td className="px-2">
                      <StatusFromView status={sv(r, 'status')} daysLeft={r.days_to_expiry as number | null} />
                    </td>
                    <td className="px-2 text-ink-secondary">{sv(r, 'issuer') || '—'}</td>
                    <td className="px-2 text-ink-secondary">{svNum(r, 'cost_rsd') ? fmtRsd(svNum(r, 'cost_rsd')) : '0'}</td>
                    {canEdit && (
                      <td className="px-2">
                        <span className="flex justify-end gap-1">
                          <button className={ROW_BTN} onClick={() => edit(r)}>
                            Izmeni
                          </button>
                          <button className={ROW_BTN_DANGER} onClick={() => setDelId(sv(r, 'id'))}>
                            Obriši
                          </button>
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {delId && (
        <ConfirmDialog title="Brisanje sertifikata" body="Obrisati ovaj sertifikat? Akcija je trajna." busy={delM.isPending} onCancel={() => setDelId(null)} onConfirm={() => void remove()} />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">{toast}</div>
      )}
    </Dialog>
  );
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}

function CertForm({ draft, setDraft, onSave, onCancel, busy }: { draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  return (
    <div className="space-y-3 rounded-panel border border-line bg-surface-2 p-4">
      <h4 className="text-sm font-semibold text-ink">{draft.id ? 'Izmeni sertifikat' : 'Novi sertifikat / licenca'}</h4>
      <div className="grid grid-cols-2 gap-3">
        <F label="Tip">
          <select className={INPUT_CLS} value={draft.certType} onChange={(e) => set('certType', e.target.value)}>
            {Object.entries(CERT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </F>
        <F label="Naziv *">
          <input className={INPUT_CLS} value={draft.certName} onChange={(e) => set('certName', e.target.value)} placeholder="npr. B kategorija, IPAF 3a/3b" />
        </F>
        <F label="Izdavalac">
          <input className={INPUT_CLS} value={draft.issuer} onChange={(e) => set('issuer', e.target.value)} />
        </F>
        <F label="Br. dokumenta">
          <input className={INPUT_CLS} value={draft.documentNo} onChange={(e) => set('documentNo', e.target.value)} />
        </F>
        <F label="Izdat *">
          <input className={INPUT_CLS} type="date" value={draft.issuedOn} onChange={(e) => set('issuedOn', e.target.value)} />
        </F>
        <F label="Ističe (opc.)">
          <input className={INPUT_CLS} type="date" value={draft.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} />
        </F>
        <F label="Trošak (RSD)">
          <input className={INPUT_CLS} type="number" min="0" step="0.01" value={draft.costRsd} onChange={(e) => set('costRsd', e.target.value)} />
        </F>
        <F label="Link na dokument (URL)">
          <input className={INPUT_CLS} type="url" value={draft.documentUrl} onChange={(e) => set('documentUrl', e.target.value)} placeholder="https://…" />
        </F>
      </div>
      <F label="Napomena">
        <textarea className={`${INPUT_CLS} h-auto py-2`} rows={2} value={draft.note} onChange={(e) => set('note', e.target.value)} />
      </F>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Otkaži
        </Button>
        <Button onClick={onSave} loading={busy}>
          Sačuvaj
        </Button>
      </div>
    </div>
  );
}
