'use client';

// „Komande" (audit) tab — poslednjih 40 komandi (read; GET /energetika/commands, R1).
// Status menja ISKLJUČIVO bridge (allowlist + opsezi + rate-limit). Paritet 1.0
// renderCommandsTab: vreme/sistem/target/vrednost/ko/status/ishod.

import { useRecentCommands } from '@/api/energetika';
import { cmdStatusLabel, fmtWhen, siteName, type ScadaSite } from '@/lib/scada';
import { StatusBadge } from '@/components/ui-kit/status-badge';

export function CommandsAudit({
  active,
  sites,
}: {
  active: boolean;
  sites: ScadaSite[] | undefined;
}) {
  const q = useRecentCommands(40, active);
  const rows = q.data ?? [];

  return (
    <section className="space-y-3">
      <p className="text-sm text-ink-secondary">
        Svaka komanda se trajno beleži: ko, kada, šta i ishod. Status menja isključivo
        bridge (allowlist + opsezi + rate-limit).
      </p>
      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-ink-secondary">
              <th className="px-3 py-2 font-medium">Vreme</th>
              <th className="px-3 py-2 font-medium">Sistem</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Vrednost</th>
              <th className="px-3 py-2 font-medium">Poslao</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Ishod</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-secondary">
                  Učitavanje…
                </td>
              </tr>
            ) : q.isError ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-status-danger">
                  Greška pri učitavanju komandi.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-ink-secondary">
                  Još nema komandi.
                </td>
              </tr>
            ) : (
              rows.map((c) => {
                const st = cmdStatusLabel(c.status);
                const ishod = c.result?.error
                  ? c.result.error
                  : c.status === 'applied'
                    ? 'OK'
                    : '';
                return (
                  <tr key={c.id} className="border-b border-line-soft last:border-0">
                    <td className="tabular-nums whitespace-nowrap px-3 py-2 text-ink">
                      {fmtWhen(c.requestedAt)}
                    </td>
                    <td className="px-3 py-2 text-ink">{siteName(c.siteKey, sites)}</td>
                    <td className="px-3 py-2">
                      <code className="text-xs text-ink">{c.target}</code>
                    </td>
                    <td className="px-3 py-2">
                      <code className="text-xs text-ink-secondary">
                        {c.value ? JSON.stringify(c.value) : '—'}
                      </code>
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">{c.requestedBy}</td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={st.tone} label={st.label} />
                    </td>
                    <td className="px-3 py-2 text-ink-secondary">{ishod}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
