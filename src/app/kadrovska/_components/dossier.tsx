'use client';

import { useState } from 'react';
import { FileText, QrCode } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { generateBadgeSheetPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import {
  useEmployee,
  useContracts,
  useEmployeeDocuments,
  useEmployeeChildren,
  useEmployeeBankCards,
  useMedicalExams,
  useCertificates,
  signDocument,
} from '@/api/kadrovska';
import { Field, LockedNote, sv, SummaryChips } from './common';
import { DocGenDialog } from './doc-gen-dialog';

/**
 * Dosije (karton) zaposlenog — read-only master–detalj panel.
 *
 * IZDVOJENO iz `zaposleni-tab.tsx` (P2 refaktor, prvi korak) bez izmena ponašanja
 * da bi P3 mogao da nadograđuje PII/lekarski/sertifikati/audit modale nezavisno
 * od liste/CRUD-a (P2). Ako menjaš ovaj fajl, pazi: lista NE zna za interne detalje
 * dosijea — jedini ugovor je `<DosijeDialog id onClose />`.
 */
export function DosijeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canManage = can(PERMISSIONS.KADROVSKA_MANAGE);

  const empQ = useEmployee(id);
  const emp = empQ.data?.data;
  const contractsQ = useContracts({ employeeId: id }, canContracts);
  const docsQ = useEmployeeDocuments(id, canPii);
  const childrenQ = useEmployeeChildren(id, canPii);
  const cardsQ = useEmployeeBankCards(id, canPii);
  const medicalQ = useMedicalExams({ employeeId: id }, canManage);
  const certsQ = useCertificates({ employeeId: id }, canManage);

  const [docGen, setDocGen] = useState(false);
  const [badgeBusy, setBadgeBusy] = useState(false);

  async function makeBadge() {
    if (!emp) return;
    setBadgeBusy(true);
    try {
      const { blob, fileName } = await generateBadgeSheetPdf([{ name: emp.full_name, dep: emp.department || '', code: emp.id }]);
      openBlob(blob);
      downloadBlob(blob, fileName);
    } finally {
      setBadgeBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={emp?.full_name ? `Dosije — ${emp.full_name}` : 'Dosije zaposlenog'}
      footer={
        <>
          <Button variant="secondary" onClick={makeBadge} loading={badgeBusy}>
            <QrCode className="h-4 w-4" aria-hidden /> QR bedž
          </Button>
          <Button onClick={() => setDocGen(true)} disabled={!emp}>
            <FileText className="h-4 w-4" aria-hidden /> Generiši dokument
          </Button>
        </>
      }
    >
      {empQ.isLoading || !emp ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-6">
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Osnovno</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Ime i prezime">{emp.full_name}</Field>
              <Field label="Pozicija">{emp.position}</Field>
              <Field label="Odeljenje">{emp.department}</Field>
              <Field label="Tim">{emp.team}</Field>
              <Field label="Telefon (službeni)">{emp.phone_work}</Field>
              <Field label="Email">{emp.email}</Field>
              <Field label="Status">{emp.is_active ? 'Aktivan' : 'Neaktivan'}</Field>
            </div>
          </section>

          {canContracts && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Ugovori</h3>
              {(contractsQ.data?.data ?? []).length === 0 ? (
                <p className="text-sm text-ink-secondary">Nema ugovora.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {(contractsQ.data?.data ?? []).map((c) => (
                    <li key={c.id} className="flex items-center justify-between rounded-control border border-line px-3 py-1.5">
                      <span>
                        {c.contractType}
                        {c.probniRad ? ' · probni rad' : ''}
                      </span>
                      <span className="text-ink-secondary">
                        {formatDate(c.dateFrom)} — {c.dateTo ? formatDate(c.dateTo) : 'na neodređeno'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink">Dokumenta {!canPii && '🔒'}</h3>
            {!canPii ? (
              <LockedNote text="Dokumenta i lični podaci vidljivi su samo Kadrovskoj sa PII pravom (admin / poslovni admin)." />
            ) : (docsQ.data?.data ?? []).length === 0 ? (
              <p className="text-sm text-ink-secondary">Nema priloženih dokumenata.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(docsQ.data?.data ?? []).map((d) => (
                  <li key={d.id} className="flex items-center justify-between rounded-control border border-line px-3 py-1.5">
                    <span>
                      <span className="text-ink-secondary">{d.docType}</span> · {d.fileName || '—'}
                    </span>
                    <button
                      className="text-accent hover:underline"
                      onClick={async () => {
                        try {
                          const r = await signDocument(d.id);
                          if (r.data) window.open(r.data, '_blank');
                        } catch {
                          /* noop */
                        }
                      }}
                    >
                      Otvori
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canPii && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Lični podaci (PII)</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Deca</div>
                  {(childrenQ.data?.data ?? []).length === 0 ? (
                    <p className="text-sm text-ink-secondary">—</p>
                  ) : (
                    <ul className="text-sm">
                      {(childrenQ.data?.data ?? []).map((c) => (
                        <li key={c.id}>
                          {c.firstName} {c.birthDate ? `(${formatDate(c.birthDate)})` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">Kartice banke</div>
                  {(cardsQ.data?.data ?? []).length === 0 ? (
                    <p className="text-sm text-ink-secondary">—</p>
                  ) : (
                    <ul className="text-sm">
                      {(cardsQ.data?.data ?? []).map((c) => (
                        <li key={c.id}>
                          {c.bank} {c.validThru ? `· do ${formatDate(c.validThru)}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          )}

          {canManage && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-ink">Zdravlje i sertifikati</h3>
              <SummaryChips
                items={[
                  { label: 'Lekarski pregledi', value: (medicalQ.data?.data ?? []).length },
                  { label: 'Sertifikati', value: (certsQ.data?.data ?? []).length },
                ]}
              />
              {(medicalQ.data?.data ?? []).slice(0, 3).map((m, i) => (
                <p key={i} className="mt-1 text-sm text-ink-secondary">
                  🩺 {sv(m, 'exam_type')} — važi do {sv(m, 'valid_until') ? formatDate(sv(m, 'valid_until')) : '—'}
                </p>
              ))}
            </section>
          )}
        </div>
      )}

      {docGen && emp && <DocGenDialog employee={emp} onClose={() => setDocGen(false)} />}
    </Dialog>
  );
}
