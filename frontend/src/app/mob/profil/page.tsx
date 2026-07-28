'use client';

/**
 * Mobilni „Moj profil" (/mob/profil) — PLAN_MOB_3.0 Faza 2, talas B
 * (paritet 1.0 mobilnog `/m/profil` = myProfile, SAŽETA verzija). TANAK omotač nad
 * postojećim `profile` hook-ovima (`/v1/profile/*`) — nula nove poslovne logike:
 * PDF opisa pozicije koristi isti generator kao desktop
 * (`app/profil/_components/documents-section.tsx`), a „Kolege na odsustvu" preslikava
 * `misc-sections.tsx › ColleaguesSection`.
 *
 * Namerno SAŽETO: mobilni profil je RASKRSNICA (brzi linkovi na GO/sate/prisustvo)
 * + ono što se čita, a ne uređuje. Teške desktop sekcije (razgovori, samoprocena,
 * plan razvoja, očekivanja, dokumenta/saglasnosti) ostaju na desktopu.
 *
 * Gate: svaki prijavljen korisnik (`profile.self` ima svaka rola; BE kroz GUC
 * presuđuje red — bez zaposleničkog reda vraća `data:null`). „Moj tim" je iza
 * `profile.team` i renderuje se kao ZASEBNA komponenta da se `useTeam()` uopšte
 * ne ispali korisniku bez tog prava (403 bez retry-ja = šum u konzoli).
 *
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  UserCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Button } from '@/components/ui-kit/button';
import { Markdown } from '@/lib/markdown';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { generateJobPositionPdf, downloadBlob } from '@/lib/hr-pdf';
import {
  useColleaguesOnLeave,
  usePosition,
  useProfileMe,
  useProfileSummary,
  useTeam,
} from '@/api/moj-profil';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Labele tipova odsustva — isti rečnik kao desktop ColleaguesSection. */
const ABS_TYPE_LABELS: Record<string, string> = {
  godisnji: 'Godišnji odmor',
  bolovanje: 'Bolovanje',
  sluzbeno: 'Službeni put',
  slava: 'Krsna slava',
  placeno: 'Plaćeno odsustvo',
  neplaceno: 'Neplaćeno odsustvo',
  slobodan: 'Slobodan dan',
  ostalo: 'Ostalo',
};

