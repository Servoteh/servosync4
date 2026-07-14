'use client';

import { useEffect, useMemo, useState } from 'react';
import { Contact, Copy, MessageCircle, Phone } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { ApiError } from '@/api/client';
import { useAllEmployees, useUpdateEmployee, type EmployeeSafe } from '@/api/kadrovska';
import { employeeVCard, isSrMobile, normalizeSrPhone, prettyPhone, telLink, waLink } from '@/lib/phone';
import { sv } from './common';
import { Avatar, compareEmpByLastFirst, empDisplayName, kontaktRec } from './emp-shared';

// Imenik (telefoni zaposlenih) — port 1.0 imenikTab.js. Aktivni zaposleni sa
// avatarima, pretraga ime/pozicija, „samo sa telefonom", kolone mobilni/poslovni,
// po redu: poziv (tel:) / WhatsApp (wa.me, samo SR mobilni) / vCard / kopiraj;
// toolbar izvoz svih prikazanih u jedan .vcf.
//
// INLINE UNOS telefona: samo kadrovska.pii (privatni telefon je PII —
// employees_sensitive_guard). Snima PATCH /employees/:id (hr_update_employee,
// optimistic lock) — rollback + poruka na stale/permission.
//
// TODO(P1a): server paginacija/pretraga — do tada fetch svih (pageSize 500).

