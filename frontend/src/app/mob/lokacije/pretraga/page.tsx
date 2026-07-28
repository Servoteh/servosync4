'use client';

/**
 * Mobilna „Gde je crtež?" (/mob/lokacije/pretraga) — PLAN_MOB_3.0 Faza 2, talas C
 * (1.0 `/m/lookup` paritet). TANAK omotač nad `loc_report_parts_by_locations`
 * (`useReportByLocation`) + autosugestija naziva dela (`useReportSuggest`).
 * Referentni desktop: `app/lokacije/_components/report-tab.tsx` — ista dva filtera
 * (`drawingNo`, `nazivDela`) i isto razrešavanje hale (RPC `hall_code`, a za mašinu
 * 2+ nivoa ispod hale prazno → ostaje samo šifra police). Bez nove poslovne logike.
 *
 * Gate: `lokacije.read`. Static export: čista statička ruta, bez `[id]` i bez
 * `useSearchParams`.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, Search, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { useReportByLocation, useReportSuggest, type ReportRow } from '@/api/lokacije';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Koliko redova povlačimo na telefon (BE klampuje na 500; ovde je pregled, ne izvoz). */
const PAGE_SIZE = 100;

const s = (v: unknown): string => (v == null ? '' : String(v)).trim();

export default function MobLokacijePretragaPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  // Dva filtera, kao na desktopu: broj crteža (kucanje) i naziv dela (iz sugestije).
  const [drawingNo, setDrawingNo] = useState('');
  const [nazivDela, setNazivDela] = useState('');
  // Debounce kucanja: svaki karakter bi inače okinuo pun RPC preko mobilne mreže.
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(drawingNo.trim()), 350);
    return () => clearTimeout(t);
  }, [drawingNo]);

  const allowed = can(PERMISSIONS.LOKACIJE_READ);
  const hasFilter = debounced.length > 0 || nazivDela.length > 0;
  const q = useReportByLocation(
    {
      drawingNo: debounced || undefined,
      nazivDela: nazivDela || undefined,
      page: 1,
      pageSize: PAGE_SIZE,
    },
    allowed && hasFilter,
  );
  // Sugestije naziva dela — isti hook kao desktop (prag 2 znaka je u hook-u).
  const suggest = useReportSuggest(drawingNo);
  const suggestions = useMemo(
    () => (nazivDela ? [] : (suggest.data?.data ?? []).slice(0, 8)),
    [suggest.data, nazivDela],
  );

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
        Nemate pristup lokacijama — javite se administratoru (potrebno `lokacije.read`).
      </main>
    );
  }

  const rows = q.data?.data.rows ?? [];
  const total = q.data?.data.total ?? 0;

  return (
    <div className="min-h-screen bg-app pb-16">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-md font-semibold text-ink">Gde je crtež?</h1>
          <p className="truncate text-xs text-ink-secondary">pretraga smeštaja po broju crteža</p>
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
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-disabled"
            aria-hidden
          />
          <input
            value={drawingNo}
            onChange={(e) => setDrawingNo(e.target.value)}
            inputMode="search"
            enterKeyHint="search"
            aria-label="Broj crteža"
            placeholder="Broj crteža — npr. 1091063"
            // text-md = 16 px: ispod toga iOS Safari zumira stranicu na fokus polja.
            className={`h-14 w-full rounded-panel border border-line bg-surface pl-11 pr-11 text-md text-ink outline-none focus:border-accent ${FOCUS}`}
          />
          {drawingNo && (
            <button
              onClick={() => setDrawingNo('')}
              aria-label="Očisti pretragu"
              className={`absolute right-1.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-control text-ink-secondary active:bg-surface-2 ${FOCUS}`}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          )}
        </div>

        {/* Sugestije naziva dela (paritet desktop filtera „Naziv dela"): tap na red
            sa brojem crteža pretražuje po crtežu, inače postavlja filter naziva. */}
        {suggestions.length > 0 && (
          <ul className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
            {suggestions.map((sg, i) => (
              <li key={`${sg.naziv_dela}|${i}`}>
                <button
                  onClick={() => {
                    const bc = s(sg.broj_crteza);
                    if (bc) {
                      setNazivDela('');
                      setDrawingNo(bc);
                    } else {
                      setDrawingNo('');
                      setNazivDela(sg.naziv_dela);
                    }
                  }}
                  className={`flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left active:bg-surface-2 ${FOCUS}`}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{sg.naziv_dela}</span>
                  {s(sg.broj_crteza) && (
                    <span className="tnums shrink-0 text-xs text-ink-secondary">
                      {s(sg.broj_crteza)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {nazivDela && (
          <button
            onClick={() => setNazivDela('')}
            className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-accent bg-accent-subtle px-3 text-sm text-accent ${FOCUS}`}
          >
            Naziv: {nazivDela}
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}

        {!hasFilter ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Unesi broj crteža (ili izaberi naziv iz predloga) da vidiš gde deo stoji.
          </p>
        ) : q.isLoading ? (
          <p className="py-8 text-center text-sm text-ink-secondary">Tražim…</p>
        ) : q.isError ? (
          <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
            Greška pri pretrazi. Proveri vezu pa pokušaj ponovo.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
            Nema zabeleženog smeštaja za ovaj upit.
          </p>
        ) : (
          <>
            <p className="tnums text-xs text-ink-secondary">
              {total} {total === 1 ? 'zapis' : 'zapisa'}
              {total > rows.length ? ` · prikazano prvih ${rows.length}` : ''}
            </p>
            <ul className="space-y-2">
              {rows.map((r, i) => (
                <PlaceRow key={s(r.placement_id) || `${s(r.item_ref_id)}|${s(r.location_code)}|${i}`} r={r} />
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

function PlaceRow({ r }: { r: ReportRow }) {
  const hall = s(r.hall_code);
  const loc = s(r.location_code) || '—';
  const qty = s(r.qty_on_location);
  const rn = s(r.order_no);
  const crtez = s(r.drawing_no) || s(r.wo_broj_crteza);

  return (
    <li className="rounded-panel border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-md font-semibold text-ink">
          {hall ? <span className="text-ink-secondary">{hall} · </span> : null}
          {loc}
        </span>
        <span className="tnums shrink-0 text-md font-bold text-ink">{qty || '—'} kom</span>
      </div>
      {s(r.location_name) && (
        <p className="truncate text-xs text-ink-secondary">{s(r.location_name)}</p>
      )}
      <p className="mt-1 text-sm text-ink">
        {rn ? <span className="font-semibold">RN {rn}</span> : null}
        {rn && crtez ? ' · ' : ''}
        {crtez ? <span className="tnums">crtež {crtez}</span> : null}
      </p>
      {s(r.naziv_dela) && <p className="text-xs text-ink-secondary">{s(r.naziv_dela)}</p>}
      {s(r.komada_rn) && (
        <p className="tnums text-xs text-ink-secondary">na nalogu: {s(r.komada_rn)} kom</p>
      )}
    </li>
  );
}
