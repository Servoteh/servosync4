'use client';

import { usePermissionsMatrix, useRolesCatalog } from '@/api/podesavanja';

/**
 * Uloge i dozvole — ŽIV prikaz kataloga (ROLE_PERMISSIONS + roles.ts), zamena 1.0 statičke
 * erpRbacMatrix (§2.3.6/D8). Jedan izvor istine: backend `/admin/permissions/matrix`.
 */
export function UlogeTab() {
  const matrixQ = usePermissionsMatrix();
  const catalogQ = useRolesCatalog();
  const matrix = matrixQ.data?.data;
  const catalog = catalogQ.data?.data ?? [];
  const noteByKey = new Map(catalog.map((r) => [r.key, r]));

  if (matrixQ.isLoading) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  if (!matrix) return <p className="text-sm text-status-danger">Katalog nije dostupan.</p>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Živ prikaz permisija po ulozi ({matrix.permissions.length} ključeva, {matrix.roles.length} uloga). Izvor: backend katalog — ne prepisuje se ručno.
      </p>
      <div className="space-y-2">
        {matrix.roles.map((r) => {
          const meta = noteByKey.get(r.role);
          return (
            <div key={r.role} className="rounded-panel border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{r.label}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-ink-secondary">{r.role}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">tier {r.tier}</span>
                <span className="ml-auto text-xs text-ink-disabled">{r.permissions.length} dozvola</span>
              </div>
              {meta?.note && <p className="mt-1 text-xs text-ink-secondary">{meta.note}</p>}
              <div className="mt-2 flex flex-wrap gap-1">
                {r.permissions.length === 0 ? (
                  <span className="text-xs text-ink-disabled">— nema dodeljenih permisija —</span>
                ) : (
                  r.permissions.map((p) => (
                    <span key={p} className="rounded bg-accent-subtle px-1.5 py-0.5 font-mono text-2xs text-ink">
                      {p}
                    </span>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
