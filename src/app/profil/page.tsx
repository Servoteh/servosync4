'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useProfileMe, useProfileSummary } from '@/api/moj-profil';
import { VacationSection } from './_components/vacation-section';
import { MakeupSection, PaidLeaveSection } from './_components/makeup-paidleave-section';
import { AttendanceSection } from './_components/attendance-section';
import { NonconformitySection } from './_components/nonconformity-section';
import {
  TalksSection,
  ExpectationsSection,
  PositionSection,
  CompanyValuesSection,
  ColleaguesSection,
  ReversiSection,
} from './_components/misc-sections';

/**
 * Moj profil (1.0 self-service) — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30 §0.2/§4).
 * Agregator nad tuđim domenima kroz GUC: GO/nadoknada/plaćeno/prisustvo/razgovori/očekivanja/
 * pozicija/vrednosti/kolege/zaduženja (reuse Reversi). Scope = email→employee (bez reda = prazan
 * profil). Vidljivost = profile.self (svaki prijavljen). Karnet PDF / Pravilnik GO / 360 puni
 * scoring i „Moj tim" menadžerske drill-down sekcije su naknadni R3 dodaci (v. izveštaj).
 */
export default function ProfilPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useProfileMe();
  const summaryQ = useProfileSummary();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const me = meQ.data?.data;
  const emp = me?.employee;
  const hasProfile = me?.hasProfile ?? false;
  const s = summaryQ.data?.data;

  return (
    <AppShell>
      <PageHeader title="Moj profil" />
      <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 overflow-auto p-6">
        {/* Header */}
        <div className="flex items-center gap-3 rounded-panel border border-line bg-surface p-4">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-accent-subtle text-lg font-semibold text-accent">
            {(emp?.full_name ?? user.email)[0]?.toUpperCase()}
          </div>
          <div>
            <div className="text-base font-semibold text-ink">{emp?.full_name ?? user.fullName ?? user.email}</div>
            <div className="text-sm text-ink-secondary">{user.email}</div>
          </div>
        </div>

        {!hasProfile && (
          <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg/40 p-4 text-sm text-ink">
            Nismo pronašli Vaš zaposlenički profil (email: {user.email}). Obratite se HR-u da proveri da li je Vaš email ispravno upisan u evidenciji zaposlenih.
          </div>
        )}

        {/* Presek (summary) */}
        {s && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Preostalo GO" value={s.vacationDaysRemaining ?? '—'} />
            <MiniStat label="Otvoreni GO zahtevi" value={s.openVacationRequests} />
            <MiniStat label="Sati (mesec)" value={s.monthPresenceHours.toFixed(0)} />
            <MiniStat label="Razgovori za potvrdu" value={s.unacknowledgedTalks} tone={s.unacknowledgedTalks > 0 ? 'warn' : undefined} />
          </div>
        )}

        {hasProfile && (
          <>
            <VacationSection />
            <MakeupSection />
            <PaidLeaveSection />
            <AttendanceSection />
            <TalksSection />
            <ExpectationsSection />
            <PositionSection />
            <ReversiSection />
            <ColleaguesSection />
          </>
        )}
        {/* Neusaglašenosti (K3) — scope po worker_id (server); prikaz i bez employee profila. */}
        <NonconformitySection />
        <CompanyValuesSection />
      </div>
    </AppShell>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="rounded-panel border border-line bg-surface px-3 py-2">
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className={tone === 'warn' ? 'text-lg font-semibold text-status-warn' : 'text-lg font-semibold text-ink'}>{value}</div>
    </div>
  );
}
