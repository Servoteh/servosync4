'use client';

import { useMemo, useState } from 'react';
import { KeyRound, Pencil, Trash2, Ban, Check } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { formatDate } from '@/lib/format';
import {
  useUsers,
  useRolesCatalog,
  useOrgStructure,
  useInviteUser,
  useUpdateUser,
  useResetPassword,
  useDeactivateUser,
  useActivateUser,
  useSoftDeleteUser,
  type UserRoleRow,
  type UserRbacFields,
} from '@/api/podesavanja';

function roleLabel(catalog: { key: string; label: string }[] | undefined, key: string): string {
  return catalog?.find((r) => r.key === key)?.label ?? key;
}

export function KorisniciTab() {
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const usersQ = useUsers({ q: q || undefined, role: role || undefined, isActive: active || undefined });
  const rolesQ = useRolesCatalog();
  const [modal, setModal] = useState<{ mode: 'invite' | 'edit'; user?: UserRoleRow } | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserRoleRow | null>(null);
  const [resetUser, setResetUser] = useState<UserRoleRow | null>(null);

  const rows = usersQ.data?.data ?? [];
  const catalog = rolesQ.data?.data;

  const stats = useMemo(() => {
    const total = rows.length;
    const activeCount = rows.filter((r) => r.is_active).length;
    const byRole = new Map<string, number>();
    for (const r of rows) byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
    return { total, activeCount, byRole: [...byRole.entries()].sort((a, b) => b[1] - a[1]) };
  }, [rows]);

  const deactivateM = useDeactivateUser();
  const activateM = useActivateUser();

  const selCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

  return (
    <div className="space-y-4">
      {/* Stat kartice */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        <StatCard label="Ukupno" value={stats.total} accent />
        <StatCard label="Aktivni" value={stats.activeCount} />
        {stats.byRole.slice(0, 4).map(([r, n]) => (
          <StatCard key={r} label={roleLabel(catalog, r)} value={n} />
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Ime, email, tim…" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className={selCls} aria-label="Uloga">
          <option value="">Sve uloge</option>
          {(catalog ?? []).map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={active} onChange={(e) => setActive(e.target.value as '' | 'true' | 'false')} className={selCls} aria-label="Status">
          <option value="">Svi statusi</option>
          <option value="true">Aktivni</option>
          <option value="false">Neaktivni</option>
        </select>
        <div className="ml-auto">
          <Button onClick={() => setModal({ mode: 'invite' })}>Pozovi korisnika</Button>
        </div>
      </div>
      <p className="text-xs text-ink-disabled">
        Pozivnica kreira nalog + ulogu i piše u 2.0 i sy15 (paralelni rad). Menadžment: pododeljenja u formi = Kadrovska scope.
      </p>

      {usersQ.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema korisnika" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="px-3 py-2">Ime i prezime</th>
                <th className="px-3 py-2">Email</th>
                <th className="px-3 py-2">Uloga</th>
                <th className="px-3 py-2">Tim</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-line-soft hover:bg-surface-2">
                  <td className="px-3 py-2">
                    <span className="font-medium text-ink">{u.full_name || '—'}</span>
                    {u.must_change_password && <span className="ml-1 rounded bg-status-warn-bg px-1 text-2xs text-status-warn">lozinka</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-secondary">{u.email}</td>
                  <td className="px-3 py-2">
                    <span className="text-ink">{roleLabel(catalog, u.role)}</span>
                    <RightsChips u={u} />
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">{u.team || '—'}</td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={u.is_active ? 'success' : 'neutral'} label={u.is_active ? 'Aktivan' : 'Neaktivan'} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <IconBtn title="Izmeni" onClick={() => setModal({ mode: 'edit', user: u })}>
                        <Pencil className="h-3.5 w-3.5" />
                      </IconBtn>
                      <IconBtn title="Resetuj lozinku" onClick={() => setResetUser(u)}>
                        <KeyRound className="h-3.5 w-3.5" />
                      </IconBtn>
                      {u.is_active ? (
                        <IconBtn title="Deaktiviraj" onClick={() => confirm(`Deaktivirati ${u.email}?`) && deactivateM.mutate({ id: u.id })}>
                          <Ban className="h-3.5 w-3.5" />
                        </IconBtn>
                      ) : (
                        <IconBtn title="Aktiviraj" onClick={() => activateM.mutate({ id: u.id })}>
                          <Check className="h-3.5 w-3.5" />
                        </IconBtn>
                      )}
                      <IconBtn title="Obriši (soft)" danger onClick={() => setDeleteUser(u)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && <UserModal mode={modal.mode} user={modal.user} allUsers={rows} onClose={() => setModal(null)} />}
      {deleteUser && <DeleteModal user={deleteUser} onClose={() => setDeleteUser(null)} />}
      {resetUser && <ResetModal user={resetUser} onClose={() => setResetUser(null)} />}
    </div>
  );
}

function RightsChips({ u }: { u: UserRoleRow }) {
  const chips: string[] = [];
  const scopeLen = u.managed_sub_department_ids?.length ?? 0;
  if (scopeLen) chips.push(`scope ${scopeLen}`);
  if (u.kadrovska_access) chips.push('+Kadr');
  if (u.kadrovska_hide_contracts) chips.push('−Ugovori');
  if (u.plan_montaze_readonly) chips.push('PM čitanje');
  if (!chips.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1">
      {chips.map((c) => (
        <span key={c} className="rounded bg-surface-2 px-1 text-2xs text-ink-secondary">
          {c}
        </span>
      ))}
    </span>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`rounded-panel border px-3 py-2 ${accent ? 'border-accent/40 bg-accent-subtle' : 'border-line bg-surface'}`}>
      <div className="text-lg font-semibold text-ink">{value}</div>
      <div className="truncate text-xs text-ink-secondary">{label}</div>
    </div>
  );
}
function IconBtn({ title, onClick, children, danger }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className={`rounded p-1 text-ink-secondary hover:bg-surface-2 ${danger ? 'hover:text-status-danger' : ''}`}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Invite/Edit modal

function UserModal({ mode, user, allUsers, onClose }: { mode: 'invite' | 'edit'; user?: UserRoleRow; allUsers: UserRoleRow[]; onClose: () => void }) {
  const rolesQ = useRolesCatalog();
  const orgQ = useOrgStructure();
  const inviteM = useInviteUser();
  const updateM = useUpdateUser();

  const [email, setEmail] = useState(user?.email ?? '');
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [team, setTeam] = useState(user?.team ?? '');
  const [role, setRole] = useState(user?.role ?? 'viewer');
  const [password, setPassword] = useState('');
  const [subDepts, setSubDepts] = useState<number[]>(user?.managed_sub_department_ids ?? []);
  const [kadrovskaAccess, setKadr] = useState(!!user?.kadrovska_access);
  const [kadrovskaHideContracts, setHideC] = useState(!!user?.kadrovska_hide_contracts);
  const [planMontazeReadonly, setPlanRO] = useState(!!user?.plan_montaze_readonly);
  const [isActive, setIsActive] = useState(user?.is_active ?? true);
  const [mustChange, setMustChange] = useState(!!user?.must_change_password);
  const [copyFrom, setCopyFrom] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function applyCopy(fromId: string) {
    setCopyFrom(fromId);
    const src = allUsers.find((u) => u.id === fromId);
    if (!src) return;
    setRole(src.role);
    setSubDepts(src.managed_sub_department_ids ?? []);
    setKadr(!!src.kadrovska_access);
    setHideC(!!src.kadrovska_hide_contracts);
    setPlanRO(!!src.plan_montaze_readonly);
  }

  async function save() {
    setErr(null);
    const fields: UserRbacFields = {
      fullName: fullName || undefined,
      team: team || undefined,
      managedSubDepartmentIds: subDepts,
      kadrovskaAccess,
      kadrovskaHideContracts,
      planMontazeReadonly,
    };
    try {
      if (mode === 'invite') {
        if (!email.trim()) return setErr('Email je obavezan.');
        const res = await inviteM.mutateAsync({ email: email.trim(), role, password: password || undefined, ...fields });
        const d = res.data;
        setResult(
          `Nalog kreiran (${d.email}).${d.sy15Synced === false ? ' ⚠ sy15 sinhronizacija nije uspela — ponovi.' : ''}`,
        );
      } else if (user) {
        const res = await updateM.mutateAsync({ id: user.id, role, isActive, mustChangePassword: mustChange, ...fields });
        if (res.data.sy15Synced === false) {
          setResult('Sačuvano u 2.0, ali sy15 sinhronizacija nije uspela — ponovi.');
        } else {
          onClose();
        }
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Čuvanje nije uspelo.');
    }
  }

  const subDepartments = orgQ.data?.data?.subDepartments ?? [];
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-base text-ink';
  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>
        {result ? 'Zatvori' : 'Otkaži'}
      </Button>
      {!result && (
        <Button onClick={save} loading={inviteM.isPending || updateM.isPending}>
          {mode === 'invite' ? 'Pošalji pozivnicu' : 'Snimi'}
        </Button>
      )}
    </>
  );

  return (
    <Dialog open onClose={onClose} title={mode === 'invite' ? 'Pozovi korisnika' : 'Izmeni korisnika'} footer={footer}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
        {result && <p className="rounded-control bg-status-success-bg px-2 py-1 text-sm text-status-success">{result}</p>}
        <FormField label="Email" required>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} disabled={mode === 'edit'} placeholder="ime@servoteh.com" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Puno ime">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </FormField>
          <FormField label="Tim">
            <Input value={team} onChange={(e) => setTeam(e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Uloga">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={selCls}>
              {(rolesQ.data?.data ?? []).map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </FormField>
          {mode === 'invite' ? (
            <FormField label="Lozinka (opciono)" hint="Prazno = auto-generisana">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="auto-generisana" />
            </FormField>
          ) : (
            <FormField label="Nalog">
              <div className="flex h-9 items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Aktivan
                </label>
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} /> Mora promeniti lozinku
                </label>
              </div>
            </FormField>
          )}
        </div>

        <FormField label="Kopiranje prava" hint="Popuni formu po drugom korisniku (ne snima)">
          <select value={copyFrom} onChange={(e) => applyCopy(e.target.value)} className={selCls}>
            <option value="">— izaberi korisnika kao šablon —</option>
            {allUsers.filter((u) => u.id !== user?.id).map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.email} — {u.email} ({u.role})
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Pododeljenja (scope rukovodioca)" hint="Prazno = bez scope-a; za menadžment prazno = pun obim">
          <select
            multiple
            size={5}
            value={subDepts.map(String)}
            onChange={(e) => setSubDepts(Array.from(e.target.selectedOptions, (o) => Number(o.value)))}
            className="w-full rounded-control border border-line bg-surface px-2 py-1 text-sm text-ink"
          >
            {subDepartments.map((sd) => (
              <option key={sd.id} value={sd.id}>
                {sd.name}
              </option>
            ))}
          </select>
        </FormField>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-ink-secondary">Dodatne dozvole (per-korisnik)</div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={kadrovskaAccess} onChange={(e) => setKadr(e.target.checked)} /> Pristup Kadrovskoj
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={kadrovskaHideContracts} onChange={(e) => setHideC(e.target.checked)} /> Sakrij ugovore u Kadrovskoj
          </label>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={planMontazeReadonly} onChange={(e) => setPlanRO(e.target.checked)} /> Plan montaže samo-za-čitanje
          </label>
        </div>
      </div>
    </Dialog>
  );
}

function ResetModal({ user, onClose }: { user: UserRoleRow; onClose: () => void }) {
  const resetM = useResetPassword();
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      const res = await resetM.mutateAsync({ id: user.id });
      setResult(`Lozinka resetovana za ${res.data.email}. Korisnik dobija mejl i mora je promeniti.`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reset nije uspeo.');
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Reset lozinke"
      footer={
        result ? (
          <Button onClick={onClose}>Zatvori</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={go} loading={resetM.isPending}>
              Resetuj
            </Button>
          </>
        )
      }
    >
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      {result ? (
        <p className="text-sm text-status-success">{result}</p>
      ) : (
        <p className="text-sm text-ink">Generisati novu privremenu lozinku za {user.email}? Korisnik dobija mejl sa novom lozinkom.</p>
      )}
    </Dialog>
  );
}

function DeleteModal({ user, onClose }: { user: UserRoleRow; onClose: () => void }) {
  const delM = useSoftDeleteUser();
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      await delM.mutateAsync({ id: user.id, confirmEmail: confirm.trim() });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Brisanje nije uspelo.');
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Brisanje korisnika (soft)"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="danger" onClick={go} loading={delM.isPending} disabled={confirm.trim().toLowerCase() !== user.email.toLowerCase()}>
            Obriši
          </Button>
        </>
      }
    >
      {err && <p className="mb-2 rounded-control bg-status-danger-bg px-2 py-1 text-sm text-status-danger">{err}</p>}
      <p className="mb-2 text-sm text-ink">
        Soft brisanje (deaktivacija) reda za <b>{user.email}</b>. Za potvrdu ukucaj tačan email:
      </p>
      <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={user.email} />
    </Dialog>
  );
}
