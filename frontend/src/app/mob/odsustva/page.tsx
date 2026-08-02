'use client';

/**
 * Mobilna „Odsustva / GO" (/mob/odsustva) — PLAN_MOB_3.0 Faza 2, talas A
 * (paritet 1.0 mobilnog `/m/odsustva` = myLeave). TANAK omotač nad `GET /v1/profile/vacation`
 * (`useVacation`) i postojećim self-RPC mutacijama (`useSubmitVacation` / `useReviseVacation` /
 * `useCancelVacation` / `useDeleteVacation`) — nula nove poslovne logike: pravila „koja akcija
 * je dozvoljena u kom statusu", MIN_DATE i informativni obračun radnih dana preslikani su sa
 * `app/profil/_components/vacation-section.tsx`, a mapa statusa je deljena (`statusLabel`/
 * `statusTone` iz istog modula) — server ostaje autoritet (praznici, saldo, dual-control).
 *
 * Gate: svaki prijavljen korisnik (`profile.self`). „Za koga" picker se pojavljuje samo
 * upravljačima sa opsegom (`useTeam` prazno/403 → zahtev isključivo za sebe).
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarPlus, ChevronLeft, FileText, Pencil, Trash2, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import { generateVacationDecisionPdf, downloadBlob } from '@/lib/hr-pdf';
import { nextWorkingDay } from '@/app/kadrovska/_components/odmori/helpers';
import { statusLabel, statusTone } from '@/app/profil/_components/section';
import {
  newClientEventId,
  useVacation,
  useSubmitVacation,
  useReviseVacation,
  useCancelVacation,
  useDeleteVacation,
  useMakeupPaidLeave,
  useSubmitVacationChange,
  useTeam,
  useProfileMe,
  usePosition,
  vacationRemaining,
  type MakeupRequest,
  type VacationRequest,
  type VacationChangeRequest,
} from '@/api/moj-profil';
import type { GoLedgerBlock, GoLedgerPeriod } from '@/api/kadrovska';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Najraniji dozvoljen datum zahteva (paritet desktopa — start 3.0 evidencije GO). */
const MIN_DATE = '2026-05-01';

