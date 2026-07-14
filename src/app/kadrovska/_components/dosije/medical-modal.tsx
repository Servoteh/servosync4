'use client';

// Lekarski pregledi — modal (paritet 1.0 medicalExamsModal.js, uz BE ograničenje).
//
// ⚠️ BE GAP: GET /medical-exams vraća v_kadr_medical_exam_status — PER-ZAPOSLENI
// (jedan red: medical_exam_date/expires/status/days_to_expiry), NEMA istorije
// pojedinačnih pregleda ni exam `id`. Zato modal prikazuje TRENUTNI status i
// dozvoljava DODAVANJE novog pregleda (POST → DB trigger ažurira employees.*),
// ali NE listu/izmenu/brisanje pojedinačnih pregleda. Kad BE doda GET istorije
// (kadr_medical_exams po zaposlenom + id), lista i edit/delete se dodaju ovde.

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import { newClientEventId, useMedicalExams, useCreateMedical } from '@/api/kadrovska';
import { sv } from '../common';
import { EXAM_TYPE_LABELS, INPUT_CLS, StatusFromView, toDateInput } from './shared';

type Toast = (msg: string) => void;

export function MedicalExamsDialog({ employeeId, employeeName, canEdit, onClose }: { employeeId: string; employeeName: string; canEdit: boolean; onClose: () => void }) {
  const q = useMedicalExams({ employeeId }, true);
  const createM = useCreateMedical();
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const status = (q.data?.data?.[0] as Record<string, unknown> | undefined) ?? undefined;

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

  async function save() {
    if (!examDate) {
      notify('⚠ Datum pregleda je obavezan');
      return;
    }
    if (validUntil && validUntil < examDate) {
      notify('⚠ „Važi do" ne može biti pre datuma pregleda');
      return;
    }
    try {
      await createM.mutateAsync({
        employeeId,
        clientEventId: newClientEventId(),
        examDate,
        examType,
        validUntil: validUntil || undefined,
        institution: inst.trim() || undefined,
        costRsd: cost ? Number(cost) : undefined,
        documentUrl: docUrl.trim() || undefined,
        note: note.trim() || undefined,
      });
      resetForm();
      setAdding(false);
      notify('✅ Pregled sačuvan');
    } catch {
      notify('⚠ Čuvanje nije uspelo');
    }
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
            <h4 className="text-sm font-semibold text-ink">Novi lekarski pregled</h4>
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
              <Button
                variant="secondary"
                onClick={() => {
                  setAdding(false);
                  resetForm();
                }}
              >
                Otkaži
              </Button>
              <Button onClick={() => void save()} loading={createM.isPending}>
                Sačuvaj
              </Button>
            </div>
          </div>
        )}

        <p className="text-xs text-ink-secondary">
          Napomena: prikaz istorije pojedinačnih pregleda čeka BE dopunu (GET liste `kadr_medical_exams` po zaposlenom).
          Dodavanje novog pregleda odmah ažurira aktuelni status iznad.
        </p>
      </div>

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
