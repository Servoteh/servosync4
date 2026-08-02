'use client';

/**
 * Mobilni „Moji reversi" (/mob/reversi) — PLAN_MOB_3.0 Faza 2, talas C
 * (1.0 `/m/reversi` „myReversi" paritet). TANAK omotač nad četiri postojeća
 * „moja" endpointa (svi user-scoped na BE-u preko `req.user.email`):
 *   `useMyMachinesCutting` + `useMyCuttingOpenLines` → rezni alat na mojim mašinama,
 *   `useMyIssuedTools` → zaduženo na mene (ručni alat / oprema / LZO),
 *   `useMyConsumed` → potrošni materijal.
 * Semantika spajanja reznog alata (dedup po `lineId`, prednost `my-machines-cutting`,
 * grupisanje po mašini) i `isOverdue` su PRESLIKANI sa
 * `app/reversi/_components/moji-alati-tab.tsx` — bez nove poslovne logike.
 *
 * ⚠️ AUTHZ: `POST /reversi/return` i `/reversi/issue` traže `reversi.manage`
 * (magacioner). Dugmad povraćaja/izdavanja se zato prikazuju SAMO uz taj ključ —
 * na desktopu su vidljiva svima i operateru pucaju 403 na potvrdi. Radnik bez
 * `manage` dobija čist read-only prikaz + uputstvo. (Da li operater sme sam sebi
 * da razduži alat je ODLUKA NENADA — BE gate se ovde NE dira.)
 *
 * Gate ekrana: `reversi.read` (klasni BE gate modula). Static export: čista
 * statička ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, PackagePlus, RefreshCw, ScanLine } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useMyConsumed,
  useMyCuttingOpenLines,
  useMyIssuedTools,
  useMyMachinesCutting,
  type MyConsumedRow,
  type MyIssuedRow,
} from '@/api/reversi';
import { DocStatusBadge } from '@/app/reversi/_components/common';
import { QuickReturnDialog } from '@/app/reversi/_components/quick-return-dialog';
import { CuttingReturnDialog } from '@/app/reversi/_components/cutting-return-dialog';
import { IssueDialog } from '@/app/reversi/_components/issue-dialog';
import { MobPermissionsError } from '../_components/mob-refresh';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/**
 * Rok prekoračen — PRESLIKANO iz `moji-alati-tab.tsx` (poređenje `YYYY-MM-DD`
 * stringova, bez Date parse-a; izbegava TZ pomeranje datuma na telefonu).
 */
function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

/** Normalizovan red reznog alata (isti oblik kao desktop `CuttingCardRow`). */
interface CuttingCardRow {
  lineId: string;
  machineCode: string;
  barcode: string | null;
  naziv: string;
  klasa: string | null;
  remaining: number;
  returned: number;
  unit: string;
  signedBy: string | null;
  issuedAt: string | null;
  docNumber: string | null;
}

/**
 * Zaduženja su jedna lista na BE-u; LZO se izdvaja SAMO prikazno, po klasifikaciji
 * (`group_label`). Kad oznaka ne postoji, red ostaje u „Zaduženi alati" — isti
 * sadržaj kao desktop tabela (degradira na jednu sekciju, ništa se ne gubi).
 */
function isLzo(r: MyIssuedRow): boolean {
  const g = `${r.group_label ?? ''} ${r.subgroup_label ?? ''}`.toLowerCase();
  return /\blzo\b|zaštit|zastit/.test(g);
}

