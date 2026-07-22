'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { Tabs } from '@/components/ui-kit/tabs';
import {
  useZahtev,
  REQUEST_KIND_LABEL,
  REQUEST_PRIORITY_LABEL,
  type ChangeRequestDetail,
  type RequestKind,
  type RequestPriority,
} from '@/api/zahtevi';
import { statusMeta } from '../_lib/status';
import { OwnerActions, AdminActions } from './_components/action-bars';
import { RequestTab } from './_components/request-tab';
import { QuestionsTab } from './_components/questions-tab';
import { HistoryTab } from './_components/history-tab';
import { AiTeaser } from './_components/ai-teaser';

/**
 * Zahtev — detalj (MODULE_SPEC §8). Header (reqNo + naslov + StatusBadge + meta
 * čipovi) + akcije po statusu i ulozi (owner / admin action-bar). Tabovi: Zahtev
 * (immutable original + prilozi), Pitanja (komentari), Istorija (events timeline).
 * AI tab stiže u F3 — ako detalj već vraća `analyses`, prikaže se samo minimalni
 * teaser (bez punog AI prikaza). Data isključivo kroz @/api/zahtevi.
 *
 * Detalj se refetch-uje na 4s DOK je AI korak u toku (ANALYSIS_APPROVED) ili dok
 * ima PENDING analize — front polluje trijažu/analizu (F3 obrazac §8), inače miruje.
 */

type Tab = 'zahtev' | 'pitanja' | 'istorija';

function chip(label: string) {
  return (
    <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">
      {label}
    </span>
  );
}

export default function ZahtevDetailPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const can = useCan();
  const isAdmin = can(PERMISSIONS.ZAHTEVI_ADMIN);

  const id = Number(params.id);
  const validId = Number.isInteger(id) && id > 0 ? id : null;

  const [tab, setTab] = useState<Tab>('zahtev');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const detailQuery = useZahtev(validId);
  const req = detailQuery.data?.data ?? null;

  // Poll dok je AI korak „u letu" (F3): ANALYSIS_APPROVED ili bilo koja PENDING analiza.
  const shouldPoll = useMemo(() => {
    if (!req) return false;
    if (req.status === 'ANALYSIS_APPROVED') return true;
    return req.analyses?.some((a) => a.status === 'PENDING') ?? false;
  }, [req]);
  const polledQuery = useZahtev(validId, { refetchInterval: shouldPoll ? 4000 : false });
  const detail = polledQuery.data?.data ?? req;

  const goBack = () => router.push('/zahtevi');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const notFound =
    validId != null && !detailQuery.isLoading && !detailQuery.error && detail === null;
  const s = detail ? statusMeta(detail.status) : null;

  const isOwner = detail != null && detail.createdByUserId === user.id;

  return (
    <AppShell>
      <PageHeader
        title={detail ? `Zahtev ${detail.reqNo}` : 'Zahtev'}
        count={s?.label}
        actions={
          <Button variant="ghost" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden />
            Nazad
          </Button>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-4 sm:p-6">
        {detailQuery.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(detailQuery.error as Error).message}
          </div>
        )}

        {detailQuery.isLoading ? (
          <div className="grid place-items-center py-16 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : notFound || !detail ? (
          <EmptyState
            title="Zahtev nije pronađen"
            hint="Zahtev je možda obrisan ili nemate pristup. Vratite se na listu."
          />
        ) : (
          <>
            <ZahtevHeader detail={detail} />

            {/* Akcije: owner (submit/withdraw/edit/delete/dopuna) + admin action-bar. */}
            <div className="space-y-3">
              {isOwner && <OwnerActions detail={detail} />}
              {isAdmin && <AdminActions detail={detail} />}
            </div>

            {/* AI teaser — SAMO ako detalj već ima analize (inače ništa; pun AI tab je F3). */}
            {detail.analyses.length > 0 && <AiTeaser count={detail.analyses.length} />}

            <Tabs<Tab>
              ariaLabel="Sekcije zahteva"
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'zahtev', label: 'Zahtev' },
                { key: 'pitanja', label: `Pitanja${detail.comments.length ? ` (${detail.comments.length})` : ''}` },
                { key: 'istorija', label: 'Istorija' },
              ]}
            />

            {tab === 'zahtev' && <RequestTab detail={detail} />}
            {tab === 'pitanja' && <QuestionsTab detail={detail} isAdmin={isAdmin} />}
            {tab === 'istorija' && <HistoryTab detail={detail} />}
          </>
        )}
      </div>
    </AppShell>
  );
}

/** Zaglavlje: naslov + StatusBadge + meta čipovi (modul/tip/prioritet/ocena). */
function ZahtevHeader({ detail }: { detail: ChangeRequestDetail }) {
  const s = statusMeta(detail.status);
  const score = detail.finalScore ?? detail.aiScore;
  const priority = (detail.priorityFinal ?? detail.priorityUser) as RequestPriority | null;
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink">{detail.title}</h1>
          <p className="mt-1 tnums text-sm text-ink-secondary">{detail.reqNo}</p>
        </div>
        <StatusBadge tone={s.tone} label={s.label} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {detail.module && chip(`Modul: ${detail.module}`)}
        {detail.kind && chip(`Tip: ${REQUEST_KIND_LABEL[detail.kind as RequestKind] ?? detail.kind}`)}
        {priority && chip(`Prioritet: ${REQUEST_PRIORITY_LABEL[priority] ?? priority}`)}
        {detail.areas.length > 0 && chip(`Oblasti: ${detail.areas.join(', ')}`)}
        {score != null &&
          chip(
            `Ocena: ${score}★${detail.finalScore == null ? ' (AI predlog)' : ''}`,
          )}
        {detail.rewardAmount &&
          chip(`Nagrada: ${detail.rewardAmount} RSD`)}
      </div>
      {detail.aiScoreReason && detail.status === 'REJECTED' && (
        <p className="mt-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          {detail.aiScoreReason}
        </p>
      )}
    </section>
  );
}
