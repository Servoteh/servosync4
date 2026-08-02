'use client';

/**
 * Mobilna „Kadrovska" (/mob/kadrovska) — PLAN_MOB_3.0 Faza 2, talas B
 * (paritet 1.0 mobilnog `/m/kadrovska` = myKadrovska). READ-ONLY pregled: lista
 * zaposlenih sa pretragom i čipovima → karton na ISTOJ ruti kroz `?id=<uuid>`.
 * TANAK omotač nad `GET /v1/kadrovska/{employees,employees/:id,contracts,absences}`.
 *
 * Gate: `kadrovska.read` (KANON vidljivosti modula, paritet 1.0 canAccessKadrovska) —
 * isti gate nosi i hub kartica.
 *
 * ⚠️ BEZ PII: karton prikazuje samo `v_employees_safe` polja koja 1.0 pokazuje svima
 * sa `kadrovska.read` (ime/pozicija/odeljenje/tim/službeni telefon/email/status).
 * JMBG, adresa, banka, privatni telefon i ZARADE se ovde NE prikazuju (view ih
 * maskira po pozivaocu, a mi ih ni ne čitamo — drugi sloj).
 *
 * ⚠️ Ugovori su iza STROŽIJEG prava: `GET /contracts` traži `kadrovska.contracts_read`
 * (ne `kadrovska.read`). Zato se i sekcija „Aktivan ugovor" i čip „Ugovor ističe"
 * prikazuju samo uz to pravo — inače bi svaki zahtev vratio 403.
 *
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams` — detalj se
 * čita iz `window.location.search` (isti obrazac kao `/mob/sastanci?open=`).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import {
  useAbsences,
  useAbsentNow,
  useContracts,
  useEmployee,
  useEmployeesList,
} from '@/api/kadrovska';
import { absTypeFullLabel } from '@/app/kadrovska/_components/odsustva/shared';
import { CON_TYPE_LABELS } from '@/app/kadrovska/_components/ugovori/shared';
import { MobPermissionsError, MobRefreshButton } from '../_components/mob-refresh';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** „Uskoro ističe" prozor u danima — isti prag kao ostali čipovi modula
 *  (BE `med-soon` = 30 dana; ugovorni ekvivalent BE filter NEMA, računa se ovde). */
const EXPIRY_DAYS = 30;

/** BE klampuje `pageSize` na 200; aktivnih zaposlenih je ~157 → jedna strana.
 *  Ako firma preraste 200, prikazuje se traka „suzi pretragu" (bez tihe krnje liste). */
const PAGE_SIZE = 200;

type Chip = 'svi' | 'ugovor' | 'odsutni';

/** Snake_case kolona `v_employees_safe` reda → prikazni string. */
function sv(row: Record<string, unknown> | null | undefined, key: string): string {
  const v = row?.[key];
  return v == null ? '' : String(v);
}

function ymdPlus(days: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function MobKadrovskaPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/mob/prijava');
  }, [user, isLoading, router]);

  // Deep-link `?id=<uuid>` (SSO prečica iz 1.0 / bookmark) — čita se JEDNOM iz
  // `window.location.search`, ne kroz `useSearchParams` (static export bi tražio
  // Suspense granicu). Isti obrazac kao `/mob/sastanci?open=`.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get('id');
    if (id) setOpenId(id);
  }, []);

  /** URL prati stanje (refresh/deljenje linka pogađa isti karton), ali BEZ Next
   *  navigacije — `history.replaceState` ne remeti statički export ni back stek. */
  function open(id: string | null) {
    setOpenId(id);
    if (typeof window !== 'undefined') {
      const url = id ? `/mob/kadrovska?id=${encodeURIComponent(id)}` : '/mob/kadrovska';
      window.history.replaceState(null, '', url);
    }
  }

  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return <MobPermissionsError />;
  }
  if (!can(PERMISSIONS.KADROVSKA_READ)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Kadrovska evidencija nije dostupna tvojoj ulozi (potrebno `kadrovska.read`).
      </main>
    );
  }

  return openId ? (
    <EmployeeCard id={openId} onBack={() => open(null)} />
  ) : (
    <EmployeeList userLabel={user.fullName ?? user.email} onOpen={open} />
  );
}

// ────────────────────────────────────────────────────────────────── lista

