'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDecimal } from '@/lib/format';
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
import { AiTab } from './_components/ai-tab';

/**
 * Zahtev — detalj (MODULE_SPEC §8). Header (reqNo + naslov + StatusBadge + meta
 * čipovi) + akcije po statusu i ulozi (owner / admin action-bar). Tabovi: Zahtev
 * (immutable original + prilozi), Pitanja (komentari), Istorija (events timeline).
 * Tab „AI analiza" (F3): trijaža/detaljna/duplikati/Claude paket/pitanja. Data
 * isključivo kroz @/api/zahtevi.
 *
 * Detalj se refetch-uje na 4s DOK je AI korak u toku (ANALYSIS_APPROVED) ili dok
 * ima PENDING analize — front polluje trijažu/analizu (§8), inače miruje.
 */

type Tab = 'zahtev' | 'ai' | 'pitanja' | 'istorija';

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
  const can = useCan();
  const isAdmin = can(PERMISSIONS.ZAHTEVI_ADMIN);

  // Statička ruta `?id=N` umesto `[id]` segmenta: dinamički segmenti NE rade na
  // static exportu — klijentska navigacija traži neizvezen prerender pa hard-404
  // (incident 22.07; [id] obrazac ostaje samo za 4.0 module na dev serveru).
  // Bez useSearchParams — on bi u output:export tražio Suspense oko cele stranice.
  const [validId, setValidId] = useState<number | null>(null);
  const [idResolved, setIdResolved] = useState(false);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('id');
    const n = raw ? Number(raw) : NaN;
    setValidId(Number.isInteger(n) && n > 0 ? n : null);
    setIdResolved(true);
  }, []);

  const [tab, setTab] = useState<Tab>('zahtev');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const detailQuery = useZahtev(validId);
  const req = detailQuery.data?.data ?? null;

  // Poll dok je AI korak „u letu" (F3): ANALYSIS_APPROVED ili bilo koja PENDING analiza.
  const aiInFlight = useMemo(() => {
    if (!req) return false;
    if (req.status === 'ANALYSIS_APPROVED') return true;
    return req.analyses?.some((a) => a.status === 'PENDING') ?? false;
  }, [req]);

  // F8b: polling se GASI posle ~5 min (zombie-PENDING zaštita) — inače bi FE polovao beskrajno
  // ako AI red nikad ne pređe iz PENDING (npr. proces pao pre nego upiše FAILED). Po isteku:
  // banner + „Pokušaj ponovo" (re-armuje tajmer + refetch). MAX_POLL_MS = 5 min, interval 4s.
  const MAX_POLL_MS = 5 * 60 * 1000;
  const pollStartRef = useRef<number | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  useEffect(() => {
    if (aiInFlight) {
      if (pollStartRef.current == null) pollStartRef.current = Date.now();
    } else {
      // AI više nije „u letu" → resetuj tajmer i banner za sledeći ciklus.
      pollStartRef.current = null;
      setPollTimedOut(false);
    }
  }, [aiInFlight]);

  const shouldPoll = aiInFlight && !pollTimedOut;
  const polledQuery = useZahtev(validId, { refetchInterval: shouldPoll ? 4000 : false });
  const detail = polledQuery.data?.data ?? req;

  // Kad polling traje duže od MAX_POLL_MS a AI je i dalje „u letu" → prekini i pokaži banner.
  useEffect(() => {
    if (!shouldPoll) return;
    const started = pollStartRef.current;
    if (started == null) return;
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, MAX_POLL_MS - elapsed);
    const t = setTimeout(() => setPollTimedOut(true), remaining);
    return () => clearTimeout(t);
  }, [shouldPoll, polledQuery.dataUpdatedAt, MAX_POLL_MS]);

  const retryPoll = () => {
    pollStartRef.current = Date.now();
    setPollTimedOut(false);
    void polledQuery.refetch();
  };

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
    (idResolved && validId == null) ||
    (validId != null && !detailQuery.isLoading && !detailQuery.error && detail === null);
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

        {!idResolved || detailQuery.isLoading ? (
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

            {/* F8b: AI korak predugo „u letu" (polling istekao) → poruka + Pokušaj ponovo. */}
            {pollTimedOut && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-status-warn">
                <span>
                  AI obrada traje neuobičajeno dugo. Osvežavanje je zaustavljeno. Pokušajte
                  ponovo ili pokrenite ponovnu obradu u tabu „AI analiza".
                </span>
                <Button variant="ghost" onClick={retryPoll}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Pokušaj ponovo
                </Button>
              </div>
            )}

            {/* Akcije: owner (submit/withdraw/edit/delete/dopuna) + admin action-bar. */}
            <div className="space-y-3">
              {isOwner && <OwnerActions detail={detail} />}
              {isAdmin && <AdminActions detail={detail} />}
            </div>

            <Tabs<Tab>
              ariaLabel="Sekcije zahteva"
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'zahtev', label: 'Zahtev' },
                { key: 'ai', label: `AI analiza${detail.analyses.length ? ` (${detail.analyses.length})` : ''}` },
                { key: 'pitanja', label: `Pitanja${detail.comments.length ? ` (${detail.comments.length})` : ''}` },
                { key: 'istorija', label: 'Istorija' },
              ]}
            />

            {tab === 'zahtev' && <RequestTab detail={detail} />}
            {tab === 'ai' && <AiTab detail={detail} isAdmin={isAdmin} />}
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
          chip(`Nagrada: ${formatDecimal(detail.rewardAmount)} RSD`)}
      </div>
      {detail.aiScoreReason && detail.status === 'REJECTED' && (
        <p className="mt-3 rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
          {detail.aiScoreReason}
        </p>
      )}
    </section>
  );
}
