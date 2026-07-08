'use client';

import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

export type MessageTone = 'success' | 'danger' | 'info';

const TONE = {
  success: {
    wrap: 'border-status-success/40 bg-status-success-bg text-status-success',
    Icon: CheckCircle2,
  },
  danger: {
    wrap: 'border-status-danger/40 bg-status-danger-bg text-status-danger',
    Icon: XCircle,
  },
  info: {
    wrap: 'border-status-info/40 bg-status-info-bg text-status-info',
    Icon: Info,
  },
} as const;

/**
 * Velika poruka uspeh/greška/info — visok kontrast, velika slova (§9 poruke:
 * šta se desilo + šta radnik može da uradi). `aria-live` da čitač saopšti ishod.
 */
export function BigMessage({
  tone,
  title,
  detail,
}: {
  tone: MessageTone;
  title: string;
  detail?: string;
}) {
  const t = TONE[tone];
  const Icon = t.Icon;
  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn('flex items-start gap-4 rounded-panel border-2 px-6 py-5', t.wrap)}
    >
      <Icon className="h-11 w-11 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="text-2xl font-bold uppercase tracking-wide">{title}</p>
        {detail && <p className="mt-1 text-xl font-medium">{detail}</p>}
      </div>
    </div>
  );
}