/** Radni dani (Pon–Pet) uključivo — informativno; praznike server oduzima (on je autoritet). */
function workDays(from: string, to: string): number {
  const s = new Date(from);
  const e = new Date(to);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  let n = 0;
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type FormState = { mode: 'new' } | { mode: 'edit'; req: VacationRequest } | null;

export default function MobOdsustvaPage() {
  const { user, isLoading, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const q = useVacation();
  const data = q.data?.data;
  const balance = data?.balance;
  const requests = data?.requests ?? [];
  const ledger = data?.ledger ?? [];
  // ZAHTEV 026/26 — molbe za izmenu/otkaz POTVRĐENOG termina (odlučuje HR).
  const changeRequests = data?.changeRequests ?? [];
  const openChangeByReq = new Map<string, VacationChangeRequest>(
    changeRequests.filter((c) => c.status === 'pending').map((c) => [c.vacation_request_id, c]),
  );
  // ZAHTEV 028/26: prikazuje se STEČENO do danas (1.0 kanon), ne kalendarsko pravo.
  const remaining = vacationRemaining(balance);

  const meQ = useProfileMe();
  const positionQ = usePosition();
  const cancelM = useCancelVacation();
  const deleteM = useDeleteVacation();

  const [form, setForm] = useState<FormState>(null);
  const [changeFor, setChangeFor] = useState<{ req: VacationRequest; kind: 'cancel' | 'revise' } | null>(null);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  /** Rešenje o GO za SEBE — isti generator kao Kadrovska (`generateVacationDecisionPdf`),
   *  samo bez PII/upload dela (JMBG i evidencija dokumenata su HR domen). */
  async function onPdf(r: VacationRequest) {
    const name = meQ.data?.data.employee?.full_name || user?.fullName || user?.email || '';
    const position = positionQ.data?.data?.name;
    if (!position) {
      toast('Nemaš upisano radno mesto — rešenje ne može da se generiše. Javi se HR-u.');
      return;
    }
    setPdfBusy(r.id);
    try {
      const from = r.date_from.slice(0, 10);
      const to = r.date_to.slice(0, 10);
      const days = r.days_count || workDays(from, to);
      const saldo = balance
        ? {
            ukupno: num(balance.days_earned ?? balance.days_total) + num(balance.days_carried_over),
            iskorisceno: num(balance.days_used),
            preostalo: num(balance.days_remaining_accrued ?? balance.days_remaining),
          }
        : null;
      // Praznici se ovde ne učitavaju (lista je HR endpoint) — povratak = prvi radni dan
      // po kalendaru; ako pada na praznik, HR verzija rešenja je merodavna.
      const povratak = nextWorkingDay(to, null);
      const { blob, fileName } = await generateVacationDecisionPdf({
        brojResenja: `GO-${r.year}-${String(r.id).replace(/-/g, '').slice(0, 4).toUpperCase()}`,
        datumDonosenja: formatDate(new Date().toISOString().slice(0, 10)),
        mesto: 'Dobanovci',
        godina: r.year,
        imePrezime: name,
        radnoMesto: position,
        brojDana: days,
        datumOd: formatDate(from),
        datumDo: formatDate(to),
        datumPovratka: povratak ? formatDate(povratak) : '________',
        saldo,
        potpisPoslodavac: 'Nenad Jaraković',
      });
      // Samo preuzimanje — `openBlob` otvara novi tab, što APK WebView blokira.
      downloadBlob(blob, fileName);
      toast('Rešenje preuzeto.');
    } catch (e) {
      toast(e instanceof Error ? `Greška pri generisanju: ${e.message}` : 'Greška pri generisanju rešenja.');
    } finally {
      setPdfBusy(null);
    }
  }

  async function onCancel(r: VacationRequest) {
    if (!window.confirm('Otkazati zahtev?')) return;
    try {
      await cancelM.mutateAsync({ id: r.id });
      toast('Zahtev otkazan.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Otkazivanje nije uspelo.');
    }
  }
  async function onDelete(r: VacationRequest) {
    if (!window.confirm('Trajno obrisati zahtev?')) return;
    try {
      await deleteM.mutateAsync({ id: r.id });
      toast('Zahtev obrisan.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Brisanje nije uspelo.');
    }
  }

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Odsustva / GO</h1>
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
        {q.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : !data ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Tvoj zaposlenički profil nije pronađen — obrati se HR-u.
          </p>
        ) : (
          <>
            {/* Saldo */}
            <div className="grid grid-cols-3 gap-2">
              <Stat
                label="Pravo"
                value={balance ? num(balance.days_earned ?? balance.days_total) + num(balance.days_carried_over) : '—'}
                hint="zarađeno + preneto"
              />
              <Stat label="Iskorišćeno" value={balance ? num(balance.days_used) : '—'} />
              <Stat
                label="Preostalo"
                value={remaining ?? '—'}
                tone={remaining != null && num(remaining) <= 3 ? 'warn' : undefined}
              />
            </div>

            {/* Novi zahtev / obrazac */}
            {form ? (
              <RequestForm
                key={form.mode === 'edit' ? form.req.id : 'new'}
                state={form}
                selfRemaining={remaining}
                onClose={() => setForm(null)}
              />
            ) : (
              <Button onClick={() => setForm({ mode: 'new' })} className="h-12 w-full">
                <CalendarPlus className="h-4 w-4" aria-hidden />
                Novi zahtev
              </Button>
            )}

            {/* Moji zahtevi */}
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                Moji zahtevi
              </h2>
              {changeFor && (
                <ChangeForm
                  key={`${changeFor.req.id}-${changeFor.kind}`}
                  req={changeFor.req}
                  kind={changeFor.kind}
                  onClose={() => setChangeFor(null)}
                />
              )}
              {requests.length === 0 ? (
                <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
                  Još nema podnetih zahteva za godišnji odmor.
                </p>
              ) : (
                <ul className="space-y-2">
                  {requests.map((r) => {
                    // Ista pravila kao desktop (ZAHTEV 026/26): dok zahtev NIJE potvrđen radnik
                    // ga menja/otkazuje/briše sam; nad POTVRĐENIM terminom ide molba HR-u.
                    const editable = ['pending', 'sef_approved'].includes(r.status);
                    const approved = r.status === 'approved';
                    const openChange = openChangeByReq.get(r.id);
                    return (
                      <li key={r.id} className="rounded-panel border border-line bg-surface p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="tnums text-md font-semibold text-ink">
                              {formatDate(r.date_from)} – {formatDate(r.date_to)}
                            </p>
                            <p className="tnums text-sm text-ink-secondary">{r.days_count} radnih dana</p>
                          </div>
                          <span className="shrink-0">
                            <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />
                          </span>
                        </div>
                        {r.note && <p className="mt-2 text-sm text-ink-secondary">{r.note}</p>}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {editable && (
                            <>
                              <Button
                                variant="secondary"
                                className="h-11"
                                onClick={() => setForm({ mode: 'edit', req: r })}
                              >
                                <Pencil className="h-4 w-4" aria-hidden /> Izmeni
                              </Button>
                              <Button
                                variant="secondary"
                                className="h-11"
                                loading={cancelM.isPending}
                                onClick={() => void onCancel(r)}
                              >
                                <X className="h-4 w-4" aria-hidden /> Otkaži
                              </Button>
                            </>
                          )}
                          {approved && (openChange ? (
                            <span className="self-center text-xs text-status-warn">
                              ⏳ {openChange.kind === 'cancel' ? 'Otkazivanje' : 'Izmena'} poslata — čeka HR
                            </span>
                          ) : (
                            <>
                              <Button variant="secondary" className="h-11" onClick={() => setChangeFor({ req: r, kind: 'revise' })}>
                                <Pencil className="h-4 w-4" aria-hidden /> Zatraži izmenu
                              </Button>
                              <Button variant="secondary" className="h-11" onClick={() => setChangeFor({ req: r, kind: 'cancel' })}>
                                <X className="h-4 w-4" aria-hidden /> Zatraži otkazivanje
                              </Button>
                            </>
                          ))}
                          {approved && (
                            <Button
                              variant="secondary"
                              className="h-11"
                              loading={pdfBusy === r.id}
                              onClick={() => void onPdf(r)}
                            >
                              <FileText className="h-4 w-4" aria-hidden /> PDF rešenja
                            </Button>
                          )}
                          {!approved && (
                            <Button
                              variant="ghost"
                              className="ml-auto h-11 w-11 px-0 text-status-danger"
                              aria-label="Trajno obriši zahtev"
                              title="Trajno obriši zahtev"
                              onClick={() => void onDelete(r)}
                            >
                              <Trash2 className="h-4 w-4" aria-hidden />
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* ZAHTEV 026/26 — moje molbe za izmenu/otkaz potvrđenog termina */}
            {changeRequests.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                  Zahtevi za izmenu / otkazivanje
                </h2>
                <ul className="space-y-2">
                  {changeRequests.map((c) => (
                    <li key={c.id} className="rounded-panel border border-line bg-surface p-3">
                      <div className="flex items-start justify-between gap-3">
                        <p className="tnums text-sm text-ink">
                          {c.kind === 'cancel' ? 'Otkazivanje' : 'Izmena'}: {formatDate(c.old_date_from)} – {formatDate(c.old_date_to)}
                          {c.kind === 'revise' && c.new_date_from && c.new_date_to
                            ? ` → ${formatDate(c.new_date_from)} – ${formatDate(c.new_date_to)}`
                            : ''}
                        </p>
                        <span className="shrink-0">
                          <StatusBadge
                            tone={c.status === 'pending' ? 'warn' : c.status === 'approved' ? 'success' : 'danger'}
                            label={c.status === 'pending' ? 'Čeka odluku' : c.status === 'approved' ? 'Odobreno' : 'Odbijeno'}
                          />
                        </span>
                      </div>
                      {c.reason && <p className="mt-1 text-xs text-ink-secondary">{c.reason}</p>}
                      {c.decision_note && <p className="mt-1 text-xs text-ink-secondary">Odluka: {c.decision_note}</p>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Istorija GO po godinama (go_ledger — isti presek kao desktop) */}
            {ledger.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                  Istorija godišnjeg odmora
                </h2>
                <div className="space-y-2">
                  {ledger.map((b) => (
                    <LedgerYear key={b.godina} b={b} />
                  ))}
                </div>
                <p className="text-2xs text-ink-disabled">
                  Iskorišćeni + planirani (odobreni) dani po datumu. Slobodno = preostalo.
                </p>
              </section>
            )}

            {/* Nadoknade / rad vikendom — read-only samouvid (podnošenje: desktop Moj profil) */}
            <MakeupList />
          </>
        )}
      </main>
    </div>
  );
}

/**
 * Nadoknade sati / dan odmora za rad vikendom — TANAK read-only omotač nad
 * `GET /v1/profile/makeup-paid-leave` (isti izvor kao desktop Moj profil).
 * Za 'dan_odmora' bedž razlikuje UPISAN +1 dan GO od odobrenog-bez-upisa
 * (istorijski ne-atomski grant — incident 04.07.2026); podnošenje novog
 * zahteva ostaje na desktopu („Moj profil" → Nadoknada sati).
 */
function MakeupList() {
  const q = useMakeupPaidLeave();
  const rows = q.data?.data?.makeup ?? [];
  if (q.isLoading || rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
        Nadoknade / rad vikendom
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => (
          <MakeupCard key={r.id} r={r} />
        ))}
      </ul>
      <p className="text-2xs text-ink-disabled">
        Dan odmora za odrađen vikend menja plaćene sate tog dana (zamena, ne duplo).
        Novi zahtev se podnosi u „Moj profil" na računaru.
      </p>
    </section>
  );
}

function MakeupCard({ r }: { r: MakeupRequest }) {
  const danOdmora = r.compensation_type === 'dan_odmora';
  const datum = danOdmora ? r.weekend_work_date || r.absence_date : r.absence_date;
  // Tri stanja: true = upisan; false = nije (warn); undefined (stari BE bez
  // polja) = neutralan status bez tvrdnje.
  const badge =
    danOdmora && (r.status === 'approved' || r.status === 'completed') && r.bonus_granted === true ? (
      <StatusBadge tone="success" label="+1 dan GO upisan" />
    ) : danOdmora && (r.status === 'approved' || r.status === 'completed') && r.bonus_granted === false ? (
      <StatusBadge tone="warn" label="Dan još nije upisan" />
    ) : (
      <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />
    );
  return (
    <li className="rounded-panel border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {danOdmora ? '🏖 Dan odmora (rad vikendom)' : 'Nadoknada sati'}
          </p>
          <p className="tnums text-sm text-ink-secondary">
            {formatDate(datum)} · {Number(r.absence_hours)}h
            {!danOdmora && r.makeup_deadline ? ` · rok ${formatDate(r.makeup_deadline)}` : ''}
          </p>
        </div>
        <span className="shrink-0">{badge}</span>
      </div>
      {(r.reason || r.makeup_plan) && (
        <p className="mt-2 text-xs text-ink-secondary">{r.reason || r.makeup_plan}</p>
      )}
    </li>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <div className="rounded-panel border border-line bg-surface px-3 py-2.5">
      <div className="text-xs text-ink-secondary">{label}</div>
      <div className={`tnums text-2xl font-semibold ${tone === 'warn' ? 'text-status-warn' : 'text-ink'}`}>
        {value}
      </div>
      {hint && <div className="text-2xs text-ink-disabled">{hint}</div>}
    </div>
  );
}

/**
 * Novi/izmena zahteva — inline kartica (na telefonu bolja od modala: tastatura + skrol).
 *
 * ⚠️ ZAHTEV 028/26: kao i desktop `vacation-section.tsx`, ovaj obrazac je uz „Za koga"
 * picker prikazivao saldo PODNOSIOCA i kad se podnosi za člana tima. Saldo se sada čita
 * iz `useTeam()` reda izabranog člana; bez podatka se piše upozorenje, ne tuđi broj.
 */
function RequestForm({
  state,
  selfRemaining,
  onClose,
}: {
  state: NonNullable<FormState>;
  /** Saldo PODNOSIOCA (prikazuje se samo kad zahtev ide za sebe). */
  selfRemaining: number | null;
  onClose: () => void;
}) {
  const req = state.mode === 'edit' ? state.req : undefined;
  const [dateFrom, setDateFrom] = useState(req?.date_from?.slice(0, 10) ?? '');
  const [dateTo, setDateTo] = useState(req?.date_to?.slice(0, 10) ?? '');
  const [note, setNote] = useState(req?.note ?? '');
  const [forEmp, setForEmp] = useState(''); // '' = za sebe; inače employeeId člana tima
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitVacation();
  const reviseM = useReviseVacation();
  const days = dateFrom && dateTo ? workDays(dateFrom, dateTo) : 0;

  // „Za koga" (paritet 1.0 / desktopa): samo pri NOVOM zahtevu i samo upravljačima sa
  // opsegom (useTeam vraća prazno/403 → nema pickera). Izmena je uvek nad postojećim.
  const teamQ = useTeam();
  const team = state.mode === 'new' ? (teamQ.data?.data?.members ?? []) : [];
  const teamOpts = team.map((m) => ({ value: m.id, label: m.fullName ?? '—' }));

  // Saldo koji se prikazuje MORA pripadati onome za koga se zahtev podnosi.
  const selected = forEmp ? team.find((m) => m.id === forEmp) : undefined;
  const remaining = forEmp ? vacationRemaining(selected?.balance) : selfRemaining;
  const remainingFor = forEmp ? (selected?.fullName ?? 'izabranog zaposlenog') : null;

  async function save() {
    setErr(null);
    if (!dateFrom || !dateTo) return setErr('Izaberi period.');
    if (dateTo < dateFrom) return setErr('„Do" ne može biti pre „Od".');
    if (dateFrom < MIN_DATE) return setErr(`Najraniji dozvoljeni datum je ${formatDate(MIN_DATE)}`);
    try {
      if (state.mode === 'edit') {
        await reviseM.mutateAsync({
          id: state.req.id,
          dateFrom,
          dateTo,
          daysCount: days,
          note: note || undefined,
        });
        toast('Zahtev izmenjen.');
      } else {
        await submitM.mutateAsync({
          clientEventId: newClientEventId(),
          dateFrom,
          dateTo,
          daysCount: days,
          note: note || undefined,
          employeeId: forEmp || undefined, // '' → za sebe (server presuđuje)
        });
        toast('Zahtev poslat na odobravanje.');
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Slanje nije uspelo.');
    }
  }

  return (
    <section className="space-y-3 rounded-panel border border-accent/40 bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">
        {state.mode === 'edit' ? 'Izmena zahteva za godišnji' : 'Zahtev za godišnji odmor'}
      </h2>
      {err && (
        <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>
      )}
      {teamOpts.length > 0 && (
        <FormField label="Za koga">
          <Select
            className="h-11 text-md"
            value={forEmp}
            onChange={(e) => setForEmp(e.target.value)}
            placeholder="Ja (moj zahtev)"
            options={teamOpts}
          />
        </FormField>
      )}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Od datuma" required>
          <Input
            type="date"
            min={MIN_DATE}
            className="h-11 text-md"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </FormField>
        <FormField label="Do datuma" required>
          <Input
            type="date"
            min={MIN_DATE}
            className="h-11 text-md"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </FormField>
      </div>
      <p className="text-sm text-ink-secondary">
        Radnih dana: <b className="tnums">{days}</b>
        {remaining != null ? (
          <span>
            {' · '}
            Preostalo GO{remainingFor ? ` (${remainingFor})` : ''}: <b className="tnums">{remaining}</b>
          </span>
        ) : forEmp ? (
          <span className="text-status-warn"> · nema podatka o fondu za izabranog zaposlenog</span>
        ) : null}
      </p>
      <p className="text-2xs text-ink-disabled">
        Broj dana je informativan (Pon–Pet). Državne praznike oduzima server pri upisu.
      </p>
      <FormField label="Napomena">
        <Textarea
          className="text-md"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
        />
      </FormField>
      <div className="flex gap-2">
        <Button variant="secondary" className="h-11 flex-1" onClick={onClose}>
          Otkaži
        </Button>
        <Button
          className="h-11 flex-1"
          onClick={() => void save()}
          loading={submitM.isPending || reviseM.isPending}
        >
          {state.mode === 'edit' ? 'Sačuvaj' : 'Podnesi'}
        </Button>
      </div>
    </section>
  );
}

/**
 * ZAHTEV 026/26 — molba za izmenu/otkaz POTVRĐENOG termina (mobilni pandan desktop
 * `ChangeRequestModal`). Ne menja termin: pravi red koji odobrava HR. Broj radnih dana
 * računa server (klijentski se ne šalje).
 */
function ChangeForm({
  req,
  kind,
  onClose,
}: {
  req: VacationRequest;
  kind: 'cancel' | 'revise';
  onClose: () => void;
}) {
  const [dateFrom, setDateFrom] = useState(req.date_from?.slice(0, 10) ?? '');
  const [dateTo, setDateTo] = useState(req.date_to?.slice(0, 10) ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submitM = useSubmitVacationChange();
  const days = kind === 'revise' && dateFrom && dateTo ? workDays(dateFrom, dateTo) : 0;

  async function save() {
    setErr(null);
    if (!reason.trim()) return setErr('Razlog je obavezan — HR na osnovu njega odlučuje.');
    if (kind === 'revise') {
      if (!dateFrom || !dateTo) return setErr('Izaberi novi period.');
      if (dateTo < dateFrom) return setErr('„Do" ne može biti pre „Od".');
      if (dateFrom < MIN_DATE) return setErr(`Najraniji dozvoljeni datum je ${formatDate(MIN_DATE)}`);
      if (dateFrom === req.date_from?.slice(0, 10) && dateTo === req.date_to?.slice(0, 10))
        return setErr('Novi termin je isti kao postojeći.');
    }
    try {
      const res = await submitM.mutateAsync({
        id: req.id,
        clientEventId: newClientEventId(),
        kind,
        ...(kind === 'revise' ? { dateFrom, dateTo } : {}),
        reason: reason.trim(),
      });
      const status = ((res as { data?: { status?: string } } | null)?.data ?? {}).status;
      if (status === 'already_pending') return setErr('Za ovaj termin već postoji zahtev koji čeka odluku.');
      if (status === 'not_approved') return setErr('Termin više nije potvrđen — osveži stranicu.');
      if (status === 'overlap') return setErr('Predloženi termin se preklapa sa drugim odsustvom.');
      // Uspeh je SAMO 'pending' (molba je zavedena). 'not_found' ili nepoznat status
      // ne smeju da prikažu „poslato" — red u bazi tada ne postoji.
      if (status !== 'pending')
        return setErr('Zahtev nije zaveden — osveži stranicu i pokušaj ponovo.');
      toast('Zahtev poslat HR-u.');
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Slanje nije uspelo.');
    }
  }

  return (
    <section className="space-y-3 rounded-panel border border-accent/40 bg-surface p-4">
      <h2 className="text-sm font-semibold text-ink">
        {kind === 'cancel' ? 'Zahtev za otkazivanje godišnjeg' : 'Zahtev za izmenu termina'}
      </h2>
      {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
      <p className="tnums text-sm text-ink-secondary">
        Potvrđen termin: <b>{formatDate(req.date_from)} – {formatDate(req.date_to)}</b> ({req.days_count} radnih dana)
      </p>
      {kind === 'revise' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Novo od" required>
              <Input type="date" min={MIN_DATE} className="h-11 text-md" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </FormField>
            <FormField label="Novo do" required>
              <Input type="date" min={MIN_DATE} className="h-11 text-md" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </FormField>
          </div>
          <p className="text-sm text-ink-secondary">Radnih dana: <b className="tnums">{days}</b></p>
        </>
      )}
      <FormField label="Razlog" required>
        <Textarea className="text-md" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
      </FormField>
      <p className="text-2xs text-ink-disabled">
        {kind === 'cancel'
          ? 'Termin važi dok HR ne odobri otkazivanje; posle odobrenja dani se vraćaju u fond.'
          : 'Termin važi dok HR ne odobri izmenu; posle odobrenja stari termin se poništava, a novi upisuje.'}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" className="h-11 flex-1" onClick={onClose}>Odustani</Button>
        <Button className="h-11 flex-1" onClick={() => void save()} loading={submitM.isPending}>Pošalji</Button>
      </div>
    </section>
  );
}

function fmtPeriod(p: GoLedgerPeriod): string {
  if (!p.od) return '—';
  if (!p.do || p.od === p.do) return formatDate(p.od);
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.od);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.do);
  if (a && b && a[1] === b[1] && a[2] === b[2]) return `${a[3]}–${b[3]}.${b[2]}.${b[1]}.`;
  return `${formatDate(p.od)} – ${formatDate(p.do)}`;
}

/** Jedna godina GO liste (read-only) — tap razvija dane po datumu. */
function LedgerYear({ b }: { b: GoLedgerBlock }) {
  const isHist = b.izvor === 'istorija';
  const entries = b.istorija_unosi ?? b.stara_evidencija ?? [];
  return (
    <details className="rounded-panel border border-line bg-surface px-4 py-3">
      <summary className={`min-h-11 cursor-pointer list-none text-sm ${FOCUS}`}>
        <b className="text-ink">{b.godina}.</b>{' '}
        <span className="tnums text-ink-secondary">
          iskorišćeno <b>{b.iskorisceno}</b>
          {b.planirano > 0 ? <> · planirano <b>{b.planirano}</b></> : null}
          {b.preostalo != null ? <> · preostalo <b>{b.preostalo}</b></> : null}
        </span>
      </summary>
      <div className="mt-2 space-y-1 text-xs text-ink-secondary">
        {isHist ? (
          entries.map((e, i) => (
            <div key={i} className="tnums">
              {e.days ?? '–'} · {e.kind} · {e.dates}
              {e.comment ? ` — ${e.comment}` : ''}
            </div>
          ))
        ) : (
          <>
            {(b.iskorisceno_periodi ?? []).map((p, i) => (
              <div key={`u${i}`} className="tnums">
                {fmtPeriod(p)} — {p.dana} d
              </div>
            ))}
            {b.ranije_evidentirano > 0 && (
              <div className="tnums text-ink-disabled">
                bez preciznog datuma — {b.ranije_evidentirano} d
              </div>
            )}
            {(b.planirano_periodi ?? []).map((p, i) => (
              <div key={`p${i}`} className="tnums text-status-info">
                planirano: {fmtPeriod(p)} — {p.dana} d
              </div>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
