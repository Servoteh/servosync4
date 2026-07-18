'use client';

// Moja očekivanja (P3) — self-write. Paritet 1.0 `src/ui/mojProfil/index.js`
// (~2358-2485 _myExpectationsCardHtml / _expectationRowHtml / _onExpectationAction)
// + `services/orgProfile.js` (markMyExpectationStatus). Prikazuje SAMO samostalna
// očekivanja (bez plan_id) — plan-vezani ciljevi su u „Moj plan razvoja". Radnik sam
// pomera status na „u toku" ili „ispunjeno" (uz opcionu napomenu).

import { useState } from 'react';
import { Target, Zap, Play, Check, AlertTriangle, Calendar, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import { useExpectations, useUpdateMyExpectation, type Expectation } from '@/api/moj-profil';
import { Section } from './section';

const STATUS_LABEL: Record<string, string> = {
  aktivno: 'Aktivno',
  u_toku: 'U toku',
  ispunjeno: 'Ispunjeno',
  otkazano: 'Otkazano',
};
const STATUS_TONE: Record<string, Tone> = {
  aktivno: 'neutral',
  u_toku: 'warn',
  ispunjeno: 'success',
  otkazano: 'danger',
};
const PRIO_LABEL: Record<string, string> = { niska: 'Niska', srednja: 'Srednja', visoka: 'Visoka' };

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

export function ExpectationsSection() {
  const q = useExpectations();
  const all = q.data?.data ?? [];
  // Samostalna očekivanja (bez razvojnog plana). Plan-vezani ciljevi se prikazuju u planu.
  const standalone = all.filter((e) => !e.planId);

  // Sort: aktivno/u_toku prvo (po roku), pa završeni.
  const active = standalone
    .filter((e) => e.status === 'aktivno' || e.status === 'u_toku')
    .sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  const done = standalone
    .filter((e) => e.status === 'ispunjeno' || e.status === 'otkazano')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const rows = [...active, ...done];

  return (
    <Section icon={<Target className="h-4 w-4 text-ink-secondary" />} title="Moja očekivanja">
      {rows.length === 0 ? (
        <p className="text-sm text-ink-disabled">Nema definisanih očekivanja.</p>
      ) : (
        <>
          <p className="mb-3 text-sm text-ink-secondary">
            Konkretna očekivanja koja je definisao Vaš nadređeni. Možete sami da označite ono što ste počeli (u toku) ili završili (ispunjeno).
          </p>
          <ul className="space-y-2">
            {rows.map((e) => (
              <ExpectationRow key={e.id} exp={e} />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function ExpectationRow({ exp }: { exp: Expectation }) {
  const upd = useUpdateMyExpectation();
  const isActive = exp.status === 'aktivno';
  const isDone = exp.status === 'ispunjeno' || exp.status === 'otkazano';
  const overdue = !isDone && isOverdue(exp.dueDate);
  const border = overdue ? 'border-l-status-danger' : isDone ? 'border-l-status-success' : 'border-l-accent';

  async function mark(status: 'u_toku' | 'ispunjeno') {
    let completionNote: string | undefined;
    if (status === 'ispunjeno') {
      const input = window.prompt('Napomena uz ispunjenje (opciono):', '');
      if (input === null) return; // odustao
      completionNote = input.trim() || undefined;
    }
    try {
      await upd.mutateAsync({ id: exp.id, status, completionNote });
      toast(status === 'ispunjeno' ? 'Označeno kao ispunjeno' : 'Označeno kao u toku');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Greška pri snimanju');
    }
  }

  return (
    <li className={`rounded-control border border-line-soft border-l-4 ${border} bg-surface-2 p-3`}>
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-ink">{exp.title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {exp.priority && exp.priority !== 'srednja' && (
            <span className="inline-flex items-center gap-1 text-xs text-ink-secondary"><Zap className="h-3.5 w-3.5" aria-hidden /> {PRIO_LABEL[exp.priority] || exp.priority}</span>
          )}
          <StatusBadge tone={STATUS_TONE[exp.status] || 'neutral'} label={STATUS_LABEL[exp.status] || exp.status} />
        </div>
      </div>
      {exp.descriptionMd && <Markdown source={exp.descriptionMd} className="mt-1 text-sm text-ink-secondary" />}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-ink-disabled">
          <span className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-status-danger' : ''}`}>
            {overdue ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : <Calendar className="h-3.5 w-3.5" aria-hidden />}
            {exp.dueDate ? `${overdue ? 'Probijen rok: ' : 'Rok: '}${formatDate(exp.dueDate)}` : 'Bez roka'}
          </span>
          {exp.createdBy && <span> · Definisao: {exp.createdBy}</span>}
        </div>
        {!isDone && (
          <div className="flex gap-2">
            {isActive && (
              <Button variant="secondary" className="h-7 text-xs" onClick={() => mark('u_toku')} loading={upd.isPending}>
                <Play className="h-3.5 w-3.5" aria-hidden /> Označi kao u toku
              </Button>
            )}
            <Button className="h-7 text-xs" onClick={() => mark('ispunjeno')} loading={upd.isPending}>
              <Check className="h-3.5 w-3.5" aria-hidden /> Označi kao ispunjeno
            </Button>
          </div>
        )}
      </div>
      {isDone && exp.completionNote && (
        <div className="mt-1.5 flex items-start gap-1 text-xs italic text-ink-secondary">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{exp.completionNote}</span>
        </div>
      )}
    </li>
  );
}
