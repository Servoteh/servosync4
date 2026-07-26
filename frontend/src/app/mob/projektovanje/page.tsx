'use client';

/**
 * Mobilno „Moje projektovanje" (/mob/projektovanje) — PLAN_MOB_3.0 Faza 2, talas C
 * (1.0 `/m/projektovanje` „myProjektovanje" paritet). TANAK omotač nad Projektnim
 * biroom: `useTasks({ employeeId })` → moji zadaci grupisani po projektu, tap otvara
 * inline uređivač (status + procenat kroz `useUpdateProgress`) i komentare.
 *
 * Poslovna logika je PRESLIKANA sa `app/pb/_components/task-editor.tsx` (restriktovan
 * „inženjerski" mod): jedini write je `POST /v1/pb/tasks/:id/progress` sa `{status,
 * procenat}` — oba polja idu zajedno, RPC radi `coalesce`, 100% NE menja status
 * automatski i ne upisuje realni datum završetka. Statusi = kanon `PB_STATUSI`;
 * tonovi/badževi iz `app/pb/_components/shared.tsx`.
 *
 * „Moj employeeId" = `useProfileMe().data.employee.id` (`/v1/profile/me`, isti
 * `employees.id` koji BE koristi u `pb_current_employee_id()`). ⚠️ Bez njega se
 * `useTasks` NE zove — `employeeId: undefined` bi vratio TUĐE zadatke (sve).
 *
 * Gate ekrana: `pb.read` (klasni BE gate `/v1/pb`); izmena progresa `pb.progress`;
 * komentari `pb.comment`. Static export: čista statička ruta, bez `[id]` i bez
 * `useSearchParams` (detalj je inline akordeon, ne zasebna ruta).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui-kit/button';
import { Textarea } from '@/components/ui-kit/textarea';
import { useProfileMe } from '@/api/moj-profil';
import {
  PB_STATUSI,
  newClientEventId,
  useCreateComment,
  useTaskComments,
  useTasks,
  useUpdateProgress,
  type PbTask,
} from '@/api/projektni-biro';
import { PrioBadge, ProgressBar, TaskStatusBadge, shortDate } from '@/app/pb/_components/shared';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** BE `parsePagination` klampuje na 200; „moji zadaci" realno stanu u jednu stranu. */
const PAGE_SIZE = 200;

