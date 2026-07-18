'use client';

// PII pod-resursi dosijea (kadrovska.pii) — deca, službene kartice, lična
// dokumenta (LK/pasoš/vozačka), stranac (11 polja). Paritet 1.0 employeesTab.js.
// Ugovor: READ = Prisma camelCase; WRITE personal/foreign nosi SNAKE_CASE `data`
// (BE mapForeign/mapPersonal). Deca/kartice imaju tipizirane hookove.

import { useState } from 'react';
import { Trash2, Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { formatDate } from '@/lib/format';
import {
  newClientEventId,
  useEmployeeChildren,
  useEmployeeBankCards,
  useEmployeeForeignDocs,
  useEmployeePersonalDocs,
  useCreateChild,
  useDeleteChild,
  useCreateBankCard,
  useUpdateBankCard,
  useDeleteBankCard,
  useCreatePersonalDoc,
  useUpdatePersonalDoc,
  useCreateForeignDoc,
  useUpdateForeignDoc,
  type EmployeePersonalDoc,
  type EmployeeForeignDoc,
} from '@/api/kadrovska';
import { ConfirmDialog, ExpiryBadge, INPUT_CLS, ROW_BTN_DANGER, SectionTitle, toDateInput } from './shared';

type Toast = (msg: string) => void;

/* ══════════════════ DECA ══════════════════ */

export function ChildrenSection({ employeeId, canEdit, onToast }: { employeeId: string; canEdit: boolean; onToast?: Toast }) {
  const q = useEmployeeChildren(employeeId, true);
  const createM = useCreateChild();
  const delM = useDeleteChild();
  const [name, setName] = useState('');
  const [bday, setBday] = useState('');
  const [delId, setDelId] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  async function add() {
    if (!name.trim()) return;
    try {
      await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), firstName: name.trim(), birthDate: bday || undefined });
      setName('');
      setBday('');
      onToast?.('✅ Dete dodato');
    } catch {
      onToast?.('⚠ Dodavanje nije uspelo');
    }
  }
  async function remove() {
    if (!delId) return;
    try {
      await delM.mutateAsync({ id: delId });
      onToast?.('🗑 Obrisano');
    } catch {
      onToast?.('⚠ Brisanje nije uspelo');
    }
    setDelId(null);
  }

  return (
    <div>
      <SectionTitle>👶 Deca</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema upisane dece.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-control border border-line px-3 py-1.5">
              <span>
                {c.firstName}
                {c.birthDate ? <span className="text-ink-secondary"> · {formatDate(c.birthDate)}</span> : ''}
              </span>
              {canEdit && (
                <button className={ROW_BTN_DANGER} title="Obriši" onClick={() => setDelId(c.id)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className={`${INPUT_CLS} max-w-[12rem]`} placeholder="Ime deteta" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={`${INPUT_CLS} max-w-[10rem]`} type="date" title="Datum rođenja" value={bday} onChange={(e) => setBday(e.target.value)} />
          <Button variant="ghost" onClick={() => void add()} loading={createM.isPending} disabled={!name.trim()}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj
          </Button>
        </div>
      )}
      {delId && (
        <ConfirmDialog title="Brisanje deteta" body="Obrisati ovaj unos?" busy={delM.isPending} onCancel={() => setDelId(null)} onConfirm={() => void remove()} />
      )}
    </div>
  );
}

/* ══════════════════ SLUŽBENE KARTICE BANKE ══════════════════ */

const BANK_PRESETS = ['Banca Intesa', 'AIK Banka', 'Raiffeisen', 'druga'];

