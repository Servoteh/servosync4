'use client';

import { useEffect, useState } from 'react';
import { Target, Eye, Gem } from 'lucide-react';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui-kit/button';
import { Markdown } from '@/lib/markdown';
import { formatDateTime } from '@/lib/format';
import { useCompanyProfile, useSaveCompanyProfile, type CompanyProfile } from '@/api/podesavanja';

// ============================================================================
// Vrednosti firme — WRITE (paritet 1.0 `podesavanja/companyProfileTab.js`).
// Jedinstven red company_profile (id=1) sa 3 markdown polja (Misija/Vizija/Vrednosti).
// 3 textarea levo + live markdown preview desno → „Snimi izmene" (PUT). Non-editorima
// je gating na page-nivou (settings.org_profile); ovde su polja readonly ako nedostaje
// mutacija (403 se hvata i vraća toast). Sadržaj vidi radnik u „Moj profil".
// ============================================================================

interface FieldDef {
  key: 'missionMd' | 'visionMd' | 'valuesMd';
  label: string;
  icon: typeof Target;
  placeholder: string;
}

const FIELDS: FieldDef[] = [
  { key: 'missionMd', label: 'Misija', icon: Target, placeholder: 'Šta je misija firme? Zašto postojimo?' },
  { key: 'visionMd', label: 'Vizija', icon: Eye, placeholder: 'Gde želimo da budemo za 3–5 godina?' },
  { key: 'valuesMd', label: 'Vrednosti', icon: Gem, placeholder: 'Naše vrednosti — npr. kvalitet, integritet, timski rad...' },
];

type FormState = Record<FieldDef['key'], string>;

function toForm(c: CompanyProfile | null | undefined): FormState {
  return {
    missionMd: c?.missionMd ?? '',
    visionMd: c?.visionMd ?? '',
    valuesMd: c?.valuesMd ?? '',
  };
}

export function CompanyProfileTab() {
  const q = useCompanyProfile();
  const saveM = useSaveCompanyProfile();
  const server = q.data?.data ?? null;

  const [form, setForm] = useState<FormState>(() => toForm(server));
  const [dirty, setDirty] = useState(false);

  // Poravnaj lokalnu formu kad stigne/osveži se serverska vrednost (osim ako je korisnik menjao).
  useEffect(() => {
    if (!dirty) setForm(toForm(server));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const setField = (key: FieldDef['key'], val: string) => {
    setDirty(true);
    setForm((p) => ({ ...p, [key]: val }));
  };

  async function save() {
    try {
      await saveM.mutateAsync({
        missionMd: form.missionMd.trim() || null,
        visionMd: form.visionMd.trim() || null,
        valuesMd: form.valuesMd.trim() || null,
      });
      setDirty(false);
      toast('✅ Vrednosti firme snimljene');
    } catch (e) {
      const forbidden = e instanceof ApiError && e.status === 403;
      toast(forbidden ? '⚠ Nemate dozvolu (admin/menadžment/pm/lpm)' : '⚠ Snimanje nije uspelo — pokušajte ponovo');
    }
  }

  if (q.isLoading) return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-ink-secondary">
          Sadržaj se prikazuje radnicima u <strong className="text-ink">Moj profil → Vrednosti firme</strong>. Podržan je jednostavan markdown.
        </p>
        <Button onClick={save} loading={saveM.isPending} disabled={!dirty}>
          Snimi izmene
        </Button>
      </div>

      <div className="space-y-6">
        {FIELDS.map((f) => {
          const Icon = f.icon;
          const val = form[f.key];
          return (
            <div key={f.key}>
              <div className="mb-1.5 flex items-center gap-2">
                <Icon className="h-4 w-4 text-ink-secondary" aria-hidden />
                <label htmlFor={`cp-${f.key}`} className="text-sm font-semibold text-ink">
                  {f.label}
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <textarea
                  id={`cp-${f.key}`}
                  value={val}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="min-h-[140px] w-full resize-y rounded-control border border-line bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none"
                />
                <div className="min-h-[140px] overflow-y-auto rounded-control border border-line bg-surface px-3 py-2 text-sm">
                  {val.trim() ? (
                    <Markdown source={val} className="text-sm leading-relaxed text-ink-secondary" />
                  ) : (
                    <span className="text-ink-disabled">(prazno)</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {server?.updatedAt && (
        <p className="text-xs text-ink-disabled">
          Poslednja izmena: {formatDateTime(server.updatedAt)}
          {server.updatedBy && <> · {server.updatedBy}</>}
        </p>
      )}
    </div>
  );
}