export default function MobProfilPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const meQ = useProfileMe();
  const summaryQ = useProfileSummary();
  const positionQ = usePosition();
  const colleaguesQ = useColleaguesOnLeave();

  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  const employee = meQ.data?.data.employee ?? null;
  const summary = summaryQ.data?.data ?? null;
  const position = positionQ.data?.data ?? null;
  const colleagues = colleaguesQ.data?.data ?? [];
  const fullName = employee?.full_name || user.fullName || user.email;
  const goLeft = summary?.vacationDaysRemaining;

  /** Opis radnog mesta u PDF — isti generator kao desktop „Opis pozicije (PDF)".
   *  SAMO preuzimanje (`downloadBlob`): `openBlob` otvara novi tab, a APK WebView
   *  ga blokira (isti razlog kao rešenje o GO na /mob/odsustva). */
  async function onPositionPdf() {
    if (!position) {
      toast('Tvoja pozicija nije povezana sa opisom posla — obrati se HR-u.');
      return;
    }
    setPdfBusy(true);
    try {
      const { blob, fileName } = await generateJobPositionPdf(
        position,
        fullName ? { fullName } : null,
      );
      downloadBlob(blob, fileName);
      toast('Opis pozicije preuzet.');
    } catch (e) {
      toast(e instanceof Error ? `PDF nije uspeo: ${e.message}` : 'PDF nije uspeo.');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Moj profil</h1>
          <p className="truncate text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
        </div>
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-4 p-4">
        {/* ── 1. Zaglavlje: ime · pozicija · email ── */}
        <section className="rounded-panel border border-line bg-surface p-4">
          <h2 className="text-lg font-semibold text-ink">{fullName}</h2>
          {position?.name && <p className="text-sm text-ink-secondary">{position.name}</p>}
          <p className="truncate text-sm text-ink-secondary">{user.email}</p>
          {employee?.hireDate && (
            <p className="tnums mt-1 text-xs text-ink-disabled">
              U firmi od {formatDate(employee.hireDate)}
            </p>
          )}
          {meQ.data && !employee && (
            <p className="mt-2 text-sm text-ink-secondary">
              Tvoj zaposlenički profil nije pronađen — obrati se HR-u.
            </p>
          )}
        </section>

        {/* ── 2. Brzi linkovi (raskrsnica ka self-service ekranima) ── */}
        <section className="space-y-2">
          <QuickLink
            href="/mob/odsustva"
            icon={CalendarDays}
            label="Odsustva / GO"
            hint={
              goLeft != null
                ? `GO saldo: ${goLeft} dana`
                : 'saldo, zahtev za godišnji, rešenje'
            }
          />
          <QuickLink
            href="/mob/sati"
            icon={Clock}
            label="Moji sati"
            hint={
              summary
                ? `Ovaj mesec: ${summary.monthPresenceHours} h prisustva`
                : 'mesečni sati + primedba HR-u'
            }
          />
          <QuickLink
            href="/mob/moje-prisustvo"
            icon={UserCheck}
            label="Moje prisustvo"
            hint="moji prolazi + prijava korekcije"
          />
        </section>

        {/* ── 3. Opis pozicije ── */}
        <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Opis pozicije</h2>
          {positionQ.isLoading ? (
            <p className="text-sm text-ink-secondary">Učitavanje…</p>
          ) : !position ? (
            <p className="text-sm text-ink-secondary">
              Tvoja pozicija nije povezana sa opisom posla — obrati se HR-u.
            </p>
          ) : (
            <>
              <p className="text-base font-medium text-ink">{position.name}</p>
              {position.reportsToLine && (
                <p className="text-sm text-ink-secondary">
                  Linijski odgovara: {position.reportsToLine}
                </p>
              )}
              {position.summaryMd ? (
                <Markdown source={position.summaryMd} className="text-sm text-ink-secondary" />
              ) : (
                <p className="text-sm text-ink-disabled">
                  Svrha radnog mesta nije upisana — ceo opis je u PDF-u.
                </p>
              )}
              <Button
                variant="secondary"
                className="h-11 w-full"
                loading={pdfBusy}
                onClick={() => void onPositionPdf()}
              >
                <FileText className="h-4 w-4" aria-hidden /> Ceo opis (PDF)
              </Button>
            </>
          )}
        </section>

        {/* ── 4. Kolege na odsustvu ── */}
        <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Kolege na odsustvu</h2>
          {colleaguesQ.isLoading ? (
            <p className="text-sm text-ink-secondary">Učitavanje…</p>
          ) : colleagues.length === 0 ? (
            <p className="text-sm text-ink-disabled">Niko trenutno nije na odsustvu.</p>
          ) : (
            <ul className="space-y-2">
              {colleagues.map((c, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full bg-status-warn" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-ink">
                      {c.full_name}
                      {c.department && <span className="text-ink-secondary"> · {c.department}</span>}
                    </span>
                    <span className="tnums block text-xs text-ink-secondary">
                      {ABS_TYPE_LABELS[c.type] || c.type} · {formatDate(c.date_from)} →{' '}
                      {formatDate(c.date_to)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 5. Moj tim (samo `profile.team`) ── */}
        {can(PERMISSIONS.PROFILE_TEAM) && <TeamSection />}
      </main>
    </div>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
  hint,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-14 items-center gap-3 rounded-panel border border-line bg-surface p-4 active:bg-surface-2 ${FOCUS}`}
    >
      <Icon className="h-6 w-6 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink">{label}</span>
        <span className="block text-xs text-ink-secondary">{hint}</span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-ink-disabled" aria-hidden />
    </Link>
  );
}

/**
 * „Moj tim" — roster u opsegu (BE `GET /v1/profile/team`, prazno/403 = nema opsega).
 * Zasebna komponenta jer se montira SAMO uz `profile.team` (hook nema `enabled`).
 *
 * SVESNO PLITKO u ovoj fazi: samo ime + pozicija (+ oznaka „na odsustvu"). Drill po
 * članu (alat/karnet/GO saldo/korekcija — desktop `profil/_components/team-section.tsx`,
 * 731 ln) dolazi kasnije; ne portovati ga bez posebne odluke.
 */
function TeamSection() {
  const teamQ = useTeam();
  const members = teamQ.data?.data?.members ?? [];
  if (teamQ.isError || (!teamQ.isLoading && members.length === 0)) return null;

  return (
    <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Users className="h-4 w-4 text-ink-secondary" aria-hidden /> Moj tim
      </h2>
      {teamQ.isLoading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{m.fullName ?? '—'}</span>
                <span className="block truncate text-xs text-ink-secondary">
                  {m.position || m.subDepartmentName || m.department || '—'}
                </span>
              </span>
              {m.currentAbsence && (
                <span className="shrink-0 rounded-full bg-status-warn-bg px-2 py-0.5 text-2xs font-medium text-status-warn">
                  {ABS_TYPE_LABELS[String(m.currentAbsence.type)] || 'odsutan'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
