'use client';

// Lekarski pregledi — modal (paritet 1.0 medicalExamsModal.js).
//
// Dva sloja:
//   • TRENUTNI STATUS (GET /medical-exams = v_kadr_medical_exam_status, per-zaposleni:
//     medical_exam_date/expires/status/days_to_expiry) + „Dodaj pregled" (POST → DB
//     trigger ažurira employees.*).
//   • ISTORIJA POJEDINAČNIH PREGLEDA (GET /employees/:id/medical-exams =
//     kadr_medical_exams, camelCase, exam_date DESC) sa po-redu Izmeni/Obriši
//     (PATCH/DELETE /medical-exams/:id). Poslednji unos i dalje diktira aktuelni status.

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useMedicalExams,
  useMedicalExamHistory,
  useCreateMedical,
  useUpdateMedical,
  useDeleteMedical,
  type MedicalExam,
} from '@/api/kadrovska';
import { sv } from '../common';
import {
  ConfirmDialog,
  EXAM_TYPE_LABELS,
  INPUT_CLS,
  ROW_BTN,
  ROW_BTN_DANGER,
  StatusFromView,
  fmtRsd,
  toDateInput,
} from './shared';

type Toast = (msg: string) => void;

export function MedicalExamsDialog({ employeeId, employeeName, canEdit, onClose }: { employeeId: string; employeeName: string; canEdit: boolean; onClose: () => void }) {
  const q = useMedicalExams({ employeeId }, true);
  const histQ = useMedicalExamHistory(employeeId, true);
  const createM = useCreateMedical();
  const updateM = useUpdateMedical();
  const delM = useDeleteMedical();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const status = (q.data?.data?.[0] as Record<string, unknown> | undefined) ?? undefined;
  const hist = histQ.data?.data ?? [];

  const notify: Toast = (m) => {
    setToast(m);
    setTimeout(() => setToast(null), 3000);
  };

  const today = new Date().toISOString().slice(0, 10);
  const [examDate, setExamDate] = useState(today);
  const [validUntil, setValidUntil] = useState('');
  const [examType, setExamType] = useState('redovan');
  const [cost, setCost] = useState('');
  const [inst, setInst] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [note, setNote] = useState('');

  function resetForm() {
    setExamDate(today);
    setValidUntil('');
    setExamType('redovan');
    setCost('');
    setInst('');
    setDocUrl('');
    setNote('');
  }

  function closeForm() {
    setAdding(false);
    setEditId(null);
    resetForm();
  }

  function startEdit(row: MedicalExam) {
    setEditId(row.id);
    setExamDate(toDateInput(row.examDate) || today);
    setValidUntil(toDateInput(row.validUntil));
    setExamType(row.examType || 'redovan');
    setCost(row.costRsd != null ? String(row.costRsd) : '');
    setInst(row.institution || '');
    setDocUrl(row.documentUrl || '');
    setNote(row.note || '');
    setAdding(true);
  }

  async function save() {
    if (!examDate) {
      notify('⚠ Datum pregleda je obavezan');
      return;
    }
    if (validUntil && validUntil < examDate) {
      notify('⚠ „Važi do" ne može biti pre datuma pregleda');
      return;
    }
    // Izmena: prazno polje šalje null da BE OBRIŠE staru vrednost (BE piše !== undefined).
    // Kreiranje: prazno polje se izostavlja (undefined). Paritet 1.0 (moguće očistiti ustanovu/napomenu/URL/trošak).
    const blank = editId ? null : undefined;
    const body = {
      examDate,
      examType,
      validUntil: validUntil || blank,
      institution: inst.trim() || blank,
      costRsd: cost ? Number(cost) : blank,
      documentUrl: docUrl.trim() || blank,
      note: note.trim() || blank,
    };
    try {
      if (editId) await updateM.mutateAsync({ id: editId, patch: body });
      else await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), ...body });
      closeForm();
      notify(editId ? '✏️ Izmenjeno' : '✅ Pregled sačuvan');
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
      title={`🩺 Lekarski pregledi — ${employeeName}`}
      footer={
        <>
          {canEdit && !adding && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              + Dodaj pregled
            </Button>
          )}
          <Button onClick={onClose}>Zatvori</Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-secondary">Najnoviji unos automatski postaje aktuelni datum/istek na profilu zaposlenog.</p>

        {q.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2 p-4 sm:grid-cols-4">
            <Info label="Poslednji pregled">{sv(status, 'medical_exam_date') ? formatDate(sv(status, 'medical_exam_date')) : '—'}</Info>
            <Info label="Važi do">{sv(status, 'medical_exam_expires') ? formatDate(sv(status, 'medical_exam_expires')) : '—'}</Info>
            <Info label="Status">
              <StatusFromView status={sv(status, 'status') || 'never'} daysLeft={status?.days_to_expiry as number | null} />
            </Info>
            <Info label="Preostalo">{status?.days_to_expiry != null ? `${status.days_to_expiry} d` : '—'}</Info>
          </div>
        )}

        {adding && canEdit && (
          <div className="space-y-3 rounded-panel border border-line bg-surface-2 p-4">
            <h4 className="text-sm font-semibold text-ink">{editId ? 'Izmena lekarskog pregleda' : 'Novi lekarski pregled'}</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Datum pregleda *">
                <input className={INPUT_CLS} type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} />
              </Field>
              <Field label="Važi do">
                <input className={INPUT_CLS} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </Field>
              <Field label="Tip *">
                <select className={INPUT_CLS} value={examType} onChange={(e) => setExamType(e.target.value)}>
                  {Object.entries(EXAM_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Trošak (RSD)">
                <input className={INPUT_CLS} type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
              </Field>
              <Field label="Ustanova / lekar">
                <input className={INPUT_CLS} value={inst} onChange={(e) => setInst(e.target.value)} />
              </Field>
              <Field label="Link na dokument (URL)">
                <input className={INPUT_CLS} type="url" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} placeholder="https://…" />
              </Field>
            </div>
            <Field label="Napomena">
              <textarea className={`${INPUT_CLS} h-auto py-2`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={closeForm}>
                Otkaži
              </Button>
              <Button onClick={() => void save()} loading={createM.isPending || updateM.isPending}>
                Sačuvaj
              </Button>
            </div>
          </div>
        )}

        {/* Istorija pojedinačnih pregleda (DOPUNA — trenutni status + dodavanje ostaju iznad). */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-ink">Istorija pregleda</h4>
          {histQ.isLoading ? (
            <p className="text-sm text-ink-secondary">Učitavanje…</p>
          ) : hist.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-secondary">Nema upisanih pregleda.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-secondary">
                    <th className="py-1.5 pr-2">Datum</th>
                    <th className="px-2">Tip</th>
                    <th className="px-2">Važi do</th>
                    <th className="px-2">Ustanova</th>
                    <th className="px-2">Trošak</th>
                    <th className="px-2">Napomena</th>
                    {canEdit && <th className="px-2 text-right">Akcije</th>}
                  </tr>
                </thead>
                <tbody>
                  {hist.map((r) => (
                    <tr key={r.id} className="border-b border-line/60">
                      <td className="py-1.5 pr-2 text-ink">{r.examDate ? formatDate(r.examDate) : '—'}</td>
                      <td className="px-2 text-ink-secondary">{EXAM_TYPE_LABELS[r.examType] ?? r.examType}</td>
                      <td className="px-2 text-ink-secondary">{r.validUntil ? formatDate(r.validUntil) : '—'}</td>
                      <td className="px-2 text-ink-secondary">{r.institution || '—'}</td>
                      <td className="px-2 text-ink-secondary">{r.costRsd != null ? fmtRsd(r.costRsd) : '—'}</td>
                      <td className="px-2 text-ink-secondary">{r.note || '—'}</td>
                      {canEdit && (
                        <td className="px-2">
                          <span className="flex justify-end gap-1">
                            <button className={ROW_BTN} onClick={() => startEdit(r)}>
                              Izmeni
                            </button>
                            <button className={ROW_BTN_DANGER} onClick={() => setDelId(r.id)}>
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

        <p className="text-xs text-ink-secondary">
          Najnoviji pregled automatski postaje aktuelni datum/istek na profilu zaposlenog; izmena ili brisanje reda iznad
          odmah osveži aktuelni status.
        </p>
      </div>

      {delId && (
        <ConfirmDialog title="Brisanje pregleda" body="Obrisati ovaj lekarski pregled? Akcija je trajna." busy={delM.isPending} onCancel={() => setDelId(null)} onConfirm={() => void remove()} />
      )}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">{toast}</div>
      )}
    </Dialog>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className="mt-0.5 text-sm text-ink">{children}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{label}</span>
      <div className="mt-0.5">{children}</div>
    </label>
  );
}