export function BankCardsSection({ employeeId, canEdit, onToast }: { employeeId: string; canEdit: boolean; onToast?: Toast }) {
  const q = useEmployeeBankCards(employeeId, true);
  const createM = useCreateBankCard();
  const updM = useUpdateBankCard();
  const delM = useDeleteBankCard();
  const [bank, setBank] = useState('Banca Intesa');
  const [bankOther, setBankOther] = useState('');
  const [num, setNum] = useState('');
  const [valid, setValid] = useState('');
  const [delId, setDelId] = useState<string | null>(null);
  const rows = q.data?.data ?? [];

  async function add() {
    const bankName = bank === 'druga' ? bankOther.trim() : bank;
    if (!bankName) return;
    try {
      await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), bank: bankName, cardNumber: num.trim() || undefined, validThru: valid || undefined, isActive: true });
      setNum('');
      setValid('');
      setBankOther('');
      onToast?.('✅ Kartica dodata');
    } catch {
      onToast?.('⚠ Dodavanje nije uspelo');
    }
  }
  async function toggle(id: string, isActive: boolean) {
    try {
      await updM.mutateAsync({ id, patch: { isActive: !isActive } });
    } catch {
      onToast?.('⚠ Izmena nije uspela');
    }
  }
  async function remove() {
    if (!delId) return;
    try {
      await delM.mutateAsync({ id: delId });
      onToast?.('🗑 Obrisano');
    } catch {
      onToast?.('⚠ Brisanje nije uspelo');
    }
    setDelId(null);
  }

  return (
    <div>
      <SectionTitle>💳 Službene kartice banke</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema kartica.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-1.5">
              <span className="min-w-0 truncate">
                <strong>{c.bank}</strong>
                {c.cardNumber ? <span className="text-ink-secondary"> · {c.cardNumber}</span> : ''}
                {c.validThru ? <span className="text-ink-secondary"> · do {formatDate(c.validThru)}</span> : ''}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  className="text-xs text-accent hover:underline disabled:opacity-50"
                  disabled={!canEdit || updM.isPending}
                  title="Prebaci aktivnu/neaktivnu"
                  onClick={() => void toggle(c.id, c.isActive)}
                >
                  {c.isActive ? 'aktivna' : 'neaktivna'}
                </button>
                {canEdit && (
                  <button className={ROW_BTN_DANGER} title="Obriši" onClick={() => setDelId(c.id)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select className={`${INPUT_CLS} max-w-[10rem]`} value={bank} onChange={(e) => setBank(e.target.value)} aria-label="Banka">
            {BANK_PRESETS.map((b) => (
              <option key={b} value={b}>
                {b === 'druga' ? 'druga…' : b}
              </option>
            ))}
          </select>
          {bank === 'druga' && (
            <input className={`${INPUT_CLS} max-w-[10rem]`} placeholder="Naziv banke" value={bankOther} onChange={(e) => setBankOther(e.target.value)} />
          )}
          <input className={`${INPUT_CLS} max-w-[10rem]`} placeholder="Broj kartice" value={num} onChange={(e) => setNum(e.target.value)} />
          <input className={`${INPUT_CLS} max-w-[9rem]`} type="date" title="Važi do" value={valid} onChange={(e) => setValid(e.target.value)} />
          <Button variant="ghost" onClick={() => void add()} loading={createM.isPending}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj karticu
          </Button>
        </div>
      )}
      <p className="mt-1 text-xs text-ink-secondary">Mejl administraciji 30 dana pre i na dan isteka.</p>
      {delId && (
        <ConfirmDialog title="Brisanje kartice" body="Obrisati ovu karticu?" busy={delM.isPending} onCancel={() => setDelId(null)} onConfirm={() => void remove()} />
      )}
    </div>
  );
}

/* ══════════════════ LIČNA DOKUMENTA (LK/pasoš/vozačka) ══════════════════ */

const PERSONAL_FIELDS: { key: string; label: string; type: 'text' | 'date'; camel: keyof EmployeePersonalDoc }[] = [
  { key: 'lk_number', label: 'Broj lične karte', type: 'text', camel: 'lkNumber' },
  { key: 'lk_expiry', label: 'Ističe lična karta', type: 'date', camel: 'lkExpiry' },
  { key: 'passport_number', label: 'Broj pasoša', type: 'text', camel: 'passportNumber' },
  { key: 'passport_expiry', label: 'Ističe pasoš', type: 'date', camel: 'passportExpiry' },
  { key: 'driver_license_number', label: 'Broj vozačke', type: 'text', camel: 'driverLicenseNumber' },
  { key: 'driver_license_expiry', label: 'Ističe vozačka', type: 'date', camel: 'driverLicenseExpiry' },
  { key: 'driver_license_categories', label: 'Kategorije (vozačka)', type: 'text', camel: 'driverLicenseCategories' },
];

export function PersonalDocsSection({ employeeId, canEdit, onToast }: { employeeId: string; canEdit: boolean; onToast?: Toast }) {
  const q = useEmployeePersonalDocs(employeeId, true);
  const createM = useCreatePersonalDoc();
  const updM = useUpdatePersonalDoc();
  const row = (q.data?.data?.[0] as EmployeePersonalDoc | undefined) ?? undefined;

  return (
    <UpsertDocForm
      title="🪪 Lična dokumenta — važenje"
      hint="Podsetnik: lična karta 30 dana, pasoš 6 meseci, vozačka 30 dana pre isteka (lekarski 15 dana). Pasoš unositi samo za INO terene."
      fields={PERSONAL_FIELDS}
      row={row as unknown as Record<string, unknown> | undefined}
      expiryKeys={['lkExpiry', 'passportExpiry', 'driverLicenseExpiry']}
      canEdit={canEdit}
      loading={q.isLoading}
      busy={createM.isPending || updM.isPending}
      onSave={async (data) => {
        if (row) await updM.mutateAsync({ id: row.id, data });
        else await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), data });
      }}
      onToast={onToast}
    />
  );
}

/* ══════════════════ STRANAC — DOKUMENTI (11 polja) ══════════════════ */

