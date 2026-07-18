'use client';

import { useEffect, useState } from 'react';
import { FileText, QrCode, History, Stethoscope, Award } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { generateBadgeSheetPdf, generateJobPositionPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import {
  useEmployee,
  useEmployeePii,
  useContracts,
  useMedicalExams,
  useCertificates,
  useOrgStructure,
} from '@/api/kadrovska';
import { Field, LockedNote, sv, SummaryChips } from './common';
import { EDU_LEVEL_LABELS, WORK_TYPE_OPTIONS, contractStatus, empDisplayName } from './emp-shared';
import { DocGenDialog } from './doc-gen-dialog';
import { ChildrenSection, BankCardsSection, PersonalDocsSection, ForeignDocsSection } from './dosije/pii-sections';
import { DocumentsSection } from './dosije/documents-section';
import { MedicalExamsDialog } from './dosije/medical-modal';
import { CertificatesDialog } from './dosije/certificates-modal';
import { EmployeeAuditDialog } from './dosije/audit-modal';
import { SectionTitle } from './dosije/shared';

/**
 * Dosije (karton) zaposlenog — master–detalj panel (P3: PII sekcije, lekarski,
 * sertifikati, audit, dokumenta). Read osnovnih polja + CRUD PII pod-resursa.
 *
 * PII gating STRIKTNO: sekcije deca/kartice/dokumenta/lična/stranac + PII karton
 * su nevidljive bez `kadrovska.pii` (LockedNote). Lekarski/sertifikati traže
 * `kadrovska.manage`; audit `kadrovska.admin` — presuđuje BE guard + sy15 RLS.
 *
 * `focus` (opciono) — otvara odmah ciljni modal (P2 red-dugmad 🩺/📜/📒):
 *   <DosijeDialog id focus="medical" onClose /> · 'certs' · 'audit'.
 * Bez focusa ponašanje je identično dosadašnjem (kompatibilno sa P2 listom).
 */
export type DosijeFocus = 'medical' | 'certs' | 'audit';

export function DosijeDialog({ id, focus, onClose }: { id: string; focus?: DosijeFocus; onClose: () => void }) {
  const { can } = useAuth();
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canManage = can(PERMISSIONS.KADROVSKA_MANAGE);
  const canAdmin = can(PERMISSIONS.KADROVSKA_ADMIN);
  const canEditPii = canPii; // PII pod-resursi (BE guard = kadrovska.pii)

  const empQ = useEmployee(id);
  const emp = empQ.data?.data;
  const piiQ = useEmployeePii(id, canPii);
  const pii = piiQ.data?.data;
  const contractsQ = useContracts({ employeeId: id }, canContracts);
  const medicalQ = useMedicalExams({ employeeId: id }, canManage);
  const certsQ = useCertificates({ employeeId: id }, canManage);
  const orgQ = useOrgStructure();

  const [docGen, setDocGen] = useState(false);
  const [badgeBusy, setBadgeBusy] = useState(false);
  const [posBusy, setPosBusy] = useState(false);
  const [openModal, setOpenModal] = useState<DosijeFocus | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Row-dugmad integracija (P2): otvori ciljni modal odmah po montiranju.
  useEffect(() => {
    if (!focus) return;
    if (focus === 'audit' && !canAdmin) return;
    if ((focus === 'medical' || focus === 'certs') && !canManage) return;
    setOpenModal(focus);
  }, [focus, canAdmin, canManage]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const name = emp ? empDisplayName(emp) : '';

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

  // „Opis pozicije (PDF)" — job_positions red po position_id (paritet P4 zaposleni-tab).
  const positionId = Number(sv(emp, 'position_id')) || 0;
  async function makePositionPdf() {
    if (!emp) return;
    const pos = orgQ.data?.data.jobPositions.find((p) => p.id === positionId);
    if (!pos) {
      setToast('Zaposlenom nije dodeljeno radno mesto iz sistematizacije.');
      return;
    }
    setPosBusy(true);
    try {
      const { blob, fileName } = await generateJobPositionPdf(pos, { fullName: emp.full_name, department: emp.department || '' });
      openBlob(blob);
      downloadBlob(blob, fileName);
    } finally {
      setPosBusy(false);
    }
  }

  const eduLevel = sv(pii, 'education_level');
  // Osnovno (non-PII iz v_employees_safe): Tip rada (human label) / Krsna slava / Dan slave (MMDD → MM-DD).
  const workType = sv(emp, 'work_type');
  const workTypeLabel = WORK_TYPE_OPTIONS.find(([v]) => v === workType)?.[1] ?? workType;
  const slavaDayRaw = sv(emp, 'slava_day');
  const slavaDay = slavaDayRaw && slavaDayRaw.length === 4 ? `${slavaDayRaw.slice(0, 2)}-${slavaDayRaw.slice(2, 4)}` : slavaDayRaw;

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={name ? `Dosije — ${name}` : 'Dosije zaposlenog'}
      footer={
        <>
          {canAdmin && (
            <Button variant="ghost" onClick={() => setOpenModal('audit')} disabled={!emp} title="Istorija izmena (audit)">
              <History className="h-4 w-4" aria-hidden /> Istorija izmena
            </Button>
          )}
          <Button variant="secondary" onClick={makeBadge} loading={badgeBusy} disabled={!emp}>
            <QrCode className="h-4 w-4" aria-hidden /> QR bedž
          </Button>
          {positionId > 0 && (
            <Button variant="secondary" onClick={makePositionPdf} loading={posBusy} disabled={!emp}>
              <FileText className="h-4 w-4" aria-hidden /> Opis pozicije (PDF)
            </Button>
          )}
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
          {/* ── Osnovno ── */}
          <section>
            <SectionTitle>Osnovno</SectionTitle>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Ime i prezime">{emp.full_name}</Field>
              <Field label="Pozicija">{emp.position}</Field>
              <Field label="Odeljenje">{emp.department}</Field>
              <Field label="Pododeljenje">{sv(emp, 'sub_department_name')}</Field>
              <Field label="Tim">{emp.team}</Field>
              <Field label="Telefon (službeni)">{emp.phone_work}</Field>
              <Field label="Email">{emp.email}</Field>
              <Field label="Zaposlen od">{sv(emp, 'hire_date') ? formatDate(sv(emp, 'hire_date')) : ''}</Field>
              <Field label="Status">{emp.is_active ? 'Aktivan' : 'Neaktivan'}</Field>
              <Field label="Tip rada">{workTypeLabel}</Field>
              <Field label="Krsna slava">{sv(emp, 'slava')}</Field>
              <Field label="Dan slave">{slavaDay}</Field>
            </div>
          </section>

          {/* ── Lični podaci (PII karton) ── */}
          <section>
            <SectionTitle>Lični podaci (PII) {!canPii && '🔒'}</SectionTitle>
            {!canPii ? (
              <LockedNote text="Lični podaci (JMBG, adresa, banka, hitni kontakt) vidljivi su samo Kadrovskoj sa PII pravom (admin / poslovni admin)." />
            ) : piiQ.isLoading ? (
              <p className="text-sm text-ink-secondary">Učitavanje…</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Datum rođenja">{sv(pii, 'birth_date') ? formatDate(sv(pii, 'birth_date')) : ''}</Field>
                <Field label="JMBG">{sv(pii, 'personal_id')}</Field>
                <Field label="Pol">{sv(pii, 'gender')}</Field>
                <Field label="Adresa">{sv(pii, 'address')}</Field>
                <Field label="Grad">{[sv(pii, 'postal_code'), sv(pii, 'city')].filter(Boolean).join(' ')}</Field>
                <Field label="Telefon (privatni)">{sv(pii, 'phone_private')}</Field>
                <Field label="Obrazovanje">{eduLevel ? EDU_LEVEL_LABELS[eduLevel] ?? eduLevel : ''}</Field>
                <Field label="Zvanje / titula">{sv(pii, 'education_title')}</Field>
                <Field label="Banka">{sv(pii, 'bank_name')}</Field>
                <Field label="Broj računa">{sv(pii, 'bank_account')}</Field>
                <Field label="Hitni kontakt">
                  {[sv(pii, 'emergency_contact_name'), sv(pii, 'emergency_contact_relation')].filter(Boolean).join(' · ')}
                </Field>
                <Field label="Hitni telefon">
                  {[sv(pii, 'emergency_contact_phone'), sv(pii, 'emergency_contact_phone_alt')].filter(Boolean).join(' / ')}
                </Field>
              </div>
            )}
          </section>

          {/* ── Ugovori ── */}
          {canContracts && (
            <section>
              <SectionTitle>Ugovori</SectionTitle>
              {(contractsQ.data?.data ?? []).length === 0 ? (
                <p className="text-sm text-ink-secondary">Nema ugovora.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {(contractsQ.data?.data ?? []).map((c) => {
                    const st = contractStatus(c);
                    const tone = st.key === 'expired' ? 'danger' : st.key === 'expiring' ? 'warn' : st.key === 'inactive' ? 'neutral' : 'success';
                    return (
                      <li key={c.id} className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-1.5">
                        <span>
                          {c.contractType}
                          {c.probniRad ? ` · probni rad${c.probniMeseci ? ` (${c.probniMeseci} mes.)` : ''}` : ''}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="text-ink-secondary">
                            {formatDate(c.dateFrom)} — {c.dateTo ? formatDate(c.dateTo) : 'na neodređeno'}
                          </span>
                          <StatusBadge tone={tone} label={st.label} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {/* ── Zdravlje i sertifikati ── */}
          {canManage && (
            <section>
              <SectionTitle
                action={
                  <span className="flex gap-2">
                    <Button variant="ghost" onClick={() => setOpenModal('medical')} disabled={!emp}>
                      <Stethoscope className="h-4 w-4" aria-hidden /> Lekarski
                    </Button>
                    <Button variant="ghost" onClick={() => setOpenModal('certs')} disabled={!emp}>
                      <Award className="h-4 w-4" aria-hidden /> Sertifikati
                    </Button>
                  </span>
                }
              >
                Zdravlje i sertifikati
              </SectionTitle>
              <SummaryChips
                items={[
                  { label: 'Lekarski status', value: sv(medicalQ.data?.data?.[0], 'medical_exam_expires') ? formatDate(sv(medicalQ.data?.data?.[0], 'medical_exam_expires')) : '—' },
                  { label: 'Sertifikati', value: (certsQ.data?.data ?? []).length },
                ]}
              />
            </section>
          )}

          {/* ── PII pod-resursi (CRUD) ── */}
          <section>
            <SectionTitle>Porodica i dokumenta {!canPii && '🔒'}</SectionTitle>
            {!canPii ? (
              <LockedNote text="Deca, kartice banke, lična/strana dokumenta i priloženi fajlovi vidljivi su samo Kadrovskoj sa PII pravom." />
            ) : (
              <div className="space-y-6">
                <ChildrenSection employeeId={id} canEdit={canEditPii} onToast={setToast} />
                <BankCardsSection employeeId={id} canEdit={canEditPii} onToast={setToast} />
                <PersonalDocsSection employeeId={id} canEdit={canEditPii} onToast={setToast} />
                <ForeignDocsSection employeeId={id} canEdit={canEditPii} onToast={setToast} />
                <DocumentsSection employeeId={id} canEdit={canEditPii} onToast={setToast} />
              </div>
            )}
          </section>
        </div>
      )}

      {docGen && emp && <DocGenDialog employee={emp} onClose={() => setDocGen(false)} />}
      {openModal === 'medical' && emp && <MedicalExamsDialog employeeId={id} employeeName={name} canEdit={canManage} onClose={() => setOpenModal(null)} />}
      {openModal === 'certs' && emp && <CertificatesDialog employeeId={id} employeeName={name} canEdit={canManage} onClose={() => setOpenModal(null)} />}
      {openModal === 'audit' && emp && <EmployeeAuditDialog employeeId={id} employeeName={name} onClose={() => setOpenModal(null)} />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">{toast}</div>
      )}
    </Dialog>
  );
}