export default function MobReversiPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  const [quickReturn, setQuickReturn] = useState(false);
  const [cuttingReturn, setCuttingReturn] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);

  const allowed = can(PERMISSIONS.REVERSI_READ);
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  const issued = useMyIssuedTools();
  const consumed = useMyConsumed();
  const machines = useMyMachinesCutting();
  const openLines = useMyCuttingOpenLines();

  // Spajanje reznog alata — PARITET desktop `moji-alati-tab.tsx`: dedup po `lineId`,
  // prednost ima `my-machines-cutting` (bogatiji red), pa se dopuni otvorenim linijama.
  const cutting = useMemo(() => {
    const seen = new Set<string>();
    const rows: CuttingCardRow[] = [];
    for (const r of machines.data?.data ?? []) {
      const lineId = String(r.line_id);
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      rows.push({
        lineId,
        machineCode: r.recipient_machine_code || '—',
        barcode: r.barcode ?? null,
        naziv: r.naziv || r.oznaka || '',
        klasa: r.klasa ?? null,
        remaining: Number(r.remaining_quantity ?? r.quantity ?? 0),
        returned: Number(r.returned_quantity ?? 0),
        unit: r.unit || 'kom',
        signedBy: r.issued_to_employee_name ?? null,
        issuedAt: r.issued_at ?? null,
        docNumber: r.doc_number ?? null,
      });
    }
    for (const r of openLines.data?.data ?? []) {
      const lineId = String(r.lineId);
      if (seen.has(lineId)) continue;
      seen.add(lineId);
      rows.push({
        lineId,
        machineCode: r.machineCode || '—',
        barcode: r.barcode ?? null,
        naziv: r.naziv || r.oznaka || '',
        klasa: null,
        remaining: Number(r.remainingQty ?? 0),
        returned: Number(r.returnedQty ?? 0),
        unit: r.unit || 'kom',
        signedBy: null,
        issuedAt: r.issuedAt ?? null,
        docNumber: r.docNumber ?? null,
      });
    }
    const byMachine = new Map<string, CuttingCardRow[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machineCode) ?? [];
      list.push(r);
      byMachine.set(r.machineCode, list);
    }
    return { total: rows.length, keys: [...byMachine.keys()].sort(), byMachine };
  }, [machines.data, openLines.data]);

  const issuedRows = issued.data?.data ?? [];
  const tools = useMemo(() => issuedRows.filter((r) => !isLzo(r)), [issuedRows]);
  const lzo = useMemo(() => issuedRows.filter(isLzo), [issuedRows]);
  const consumedRows = consumed.data?.data ?? [];

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
    return <MobPermissionsError />;
  }
  if (!allowed) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup reversima — javite se administratoru (potrebno `reversi.read`).
      </main>
    );
  }

  const cuttingLoading = machines.isLoading || openLines.isLoading;
  const cuttingError = machines.isError || openLines.isError;

  return (
    <div className="min-h-dvh bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Moji reversi</h1>
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
        {/* Akcije — SAMO magacioner (`reversi.manage`); ostali dobijaju uputstvo. */}
        {manage ? (
          <div className="grid gap-2">
            <button
              onClick={() => setQuickReturn(true)}
              className={`flex min-h-14 items-center gap-3 rounded-panel bg-accent px-4 text-md font-semibold text-accent-fg active:opacity-90 ${FOCUS}`}
            >
              <ScanLine className="h-6 w-6 shrink-0" aria-hidden />
              Brzi povraćaj (skener)
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setCuttingReturn(true)}
                className={`flex min-h-14 items-center justify-center gap-2 rounded-panel border border-line bg-surface px-3 text-sm font-semibold text-ink active:bg-surface-2 ${FOCUS}`}
              >
                <RefreshCw className="h-5 w-5 shrink-0 text-accent" aria-hidden />
                Vrati rezni
              </button>
              <button
                onClick={() => setIssueOpen(true)}
                className={`flex min-h-14 items-center justify-center gap-2 rounded-panel border border-line bg-surface px-3 text-sm font-semibold text-ink active:bg-surface-2 ${FOCUS}`}
              >
                <PackagePlus className="h-5 w-5 shrink-0 text-accent" aria-hidden />
                Izdaj alat
              </button>
            </div>
          </div>
        ) : (
          <p className="rounded-panel border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
            Pregled tvojih zaduženja. Vraćanje ide preko magacionera.
          </p>
        )}

        {/* ── Rezni alat na mašinama ─────────────────────────────────────── */}
        <Section title="Rezni alat" count={cutting.total}>
          {cuttingError && (
            <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
              ⚠ Deo zaduženja nije učitan — prikaz može biti nepotpun.
            </p>
          )}
          {cuttingLoading ? (
            <Info>Učitavanje…</Info>
          ) : cutting.total === 0 ? (
            <Info>Nema reznog alata na tvojim mašinama.</Info>
          ) : (
            cutting.keys.map((code) => (
              <div key={code} className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                  Mašina {code} ({cutting.byMachine.get(code)?.length ?? 0})
                </h3>
                <ul className="space-y-2">
                  {(cutting.byMachine.get(code) ?? []).map((r) => (
                    <li key={r.lineId} className="rounded-panel border border-line bg-surface p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="tnums min-w-0 truncate text-sm font-bold text-ink">
                          {r.barcode || r.naziv || '—'}
                        </span>
                        <span className="tnums shrink-0 text-sm font-semibold text-ink">
                          {formatNumber(r.remaining)} {r.unit}
                        </span>
                      </div>
                      {r.naziv && <p className="text-xs text-ink-secondary">{r.naziv}</p>}
                      {r.klasa && <p className="text-xs text-ink-secondary">Klasa: {r.klasa}</p>}
                      {r.returned > 0 && (
                        <p className="tnums text-xs text-ink-secondary">
                          vraćeno {formatNumber(r.returned)} {r.unit}
                        </p>
                      )}
                      {r.signedBy && <p className="text-xs text-ink-secondary">Potpisao: {r.signedBy}</p>}
                      <p className="mt-1 text-xs text-ink-disabled">
                        Zadužen {r.issuedAt ? formatDate(r.issuedAt) : '—'}
                        {r.docNumber ? ` · ${r.docNumber}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </Section>

        {/* ── Zaduženi alati ─────────────────────────────────────────────── */}
        <Section title="Zaduženi alati" count={tools.length}>
          {issued.isLoading ? (
            <Info>Učitavanje…</Info>
          ) : issued.isError ? (
            <Info tone="danger">Greška pri učitavanju zaduženja.</Info>
          ) : tools.length === 0 ? (
            <Info>Trenutno nemaš zadužen alat ni opremu.</Info>
          ) : (
            <ul className="space-y-2">
              {tools.map((r) => (
                <IssuedCard key={`${r.document_id}-${r.oznaka}-${r.serijski_broj ?? ''}`} r={r} />
              ))}
            </ul>
          )}
        </Section>

        {/* ── LZO (prikazno izdvojeno iz istih zaduženja) ─────────────────── */}
        {lzo.length > 0 && (
          <Section title="LZO" count={lzo.length}>
            <ul className="space-y-2">
              {lzo.map((r) => (
                <IssuedCard key={`${r.document_id}-${r.oznaka}-${r.serijski_broj ?? ''}`} r={r} />
              ))}
            </ul>
          </Section>
        )}

        {/* ── Potrošeno ──────────────────────────────────────────────────── */}
        <Section title="Potrošeno" count={consumedRows.length}>
          {consumed.isLoading ? (
            <Info>Učitavanje…</Info>
          ) : consumed.isError ? (
            <Info tone="danger">Greška pri učitavanju potrošnje.</Info>
          ) : consumedRows.length === 0 ? (
            <Info>Nema evidentirane potrošnje na tvoje ime.</Info>
          ) : (
            <ul className="space-y-2">
              {consumedRows.map((r) => (
                <ConsumedCard key={r.ledger_id} r={r} />
              ))}
            </ul>
          )}
        </Section>
      </main>

      {quickReturn && <QuickReturnDialog onClose={() => setQuickReturn(false)} />}
      {cuttingReturn && <CuttingReturnDialog onClose={() => setCuttingReturn(false)} />}
      {manage && <IssueDialog open={issueOpen} onClose={() => setIssueOpen(false)} />}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-bold text-ink">{title}</h2>
        <span className="tnums rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-secondary">
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

function Info({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <p
      className={`rounded-panel border px-4 py-5 text-center text-sm ${
        tone === 'danger'
          ? 'border-status-danger/40 bg-status-danger-bg text-status-danger'
          : 'border-line bg-surface text-ink-secondary'
      }`}
    >
      {children}
    </p>
  );
}

function IssuedCard({ r }: { r: MyIssuedRow }) {
  const overdue = isOverdue(r.expected_return_date);
  return (
    <li
      className={`rounded-panel border p-3 ${
        overdue ? 'border-status-danger/50 bg-status-danger-bg' : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-bold text-ink">{r.oznaka}</span>
        <span className="tnums shrink-0 text-sm font-semibold text-ink">
          {formatNumber(Number(r.quantity))} {r.unit}
        </span>
      </div>
      <p className="text-sm text-ink">{r.naziv}</p>
      <p className="text-xs text-ink-secondary">
        {r.subgroup_label ?? r.group_label ?? '—'}
        {r.serijski_broj ? ` · ser. ${r.serijski_broj}` : ''}
        {r.pribor ? ` · pribor: ${r.pribor}` : ''}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-ink-secondary">
          {r.doc_number} · izdato {formatDate(r.issued_at)}
        </span>
        {r.expected_return_date && (
          <span
            className={overdue ? 'font-semibold text-status-danger' : 'text-ink-secondary'}
            title={overdue ? 'Prekoračen rok' : undefined}
          >
            rok {formatDate(r.expected_return_date)}
            {overdue ? ' !' : ''}
          </span>
        )}
        <span className="ml-auto">
          <DocStatusBadge status={r.document_status} />
        </span>
      </div>
    </li>
  );
}

function ConsumedCard({ r }: { r: MyConsumedRow }) {
  return (
    <li className="rounded-panel border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-bold text-ink">{r.oznaka}</span>
        {/* Ledger drži potrošnju kao NEGATIVNU količinu — prikaz je apsolutna (paritet desktopa). */}
        <span className="tnums shrink-0 text-sm font-semibold text-ink">
          {formatNumber(Math.abs(Number(r.quantity)))}
        </span>
      </div>
      <p className="text-sm text-ink">{r.naziv}</p>
      <p className="text-xs text-ink-secondary">
        {formatDate(r.consumed_at)}
        {r.doc_number ? ` · ${r.doc_number}` : ''}
      </p>
      {r.note && <p className="text-xs text-ink-secondary">{r.note}</p>}
    </li>
  );
}
