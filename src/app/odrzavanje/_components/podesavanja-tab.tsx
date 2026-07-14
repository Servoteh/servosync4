'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Input, FormField } from '@/components/ui-kit/form-field';
import {
  useNotificationRules,
  useSettings,
  useUpdateNotificationRule,
  useUpdateSettings,
  type MaintSettings,
} from '@/api/odrzavanje';

/** Podešavanja (maint_settings singleton) + notif pravila. admin_ui prikaz. */
export function PodesavanjaTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const rules = useNotificationRules();
  const updateRule = useUpdateNotificationRule();
  const [draft, setDraft] = useState<Partial<MaintSettings>>({});

  const s = settings.data?.data;
  useEffect(() => { if (s) setDraft(s); }, [s]);

  const bools: [keyof MaintSettings, string][] = [
    ['autoCreateWoMajor', 'Auto-nalog za ozbiljne kvarove'],
    ['autoCreateWoCritical', 'Auto-nalog za kritične kvarove'],
    ['safetyMarkerRequiresWo', 'Bezbednosni rizik zahteva nalog'],
    ['notificationEnabled', 'Notifikacije uključene'],
    ['notifyOnMajorIncident', 'Obavesti na ozbiljan kvar'],
    ['notifyOnCriticalIncident', 'Obavesti na kritičan kvar'],
    ['notifyOnOverduePreventive', 'Obavesti na zakasnelu preventivu'],
  ];
  const nums: [keyof MaintSettings, string][] = [
    ['majorWoDueHours', 'Rok naloga za ozbiljne (h)'],
    ['criticalWoDueHours', 'Rok naloga za kritične (h)'],
    ['preventiveDueWarningDays', 'Upozorenje na preventivu (dana)'],
  ];

  return (
    <div className="space-y-6">
      <section className="rounded-panel border border-line bg-surface p-4">
        <h2 className="mb-3 text-md font-semibold text-ink">Opšta podešavanja</h2>
        {settings.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : !s ? (
          <p className="text-sm text-ink-secondary">Podešavanja nisu dostupna.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {bools.map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={Boolean(draft[key])} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} />
                  {label}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {nums.map(([key, label]) => (
                <FormField key={key} label={label}>
                  <Input value={String(draft[key] ?? '')} onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))} inputMode="numeric" />
                </FormField>
              ))}
            </div>
            <div className="flex justify-end">
              <Button
                loading={update.isPending}
                onClick={() =>
                  update.mutate({
                    patch: {
                      autoCreateWoMajor: draft.autoCreateWoMajor,
                      autoCreateWoCritical: draft.autoCreateWoCritical,
                      safetyMarkerRequiresWo: draft.safetyMarkerRequiresWo,
                      notificationEnabled: draft.notificationEnabled,
                      notifyOnMajorIncident: draft.notifyOnMajorIncident,
                      notifyOnCriticalIncident: draft.notifyOnCriticalIncident,
                      notifyOnOverduePreventive: draft.notifyOnOverduePreventive,
                      majorWoDueHours: draft.majorWoDueHours,
                      criticalWoDueHours: draft.criticalWoDueHours,
                      preventiveDueWarningDays: draft.preventiveDueWarningDays,
                    },
                  })
                }
              >
                Sačuvaj podešavanja
              </Button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Notifikaciona pravila</h2>
        {rules.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : (rules.data?.data ?? []).length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema definisanih pravila.</p>
        ) : (
          <div className="space-y-1">
            {(rules.data?.data ?? []).map((r) => (
              <div key={r.ruleId} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
                <span className="text-ink">
                  {r.eventType} <span className="text-ink-secondary">· {r.channel}{r.targetRole ? ` → ${r.targetRole}` : ''}</span>
                </span>
                <div className="flex items-center gap-2">
                  <StatusBadge tone={r.enabled ? 'success' : 'neutral'} label={r.enabled ? 'Aktivno' : 'Isključeno'} />
                  <Button variant="ghost" disabled={updateRule.isPending} onClick={() => updateRule.mutate({ id: r.ruleId, patch: { enabled: !r.enabled } })}>
                    {r.enabled ? 'Isključi' : 'Uključi'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
