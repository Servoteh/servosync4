'use client';

import { useEffect } from 'react';
import { ChevronRight, Flame, KeyRound, Palette } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { useProfileMe, useProfileSummary } from '@/api/moj-profil';
import { VacationSection } from './_components/vacation-section';
import { MonthlyHoursSection } from './_components/monthly-hours-section';
import { MakeupSection, PaidLeaveSection } from './_components/makeup-paidleave-section';
import { AttendanceSection } from './_components/attendance-section';
import { NonconformitySection } from './_components/nonconformity-section';
import {
  TalksSection,
  PositionSection,
  CompanyValuesSection,
  ColleaguesSection,
  ReversiSection,
} from './_components/misc-sections';
import { ExpectationsSection } from './_components/expectations-section';
import { DevelopmentSection } from './_components/development-section';
import { DocumentsSection } from './_components/documents-section';
import { AssessmentSection } from './_components/assessment-section';
import { OnboardingSection } from './_components/onboarding-section';
import { AbsencesSection } from './_components/absences-section';
import { DocumentsDeadlinesSection } from './_components/documents-deadlines-section';
import { TeamSection } from './_components/team-section';

/** 'MMDD' → 'DD.MM.' (paritet 1.0 `_formatSlavaDay`). */
function formatSlavaDay(mmdd: string | null | undefined): string {
  if (!mmdd || mmdd.length !== 4) return mmdd ?? '';
  return `${mmdd.slice(2)}.${mmdd.slice(0, 2)}.`;
}
/** dd.MM.yyyy. (za header „Zaposlen od"; lokalno da ne uvozimo lib u presek imena). */
function fmtYmd(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

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
        <div className="flex flex-wrap items-center gap-3 rounded-panel border border-line bg-surface p-4">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-accent-subtle text-lg font-semibold text-accent">
            {((emp?.full_name ?? user.email) ?? '')[0]?.toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-ink">{emp?.full_name ?? user.fullName ?? user.email}</div>
            <div className="text-sm text-ink-secondary">{user.email}</div>
            {emp?.slava && (
              <div className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
                <Flame className="h-3.5 w-3.5" aria-hidden />
                <span>
                  Slava: <strong className="text-ink">{emp.slava}</strong>
                  {emp.slavaDay && <span className="opacity-70"> ({formatSlavaDay(emp.slavaDay)})</span>}
                </span>
              </div>
            )}
          </div>
          {emp?.hireDate && (
            <div className="text-right text-xs text-ink-secondary">
              Zaposlen/a od
              <br />
              <strong className="text-ink">{fmtYmd(emp.hireDate)}</strong>
            </div>
          )}
        </div>

        {/* Izgled aplikacije (tema + raspored menija) — lične UI preference. Ulaz je OVDE
            jer „Podešavanja" u nav-u traži SETTINGS_ORG_PROFILE (nevidljivo operaterima/
            tehnolozima), a Izgled tab je za svakog prijavljenog (PROFILE_SELF). Deep-link
            na tačan tab (SIDEBAR_THEME_SPEC §5). */}
        <Link
          href="/podesavanja?tab=izgled"
          className="flex items-center gap-2.5 rounded-panel border border-line bg-surface px-4 py-3 text-sm text-ink transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <Palette className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
          <span className="min-w-0 flex-1">Izgled aplikacije — tema i raspored menija</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
        </Link>

        {/* Promena lozinke (B2) — nalog akcija za svakog prijavljenog; vodi na vanredni tok /promena-lozinke. */}
        <Link
          href="/promena-lozinke"
          className="flex items-center gap-2.5 rounded-panel border border-line bg-surface px-4 py-3 text-sm text-ink transition-colors hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <KeyRound className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
          <span className="min-w-0 flex-1">Promeni lozinku</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
        </Link>

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
            <MiniStat label="Sati (mesec)" value={Number(s.monthPresenceHours ?? 0).toFixed(0)} />
            <MiniStat label="Razgovori za potvrdu" value={s.unacknowledgedTalks} tone={s.unacknowledgedTalks > 0 ? 'warn' : undefined} />
          </div>
        )}

        {hasProfile && (
          <>
            <OnboardingSection />
            <VacationSection />
            <MonthlyHoursSection employeeName={emp?.full_name ?? user.fullName ?? user.email} />
            <MakeupSection />
            <PaidLeaveSection />
            <AttendanceSection />
            <AbsencesSection />
            <TalksSection />
            <ExpectationsSection />
            <DevelopmentSection />
            <AssessmentSection />
            <PositionSection />
            <DocumentsDeadlinesSection />
            <DocumentsSection />
            <ReversiSection />
            <ColleaguesSection />
            {/* Moj tim (P5) — vidljivo samo upravljačima sa opsegom (kartica se sama sakrije). */}
            <TeamSection />
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