function downloadVcf(text: string, fileName: string) {
  const blob = new Blob([text], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toVCardInput(e: EmployeeSafe) {
  return {
    firstName: sv(e, 'first_name'),
    lastName: sv(e, 'last_name'),
    fullName: sv(e, 'full_name'),
    position: sv(e, 'position'),
    phonePrivate: sv(e, 'phone_private'),
    phoneWork: sv(e, 'phone_work'),
    phone: sv(e, 'phone'),
    email: sv(e, 'email'),
  };
}

export function ImenikTab() {
  const { can } = useAuth();
  const canPiiEdit = can(PERMISSIONS.KADROVSKA_PII);

  const [q, setQ] = useState('');
  const [onlyWithPhone, setOnlyWithPhone] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Loop-all (BE klampuje pageSize na 200 → pageSize:500 bi tiho odsekao preko 200).
  const listQ = useAllEmployees(true);
  const all = useMemo(() => listQ.data ?? [], [listQ.data]);
  const updateMut = useUpdateEmployee();

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((e) => e.is_active)
      .filter((e) => {
        if (onlyWithPhone) {
          const has = normalizeSrPhone(sv(e, 'phone_private')) || normalizeSrPhone(sv(e, 'phone_work') || sv(e, 'phone'));
          if (!has) return false;
        }
        if (needle) {
          const name = empDisplayName(e).toLowerCase();
          const pos = sv(e, 'position').toLowerCase();
          if (!name.includes(needle) && !pos.includes(needle)) return false;
        }
        return true;
      })
      .sort(compareEmpByLastFirst);
  }, [all, q, onlyWithPhone]);

  async function savePhone(e: EmployeeSafe, field: 'phone_private' | 'phone', value: string): Promise<boolean> {
    const prev = (field === 'phone_private' ? sv(e, 'phone_private') : sv(e, 'phone_work') || sv(e, 'phone')).trim();
    if (value === prev) return true;
    try {
      await updateMut.mutateAsync({
        id: e.id,
        patch: { [field]: value },
        expectedUpdatedAt: sv(e, 'updated_at') || undefined,
      });
      setToast('✅ Telefon sačuvan');
      return true;
    } catch (err) {
      const raw = err instanceof ApiError ? `${err.message} ${JSON.stringify(err.body ?? '')}` : String(err);
      const low = raw.toLowerCase();
      if (low.includes('stale') || (err instanceof ApiError && err.status === 409)) {
        setToast('⚠ Podatak je u međuvremenu izmenjen — osveži modul, pa probaj ponovo');
      } else if (low.includes('sensitive') || low.includes('permission') || (err instanceof ApiError && err.status === 403)) {
        setToast('⚠ Nemate dozvolu za izmenu telefona (samo admin / poslovni admin).');
      } else {
        setToast('⚠ Čuvanje nije uspelo: ' + (err instanceof Error ? err.message : 'greška'));
      }
      return false;
    }
  }

  function exportAllVcf() {
    const list = rows.filter((e) => normalizeSrPhone(sv(e, 'phone_private')) || normalizeSrPhone(sv(e, 'phone_work') || sv(e, 'phone')));
    if (!list.length) {
      setToast('ℹ Nema kontakata sa telefonom za izvoz.');
      return;
    }
    downloadVcf(list.map((e) => employeeVCard(toVCardInput(e))).join('\r\n'), `Imenik_Servoteh_${list.length}.vcf`);
    setToast(`📇 Izvezeno ${list.length} ${kontaktRec(list.length)} (.vcf)`);
  }

  const actBtn = 'inline-flex h-7 w-7 items-center justify-center rounded-control border border-line bg-surface text-ink-secondary hover:bg-surface-2 hover:text-ink';

  const columns: Column<EmployeeSafe>[] = [
    {
      key: 'name',
      header: 'Zaposleni',
      render: (r) => {
        const nm = empDisplayName(r) || '—';
        return (
          <span className="flex items-center gap-2">
            <Avatar name={nm} />
            <span className="font-medium text-ink">{nm}</span>
          </span>
        );
      },
    },
    { key: 'position', header: 'Pozicija', render: (r) => r.position || '—' },
    { key: 'department', header: 'Odeljenje', render: (r) => sv(r, 'sub_department_name') || r.department || '—' },
    {
      key: 'mobile',
      header: 'Mobilni',
      render: (r) =>
        canPiiEdit ? (
          <PhoneEditCell emp={r} field="phone_private" value={sv(r, 'phone_private')} onSave={savePhone} />
        ) : (
          <span className="tnums whitespace-nowrap">{sv(r, 'phone_private') ? prettyPhone(sv(r, 'phone_private')) : '—'}</span>
        ),
    },
    {
      key: 'work',
      header: 'Poslovni',
      render: (r) =>
        canPiiEdit ? (
          <PhoneEditCell emp={r} field="phone" value={sv(r, 'phone_work') || sv(r, 'phone')} onSave={savePhone} />
        ) : (
          <span className="tnums whitespace-nowrap">
            {sv(r, 'phone_work') || sv(r, 'phone') ? prettyPhone(sv(r, 'phone_work') || sv(r, 'phone')) : '—'}
          </span>
        ),
    },
    {
      key: 'contact',
      header: 'Kontakt',
      align: 'right',
      render: (r) => {
        const mob = sv(r, 'phone_private').trim();
        const work = (sv(r, 'phone_work') || sv(r, 'phone')).trim();
        const primary = mob || work;
        if (!primary) return <span className="text-xs text-ink-disabled">nema broja</span>;
        const wa = isSrMobile(mob) ? waLink(mob) : isSrMobile(work) ? waLink(work) : '';
        const tel = telLink(primary);
        return (
          <span className="inline-flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {tel && (
              <a className={actBtn} href={tel} title={`Pozovi ${prettyPhone(primary)}`}>
                <Phone className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
            {wa && (
              <a className={actBtn} href={wa} target="_blank" rel="noopener noreferrer" title="WhatsApp">
                <MessageCircle className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
            <button
              className={actBtn}
              title="Preuzmi vCard (.vcf)"
              onClick={() => downloadVcf(employeeVCard(toVCardInput(r)), `${empDisplayName(r) || 'kontakt'}.vcf`)}
            >
              <Contact className="h-3.5 w-3.5" aria-hidden />
            </button>
            <button
              className={actBtn}
              title="Kopiraj broj"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(primary)
                  .then(() => setToast('📋 Broj kopiran'))
                  .catch(() => setToast('⚠ Kopiranje nije uspelo'));
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
            </button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga po imenu i prezimenu…" />
        <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={onlyWithPhone} onChange={(e) => setOnlyWithPhone(e.target.checked)} />
          samo sa telefonom
        </label>
        <span className="ml-auto text-sm text-ink-secondary">
          {rows.length} {kontaktRec(rows.length)}
        </span>
        <Button variant="ghost" onClick={exportAllVcf} title="Izvezi sve prikazane u jedan .vcf (uvoz u kontakte telefona)">
          📇 Izvezi sve (vCard)
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={listQ.isLoading}
        empty={<EmptyState title="Nema rezultata" hint={'Promeni pretragu ili isključi „samo sa telefonom".'} />}
      />

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-panel border border-line bg-surface px-4 py-2 text-sm text-ink shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/** Inline unos telefona (PII): Enter/blur = save; rollback na grešku. */
function PhoneEditCell({
  emp,
  field,
  value,
  onSave,
}: {
  emp: EmployeeSafe;
  field: 'phone_private' | 'phone';
  value: string;
  onSave: (e: EmployeeSafe, field: 'phone_private' | 'phone', value: string) => Promise<boolean>;
}) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);

  // Spoljna promena (refetch) osvežava lokalno stanje.
  useEffect(() => setV(value), [value]);

  async function commit() {
    const trimmed = v.trim();
    if (trimmed === value.trim()) return;
    setBusy(true);
    const ok = await onSave(emp, field, trimmed);
    setBusy(false);
    if (!ok) setV(value);
  }

  return (
    <input
      value={v}
      disabled={busy}
      inputMode="tel"
      autoComplete="off"
      placeholder="upiši broj…"
      title="Upiši i pritisni Enter ili klikni van polja za čuvanje"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="tnums h-7 w-[13ch] max-w-full rounded-control border border-line bg-surface-2 px-1.5 text-sm text-ink focus-visible:outline-none focus-visible:border-accent"
    />
  );
}
