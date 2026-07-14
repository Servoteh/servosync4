'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useCreateEmployee,
  useEmployee,
  useOrgStructure,
  useUpdateEmployee,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { parseJmbg, validateJmbg } from '@/lib/jmbg';
import { postanskiZaGrad, gradZaPostanski } from '@/lib/rs-postanski';
import { sv } from './common';
import { EDU_LEVEL_LABELS, EMERGENCY_RELATIONS, WORK_TYPE_OPTIONS, empDisplayName } from './emp-shared';

// Karton zaposlenog — kreiranje + izmena (port 1.0 buildEmployeeModalHtml +
// submitEmployeeForm, doktrina §C: iste sekcije/polja/labele/poruke).
//
// PII polja (JMBG, privatni telefon, hitni kontakt, adresa i banka) su vidljiva
// ali zaključana bez `kadrovska.pii` — vrednosti tada NE ulaze u payload
// (backend guard + sy15 trigger presuđuju; FE samo krije afordansu).
//
// Izmena ide kroz PATCH sa `expectedUpdatedAt` (hr_update_employee optimistic
// lock) — poruke stale / sensitive_blocked / permission_denied kao u 1.0.
//
// ORG: kaskadni selekti odeljenje→pododeljenje→pozicija po ID iz GET
// /org-structure (1.0 _deptOptions/_subDeptOptions/_positionOptions paritet);
// payload nosi ID kolone I izvedeni tekst (department=deptObj.name,
// position=posObj.name) kao 1.0 buildEmployeePayload — ID kolone voze šefovski
// row-scope (current_user_manages_employee) i view JOIN-ove, tekst '' briše
// (COALESCE grupa u hr_update_employee; null bi tiho zadržao staro).
// FALLBACK dok ruta ne oživi (P1a merge): CREATE = slobodan tekst (nema ID-jeva
// da divergiraju); EDIT = odeljenje/pozicija ZAKLJUČANI i NE ulaze u patch
// (tekst-only upis bi tiho divergirao od ID kolona → pogrešan šefovski scope).

const SELECT_CLS = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50';

interface FormState {
  firstName: string;
  lastName: string;
  department: string;
  position: string;
  departmentId: number | null;
  subDepartmentId: number | null;
  positionId: number | null;
  team: string;
  hireDate: string;
  workType: string;
  email: string;
  phoneWork: string;
  isActive: boolean;
  personalId: string;
  birthDate: string;
  gender: string;
  phonePrivate: string;
  slava: string;
  slavaDay: string;
  emergencyContactName: string;
  emergencyContactRelation: string;
  emergencyContactPhone: string;
  emergencyContactPhoneAlt: string;
  address: string;
  city: string;
  postalCode: string;
  bankName: string;
  bankAccount: string;
  educationLevel: string;
  educationTitle: string;
  medicalExamDate: string;
  medicalExamExpires: string;
  note: string;
}

const EMPTY: FormState = {
  firstName: '', lastName: '', department: '', position: '',
  departmentId: null, subDepartmentId: null, positionId: null, team: '',
  hireDate: '', workType: 'ugovor', email: '', phoneWork: '', isActive: true,
  personalId: '', birthDate: '', gender: '', phonePrivate: '', slava: '', slavaDay: '',
  emergencyContactName: '', emergencyContactRelation: '', emergencyContactPhone: '', emergencyContactPhoneAlt: '',
  address: '', city: '', postalCode: '', bankName: '', bankAccount: '',
  educationLevel: '', educationTitle: '', medicalExamDate: '', medicalExamExpires: '', note: '',
};

function iso(v: unknown): string {
  const s = v == null ? '' : String(v);
  return s ? s.slice(0, 10) : '';
}

