'use client';

import { useState } from 'react';
import { FileText, QrCode } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { generateBadgeSheetPdf, openBlob, downloadBlob } from '@/lib/hr-pdf';
import {
  useEmployees,
  useEmployee,
  useContracts,
  useEmployeeDocuments,
  useEmployeeChildren,
  useEmployeeBankCards,
  useMedicalExams,
  useCertificates,
  signDocument,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { Field, LockedNote, sv, SummaryChips } from './common';
import { DocGenDialog } from './doc-gen-dialog';

export function ZaposleniTab() {
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const listQ = useEmployees({ q: q || undefined, active: onlyActive || undefined, page, pageSize: 25 });
  const rows = listQ.data?.data ?? [];
  const total = listQ.data?.meta.pagination.total ?? 0;
  const totalPages = listQ.data?.meta.pagination.totalPages ?? 1;

  const columns: Column<EmployeeSafe>[] = [
    {
      key: 'name',
      header: 'Ime i prezime',
      render: (r) => (
        <div>
          <div className="font-medium text-ink">{r.full_name}</div>
          <div className="text-xs text-ink-secondary">{[r.email, r.phone_work].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'position', header: 'Pozicija', render: (r) => r.position || '—' },
    { key: 'department', header: 'Odeljenje', render: (r) => r.department || '—' },
    { key: 'team', header: 'Tim', render: (r) => r.team || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.is_active ? <StatusBadge tone="success" label="Aktivan" /> : <StatusBadge tone="neutral" label="Neaktivan" />,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Pretraga po imenu, poziciji, email-u…"
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => {
              setOnlyActive(e.target.checked);
              setPage(1);
            }}
          />
          Samo aktivni
        </label>
        <span className="ml-auto text-sm text-ink-secondary">{total} zaposlenih</span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={listQ.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        empty={<EmptyState title="Nema zaposlenih" hint="Promenite pretragu ili filter." />}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button variant="secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            ‹ Prethodna
          </Button>
          <span className="text-sm text-ink-secondary">
            {page} / {totalPages}
          </span>
          <Button variant="secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
            Sledeća ›
          </Button>
        </div>
      )}

      {openId && <DosijeDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function DosijeDialog({ id, onClose }: { id: string; onClose: () => void }) {
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
