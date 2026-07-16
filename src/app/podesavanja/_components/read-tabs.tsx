'use client';

import { useState } from 'react';
import { Markdown } from '@/lib/markdown';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  useOrgStructure,
  useCompanyProfile,
  useAdminExpectations,
  useCompetenceFramework,
  useAuditLog,
} from '@/api/podesavanja';

/** Napomena: BE (R1) izlaže SAMO čitanje ovih ekrana; unos/izmena su R2 (dvostrani/RPC put). */
function ReadOnlyNote() {
  return <p className="mb-3 text-xs text-ink-disabled">Prikaz je informativan (uređivanje stiže u sledećoj fazi — dotad kroz 1.0 Podešavanja).</p>;
}

// ------------------------------------------------------------------ Organizacija (struktura)

export function OrganizacijaTab() {
  const q = useOrgStructure();
  const s = q.data?.data;
  if (!s) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  return (
    <div>
      <ReadOnlyNote />
      <div className="space-y-3">
        {s.departments.map((d) => {
          const subs = s.subDepartments.filter((sd) => sd.departmentId === d.id);
          const directPos = s.jobPositions.filter((p) => p.departmentId === d.id && !p.subDepartmentId);
          return (
            <div key={d.id} className="rounded-panel border border-line bg-surface p-3">
              <div className="font-semibold text-ink">{d.name}</div>
              <div className="mt-1 space-y-1 pl-3">
                {subs.map((sd) => (
                  <div key={sd.id}>
                    <div className="text-sm text-ink">▸ {sd.name}</div>
                    <div className="flex flex-wrap gap-1 pl-4">
                      {s.jobPositions
                        .filter((p) => p.subDepartmentId === sd.id)
                        .map((p) => (
                          <PositionChip key={p.id} name={p.name} filled={!!p.summaryMd} />
                        ))}
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap gap-1">
                  {directPos.map((p) => (
                    <PositionChip key={p.id} name={p.name} filled={!!p.summaryMd} />
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function PositionChip({ name, filled }: { name: string; filled: boolean }) {
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary" title={filled ? 'Opis unet' : 'Opis nije unet'}>
      {filled ? '✓ ' : ''}
      {name}
    </span>
  );
}

// ------------------------------------------------------------------ Vrednosti firme

export function VrednostiTab() {
  const q = useCompanyProfile();
  const c = q.data?.data;
  return (
    <div>
      <ReadOnlyNote />
      {!c ? (
        <EmptyState title="Nema unetih vrednosti" />
      ) : (
        <div className="space-y-3">
          <MdBlock title="Misija" md={c.missionMd} />
          <MdBlock title="Vizija" md={c.visionMd} />
          <MdBlock title="Vrednosti" md={c.valuesMd} />
          {c.updatedBy && <p className="text-xs text-ink-disabled">Poslednja izmena: {c.updatedBy} · {formatDate(c.updatedAt)}</p>}
        </div>
      )}
    </div>
  );
}
function MdBlock({ title, md }: { title: string; md: string | null }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-ink">{title}</h3>
      {md ? <Markdown source={md} className="text-sm text-ink-secondary" /> : <p className="text-sm text-ink-disabled">—</p>}
    </div>
  );
}

// ------------------------------------------------------------------ Očekivanja zaposlenih

export function OcekivanjaTab() {
  const q = useAdminExpectations();
  const rows = q.data?.data ?? [];
  return (
    <div>
      <ReadOnlyNote />
      {rows.length === 0 ? (
        <EmptyState title="Nema definisanih očekivanja" />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-secondary">
              <th className="py-1.5">Naslov</th>
              <th className="py-1.5">Rok</th>
              <th className="py-1.5">Prioritet</th>
              <th className="py-1.5">Status</th>
              <th className="py-1.5">Definisao</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-line-soft">
                <td className="py-1.5 text-ink">{e.title}</td>
                <td className="py-1.5 tnums text-ink-secondary">{e.dueDate ? formatDate(e.dueDate) : '—'}</td>
                <td className="py-1.5 text-ink-secondary">{e.priority}</td>
                <td className="py-1.5 text-ink-secondary">{e.status}</td>
                <td className="py-1.5 text-ink-secondary">{e.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Okvir kompetencija

export function KompetencijeTab() {
  const q = useCompetenceFramework();
  const f = q.data?.data;
  if (!f) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  const str = (o: Record<string, unknown>, k: string) => (o[k] == null ? '' : String(o[k]));
  const numv = (o: Record<string, unknown>, k: string) => Number(o[k]);
  return (
    <div>
      <ReadOnlyNote />
      <div className="mb-3 flex flex-wrap gap-2 text-xs text-ink-secondary">
        <span className="rounded bg-surface-2 px-2 py-1">{f.profiles.length} profila</span>
        <span className="rounded bg-surface-2 px-2 py-1">{f.groups.length} grupa</span>
        <span className="rounded bg-surface-2 px-2 py-1">{f.competences.length} kompetencija</span>
        <span className="rounded bg-surface-2 px-2 py-1">{f.levels.length} opisa nivoa</span>
      </div>
      <div className="space-y-2">
        {f.groups.map((g) => {
          const gid = numv(g, 'id');
          const comps = f.competences.filter((c) => numv(c, 'group_id') === gid);
          return (
            <div key={gid} className="rounded-panel border border-line bg-surface p-3">
              <div className="font-semibold text-ink">{str(g, 'name_sr') || str(g, 'code')}</div>
              <ul className="mt-1 space-y-0.5 pl-3">
                {comps.map((c) => (
                  <li key={numv(c, 'id')} className="text-sm text-ink-secondary">
                    • {str(c, 'name_sr')}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Podešavanje predmeta (WRITE) preseljen u `predmet-aktivacija-tab.tsx` — vidi `PredmetAktivacijaTab`.

// ------------------------------------------------------------------ Audit log

const AUDIT_ACTION_TONE: Record<string, Tone> = { INSERT: 'success', UPDATE: 'info', DELETE: 'danger' };

export function AuditTab() {
  const [page, setPage] = useState(1);
  const q = useAuditLog({ page, pageSize: 100 });
  const rows = q.data?.data ?? [];
  const meta = q.data?.meta?.pagination;
  return (
    <div>
      {rows.length === 0 ? (
        <EmptyState title="Nema zapisa u audit logu" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                  <th className="px-3 py-2">Vreme</th>
                  <th className="px-3 py-2">Tabela</th>
                  <th className="px-3 py-2">Akcija</th>
                  <th className="px-3 py-2">Zapis</th>
                  <th className="px-3 py-2">Polja</th>
                  <th className="px-3 py-2">Ko</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-line-soft">
                    <td className="px-3 py-1.5 tnums text-ink-secondary">{r.changed_at ? formatDateTime(r.changed_at) : '—'}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{r.table_name}</td>
                    <td className="px-3 py-1.5">
                      {r.action && <StatusBadge tone={AUDIT_ACTION_TONE[r.action] ?? 'neutral'} label={r.action} />}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink-secondary">{(r.record_id ?? '').toString().slice(0, 40)}</td>
                    <td className="px-3 py-1.5 text-xs text-ink-secondary">{(r.diff_keys ?? r.changed_fields ?? []).slice(0, 6).join(', ')}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{r.actor_email ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {meta && meta.totalPages > 1 && (
            <div className="mt-3">
              <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => Math.max(1, p - 1))} onNext={() => setPage((p) => p + 1)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
// Sistem tab (AI modeli, WRITE) živi u `system-tab.tsx` — vidi `SistemTab`.
