'use client';

/**
 * Mobilni „Moji sati" (/mob/sati) — PLAN_MOB_3.0 Faza 2, talas A (self-service klaster).
 * TANAK omotač nad `GET /v1/profile/hours` (`useProfileHours`) + primedba za mesec
 * (`useSaveHoursRemark` / `useDeleteHoursRemark`). BE radi CEO agregat (dnevni redovi,
 * praznici, karnet totali, prikazni chips, moja primedba) — ovde nema nijedne nove
 * poslovne odluke, samo mobilna prezentacija (kartice/lista umesto desktop tabele).
 * Semantika (chips, šifre odsustva, status primedbe, „prazan tekst = brisanje") je
 * preslikana sa `app/profil/_components/monthly-hours-section.tsx`.
 *
 * Gate: svaki prijavljen korisnik (`profile.self` ima svaka rola; scope presuđuje BE
 * kroz GUC — bez zaposleničkog reda vraća `data:null`). Static export: čista statička
 * ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDecimal } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  newClientEventId,
  useProfileHours,
  useSaveHoursRemark,
  useDeleteHoursRemark,
  type ProfileHoursDay,
} from '@/api/moj-profil';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Redovni-red šifra odsustva → labela (paritet desktop GRID_CODE_LABEL / 1.0 grid). */
const GRID_CODE_LABEL: Record<string, string> = {
  go: 'Godišnji',
  bo: 'Bolovanje',
  sp: 'Službeni put',
  np: 'Neopravdano',
  sl: 'Slobodan dan',
  sv: 'Krsna slava',
  pl: 'Plaćeno',
  pr: 'Praznik',
  nop: 'Neplaćeno',
};

const MONTH_NAMES = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
];
/** Latinična skraćenica dana (getDay index) — BE `letter` je ćirilično slovo za karnet. */
const DAY_ABBR = ['ned', 'pon', 'uto', 'sre', 'čet', 'pet', 'sub'];

