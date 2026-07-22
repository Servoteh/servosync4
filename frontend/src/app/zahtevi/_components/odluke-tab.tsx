'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { toast } from '@/lib/toast';
import { formatDate } from '@/lib/format';
import {
  useDecisions,
  useCreateDecision,
  useUpdateDecision,
  useSupersedeDecision,
  type DecisionLogEntry,
  type CreateDecisionInput,
} from '@/api/zahtevi';

const TAKE = 25;

/** Datum „YYYY-MM-DD" za default u formi (danas). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Tab „Odluke" (Decision Log, MODULE_SPEC §6) — vidljiv uz zahtevi.decisions.read.
 * Lista (naslov/tagovi/datum/status/veza na zahtev), forma nove odluke, detalj sa
 * supersede tokom (nova odluka zamenjuje staru) i PATCH sitne ispravke. Write akcije
 * vidljive samo uz canWrite (BE i dalje autoritativno; 403 inače).
 */
export function OdlukeTab({ canWrite }: { canWrite: boolean }) {
  const [page, setPage] = useState(1);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useDecisions({
    q: q || undefined,
    tag: tag || undefined,
    status: statusFilter || undefined,
    page,
    pageSize: TAKE,
  });

  const rows = list.data?.data ?? [];
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Pretraga
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setQ(qInput.trim());
                  setPage(1);
                }
              }}
              placeholder="Naslov, odluka, kontekst…"
              className="h-9 w-56 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Tag
            <input
              value={tag}
              onChange={(e) => {
                setTag(e.target.value.trim());
                setPage(1);
              }}
              placeholder="npr. authz"
              className="h-9 w-40 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>
          {(q || tag || statusFilter) && (
            <button
              onClick={() => {
                setQ('');
                setQInput('');
                setTag('');
                setStatusFilter('');
                setPage(1);
              }}
              className="h-9 self-end rounded-control border border-line px-3 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova odluka
          </Button>
        )}
      </div>

      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      {rows.length === 0 && !list.isLoading ? (
        <EmptyState
          title="Nema odluka"
          hint="Decision Log beleži tehničke i poslovne odluke sa obrazloženjem. Dodajte prvu ili je zabeležite uz odluku o zahtevu."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <DecisionRow key={d.id} entry={d} onOpen={() => setOpenId(d.id)} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <Pager
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      )}

      {creating && (
        <DecisionFormDialog
          mode="create"
          onClose={() => setCreating(false)}
        />
      )}
      {openId != null && (
        <DecisionDetailDialog
          entry={rows.find((r) => r.id === openId)!}
          canWrite={canWrite}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function DecisionRow({
  entry,
  onOpen,
}: {
  entry: DecisionLogEntry;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-panel border border-line bg-surface px-4 py-3 text-left hover:bg-surface-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 font-medium text-ink">{entry.title}</span>
        {entry.status === 'SUPERSEDED' ? (
          <StatusBadge tone="neutral" label="Zamenjena" />
        ) : (
          <StatusBadge tone="success" label="Aktivna" />
        )}
      </div>
      <p className="line-clamp-2 text-sm text-ink-secondary">{entry.decision}</p>
      <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-secondary">
        <span>{formatDate(entry.decidedOn)}</span>
        {entry.tags.map((t) => (
          <span
            key={t}
            className="rounded-full border border-line bg-surface-2 px-2 py-0.5"
          >
            {t}
          </span>
        ))}
        {entry.relatedRequestId && (
          <span className="text-accent">→ zahtev #{entry.relatedRequestId}</span>
        )}
      </div>
    </button>
  );
}

/* ───────────────────────────────────────────────────────── detalj + supersede */

function DecisionDetailDialog({
  entry,
  canWrite,
  onClose,
}: {
  entry: DecisionLogEntry;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'supersede'>('view');

  if (mode === 'edit')
    return (
      <DecisionFormDialog
        mode="edit"
        entry={entry}
        onClose={onClose}
        onBack={() => setMode('view')}
      />
    );
  if (mode === 'supersede')
    return (
      <DecisionFormDialog
        mode="supersede"
        entry={entry}
        onClose={onClose}
        onBack={() => setMode('view')}
      />
    );

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={entry.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Zatvori
          </Button>
          {canWrite && entry.status === 'ACTIVE' && (
            <>
              <Button variant="secondary" onClick={() => setMode('edit')}>
                Ispravi
              </Button>
              <Button variant="primary" onClick={() => setMode('supersede')}>
                Zameni novom
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {entry.status === 'SUPERSEDED' ? (
            <StatusBadge tone="neutral" label="Zamenjena" />
          ) : (
            <StatusBadge tone="success" label="Aktivna" />
          )}
          <span className="text-2xs text-ink-secondary">{formatDate(entry.decidedOn)}</span>
          {entry.supersededById && (
            <span className="inline-flex items-center gap-1 text-2xs text-ink-secondary">
              <ArrowRight className="h-3 w-3" aria-hidden /> zamenjena odlukom #
              {entry.supersededById}
            </span>
          )}
        </div>
        <Block label="Odluka (ŠTA)" text={entry.decision} />
        {entry.context && <Block label="Kontekst (ZAŠTO)" text={entry.context} />}
        {entry.consequences && <Block label="Posledice" text={entry.consequences} />}
        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {entry.tags.map((t) => (
              <span
                key={t}
                className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary"
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {entry.relatedRequestId && (
          <p className="text-2xs">
            <Link
              href={`/zahtevi/detalj?id=${entry.relatedRequestId}`}
              className="text-accent hover:underline"
              onClick={onClose}
            >
              → Povezani zahtev #{entry.relatedRequestId}
            </Link>
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-ink">{text}</p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── forma odluke */

function DecisionFormDialog({
  mode,
  entry,
  onClose,
  onBack,
}: {
  mode: 'create' | 'edit' | 'supersede';
  entry?: DecisionLogEntry;
  onClose: () => void;
  onBack?: () => void;
}) {
  const create = useCreateDecision();
  const update = useUpdateDecision();
  const supersede = useSupersedeDecision();

  // edit prefiluje iz stare; supersede prefiluje kontekst ali očekuje NOVU odluku.
  const seed = mode === 'edit' ? entry : mode === 'supersede' ? entry : undefined;
  const [title, setTitle] = useState(seed?.title ?? '');
  const [decision, setDecision] = useState(mode === 'edit' ? (seed?.decision ?? '') : '');
  const [context, setContext] = useState(seed?.context ?? '');
  const [consequences, setConsequences] = useState(seed?.consequences ?? '');
  const [tagsStr, setTagsStr] = useState((seed?.tags ?? []).join(', '));
  const [related, setRelated] = useState(
    seed?.relatedRequestId != null ? String(seed.relatedRequestId) : '',
  );
  const [decidedOn, setDecidedOn] = useState(
    mode === 'edit' ? (seed?.decidedOn?.slice(0, 10) ?? today()) : today(),
  );
  const [err, setErr] = useState<string | null>(null);

  const busy = create.isPending || update.isPending || supersede.isPending;
  const titleLabel =
    mode === 'create'
      ? 'Nova odluka'
      : mode === 'edit'
        ? 'Ispravka odluke'
        : 'Zameni novom odlukom';

  function buildInput(): CreateDecisionInput {
    const tags = tagsStr
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const relatedNum = related.trim() ? Number(related) : undefined;
    return {
      title: title.trim(),
      decision: decision.trim(),
      context: context.trim() || undefined,
      consequences: consequences.trim() || undefined,
      tags,
      relatedRequestId: relatedNum,
      decidedOn,
    };
  }

  function submit() {
    setErr(null);
    if (!title.trim()) return setErr('Naslov je obavezan.');
    if (!decision.trim()) return setErr('Odluka (ŠTA je odlučeno) je obavezna.');

    const ok = () => {
      toast(
        mode === 'supersede'
          ? 'Nova odluka je zamenila staru.'
          : mode === 'edit'
            ? 'Odluka je ispravljena.'
            : 'Odluka je zabeležena.',
      );
      onClose();
    };
    const fail = (e: unknown) => setErr((e as Error).message);

    if (mode === 'create') create.mutate(buildInput(), { onSuccess: ok, onError: fail });
    else if (mode === 'supersede')
      supersede.mutate({ id: entry!.id, ...buildInput() }, { onSuccess: ok, onError: fail });
    else
      update.mutate(
        {
          id: entry!.id,
          patch: {
            title: title.trim(),
            decision: decision.trim(),
            context: context.trim() || null,
            consequences: consequences.trim() || null,
            tags: tagsStr.split(',').map((t) => t.trim()).filter(Boolean),
            relatedRequestId: related.trim() ? Number(related) : null,
            decidedOn,
          },
        },
        { onSuccess: ok, onError: fail },
      );
  }

  return (
    <Dialog
      open
      onClose={onBack ?? onClose}
      dismissable={false}
      size="lg"
      title={titleLabel}
      footer={
        <>
          <Button variant="ghost" onClick={onBack ?? onClose}>
            {onBack ? 'Nazad' : 'Otkaži'}
          </Button>
          <Button onClick={submit} loading={busy}>
            {mode === 'supersede' ? 'Zameni' : 'Sačuvaj'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        {mode === 'supersede' && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-2xs text-ink-secondary">
            Stara odluka „{entry?.title}" biće označena kao zamenjena; ovo je nov zapis.
          </p>
        )}
        <FormField label="Naslov" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </FormField>
        <FormField label="Odluka (ŠTA je odlučeno)" required>
          <Textarea value={decision} onChange={(e) => setDecision(e.target.value)} rows={3} />
        </FormField>
        <FormField label="Kontekst (ZAŠTO — alternative, okolnosti)">
          <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={3} />
        </FormField>
        <FormField label="Posledice">
          <Textarea
            value={consequences}
            onChange={(e) => setConsequences(e.target.value)}
            rows={2}
          />
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Tagovi (zarezom)">
            <Input
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="authz, storage"
            />
          </FormField>
          <FormField label="Veza na zahtev (ID)">
            <Input
              value={related}
              onChange={(e) => setRelated(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder="opciono"
            />
          </FormField>
          <FormField label="Datum odluke">
            <input
              type="date"
              value={decidedOn}
              onChange={(e) => setDecidedOn(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </FormField>
        </div>
      </div>
    </Dialog>
  );
}