function toInt(v: unknown): number | null {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** v_employees_safe red → stanje forme (prefill za izmenu). */
function rowToState(r: EmployeeSafe): FormState {
  const slavaRaw = sv(r, 'slava_day'); // DB format MMDD
  return {
    firstName: sv(r, 'first_name'),
    lastName: sv(r, 'last_name'),
    department: sv(r, 'department'),
    position: sv(r, 'position'),
    departmentId: toInt(r['department_id']),
    subDepartmentId: toInt(r['sub_department_id']),
    positionId: toInt(r['position_id']),
    team: sv(r, 'team'),
    hireDate: iso(r['hire_date']),
    workType: sv(r, 'work_type') || 'ugovor',
    email: sv(r, 'email'),
    phoneWork: sv(r, 'phone_work') || sv(r, 'phone'),
    isActive: r.is_active !== false,
    personalId: sv(r, 'personal_id'),
    birthDate: iso(r['birth_date']),
    gender: sv(r, 'gender'),
    phonePrivate: sv(r, 'phone_private'),
    slava: sv(r, 'slava'),
    slavaDay: slavaRaw && slavaRaw.length === 4 ? `${slavaRaw.slice(0, 2)}-${slavaRaw.slice(2, 4)}` : slavaRaw,
    emergencyContactName: sv(r, 'emergency_contact_name'),
    emergencyContactRelation: sv(r, 'emergency_contact_relation'),
    emergencyContactPhone: sv(r, 'emergency_contact_phone'),
    emergencyContactPhoneAlt: sv(r, 'emergency_contact_phone_alt'),
    address: sv(r, 'address'),
    city: sv(r, 'city'),
    postalCode: sv(r, 'postal_code'),
    bankName: sv(r, 'bank_name'),
    bankAccount: sv(r, 'bank_account'),
    educationLevel: sv(r, 'education_level'),
    educationTitle: sv(r, 'education_title'),
    medicalExamDate: iso(r['medical_exam_date']),
    medicalExamExpires: iso(r['medical_exam_expires']),
    note: sv(r, 'note'),
  };
}

/** Poruke optimistic-lock/permission grešaka — paritet 1.0 hr_update_employee tok. */
function saveErrorMessage(e: unknown): string {
  const raw = e instanceof ApiError ? `${e.message} ${JSON.stringify(e.body ?? '')}` : e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();
  if (low.includes('stale') || (e instanceof ApiError && e.status === 409)) {
    return 'Profil je u međuvremenu izmenjen od strane drugog korisnika. Osvežite listu da vidite tuđe promene i pokušajte ponovo.';
  }
  if (low.includes('sensitive')) {
    return 'Osetljiva (PII) polja može da menja samo administracija (admin / poslovni admin) — izmena je odbijena.';
  }
  if (low.includes('permission') || (e instanceof ApiError && e.status === 403)) {
    return 'Nemate ovlašćenje za izmenu ovog zaposlenog.';
  }
  // DB unique indeks ux_employees_email (23505) — klijentska provera pokriva samo
  // učitanu stranu liste, pa je ovo backstop poruka.
  if (low.includes('unique') || low.includes('23505') || low.includes('duplicate')) {
    return 'Email već koristi drugi zaposleni (email mora biti jedinstven).';
  }
  return e instanceof Error && e.message ? e.message : 'Greška pri čuvanju. Pokušajte ponovo.';
}

function Section({ title, locked, children }: { title: string; locked?: boolean; children: ReactNode }) {
  return (
    <fieldset className="rounded-panel border border-line p-4">
      <legend className="px-1 text-sm font-semibold text-ink">
        {title}
        {locked && (
          <span className="ml-1" title="Nema ovlašćenja za ovu sekciju (kadrovska.pii)">🔒</span>
        )}
      </legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

export function EmployeeFormDialog({
  editId,
  employees,
  canPii,
  onClose,
  onSaved,
}: {
  /** null = novi zaposleni; inače id za izmenu. */
  editId: string | null;
  /** Učitana lista (za duplikat-email proveru i datalist predloge). */
  employees: EmployeeSafe[];
  canPii: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const isEdit = !!editId;
  const empQ = useEmployee(editId);
  const createMut = useCreateEmployee();
  const updateMut = useUpdateEmployee();

  /* Org struktura za kaskadne selekte; do P1a merge-a ruta može biti mrtva (404)
     → orgReady=false aktivira fallback ponašanje (vidi zaglavlje fajla). */
  const orgQ = useOrgStructure();
  const org = orgQ.data?.data;
  const orgReady = (org?.departments?.length ?? 0) > 0;

  const [f, setF] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);
  // Auto-popunjene vrednosti grad↔poštanski — pregazi samo ono što je sâm upisao.
  const autoZip = useRef<string | null>(null);
  const autoCity = useRef<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEdit && empQ.data?.data && !prefilled) {
      setF(rowToState(empQ.data.data));
      setPrefilled(true);
    }
  }, [isEdit, empQ.data, prefilled]);

  useEffect(() => {
    if (!isEdit || prefilled) firstRef.current?.focus();
  }, [isEdit, prefilled]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  /* JMBG → auto-fill datum rođenja i pol (samo prazna polja). */
  function onJmbg(vRaw: string) {
    const v = vRaw.replace(/\D/g, '').slice(0, 13);
    setF((p) => {
      const next = { ...p, personalId: v };
      const parsed = parseJmbg(v);
      if (parsed) {
        if (!p.birthDate) next.birthDate = parsed.birthDate;
        if (!p.gender) next.gender = parsed.gender;
      }
      return next;
    });
  }

  /* Grad ↔ Poštanski broj auto-popuna (1.0 rsPostanskiBrojevi). */
  function onCity(v: string) {
    setF((p) => {
      const next = { ...p, city: v };
      const code = postanskiZaGrad(v);
      if (code && (!p.postalCode || p.postalCode === autoZip.current)) {
        next.postalCode = code;
        autoZip.current = code;
      }
      return next;
    });
  }
  function onZip(v: string) {
    setF((p) => {
      const next = { ...p, postalCode: v };
      if (/^\d{5}$/.test(v.trim())) {
        const grad = gradZaPostanski(v.trim());
        if (grad && (!p.city || p.city === autoCity.current)) {
          next.city = grad;
          autoCity.current = grad;
        }
      }
      return next;
    });
  }

  const deptSuggestions = Array.from(new Set(employees.map((e) => sv(e, 'department')).filter(Boolean))).sort();
  const posSuggestions = Array.from(new Set(employees.map((e) => sv(e, 'position')).filter(Boolean))).sort();

  /* Kaskada (1.0 paritet): pododeljenja po odeljenju; pozicije po odeljenju
     (+ pododeljenju kad je izabrano). Promena roditelja resetuje decu. */
  const subDeptList = (org?.subDepartments ?? []).filter((s) => s.departmentId === f.departmentId);
  const positionList = (org?.jobPositions ?? []).filter(
    (p) => p.departmentId === f.departmentId && (!f.subDepartmentId || p.subDepartmentId === f.subDepartmentId),
  );
  function onDeptId(v: string) {
    const id = toInt(v);
    setF((p) => ({ ...p, departmentId: id, subDepartmentId: null, positionId: null }));
  }
  function onSubDeptId(v: string) {
    const id = toInt(v);
    setF((p) => ({ ...p, subDepartmentId: id, positionId: null }));
  }

  async function submit() {
    setError(null);
    const firstName = f.firstName.trim();
    const lastName = f.lastName.trim();
    if (!firstName || !lastName) {
      setError('Ime i Prezime su obavezni.');
      return;
    }

    /* Slava_day u DB je MMDD (bez crtice). */
    const slavaRaw = f.slavaDay.trim();
    let slavaDay: string | null = null;
    if (slavaRaw) {
      if (!/^\d{2}-?\d{2}$/.test(slavaRaw)) {
        setError('Dan slave mora biti u formatu MM-DD (npr. 12-19).');
        return;
      }
      slavaDay = slavaRaw.replace('-', '');
    }

    const email = f.email.trim().toLowerCase();
    if (email) {
      const dup = employees.find((e) => e.id !== editId && sv(e, 'email').toLowerCase() === email);
      if (dup) {
        setError('Email već koristi zaposleni: ' + (empDisplayName(dup) || dup.email));
        return;
      }
    }

    /* JMBG: format + datum blokiraju; checksum je warn-only (legacy unosi). */
    const personalId = f.personalId.trim();
    if (canPii && personalId) {
      const v = validateJmbg(personalId);
      if (!v.valid) {
        setError(v.error || 'JMBG nije validan.');
        return;
      }
      if (!validateJmbg(personalId, { requireChecksum: true }).valid) {
        console.warn('[kadrovska] JMBG checksum mismatch (dozvoljeno za legacy unose):', personalId);
      }
    }

    /* Org: izvedeni tekst iz selektovanih objekata (1.0 buildEmployeePayload) —
       UVEK string ('' briše; COALESCE grupa u RPC-u; null bi tiho zadržao staro). */
    const deptObj = orgReady ? (org?.departments ?? []).find((d) => d.id === f.departmentId) ?? null : null;
    const posObj = orgReady ? (org?.jobPositions ?? []).find((p) => p.id === f.positionId) ?? null : null;
    const departmentText = orgReady ? (deptObj?.name ?? '') : f.department.trim();
    const positionText = orgReady ? (posObj?.name ?? '') : f.position.trim();

    // Zajednička (ne-PII) polja — camelCase vrednosti forme.
    const base: Record<string, unknown> = {
      firstName,
      lastName,
      fullName: [lastName, firstName].filter(Boolean).join(' '),
      department: departmentText,
      position: positionText,
      team: f.team.trim() || null,
      hireDate: f.hireDate || null,
      workType: f.workType || 'ugovor',
      email,
      phoneWork: f.phoneWork.trim(),
      isActive: f.isActive,
      birthDate: f.birthDate || null,
      gender: f.gender || null,
      slava: f.slava.trim() || null,
      slavaDay,
      educationLevel: f.educationLevel || null,
      educationTitle: f.educationTitle.trim() || null,
      medicalExamDate: f.medicalExamDate || null,
      medicalExamExpires: f.medicalExamExpires || null,
      note: f.note.trim(),
    };
    // Osetljiva polja idu samo uz PII pravo — inače ih uopšte ne šaljemo
    // (izbegavamo sensitive_blocked na backend guardu).
    const pii: Record<string, unknown> = canPii
      ? {
          personalId: personalId || null,
          phonePrivate: f.phonePrivate.trim() || null,
          emergencyContactName: f.emergencyContactName.trim() || null,
          emergencyContactRelation: f.emergencyContactRelation || null,
          emergencyContactPhone: f.emergencyContactPhone.trim() || null,
          emergencyContactPhoneAlt: f.emergencyContactPhoneAlt.trim() || null,
          address: f.address.trim() || null,
          city: f.city.trim() || null,
          postalCode: f.postalCode.trim() || null,
          bankName: f.bankName.trim() || null,
          bankAccount: f.bankAccount.trim() || null,
        }
      : {};

    try {
      if (isEdit && editId) {
        /* PATCH — patch ključevi su snake_case kolone (hr_update_employee ugovor).
           Šaljemo sva polja forme (1.0 paritet: no-op UPDATE za nepromenjena).
           Org blok SAMO kad su selekti živi: ID kolone + izvedeni tekst zajedno
           (tekst-only bi divergirao od ID-jeva koji voze šefovski row-scope). */
        const patch: Record<string, unknown> = {
          first_name: base.firstName,
          last_name: base.lastName,
          full_name: base.fullName,
          ...(orgReady
            ? {
                department: departmentText,
                position: positionText,
                department_id: f.departmentId,
                sub_department_id: f.subDepartmentId,
                position_id: f.positionId,
              }
            : {}),
          team: base.team,
          hire_date: base.hireDate,
          work_type: base.workType,
          email: base.email,
          phone: base.phoneWork,
          is_active: base.isActive,
          birth_date: base.birthDate,
          gender: base.gender,
          slava: base.slava,
          slava_day: base.slavaDay,
          education_level: base.educationLevel,
          education_title: base.educationTitle,
          medical_exam_date: base.medicalExamDate,
          medical_exam_expires: base.medicalExamExpires,
          note: base.note,
          ...(canPii
            ? {
                personal_id: pii.personalId,
                phone_private: pii.phonePrivate,
                emergency_contact_name: pii.emergencyContactName,
                emergency_contact_relation: pii.emergencyContactRelation,
                emergency_contact_phone: pii.emergencyContactPhone,
                emergency_contact_phone_alt: pii.emergencyContactPhoneAlt,
                address: pii.address,
                city: pii.city,
                postal_code: pii.postalCode,
                bank_name: pii.bankName,
                bank_account: pii.bankAccount,
              }
            : {}),
        };
        const expectedUpdatedAt = sv(empQ.data?.data ?? null, 'updated_at') || undefined;
        await updateMut.mutateAsync({ id: editId, patch, expectedUpdatedAt });
        onSaved('✏️ Zaposleni izmenjen');
      } else {
        await createMut.mutateAsync({
          clientEventId: newClientEventId(),
          ...base,
          /* CreateEmployeeDto prima departmentId/subDepartmentId/positionId (int). */
          ...(orgReady
            ? { departmentId: f.departmentId, subDepartmentId: f.subDepartmentId, positionId: f.positionId }
            : {}),
          ...pii,
          fullName: String(base.fullName),
          workType: String(base.workType),
        } as { clientEventId: string; fullName: string; workType: string });
        onSaved('✅ Zaposleni dodat');
      }
      onClose();
    } catch (e) {
      setError(saveErrorMessage(e));
    }
  }

  const busy = createMut.isPending || updateMut.isPending;
  const loading = isEdit && !prefilled;
  const subDeptName = sv(empQ.data?.data ?? null, 'sub_department_name');

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isEdit ? 'Izmeni zaposlenog' : 'Novi zaposleni'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={() => void submit()} loading={busy} disabled={loading}>Sačuvaj</Button>
        </>
      }
    >
      {loading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        >
          <p className="text-sm text-ink-secondary">Popuni podatke po sekcijama. Samo Ime i Prezime su obavezni.</p>
          {error && (
            <p className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger" role="alert">
              {error}
            </p>
          )}

          <Section title="Osnovno">
            <FormField label="Ime" required>
              <Input ref={firstRef} value={f.firstName} onChange={(e) => set('firstName', e.target.value)} maxLength={60} />
            </FormField>
            <FormField label="Prezime" required>
              <Input value={f.lastName} onChange={(e) => set('lastName', e.target.value)} maxLength={60} />
            </FormField>
            {orgReady ? (
              <>
                <FormField label="Odeljenje">
                  <select className={SELECT_CLS} value={f.departmentId ?? ''} onChange={(e) => onDeptId(e.target.value)}>
                    <option value="">— izaberi odeljenje —</option>
                    {(org?.departments ?? []).map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Pododeljenje">
                  <select className={SELECT_CLS} value={f.subDepartmentId ?? ''} onChange={(e) => onSubDeptId(e.target.value)} disabled={!f.departmentId}>
                    <option value="">— izaberi pododeljenje —</option>
                    {subDeptList.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </FormField>
                <FormField label="Radno mesto (pozicija)">
                  <select className={SELECT_CLS} value={f.positionId ?? ''} onChange={(e) => set('positionId', toInt(e.target.value))} disabled={!f.departmentId}>
                    <option value="">— izaberi poziciju —</option>
                    {positionList.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </FormField>
              </>
            ) : (
              /* Fallback bez org-structure rute: CREATE = slobodan tekst; EDIT =
                 zaključano (tekst-only upis divergira od ID kolona → šefovski scope). */
              <>
                <FormField label="Odeljenje" hint={isEdit ? 'Izmena zaključana dok org-structure ruta ne oživi (P1a)' : undefined}>
                  <>
                    <Input value={f.department} onChange={(e) => set('department', e.target.value)} list="kadr-dept-list" maxLength={120} disabled={isEdit} />
                    <datalist id="kadr-dept-list">
                      {deptSuggestions.map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                  </>
                </FormField>
                {isEdit && (
                  <FormField label="Pododeljenje">
                    <Input value={subDeptName || '—'} disabled />
                  </FormField>
                )}
                <FormField label="Radno mesto (pozicija)" hint={isEdit ? 'Izmena zaključana dok org-structure ruta ne oživi (P1a)' : undefined}>
                  <>
                    <Input value={f.position} onChange={(e) => set('position', e.target.value)} list="kadr-pos-list" maxLength={120} disabled={isEdit} />
                    <datalist id="kadr-pos-list">
                      {posSuggestions.map((p) => (
                        <option key={p} value={p} />
                      ))}
                    </datalist>
                  </>
                </FormField>
              </>
            )}
            <FormField label="Tim">
              <Input value={f.team} onChange={(e) => set('team', e.target.value)} maxLength={80} />
            </FormField>
            <FormField label="Zaposlen od (počeo sa radom)" hint="Praznici pre ovog datuma se NE sabiraju u mesečne sate.">
              <Input type="date" value={f.hireDate} onChange={(e) => set('hireDate', e.target.value)} />
            </FormField>
            <FormField label="Tip rada" hint="Dualno/praksa/penzioner nemaju automatsko sabiranje praznika ni plaćena odsustva.">
              <select className={SELECT_CLS} value={f.workType} onChange={(e) => set('workType', e.target.value)}>
                {WORK_TYPE_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Email">
              <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} maxLength={120} />
            </FormField>
            <FormField label="Telefon (službeni)">
              <Input type="tel" value={f.phoneWork} onChange={(e) => set('phoneWork', e.target.value)} maxLength={40} />
            </FormField>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
              Aktivan zaposleni
            </label>
          </Section>

          <Section title="Lični podaci" locked={!canPii}>
            <FormField label="JMBG (13 cifara)">
              <Input
                value={f.personalId}
                onChange={(e) => onJmbg(e.target.value)}
                inputMode="numeric"
                maxLength={13}
                disabled={!canPii}
                placeholder={canPii ? '' : '•••'}
              />
            </FormField>
            <FormField label="Datum rođenja">
              <Input type="date" value={f.birthDate} onChange={(e) => set('birthDate', e.target.value)} />
            </FormField>
            <FormField label="Pol">
              <select className={SELECT_CLS} value={f.gender} onChange={(e) => set('gender', e.target.value)}>
                <option value="">—</option>
                <option value="M">Muški</option>
                <option value="Z">Ženski</option>
              </select>
            </FormField>
            <FormField label="Telefon (privatni)">
              <Input type="tel" value={f.phonePrivate} onChange={(e) => set('phonePrivate', e.target.value)} maxLength={40} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
            </FormField>
            <FormField label="Krsna slava">
              <Input value={f.slava} onChange={(e) => set('slava', e.target.value)} maxLength={80} placeholder="npr. Sveti Nikola" />
            </FormField>
            <FormField label="Dan slave (MM-DD)">
              <Input value={f.slavaDay} onChange={(e) => set('slavaDay', e.target.value)} maxLength={5} placeholder="12-19" />
            </FormField>
          </Section>

          <Section title="🚨 Kontakt u hitnom slučaju" locked={!canPii}>
            <FormField label="Ime kontakt osobe">
              <Input value={f.emergencyContactName} onChange={(e) => set('emergencyContactName', e.target.value)} maxLength={120} disabled={!canPii} />
            </FormField>
            <FormField label="Srodstvo">
              <select className={SELECT_CLS} value={f.emergencyContactRelation} onChange={(e) => set('emergencyContactRelation', e.target.value)} disabled={!canPii}>
                <option value="">—</option>
                {EMERGENCY_RELATIONS.map((rel) => (
                  <option key={rel} value={rel}>{rel}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Telefon (primarni)">
              <Input type="tel" value={f.emergencyContactPhone} onChange={(e) => set('emergencyContactPhone', e.target.value)} maxLength={40} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
            </FormField>
            <FormField label="Telefon (rezervni)">
              <Input type="tel" value={f.emergencyContactPhoneAlt} onChange={(e) => set('emergencyContactPhoneAlt', e.target.value)} maxLength={40} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
            </FormField>
          </Section>

          <Section title="Adresa i banka" locked={!canPii}>
            <div className="sm:col-span-2">
              <FormField label="Adresa">
                <Input value={f.address} onChange={(e) => set('address', e.target.value)} maxLength={200} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
              </FormField>
            </div>
            <FormField label="Grad">
              <Input value={f.city} onChange={(e) => onCity(e.target.value)} maxLength={80} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
            </FormField>
            <FormField label="Poštanski broj">
              <Input value={f.postalCode} onChange={(e) => onZip(e.target.value)} maxLength={10} disabled={!canPii} />
            </FormField>
            <FormField label="Banka">
              <Input value={f.bankName} onChange={(e) => set('bankName', e.target.value)} maxLength={120} disabled={!canPii} placeholder={canPii ? '' : '•••'} />
            </FormField>
            <FormField label="Broj računa">
              <Input value={f.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} maxLength={40} disabled={!canPii} placeholder={canPii ? 'xxx-xxxxxxxxxxxxx-xx' : '•••'} />
            </FormField>
          </Section>

          <Section title="Obrazovanje i zdravlje">
            <FormField label="Stručna sprema — stepen">
              <select className={SELECT_CLS} value={f.educationLevel} onChange={(e) => set('educationLevel', e.target.value)}>
                <option value="">—</option>
                {Object.entries(EDU_LEVEL_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </FormField>
            <FormField label="Naziv kvalifikacije">
              <Input value={f.educationTitle} onChange={(e) => set('educationTitle', e.target.value)} maxLength={120} placeholder="npr. Dipl. maš. inž." />
            </FormField>
            <FormField label="Lekarski pregled — datum">
              <Input type="date" value={f.medicalExamDate} onChange={(e) => set('medicalExamDate', e.target.value)} />
            </FormField>
            <FormField label="Lekarski pregled — ističe" hint="15 dana pre isteka mejl dobijaju zaposleni (ako ima email) i administracija.">
              <Input type="date" value={f.medicalExamExpires} onChange={(e) => set('medicalExamExpires', e.target.value)} />
            </FormField>
          </Section>

          <Section title="Napomena">
            <div className="sm:col-span-2">
              <FormField label="Slobodna napomena">
                <Textarea value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} placeholder="Opcioni komentar…" />
              </FormField>
            </div>
          </Section>
        </form>
      )}
    </Dialog>
  );
}