/** Sati sa decimalnim zarezom (DS §5): 7.5 → „7,5". */
function h(n: number | null | undefined): string {
  return formatDecimal(Number(n || 0), 2);
}
function dowOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}
function currentYm(): { year: number; month: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export default function MobSatiPage() {
  const { user, isLoading, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const init = currentYm();
  const [year, setYear] = useState(init.year);
  const [month, setMonth] = useState(init.month);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  const q = useProfileHours(monthKey);
  const data = q.data?.data ?? null;
  const days = useMemo(() => data?.days ?? [], [data]);
  const chips = data?.chips ?? null;
  const remark = data?.remark ?? null;
  const holidaySet = useMemo(() => new Set(data?.holidays ?? []), [data]);

  const saveM = useSaveHoursRemark();
  const deleteM = useDeleteHoursRemark();
  const busy = saveM.isPending || deleteM.isPending;

  // Kontrolisano polje primedbe — sinhronizuj tekst kad se učita nov mesec/remark.
  const [note, setNote] = useState('');
  useEffect(() => {
    setNote(remark?.text ?? '');
  }, [remark, monthKey]);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne stigne
  // (isti obrazac kao ostali /mob ekrani — jedan prikaz „Učitavanje…", bez treperenja).
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

  // Paritet desktopa (1.0 index.js:912): mesec se prikazuje i kad postoje SAMO
  // prekovremeni/terenski/2-mašine sati (bez redovnih i bez odsustva).
  const hasHours = days.some(
    (d) =>
      Number(d.hours) > 0 ||
      Number(d.overtimeHours) > 0 ||
      Number(d.fieldHours) > 0 ||
      Number(d.twoMachineHours) > 0 ||
      d.absenceCode,
  );

  function shiftMonth(delta: number) {
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; } else if (m > 12) { m = 1; y += 1; }
    setYear(y);
    setMonth(m);
  }

  async function saveRemark() {
    const text = note.trim();
    if (!text) {
      // Prazan tekst + postojeća primedba = brisanje (paritet 1.0 / desktopa).
      if (remark) return deleteRemark();
      toast('Unesi tekst primedbe.');
      return;
    }
    try {
      await saveM.mutateAsync({ clientEventId: newClientEventId(), year, month, text });
      toast('Primedba sačuvana — HR će je videti.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Greška pri čuvanju primedbe.');
    }
  }

  async function deleteRemark() {
    try {
      await deleteM.mutateAsync({ year, month });
      setNote('');
      toast('Primedba obrisana.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Greška pri brisanju primedbe.');
    }
  }

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Moji sati</h1>
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
        {/* Izbor meseca — pune touch mete (44 px) sa obe strane naziva. */}
        <div className="flex items-center justify-between gap-2 rounded-panel border border-line bg-surface px-2 py-2">
          <button
            onClick={() => shiftMonth(-1)}
            aria-label="Prethodni mesec"
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-secondary active:bg-surface-2 ${FOCUS}`}
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
          <span className="text-md font-semibold text-ink">
            {MONTH_NAMES[month - 1]} {year}.
          </span>
          <button
            onClick={() => shiftMonth(1)}
            aria-label="Sledeći mesec"
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-secondary active:bg-surface-2 ${FOCUS}`}
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : q.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Greška pri učitavanju sati. Proveri vezu pa osveži stranicu.
          </p>
        ) : !data ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Tvoj zaposlenički profil nije pronađen — obrati se HR-u.
          </p>
        ) : (
          <>
            {/* Zbirevi po kategorijama (BE agregat) */}
            {chips && (
              <div className="flex flex-wrap gap-2">
                <Chip label="Radnih sati" value={h(chips.radnihSati)} />
                <Chip label="Σ prisustva" value={`${h(chips.prisustvoSati)} h`} />
                {chips.godisnjiDani > 0 && <Chip label="Godišnji" value={`${chips.godisnjiDani} d`} />}
                {chips.spDani > 0 && <Chip label="Službeni put" value={`${chips.spDani} d`} />}
                {chips.bolovanjeDani > 0 && <Chip label="Bolovanje" value={`${chips.bolovanjeDani} d`} />}
                {chips.slobodniDani > 0 && <Chip label="Slob./slava/plać." value={`${chips.slobodniDani} d`} />}
                {chips.prekovremeniH > 0 && <Chip label="Prekovremeni" value={`${h(chips.prekovremeniH)} h`} />}
                {chips.terenH > 0 && <Chip label="Teren" value={`${h(chips.terenH)} h`} />}
              </div>
            )}

            {/* Dani meseca — mobilna lista (praznici/vikendi prigušeni) */}
            {hasHours ? (
              <ul className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
                {days.map((d) => (
                  <DayRow key={d.ymd} d={d} month={month} holiday={holidaySet.has(d.ymd)} />
                ))}
              </ul>
            ) : (
              <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
                Nema unetih sati za {MONTH_NAMES[month - 1]} {year}.
              </p>
            )}

            {/* Primedba za mesec */}
            <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-ink">
                  Primedba za mesec ({MONTH_NAMES[month - 1]})
                </h2>
                {remark && (
                  <StatusBadge
                    tone={remark.status === 'resolved' ? 'success' : 'danger'}
                    label={
                      remark.status === 'resolved'
                        ? `Rešeno${remark.resolvedBy ? ` · ${remark.resolvedBy}` : ''}`
                        : 'Poslato HR-u'
                    }
                  />
                )}
              </div>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={500}
                // text-md = 16 px: ispod toga iOS Safari zumira stranicu na fokus polja.
                className="text-md"
                placeholder="Ako nešto u satima nije tačno za ovaj mesec, napiši ovde — HR će videti."
              />
              <div className="flex gap-2">
                <Button onClick={saveRemark} loading={busy} className="h-11 flex-1">
                  Pošalji primedbu
                </Button>
                {remark && (
                  <Button variant="secondary" onClick={deleteRemark} loading={busy} className="h-11">
                    Obriši
                  </Button>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink">
      {label}: <b className="tnums">{value}</b>
    </span>
  );
}

function DayRow({ d, month, holiday }: { d: ProfileHoursDay; month: number; holiday: boolean }) {
  const dow = dowOf(d.ymd);
  const weekend = dow === 0 || dow === 6;
  const dim = weekend || holiday;
  const code = d.absenceCode;
  const hours = Number(d.hours || 0);
  const ot = Number(d.overtimeHours || 0);
  const fh = Number(d.fieldHours || 0);

  let main: ReactNode;
  if (code) {
    main = (
      <span className="rounded-control bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary">
        {GRID_CODE_LABEL[code] || code}
        {d.absenceSubtype ? ` · ${d.absenceSubtype}` : ''}
      </span>
    );
  } else if (hours > 0) {
    main = <span className="tnums text-sm font-medium text-ink">{h(hours)} h</span>;
  } else {
    main = <span className="text-sm text-ink-disabled">—</span>;
  }

  return (
    <li className={`flex items-center gap-3 px-4 py-2.5 ${dim ? 'bg-surface-2/50' : ''}`}>
      <span className={`tnums w-20 shrink-0 text-sm ${dim ? 'text-ink-secondary' : 'text-ink'}`}>
        {String(d.day).padStart(2, '0')}.{String(month).padStart(2, '0')}.{' '}
        <span className="text-ink-secondary">{DAY_ABBR[dow]}</span>
      </span>
      <span className="min-w-0 flex-1">{main}</span>
      <span className="tnums shrink-0 text-right text-xs text-ink-secondary">
        {ot > 0 && <span className="block">prekov. {h(ot)} h</span>}
        {fh > 0 && <span className="block">teren {h(fh)} h</span>}
        {holiday && !code && <span className="block">praznik</span>}
      </span>
    </li>
  );
}
