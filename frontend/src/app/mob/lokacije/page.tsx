'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, ClipboardList, ScanLine, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import {
  lookupLocBarcode,
  useAllLocations,
  type LocBarcodeItemResult,
  type LocPlacement,
} from '@/api/lokacije';
import { ScanOverlay } from '@/app/lokacije/_components/scan-overlay';
import { MovementDialog, type MovementPreset } from '@/app/lokacije/_components/movement-dialog';
import {
  countPendingMovements,
  flushPendingMovements,
  installAutoFlush,
  subscribeQueue,
} from '@/lib/offlineQueue';

/**
 * MOBILNO premeštanje delova (paritet 1.0 „SERVOTEH MAGACIN") — skeniraj deo →
 * vidi gde stoji → premesti (skeniraj policu, količina, potvrdi). Orkestrira
 * POSTOJEĆE delove: ScanOverlay (kamera, ITEM/SHELF razrešavanje kroz backend)
 * i MovementDialog (stanje-čipovi, INITIAL/TRANSFER/„Neraspoređeno", offline
 * queue, idempotencija) — bez nove poslovne logike.
 *
 * ⚠️ Ruta je NAMERNO van `/m/*`: Cloudflare worker (`run_worker_first`) SVE
 * `/m/*` na javnom domenu proksira na 1.0 (pages.dev) — 3.0 stranica pod /m
 * ne bi bila dostupna sa telefona. Static export: čista statička ruta, bez [id].
 */

/** Placement-i sa stvarnom količinom (0-kom redovi su legacy/istorija — paritet
 *  filtera u MovementDialog-u; bez ovoga bi „Gde je deo?" nudio premeštanje sa
 *  prazne police, a heuristika tipa pokreta birala TRANSFER za nerazmešten deo). */
function withActiveRecords(r: LocBarcodeItemResult): LocBarcodeItemResult {
  return { ...r, records: r.records.filter((p) => Number(p.quantity) > 0) };
}