function EmployeeList({
  userLabel,
  onOpen,
}: {
  userLabel: string;
  onOpen: (id: string) => void;
}) {
  const { can } = useAuth();
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canAttendance = can(PERMISSIONS.KADROVSKA_ATTENDANCE);

  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [chip, setChip] = useState<Chip>('svi');

  // Debounce kucanja (300 ms) — pretraga je server-side, telefon ne treba da šalje
  // zahtev po slovu (isti razlog kao debounce u Realizaciji).
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const listQ = useEmployeesList({
    q: dq || undefined,
    active: true,
    pageSize: PAGE_SIZE,
  });
  const rows = useMemo(() => listQ.data?.data ?? [], [listQ.data]);
  const total = listQ.data?.meta.pagination.total ?? 0;

  // „Trenutno odsutni" — BE nema quick-filter za to, ali ima `GET /absences/absent-now`
  // (isti `kadrovska.read`). Skup id-jeva služi i za bedž na redu, i za čip.
  // ⚠️ AUDIT-K5b: roster sada vraća DVA izvora — `absences` periode I dane iz
  // GRIDA (1.0 odsutniTab spaja oba; sa samo jednim lista je bila skoro prazna,
  // pa je bedž „odsutan" praktično nikad nije palio). Skup id-jeva je unija.
  const absentQ = useAbsentNow();
  const absentIds = useMemo(() => {
    const d = absentQ.data?.data;
    const ids = new Set<string>();
    for (const a of d?.absences ?? []) ids.add(a.employeeId);
    for (const g of d?.grid ?? []) ids.add(g.employee_id);
    return ids;
  }, [absentQ.data]);

  // „Ugovor ističe" — takođe bez BE filtera; računa se iz aktivnih ugovora
  // (samo uz `contracts_read`, inače endpoint vraća 403). Učitava se tek kad je čip
  // izabran, da običan pregled ne povlači sve ugovore firme.
  const contractsQ = useContracts({ status: 'active' }, canContracts && chip === 'ugovor');
  const expiringIds = useMemo(() => {
    const from = ymdPlus(0);
    const to = ymdPlus(EXPIRY_DAYS);
    const out = new Set<string>();
    for (const c of contractsQ.data?.data ?? []) {
      const end = c.dateTo ? String(c.dateTo).slice(0, 10) : null;
      if (end && end >= from && end <= to) out.add(c.employeeId);
    }
    return out;
  }, [contractsQ.data]);

  const shown = useMemo(() => {
    if (chip === 'odsutni') return rows.filter((e) => absentIds.has(e.id));
    if (chip === 'ugovor') return rows.filter((e) => expiringIds.has(e.id));
    return rows;
  }, [rows, chip, absentIds, expiringIds]);

  const chips: { key: Chip; label: string }[] = [
    { key: 'svi', label: 'Svi' },
    ...(canContracts
      ? [{ key: 'ugovor' as Chip, label: `Ugovor ističe <${EXPIRY_DAYS}d` }]
      : []),
    { key: 'odsutni', label: 'Odsutni' },
  ];

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Kadrovska</h1>
          <p className="truncate text-xs text-ink-secondary">{userLabel}</p>
        </div>
        {/* Osvežavanje bez reload-a: pull-to-refresh je pod `/mob` ugašen,
            a instalirana PWA nema adresnu traku (v. `_components/mob-refresh.tsx`). */}
        <MobRefreshButton />
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-3 p-4">
        {/* Pretraga (server-side: ime/pozicija/email/telefon/odeljenje/tim) */}
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled"
            aria-hidden
          />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            // text-md = 16 px: ispod toga iOS Safari zumira stranicu na fokus polja.
            className="h-11 pl-9 text-md"
            placeholder="Ime, pozicija, odeljenje…"
            aria-label="Pretraga zaposlenih"
          />
        </div>

        {/* Čipovi */}
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setChip(c.key)}
              aria-pressed={chip === c.key}
              className={`h-11 rounded-full border px-4 text-sm ${
                chip === c.key
                  ? 'border-accent bg-accent-subtle text-accent'
                  : 'border-line bg-surface text-ink-secondary active:bg-surface-2'
              } ${FOCUS}`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {canAttendance && (
          <Link
            href="/mob/prisustvo"
            className={`flex min-h-11 items-center gap-2 rounded-panel border border-line bg-surface px-4 py-2.5 text-sm text-ink active:bg-surface-2 ${FOCUS}`}
          >
            <Users className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span className="flex-1">Prisustvo uživo</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
          </Link>
        )}

        {listQ.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : listQ.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Lista nije učitana. Proveri vezu pa dodirni „Osveži" gore desno.
          </p>
        ) : chip === 'ugovor' && contractsQ.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje ugovora…</p>
        ) : shown.length === 0 ? (
          <EmptyState
            title="Nema rezultata"
            hint={
              chip === 'odsutni'
                ? 'Niko iz liste trenutno nije na odsustvu.'
                : chip === 'ugovor'
                  ? `Nijednom aktivnom zaposlenom ugovor ne ističe u narednih ${EXPIRY_DAYS} dana.`
                  : 'Promeni pretragu ili filter.'
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
              {shown.map((e) => (
                <li key={e.id}>
                  <button
                    onClick={() => onOpen(e.id)}
                    className={`flex w-full min-h-14 items-center gap-3 px-4 py-2.5 text-left active:bg-surface-2 ${FOCUS}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {e.full_name}
                      </span>
                      <span className="block truncate text-xs text-ink-secondary">
                        {[e.position, e.department].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </span>
                    {absentIds.has(e.id) && (
                      <span className="shrink-0">
                        <StatusBadge tone="warn" label="Odsutan" />
                      </span>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            {total > rows.length && (
              <p className="text-center text-2xs text-ink-disabled">
                Prikazano {rows.length} od {total} — suzi pretragu.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── karton

function EmployeeCard({ id, onBack }: { id: string; onBack: () => void }) {
  const { can } = useAuth();
  const canContracts = can(PERMISSIONS.KADROVSKA_CONTRACTS_READ);
  const canAttendance = can(PERMISSIONS.KADROVSKA_ATTENDANCE);

  const empQ = useEmployee(id);
  const e = empQ.data?.data;

  const contractsQ = useContracts({ employeeId: id }, canContracts);
  // BE vraća ugovore `dateFrom DESC`; aktivan = nearhiviran (isti kriterijum kao
  // `status:'active'` filter na listi).
  const activeContract = (contractsQ.data?.data ?? []).find((c) => !c.archivedAt) ?? null;

  const absQ = useAbsences({ employeeId: id });
  const absences = useMemo(
    () =>
      [...(absQ.data?.data ?? [])]
        .sort((a, b) => String(b.dateFrom).localeCompare(String(a.dateFrom)))
        .slice(0, 8),
    [absQ.data],
  );

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-3">
        <button
          onClick={onBack}
          aria-label="Nazad na listu"
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-secondary active:bg-surface-2 ${FOCUS}`}
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-md font-semibold text-ink">
          {e?.full_name ?? 'Zaposleni'}
        </h1>
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-4 p-4">
        {empQ.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : !e ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Zaposleni nije pronađen (ili nemaš pristup njegovom kartonu).
          </p>
        ) : (
          <>
            {/* Osnovni podaci — BEZ PII (v_employees_safe podskup) */}
            <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="min-w-0 text-lg font-semibold text-ink">{e.full_name}</h2>
                <span className="shrink-0">
                  <StatusBadge
                    tone={e.is_active ? 'success' : 'neutral'}
                    label={e.is_active ? 'Aktivan' : 'Neaktivan'}
                  />
                </span>
              </div>
              <Row label="Pozicija" value={e.position} />
              <Row label="Odeljenje" value={e.department} />
              <Row label="Pod-odeljenje" value={sv(e, 'sub_department_name')} />
              <Row label="Tim" value={e.team} />
              <Row label="Službeni telefon" value={e.phone_work} />
              <Row label="Email" value={e.email} />
              <Row label="U firmi od" value={sv(e, 'hire_date') ? formatDate(sv(e, 'hire_date')) : ''} />
            </section>

            {/* Aktivan ugovor — samo `kadrovska.contracts_read`; bez zarada i PII */}
            {canContracts && (
              <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
                <h2 className="text-sm font-semibold text-ink">Aktivan ugovor</h2>
                {contractsQ.isLoading ? (
                  <p className="text-sm text-ink-secondary">Učitavanje…</p>
                ) : !activeContract ? (
                  <p className="text-sm text-ink-disabled">Nema evidentiranog aktivnog ugovora.</p>
                ) : (
                  <>
                    <Row
                      label="Vrsta"
                      value={
                        CON_TYPE_LABELS[activeContract.contractType] || activeContract.contractType
                      }
                    />
                    <Row label="Broj" value={activeContract.contractNumber} />
                    <Row label="Radno mesto" value={activeContract.position} />
                    <Row
                      label="Važi"
                      value={`${formatDate(activeContract.dateFrom)} – ${
                        activeContract.dateTo ? formatDate(activeContract.dateTo) : 'neodređeno'
                      }`}
                    />
                    {activeContract.probniRad && (
                      <Row
                        label="Probni rad"
                        value={
                          activeContract.probniMeseci
                            ? `${activeContract.probniMeseci} meseci`
                            : 'da'
                        }
                      />
                    )}
                  </>
                )}
              </section>
            )}

            {/* Poslednja odsustva */}
            <section className="space-y-2 rounded-panel border border-line bg-surface p-4">
              <h2 className="text-sm font-semibold text-ink">Poslednja odsustva</h2>
              {absQ.isLoading ? (
                <p className="text-sm text-ink-secondary">Učitavanje…</p>
              ) : absences.length === 0 ? (
                <p className="text-sm text-ink-disabled">Nema evidentiranih odsustava.</p>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {absences.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                      <span className="min-w-0 text-sm text-ink">{absTypeFullLabel(a)}</span>
                      <span className="tnums shrink-0 text-right text-xs text-ink-secondary">
                        {formatDate(a.dateFrom)} – {formatDate(a.dateTo)}
                        {a.daysCount ? <span className="block">{a.daysCount} d</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {canAttendance && (
              <Link
                href="/mob/prisustvo"
                className={`flex min-h-12 items-center gap-2 rounded-panel border border-line bg-surface px-4 py-3 text-sm text-ink active:bg-surface-2 ${FOCUS}`}
              >
                <Users className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <span className="flex-1">Prisustvo uživo</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
              </Link>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-ink-secondary">{label}</span>
      <span className="min-w-0 break-words text-right text-ink">{value}</span>
    </div>
  );
}