const FOREIGN_FIELDS: { key: string; label: string; type: 'text' | 'date'; camel: keyof EmployeeForeignDoc }[] = [
  { key: 'passport_number', label: 'Broj pasoša', type: 'text', camel: 'passportNumber' },
  { key: 'passport_expiry', label: 'Ističe pasoš', type: 'date', camel: 'passportExpiry' },
  { key: 'visa_number', label: 'Broj vize', type: 'text', camel: 'visaNumber' },
  { key: 'visa_expiry', label: 'Ističe viza', type: 'date', camel: 'visaExpiry' },
  { key: 'work_permit_number', label: 'Broj radne dozvole', type: 'text', camel: 'workPermitNumber' },
  { key: 'work_permit_expiry', label: 'Ističe radna dozvola', type: 'date', camel: 'workPermitExpiry' },
  { key: 'residence_permit_number', label: 'Broj boravišne dozvole', type: 'text', camel: 'residencePermitNumber' },
  { key: 'residence_permit_expiry', label: 'Ističe boravišna dozvola', type: 'date', camel: 'residencePermitExpiry' },
  { key: 'residence_address', label: 'Adresa boravka', type: 'text', camel: 'residenceAddress' },
  { key: 'bank_account', label: 'Tekući račun (nerezident)', type: 'text', camel: 'bankAccount' },
  { key: 'foreign_id_number', label: 'Identifikacioni broj (EBS)', type: 'text', camel: 'foreignIdNumber' },
];

export function ForeignDocsSection({ employeeId, canEdit, onToast }: { employeeId: string; canEdit: boolean; onToast?: Toast }) {
  const q = useEmployeeForeignDocs(employeeId, true);
  const createM = useCreateForeignDoc();
  const updM = useUpdateForeignDoc();
  const row = (q.data?.data?.[0] as EmployeeForeignDoc | undefined) ?? undefined;

  return (
    <UpsertDocForm
      title="🌍 Stranac — dokumenti"
      hint="Za strane državljane — za domaće ostavi prazno. Administracija dobija mejl 30 dana pre i na dan isteka pasoša/vize/radne/boravišne dozvole."
      fields={FOREIGN_FIELDS}
      row={row as unknown as Record<string, unknown> | undefined}
      expiryKeys={['passportExpiry', 'visaExpiry', 'workPermitExpiry', 'residencePermitExpiry']}
      canEdit={canEdit}
      loading={q.isLoading}
      busy={createM.isPending || updM.isPending}
      onSave={async (data) => {
        if (row) await updM.mutateAsync({ id: row.id, data });
        else await createM.mutateAsync({ employeeId, clientEventId: newClientEventId(), data });
      }}
      onToast={onToast}
    />
  );
}

/* Zajednička upsert-forma (jedan red po zaposlenom; pregled → izmena → snimi). */
function UpsertDocForm({
  title,
  hint,
  fields,
  row,
  expiryKeys,
  canEdit,
  loading,
  busy,
  onSave,
  onToast,
}: {
  title: string;
  hint: string;
  fields: { key: string; label: string; type: 'text' | 'date'; camel: string }[];
  row: Record<string, unknown> | undefined;
  expiryKeys: string[];
  canEdit: boolean;
  loading: boolean;
  busy: boolean;
  onSave: (data: Record<string, string | null>) => Promise<void>;
  onToast?: Toast;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  function beginEdit() {
    const d: Record<string, string> = {};
    for (const f of fields) d[f.key] = f.type === 'date' ? toDateInput(row?.[f.camel] as string) : String(row?.[f.camel] ?? '');
    setDraft(d);
    setEditing(true);
  }
  async function save() {
    const data: Record<string, string | null> = {};
    for (const f of fields) {
      const v = (draft[f.key] ?? '').trim();
      data[f.key] = v === '' ? null : v;
    }
    try {
      await onSave(data);
      setEditing(false);
      onToast?.('✅ Sačuvano');
    } catch {
      onToast?.('⚠ Čuvanje nije uspelo');
    }
  }

  const anyValue = fields.some((f) => row?.[f.camel]);

  return (
    <div>
      <SectionTitle
        action={
          canEdit && !editing ? (
            <Button variant="ghost" onClick={beginEdit}>
              <Pencil className="h-4 w-4" aria-hidden /> {anyValue ? 'Izmeni' : 'Unesi'}
            </Button>
          ) : undefined
        }
      >
        {title}
      </SectionTitle>

      {loading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{f.label}</span>
                <input
                  className={`${INPUT_CLS} mt-0.5`}
                  type={f.type}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Otkaži
            </Button>
            <Button onClick={() => void save()} loading={busy}>
              Sačuvaj
            </Button>
          </div>
        </div>
      ) : !anyValue ? (
        <p className="text-sm text-ink-secondary">Nema unetih podataka.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {fields.map((f) => {
            const val = row?.[f.camel] as string | null | undefined;
            if (!val) return null;
            return (
              <div key={f.key}>
                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-secondary">{f.label}</div>
                <div className="mt-0.5 flex items-center gap-2 text-sm text-ink">
                  {f.type === 'date' ? formatDate(val) : val}
                  {f.type === 'date' && expiryKeys.includes(f.camel) && <ExpiryBadge date={val} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-1 text-xs text-ink-secondary">{hint}</p>
    </div>
  );
}