export default function MobLokacijePage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();
  // Kamera sken: 'move' = odmah u premeštanje; 'find' = samo pregled stanja.
  const [scan, setScan] = useState<null | 'move' | 'find'>(null);
  const [dialog, setDialog] = useState<{ preset?: MovementPreset } | null>(null);
  // Ključ montiranja dijaloga — preset se čita SAMO u useState inicijalizatorima
  // MovementDialog-a, pa svako novo otvaranje mora biti SVEŽ mount.
  const [dialogKey, setDialogKey] = useState(0);
  // „Gde je deo?" rezultat — poslednji ITEM sken sa placement-ima.
  const [found, setFound] = useState<LocBarcodeItemResult | null>(null);
  const [findBusy, setFindBusy] = useState(false);
  // Sequence guard: zakasneli refresh (stariji sken) ne sme da pregazi noviji.
  const findSeq = useRef(0);
  const [pending, setPending] = useState(0);
  const [flushBusy, setFlushBusy] = useState(false);
  const [flushMsg, setFlushMsg] = useState<string | null>(null);

  const locs = useAllLocations('true');
  const locById = useMemo(
    () => new Map((locs.data ?? []).map((l) => [l.id, l])),
    [locs.data],
  );

  // Offline queue: broj neposlatih + auto-flush kad se mreža vrati (paritet 1.0).
  useEffect(() => {
    installAutoFlush();
    setPending(countPendingMovements());
    return subscribeQueue(() => setPending(countPendingMovements()));
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Čekaj i dozvole (permissionsPending): can() je fail-closed dok permsQuery ne
  // stigne, pa bi ovlašćen radnik na svež login video lažni „Nemate pristup".
  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-screen place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  // Pad učitavanja dozvola (retry:false — ostaje za sesiju) ≠ stvarna zabrana.
  if (permissionsError) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Ne mogu da učitam tvoja prava (mreža?). Proveri vezu pa osveži stranicu.
      </main>
    );
  }

  if (!can(PERMISSIONS.LOKACIJE_READ)) {
    return (
      <main className="grid min-h-screen place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup lokacijama — javite se administratoru (potrebno `lokacije.read`).
      </main>
    );
  }

  const canMove = can(PERMISSIONS.LOKACIJE_MOVE);

  /** Osveži „Gde je deo?" panel posle premeštanja (isti raw barkod kroz backend). */
  async function refreshFound(raw: string) {
    const seq = ++findSeq.current;
    setFindBusy(true);
    try {
      const { data } = await lookupLocBarcode(raw);
      // Zakasneli odgovor starijeg zahteva se odbacuje (u međuvremenu nov sken).
      if (seq === findSeq.current && data.kind === 'ITEM') setFound(withActiveRecords(data));
    } catch {
      /* panel zadržava staro stanje — sledeći sken osvežava */
    } finally {
      if (seq === findSeq.current) setFindBusy(false);
    }
  }

  function openMoveFromItem(r: LocBarcodeItemResult, fromLocationId?: string) {
    // Zatvori skener EKSPLICITNO: u „Neprekidno" režimu overlay se posle pogotka
    // ne zatvara sam, pa bi kamera nastavila da skenira ISPOD dijaloga (novi
    // skenovi bi se tiho gutali, a moguće i premeštanje pogrešnog dela).
    setScan(null);
    setDialogKey((k) => k + 1);
    setDialog({
      preset: {
        orderNo: r.parsed.orderNo,
        itemRefId: r.parsed.itemRefId,
        drawingNo: r.parsed.drawingNo || undefined,
        fromLocationId,
        // Deo bez ijednog stvarnog smeštaja → prvo zaduženje; inače premeštanje.
        movementType: r.records.length > 0 ? 'TRANSFER' : 'INITIAL_PLACEMENT',
      },
    });
  }

  /** Ručno slanje neposlatih: bez mreže NE troši pokušaje (MAX_ATTEMPTS guard). */
  async function onFlush() {
    if (flushBusy) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setFlushMsg('Nema mreže — neposlato se šalje automatski čim se veza vrati.');
      return;
    }
    setFlushBusy(true);
    setFlushMsg(null);
    try {
      const res = await flushPendingMovements();
      if (res.dropped > 0)
        setFlushMsg(`⚠ Odbačeno ${res.dropped} zapisa (previše neuspelih pokušaja) — proveri stanje police.`);
      else if (res.failed > 0)
        setFlushMsg(`Nije prošlo ${res.failed} — pokušaće ponovo automatski.`);
      else setFlushMsg(null);
    } finally {
      setFlushBusy(false);
    }
  }

  const bigBtn =
    'flex w-full items-center gap-4 rounded-panel border-2 border-line bg-surface px-5 py-5 text-left text-lg font-semibold text-ink active:bg-surface-2';

  return (
    <div className="min-h-screen bg-app pb-24">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-bold text-ink">Lokacije — premeštanje</h1>
          {pending > 0 ? (
            <button
              onClick={() => void onFlush()}
              disabled={flushBusy}
              className="rounded-full bg-status-warn-bg px-3 py-1 text-xs font-semibold text-status-warn disabled:opacity-60"
            >
              {flushBusy ? 'Slanje…' : `⏳ ${pending} čeka — pošalji`}
            </button>
          ) : (
            <span className="rounded-full bg-status-success-bg px-3 py-1 text-xs font-semibold text-status-success">
              ✓ sinhronizovano
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-secondary">{user.fullName ?? user.email}</p>
        {flushMsg && <p className="mt-1 text-xs text-status-warn">{flushMsg}</p>}
      </header>

      <main className="space-y-3 p-4">
        {canMove ? (
          <button onClick={() => setScan('move')} className={bigBtn}>
            <ScanLine className="h-8 w-8 shrink-0 text-accent" aria-hidden />
            <span>
              SKENIRAJ DEO
              <span className="block text-sm font-normal text-ink-secondary">
                nalepnica → stanje → polica → premesti
              </span>
            </span>
          </button>
        ) : (
          <p className="rounded-panel border border-line bg-surface px-4 py-3 text-sm text-ink-secondary">
            Imate pregled bez prava premeštanja (`lokacije.move`).
          </p>
        )}

        <button onClick={() => setScan('find')} className={bigBtn}>
          <Search className="h-8 w-8 shrink-0 text-accent" aria-hidden />
          <span>
            GDE JE DEO?
            <span className="block text-sm font-normal text-ink-secondary">
              skeniraj nalepnicu — samo pregled stanja
            </span>
          </span>
        </button>

        {canMove && (
          <button
            onClick={() => {
              setDialogKey((k) => k + 1);
              setDialog({});
            }}
            className={bigBtn}
          >
            <ClipboardList className="h-8 w-8 shrink-0 text-accent" aria-hidden />
            <span>
              RUČNI UNOS
              <span className="block text-sm font-normal text-ink-secondary">
                bez kamere — broj naloga / TP
              </span>
            </span>
          </button>
        )}

        {/* „Gde je deo?" — placement-i poslednjeg skena + „Premesti odavde". */}
        {found && (
          <section className="rounded-panel border border-line bg-surface p-4">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold text-ink">
                {found.parsed.orderNo ? `Nalog ${found.parsed.orderNo} · ` : ''}
                {found.parsed.itemRefId}
                {found.parsed.drawingNo ? ` · crtež ${found.parsed.drawingNo}` : ''}
              </h2>
              {findBusy && <span className="text-xs text-ink-secondary">Osvežavam…</span>}
            </div>
            {found.records.length === 0 ? (
              <p className="text-sm text-ink-secondary">
                Nema zabeleženog smeštaja — deo je „nerazmešten".
              </p>
            ) : (
              <ul className="space-y-2">
                {found.records.map((p: LocPlacement) => {
                  const loc = locById.get(p.locationId);
                  return (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-3 rounded-control border border-line-soft bg-surface-2 px-3 py-2.5"
                    >
                      <span className="min-w-0 text-sm text-ink">
                        <span className="font-semibold">
                          {loc ? loc.locationCode : p.locationId.slice(0, 8)}
                        </span>
                        {loc?.name ? <span className="text-ink-secondary"> — {loc.name}</span> : null}
                        <span className="tnums block text-ink-secondary">{String(p.quantity)} kom</span>
                      </span>
                      {canMove && (
                        <button
                          onClick={() => openMoveFromItem(found, p.locationId)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-accent px-3 py-2 text-sm font-semibold text-accent-fg"
                        >
                          <ArrowLeftRight className="h-4 w-4" aria-hidden />
                          Premesti
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </main>

      {scan && (
        <ScanOverlay
          title={scan === 'move' ? 'Skeniraj nalepnicu dela' : 'Skeniraj — gde je deo?'}
          accept={['ITEM']}
          onResult={(r) => {
            if (r.kind !== 'ITEM') return;
            const item = withActiveRecords(r);
            // Poništi eventualni zakasneli refresh — ovaj sken je sad najnoviji.
            findSeq.current++;
            setFound(item);
            setFindBusy(false);
            if (scan === 'move') openMoveFromItem(item);
          }}
          onClose={() => setScan(null)}
        />
      )}

      {dialog && (
        <MovementDialog
          key={dialogKey}
          preset={dialog.preset}
          onClose={() => {
            setDialog(null);
            // Posle premeštanja osveži prikaz stanja (ako je panel otvoren).
            if (found) void refreshFound(found.parsed.raw);
          }}
        />
      )}
    </div>
  );
}