/** Rok prošao, a zadatak nije završen (poređenje YYYY-MM-DD stringova — bez TZ pomeranja). */
function isLate(t: PbTask): boolean {
  if (!t.datum_zavrsetka_plan || t.status === 'Završeno') return false;
  return t.datum_zavrsetka_plan.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

export default function MobProjektovanjePage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const allowed = can(PERMISSIONS.PB_READ);
  const me = useProfileMe();
  const employeeId = me.data?.data.employee?.id ?? null;

  const tasks = useTasks({
    employeeId: employeeId ?? undefined,
    status: statusFilter || undefined,
    pageSize: PAGE_SIZE,
  });
  // ⚠️ `useTasks` bez `employeeId` vraća SVE zadatke — zato se rezultat koristi tek
  // kad je zaposlenički profil razrešen (hook se ne može uslovno preskočiti).
  const rows = employeeId ? (tasks.data?.data ?? []) : [];

  /** Grupisanje po projektu (paritet 1.0: zadaci se čitaju po predmetu, ne u ravnoj listi). */
  const groups = useMemo(() => {
    const byProject = new Map<string, { label: string; items: PbTask[] }>();
    for (const t of rows) {
      const key = t.project_id ?? '—';
      const label =
        [t.project_code, t.project_name].filter(Boolean).join(' — ') || 'Bez projekta';
      const g = byProject.get(key) ?? { label, items: [] };
      g.items.push(t);
      byProject.set(key, g);
    }
    return [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label, 'sr'));
  }, [rows]);

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
  if (!allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup projektnom birou — javite se administratoru (potrebno `pb.read`).
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Projektovanje</h1>
          <p className="truncate text-xs text-ink-secondary">
            {rows.length > 0 ? `${rows.length} mojih zadataka` : (user.fullName ?? user.email)}
          </p>
        </div>
        <Link
          href="/mob"
          className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Početna
        </Link>
      </header>

      <main className="space-y-3 p-4">
        {/* Filter statusa — kanon PB_STATUSI (BE filtrira po labeli). */}
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <FilterChip active={statusFilter === ''} onClick={() => setStatusFilter('')}>
            Svi
          </FilterChip>
          {PB_STATUSI.map((s) => (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {s}
            </FilterChip>
          ))}
        </div>

        {me.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : !employeeId ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Tvoj zaposlenički profil nije pronađen — obrati se HR-u. Bez njega ne mogu da
            izdvojim tvoje zadatke.
          </p>
        ) : tasks.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : tasks.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Greška pri učitavanju zadataka. Proveri vezu pa osveži stranicu.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            {statusFilter ? `Nemaš zadataka u statusu „${statusFilter}".` : 'Nemaš dodeljenih zadataka.'}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                {g.label} ({g.items.length})
              </h2>
              <ul className="space-y-2">
                {g.items.map((t) => (
                  <TaskCard
                    key={t.id}
                    t={t}
                    open={openId === t.id}
                    onToggle={() => setOpenId((id) => (id === t.id ? null : t.id))}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 shrink-0 rounded-full border px-4 text-sm ${
        active
          ? 'border-accent bg-accent-subtle font-semibold text-accent'
          : 'border-line bg-surface text-ink-secondary active:bg-surface-2'
      } ${FOCUS}`}
    >
      {children}
    </button>
  );
}

function TaskCard({ t, open, onToggle }: { t: PbTask; open: boolean; onToggle: () => void }) {
  const late = isLate(t);
  return (
    <li
      className={`rounded-panel border bg-surface ${
        late ? 'border-status-danger/50' : 'border-line'
      }`}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className={`flex w-full items-start gap-2 p-3 text-left active:bg-surface-2 ${
          open ? 'rounded-t-panel' : 'rounded-panel'
        } ${FOCUS}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">{t.naziv}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <TaskStatusBadge status={t.status} />
            {t.prioritet && <PrioBadge prio={t.prioritet} />}
            {t.vrsta && <span className="text-xs text-ink-secondary">{t.vrsta}</span>}
          </span>
          <span className="mt-1 flex items-center gap-3">
            <ProgressBar value={t.procenat_zavrsenosti} />
            <span className={`text-xs ${late ? 'font-semibold text-status-danger' : 'text-ink-secondary'}`}>
              rok {shortDate(t.datum_zavrsetka_plan)}
              {late ? ' !' : ''}
            </span>
          </span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-ink-disabled transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && <TaskDetail t={t} />}
    </li>
  );
}

/** Inline uređivač: status + procenat (jedan `progress` poziv) i komentari. */
function TaskDetail({ t }: { t: PbTask }) {
  const { can } = useAuth();
  const canProgress = can(PERMISSIONS.PB_PROGRESS);
  const canComment = can(PERMISSIONS.PB_COMMENT);

  const [status, setStatus] = useState<string>(t.status);
  const [pct, setPct] = useState<number>(Number(t.procenat_zavrsenosti ?? 0));
  const [body, setBody] = useState('');

  const progressM = useUpdateProgress();
  const commentsQ = useTaskComments(t.id);
  const createComment = useCreateComment();
  const comments = commentsQ.data?.data ?? [];

  const dirty = status !== t.status || pct !== Number(t.procenat_zavrsenosti ?? 0);

  async function save() {
    // Clamp na FE-u: BE `@Min(0) @Max(100)` + RPC provera vraćaju 422 — ne trošimo
    // korisnikov klik na sigurnu grešku (isti raspon kao desktop `min/max` input).
    const value = Math.max(0, Math.min(100, Math.round(pct)));
    try {
      // Status i procenat idu ZAJEDNO (paritet task-editor restricted moda; RPC radi coalesce).
      await progressM.mutateAsync({ id: t.id, status, procenat: value });
      toast('Napredak sačuvan.');
    } catch (e) {
      toast(
        e instanceof ApiError
          ? e.status === 403
            ? 'Nemate pravo izmene ovog zadatka.'
            : e.message
          : 'Čuvanje nije uspelo.',
      );
    }
  }

  async function addComment() {
    const text = body.trim();
    if (!text) return;
    try {
      await createComment.mutateAsync({ taskId: t.id, clientEventId: newClientEventId(), body: text });
      setBody('');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Komentar nije sačuvan.');
    }
  }

  return (
    <div className="space-y-4 border-t border-line p-3">
      {t.opis && <p className="whitespace-pre-wrap text-sm text-ink-secondary">{t.opis}</p>}
      {t.problem && (
        <p className="whitespace-pre-wrap rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn">
          {t.problem}
        </p>
      )}

      {canProgress ? (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              // text-md = 16 px: ispod toga iOS Safari zumira stranicu na fokus polja.
              className={`h-12 w-full rounded-control border border-line bg-surface-2 px-3 text-md text-ink outline-none focus:border-accent ${FOCUS}`}
            >
              {PB_STATUSI.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs font-medium text-ink-secondary">Završenost</span>
              <span className="tnums text-sm font-semibold text-ink">{Math.round(pct)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPct((v) => Math.max(0, Math.round(v) - 5))}
                aria-label="Smanji za 5%"
                className={`h-12 w-12 shrink-0 rounded-control border border-line bg-surface-2 text-lg font-bold text-ink active:bg-surface ${FOCUS}`}
              >
                −
              </button>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(pct)}
                onChange={(e) => setPct(Number(e.target.value))}
                aria-label="Procenat završenosti"
                className="h-12 min-w-0 flex-1 accent-[var(--accent)]"
              />
              <button
                onClick={() => setPct((v) => Math.min(100, Math.round(v) + 5))}
                aria-label="Povećaj za 5%"
                className={`h-12 w-12 shrink-0 rounded-control border border-line bg-surface-2 text-lg font-bold text-ink active:bg-surface ${FOCUS}`}
              >
                +
              </button>
            </div>
          </div>

          <Button
            onClick={() => void save()}
            loading={progressM.isPending}
            disabled={!dirty}
            className="h-12 w-full"
          >
            Sačuvaj napredak
          </Button>
        </div>
      ) : (
        <p className="text-xs text-ink-secondary">
          Nemate pravo izmene napretka (`pb.progress`) — prikaz je samo za uvid.
        </p>
      )}

      {/* ── Komentari ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
          Komentari ({comments.length})
        </h3>
        {commentsQ.isLoading ? (
          <p className="text-xs text-ink-secondary">Učitavanje…</p>
        ) : comments.length === 0 ? (
          <p className="text-xs text-ink-secondary">Nema komentara.</p>
        ) : (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li key={c.id} className="rounded-control border border-line-soft bg-surface-2 px-3 py-2">
                <p className="whitespace-pre-wrap text-sm text-ink">{c.body}</p>
                <p className="mt-0.5 text-xs text-ink-disabled">
                  {c.createdBy ?? '—'} · {shortDate(c.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {canComment && (
          <div className="space-y-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              maxLength={2000}
              className="text-md"
              placeholder="Dodaj komentar… (@email za mention)"
            />
            <Button
              variant="secondary"
              onClick={() => void addComment()}
              loading={createComment.isPending}
              disabled={!body.trim()}
              className="h-11 w-full"
            >
              Pošalji komentar
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
