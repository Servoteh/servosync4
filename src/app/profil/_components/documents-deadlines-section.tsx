'use client';

import { formatDate } from '@/lib/format';
import { useProfileMe, type ProfileEmployee } from '@/api/moj-profil';
import { Section } from './section';

/**
 * 📄 Dokumenti i rokovi — paritet 1.0 `_myDocsStatusHtml` (mojProfil/index.js).
 * Read-only kartice: Lekarski pregled + Ugovor sa badge-om isteka. Zaposleni proveri
 * svoj status pre nego što ide kod HR-a. Podaci iz proširenog `/me` (employee).
 */

type DocTone = 'danger' | 'warn' | 'accent' | 'ok' | 'muted';

/** Badge isteka po datumu (paritet 1.0 `_docStatusBadge`). */
function expiryBadge(ymd: string | null | undefined): { label: string; tone: DocTone } {
  if (!ymd) return { label: '—', tone: 'muted' };
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { label: '—', tone: 'muted' };
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (diff < 0) return { label: 'Istekao', tone: 'danger' };
  if (diff === 0) return { label: 'Ističe danas', tone: 'warn' };
  if (diff <= 30) return { label: `Ističe za ${diff} d`, tone: 'warn' };
  if (diff <= 90) return { label: `Ističe za ${diff} d`, tone: 'accent' };
  return { label: `Važi do ${formatDate(ymd)}`, tone: 'ok' };
}

const TONE_CLASS: Record<DocTone, { border: string; badge: string }> = {
  danger: { border: 'border-status-danger/40', badge: 'bg-status-danger-bg text-status-danger' },
  warn: { border: 'border-status-warn/40', badge: 'bg-status-warn-bg text-status-warn' },
  accent: { border: 'border-accent/40', badge: 'bg-accent-subtle text-accent' },
  ok: { border: 'border-status-success/40', badge: 'bg-status-success-bg text-status-success' },
  muted: { border: 'border-line', badge: 'bg-surface-2 text-ink-secondary' },
};

function DocCard({
  icon,
  title,
  meta,
  badge,
}: {
  icon: string;
  title: string;
  meta: string;
  badge: { label: string; tone: DocTone } | null;
}) {
  const cls = TONE_CLASS[badge?.tone ?? 'muted'];
  return (
    <div className={`flex items-start gap-3 rounded-control border ${cls.border} bg-surface-2 p-3`}>
      <div className="text-xl" aria-hidden>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-ink">{title}</div>
        <div className="text-xs text-ink-secondary">{meta}</div>
        {badge && (
          <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-2xs font-medium ${cls.badge}`}>
            {badge.label}
          </span>
        )}
      </div>
    </div>
  );
}

export function DocumentsDeadlinesSection() {
  const meQ = useProfileMe();
  const emp: ProfileEmployee | null | undefined = meQ.data?.data?.employee;
  if (!emp) return null;

  const hasMedical = !!(emp.medicalExamExpires || emp.medicalExamDate);
  const c = emp.contract;
  const hasContract = !!(c && (c.dateFrom || c.dateTo || c.type));
  if (!hasMedical && !hasContract) return null;

  return (
    <Section icon="📄" title="Dokumenti i rokovi">
      <div className="grid gap-3 sm:grid-cols-2">
        {hasMedical && (
          <DocCard
            icon="🩺"
            title="Lekarski pregled"
            meta={emp.medicalExamDate ? `Obavljen: ${formatDate(emp.medicalExamDate)}` : 'Nema upisa'}
            badge={emp.medicalExamExpires ? expiryBadge(emp.medicalExamExpires) : null}
          />
        )}
        {hasContract && c && (
          <DocCard
            icon="📄"
            title={`Ugovor${c.type ? ` — ${c.type}` : ''}`}
            meta={
              c.dateTo
                ? `Važi: ${c.dateFrom ? formatDate(c.dateFrom) : '—'} → ${formatDate(c.dateTo)}`
                : `Važi od: ${c.dateFrom ? formatDate(c.dateFrom) : '—'}`
            }
            badge={c.dateTo ? expiryBadge(c.dateTo) : { label: 'Neodređeno', tone: 'ok' }}
          />
        )}
      </div>
    </Section>
  );
}
