'use client';

/**
 * Mobilno BATCH dodavanje na policu (/mob/lokacije/batch) — PLAN_MOB_3.0 Faza 2,
 * talas C (1.0 `/m/batch` „mobileBatch" paritet): izaberi JEDNU odredišnu policu →
 * skeniraj delove u nizu → pošalji sve.
 *
 * ── SEMANTIKA „DODAJ NA POLICU" (odluka Nenada 01.08.2026) ───────────────────
 * Batch UVEK šalje `INITIAL_PLACEMENT` BEZ `fromLocationId`: količina se DODAJE na
 * odredišnu policu, izvorna se NE prazni. To je doslovan paritet 1.0
 * (`src/ui/mobile/mobileBatch.js` → „Härd-1: INITIAL_PLACEMENT akumulira, opcija B"),
 * gde je batch alat za „upiši šta si stavio na ovu policu", a ne za strogo
 * premeštanje. Nenad: „može semantika i u 3.0 da bude dodaj na policu da ne menjamo
 * navike ljudi".
 *
 * Šta je time OTPALO (ekran je ranije sam birao tip pokreta):
 *  · heuristika „ima aktivan smeštaj → TRANSFER" — tip je sada uvek INITIAL_PLACEMENT;
 *  · izbor POLAZNE lokacije (čipovi) — `fromLocationId` se ne šalje, pa bi kontrola
 *    postavljala vrednost koju niko ne čita; smeštaji su ostali samo kao INFORMACIJA
 *    („deo sad stoji tu i tu"), da radnik vidi zatečeno stanje pre slanja;
 *  · preskakanje stavke koja je već na odredišnoj polici — pod novom semantikom to
 *    NIJE greška nego dopuna: DB trigger `loc_after_movement_insert` radi
 *    `ON CONFLICT (…) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`, dakle
 *    uredno sabira. Umesto tihog preskakanja stoji vidljivo upozorenje da se DODAJE.
 *  · podrazumevana količina „sve sa izvorne police" — imala je smisla samo za
 *    premeštanje; sada je 1 po skenu, kao u 1.0 (ponovljen sken iste stavke = +1).
 *
 * ⚠️ Pojedinačno premeštanje (`MovementDialog` sa `/mob/lokacije`) se NE menja —
 * tamo ostaje pun izbor tipa pokreta (TRANSFER / INITIAL / korekcija).
 *
 * Ostalo je nepromenjeno u odnosu na `movement-dialog.tsx`:
 *  - `itemRefTable`: iz placement-a, fallback `bigtehn_rn` (ne zavisi od tipa pokreta),
 *  - ključevi naloga/stavke kroz `normalizeLocMovementKeys` pre slanja,
 *  - offline: `enqueueMovement` sa ISTIM `clientEventUuid` (idempotentan retry).
 *
 * Slanje je SEKVENCIJALNO (ne paralelno) — `loc_create_movement` menja stanje police,
 * a red po red daje čitljiv progres i ostavlja tačno one stavke koje nisu prošle.
 *
 * Gate: `lokacije.move` (kao dugme „SKENIRAJ DEO" na `/mob/lokacije`); ekran je iza
 * `lokacije.read`. Static export: čista statička ruta, bez `[id]`/`useSearchParams`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronLeft, Plus, ScanLine, Search, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui-kit/button';
import { ScanOverlay } from '@/app/lokacije/_components/scan-overlay';
import {
  filterLocationOptions,
  isStorageLocation,
  locOptionsTruncatedHint,
} from '@/app/lokacije/_components/location-select';
import { normalizeLocMovementKeys } from '@/app/lokacije/_components/label-build';
import {
  newClientEventUuid,
  postMovement,
  useAllLocations,
  type LocBarcodeItemResult,
  type LocLocation,
  type LocPlacement,
  type MovementVars,
} from '@/api/lokacije';
import {
  countPendingMovements,
  enqueueMovement,
  installAutoFlush,
  subscribeQueue,
} from '@/lib/offlineQueue';
import { MobPermissionsError } from '../../_components/mob-refresh';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/**
 * Mrežni pad (fetch nije stigao do servera) → offline queue umesto tvrdog pada.
 * KLON `isNetworkError` iz `movement-dialog.tsx` (tamo je modul-privatan; ne
 * menjamo taj fajl) — klasifikacija MORA ostati identična u oba toka.
 */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const status = (e as { status?: number } | null)?.status;
  if (typeof status === 'number') return false; // server je odgovorio → nije mrežni pad
  const msg = String((e as { message?: string } | null)?.message ?? e ?? '').toLowerCase();
  return /failed to fetch|network|load failed|timeout|ecconn|offline/.test(msg);
}

type LineStatus = 'pending' | 'sending' | 'done' | 'queued' | 'error';

interface BatchLine {
  key: string;
  /** Idempotency ključ — generisan JEDNOM po stavci; retry nosi isti (DB fn dedup). */
  clientEventUuid: string;
  orderNo: string;
  itemRefId: string;
  drawingNo: string;
  itemRefTable: string;
  /**
   * Zatečeni smeštaji (qty > 0) — čisto INFORMATIVNO („deo sad stoji tu i tu").
   * Pod semantikom „dodaj na policu" se NE šalju: `fromLocationId` ne postoji, pa
   * ovo nije izbor nego prikaz stanja pre slanja.
   */
  placements: LocPlacement[];
  qty: string;
  status: LineStatus;
  error: string | null;
}

const num = (v: unknown): number => Number(v ?? 0);

/** Placement-i sa stvarnom količinom (0-kom redovi su legacy/istorija — paritet `/mob/lokacije`). */
function activePlacements(r: LocBarcodeItemResult): LocPlacement[] {
  return r.records.filter((p) => num(p.quantity) > 0);
}

function lineFromScan(r: LocBarcodeItemResult): BatchLine {
  const placements = [...activePlacements(r)].sort((a, b) => num(b.quantity) - num(a.quantity));
  return {
    key: `${r.parsed.orderNo}|${r.parsed.itemRefId}`,
    clientEventUuid: newClientEventUuid(),
    orderNo: r.parsed.orderNo,
    itemRefId: r.parsed.itemRefId,
    drawingNo: r.parsed.drawingNo || '',
    // Tabela stavke ne zavisi od tipa pokreta — uzima se iz zatečenog smeštaja,
    // fallback `bigtehn_rn` (isti default kao MovementDialog).
    itemRefTable: placements[0]?.itemRefTable || 'bigtehn_rn',
    placements,
    // 1 po skenu (paritet 1.0 `mobileBatch`): radnik u ruci ima jedan komad koji
    // stavlja na policu. „Sve sa izvorne police" je bila podrazumevana vrednost
    // PREMEŠTANJA; pod „dodaj na policu" bi ista brojka udvostručila stanje.
    qty: '1',
    status: 'pending',
    error: null,
  };
}

export default function MobLokacijeBatchPage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  const [dest, setDest] = useState<LocLocation | null>(null);
  const [lines, setLines] = useState<BatchLine[]>([]);
  const [scan, setScan] = useState<null | 'shelf' | 'items'>(null);
  const [destQuery, setDestQuery] = useState('');
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [pending, setPending] = useState(0);

  // `sendAll` je DUGA sekvencijalna petlja (red po red, mreža između): korisnik u
  // međuvremenu menja količinu ili briše red, a `patch()` pravi NOVE objekte —
  // snapshot iz zatvarača petlje bi poslao ZASTARELU količinu i tiho progutao
  // ispravku (ISPRAVKA 01.08). Zato petlja čita svež red iz ovog ref-a, po ključu.
  const linesRef = useRef<BatchLine[]>(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  const locs = useAllLocations('true');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);
  const locById = useMemo(() => new Map(locList.map((l) => [l.id, l])), [locList]);

  // Kandidati za odredište: SKLADIŠNE lokacije sem mašina (paritet MovementDialog
  // `destLocations` bez čekiranog „Prikaži i mašine kao destinaciju"; prijava
  // 04.08: reversi zaduženja „ZADU-* — Zaduzeno: …" iskakala u izboru police —
  // `isStorageLocation` ih seče na OBA ekrana). Filter/limit/redosled idu
  // kroz ZAJEDNIČKI `filterLocationOptions` sa `LocationSelect`-om — ovaj ekran
  // je sekao na 30 od 1.357 lokacija bez ijedne poruke, ista prijava iz pogona
  // kao za desktop picker (01.08). `shelvesFirst`: korak je „izaberi policu".
  const { items: destOptions, total: destTotal } = useMemo(
    () =>
      filterLocationOptions(
        locList.filter((l) => isStorageLocation(l) && l.locationType !== 'MACHINE'),
        destQuery,
        { shelvesFirst: true },
      ),
    [locList, destQuery],
  );
  const destHint = locOptionsTruncatedHint(
    destOptions.length,
    destTotal,
    destQuery.trim() !== '',
  );

  // Offline queue: broj neposlatih + auto-flush kad se mreža vrati (paritet `/mob/lokacije`).
  useEffect(() => {
    installAutoFlush();
    setPending(countPendingMovements());
    return subscribeQueue(() => setPending(countPendingMovements()));
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/mob/prijava');
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
  if (!can(PERMISSIONS.LOKACIJE_READ)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Nemate pristup lokacijama — javite se administratoru (potrebno `lokacije.read`).
      </main>
    );
  }
  if (!can(PERMISSIONS.LOKACIJE_MOVE)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Imate pregled bez prava premeštanja (`lokacije.move`) — batch nije dostupan.
      </main>
    );
  }

  /** Stavka već ima smeštaj na odredišnoj polici → količina se DODAJE na zatečenu. */
  function isAtDest(l: BatchLine): boolean {
    return !!dest && l.placements.some((p) => p.locationId === dest.id);
  }
  const sendable = lines.filter((l) => l.status !== 'done' && l.status !== 'queued');

  function addScanned(r: LocBarcodeItemResult) {
    const fresh = lineFromScan(r);
    setLines((prev) => {
      // Ponovljen sken iste stavke = +1 kom (paritet 1.0 `mobileBatch`: „skenirao
      // jednom iste stvari = +1 automatski"). Red se NE duplira — ključ je
      // nalog+stavka. Skener ne može da naduva brojku sam od sebe: `ScanOverlay`
      // pušta isti kod tek kad napusti kadar (re-arm gejt), pa je jedan svestan
      // sken = jedan komad. Već poslat/queue-ovan red se ne dira.
      const idx = prev.findIndex((l) => l.key === fresh.key);
      if (idx < 0) return [...prev, fresh];

      const cur = prev[idx];
      if (cur.status === 'done' || cur.status === 'queued' || cur.status === 'sending') {
        toast(`${fresh.itemRefId} je već poslat — dodaj ga kao nov unos posle slanja.`);
        return prev;
      }
      const next = String((Number(cur.qty) || 0) + 1);
      toast(`+1 ${fresh.itemRefId} (ukupno ${next})`);
      return prev.map((l, i) => (i === idx ? { ...l, qty: next, status: 'pending', error: null } : l));
    });
  }

  function patch(key: string, p: Partial<BatchLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...p } : l)));
  }

  /** Sekvencijalno slanje: red po red, progres N/M, greška ostavlja red u listi. */
  async function sendAll() {
    if (!dest || sending) return;
    const targets = lines.filter((l) => l.status !== 'done' && l.status !== 'queued');
    if (targets.length === 0) return;

    setSending({ done: 0, total: targets.length });
    let done = 0;
    for (const t of targets) {
      // SVEŽE stanje reda (ključ je stabilan: nalog+stavka) — količina koju je
      // korisnik izmenio dok slanje traje MORA da bude ona koja se šalje; red
      // obrisan u međuvremenu se preskače, ali i dalje broji u progresu N/M.
      const l = linesRef.current.find((x) => x.key === t.key);
      if (!l || l.status === 'done' || l.status === 'queued') {
        done += 1;
        setSending({ done, total: targets.length });
        continue;
      }
      const qty = Number(l.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        patch(l.key, { status: 'error', error: 'Količina mora biti veća od 0.' });
        done += 1;
        setSending({ done, total: targets.length });
        continue;
      }
      patch(l.key, { status: 'sending', error: null });

      // Paritet MovementDialog: kanonizuj nalog+stavku (dash/slash/9400) pre slanja.
      const norm = normalizeLocMovementKeys(l.orderNo, l.itemRefId);
      const payload: MovementVars = {
        clientEventUuid: l.clientEventUuid,
        itemRefTable: l.itemRefTable,
        itemRefId: norm.itemRefId,
        // „Dodaj na policu" (odluka 01.08): UVEK INITIAL_PLACEMENT i BEZ polazne
        // lokacije — 1:1 sa 1.0 `mobileBatch` payload-om. DB fn ionako nulira
        // `from` za ovaj tip, ali ga ne šaljemo ni da bi namera bila očigledna.
        movementType: 'INITIAL_PLACEMENT',
        orderNo: norm.orderNo || undefined,
        drawingNo: l.drawingNo || undefined,
        quantity: qty,
        toLocationId: dest.id,
      };

      // Offline: bez pokušaja mreže — direktno u queue (paritet 1.0 !navigator.onLine).
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        try {
          enqueueMovement(payload);
          patch(l.key, { status: 'queued', error: null });
        } catch (e) {
          patch(l.key, {
            status: 'error',
            error: `Lokalno skladište puno/nedostupno — NIJE sačuvano. (${
              e instanceof Error ? e.message : String(e)
            })`,
          });
        }
      } else {
        try {
          await postMovement(payload);
          patch(l.key, { status: 'done', error: null });
        } catch (e) {
          if (isNetworkError(e)) {
            try {
              enqueueMovement(payload);
              patch(l.key, { status: 'queued', error: null });
            } catch (qe) {
              patch(l.key, {
                status: 'error',
                error: `Mreža pala, a lokalno skladište nije dostupno. (${
                  qe instanceof Error ? qe.message : String(qe)
                })`,
              });
            }
          } else {
            patch(l.key, {
              status: 'error',
              error: e instanceof Error ? e.message : 'Premeštanje nije uspelo.',
            });
          }
        }
      }
      done += 1;
      setSending({ done, total: targets.length });
    }
    setSending(null);
  }

  const okCount = lines.filter((l) => l.status === 'done').length;
  const queuedCount = lines.filter((l) => l.status === 'queued').length;
  const errCount = lines.filter((l) => l.status === 'error').length;

  return (
    // Donji razmak = visina lepljive trake akcije + safe-area, da poslednji red
    // liste nikad ne ostane ispod nje (traka i sama nosi `env(safe-area-inset-bottom)`).
    <div className="min-h-dvh bg-app pb-[calc(7rem+env(safe-area-inset-bottom,0px))]">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-md font-semibold text-ink">Dodaj na policu</h1>
            <p className="truncate text-xs text-ink-secondary">
              {dest
                ? `dodajem na ${dest.locationCode}${dest.name ? ` — ${dest.name}` : ''}`
                : 'korak 1 — izaberi policu na koju dodaješ'}
            </p>
          </div>
          <Link
            href="/mob"
            className={`inline-flex h-11 shrink-0 items-center gap-1 rounded-control border border-line bg-surface-2 pl-2 pr-4 text-sm font-semibold text-ink active:bg-surface ${FOCUS}`}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            Početna
          </Link>
        </div>
        {pending > 0 && (
          <p className="mt-1 text-xs text-status-warn">
            ⏳ {pending} neposlatih čeka mrežu — šalju se automatski čim se veza vrati.
          </p>
        )}
      </header>

      <main className="space-y-3 p-4">
        {/* ── Korak 1: odredišna polica ─────────────────────────────────── */}
        {!dest ? (
          <>
            <button
              onClick={() => setScan('shelf')}
              className="flex w-full items-center gap-4 rounded-panel border-2 border-line bg-surface px-5 py-5 text-left text-lg font-semibold text-ink active:bg-surface-2"
            >
              <ScanLine className="h-8 w-8 shrink-0 text-accent" aria-hidden />
              <span>
                SKENIRAJ POLICU
                <span className="block text-sm font-normal text-ink-secondary">
                  polica na koju dodaješ celu seriju
                </span>
              </span>
            </button>

            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-disabled"
                aria-hidden
              />
              <input
                value={destQuery}
                onChange={(e) => setDestQuery(e.target.value)}
                aria-label="Pretraga police"
                placeholder="…ili pretraži policu / kavez"
                className={`h-14 w-full rounded-panel border border-line bg-surface pl-11 pr-3 text-md text-ink outline-none focus:border-accent ${FOCUS}`}
              />
            </div>

            {locs.isLoading ? (
              <p className="py-6 text-center text-sm text-ink-secondary">Učitavam lokacije…</p>
            ) : (
              <>
                {/* Poruka o ostatku stoji IZNAD liste (ne na dnu kao u dropdown-u):
                    ovde lista skroluje celu stranu, pa red posle 200 stavki niko
                    ne bi video — a poruka postoji baš da bi se videla odmah. */}
                {destHint && (
                  <p className="px-1 text-xs leading-snug text-ink-secondary">{destHint}</p>
                )}
                <ul className="divide-y divide-line-soft overflow-hidden rounded-panel border border-line bg-surface">
                  {destOptions.map((l) => (
                    <li key={l.id}>
                      <button
                        onClick={() => setDest(l)}
                        className={`flex min-h-12 w-full items-center gap-2 px-4 py-2 text-left active:bg-surface-2 ${FOCUS}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink">{l.locationCode}</span>
                          {/* Put (hala) umesto golog imena: šifra police se PONAVLJA po halama
                              (A1 postoji u 6 hala, ime je generično „Magacin") — bez pute su
                              dva reda „A1 — Magacin" nerazlučiva (prijava 04.08 „neke se
                              ponavljaju"). Desktop `LocationSelect` već prikazuje pathCached. */}
                          {(l.pathCached || l.name) && (
                            <span className="block truncate text-xs text-ink-secondary">
                              {l.pathCached || l.name}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                  {destOptions.length === 0 && (
                    <li className="px-4 py-6 text-center text-sm text-ink-secondary">
                      Nema lokacije za taj upit.
                    </li>
                  )}
                </ul>
              </>
            )}
          </>
        ) : (
          <>
            {/* Izabrano odredište + promena */}
            <div className="flex items-center gap-3 rounded-panel border border-accent bg-accent-subtle p-3">
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-ink-secondary">Dodajem na policu</span>
                <span className="block text-md font-bold text-ink">{dest.locationCode}</span>
                {dest.name && <span className="block truncate text-xs text-ink-secondary">{dest.name}</span>}
              </span>
              <button
                onClick={() => {
                  setDest(null);
                  setDestQuery('');
                }}
                disabled={!!sending}
                className={`inline-flex h-11 shrink-0 items-center rounded-control border border-line bg-surface px-3 text-sm font-semibold text-ink disabled:opacity-50 active:bg-surface-2 ${FOCUS}`}
              >
                Promeni
              </button>
            </div>

            {/* ── Korak 2: kontinuirani sken delova ───────────────────────── */}
            <button
              onClick={() => setScan('items')}
              disabled={!!sending}
              className="flex w-full items-center gap-4 rounded-panel border-2 border-line bg-surface px-5 py-5 text-left text-lg font-semibold text-ink disabled:opacity-50 active:bg-surface-2"
            >
              <ScanLine className="h-8 w-8 shrink-0 text-accent" aria-hidden />
              <span>
                SKENIRAJ DELOVE
                <span className="block text-sm font-normal text-ink-secondary">
                  neprekidno — svaki sken je +1 kom
                </span>
              </span>
            </button>

            {lines.length === 0 ? (
              <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
                Skeniraj nalepnice delova koje stavljaš na {dest.locationCode}. Količina se
                DODAJE na policu — izvorna polica se ne prazni.
              </p>
            ) : (
              <ul className="space-y-2">
                {lines.map((l) => (
                  <LineCard
                    key={l.key}
                    l={l}
                    atDest={isAtDest(l)}
                    destCode={dest.locationCode}
                    locById={locById}
                    busy={!!sending}
                    onQty={(v) => patch(l.key, { qty: v })}
                    onRemove={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  />
                ))}
              </ul>
            )}

            {/* ── Korak 3: pregled + pošalji ──────────────────────────────── */}
            {(okCount > 0 || queuedCount > 0 || errCount > 0) && (
              <p className="text-sm text-ink-secondary">
                {okCount > 0 && <span className="text-status-success">✓ poslato {okCount}</span>}
                {queuedCount > 0 && <span className="text-status-warn"> · ⏳ čeka mrežu {queuedCount}</span>}
                {errCount > 0 && <span className="text-status-danger"> · ✕ greška {errCount}</span>}
              </p>
            )}
          </>
        )}
      </main>

      {/* Lepljiva traka akcije — palac je uvek dohvati (paritet 1.0 mobileBatch).
          `env(safe-area-inset-*)` je OBAVEZAN: uz `viewport-fit=cover` (root
          `layout.tsx`) pregledač crta stranu preko sistemskih traka, pa je bez
          ovoga glavni CTA „Dodaj na policu" ulazio u zonu Android gesture/nav
          trake i pod iPhone home-indicator crtu. Isti obrazac kao `mob-shell.tsx`. */}
      {dest && lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))]">
          <Button
            onClick={() => void sendAll()}
            loading={!!sending}
            disabled={sendable.length === 0}
            className="h-14 w-full text-md"
          >
            {sending
              ? `Šaljem ${sending.done}/${sending.total}…`
              : sendable.length === 0
                ? 'Sve poslato'
                : `Dodaj na ${dest.locationCode} (${sendable.length})`}
          </Button>
        </div>
      )}

      {scan === 'shelf' && (
        <ScanOverlay
          title="Skeniraj odredišnu policu/kavez"
          accept={['SHELF']}
          onResult={(r) => {
            if (r.kind !== 'SHELF') return;
            if (r.record) {
              setDest(r.record);
              setScan(null);
            } else {
              toast(r.message || 'Lokacija nije prepoznata — probaj ručni izbor.');
            }
          }}
          onClose={() => setScan(null)}
        />
      )}

      {scan === 'items' && (
        <ScanOverlay
          title="Skeniraj delove (neprekidno)"
          accept={['ITEM']}
          continuous
          onResult={(r) => {
            if (r.kind === 'ITEM') addScanned(r);
          }}
          onClose={() => setScan(null)}
        />
      )}
    </div>
  );
}

function LineCard({
  l,
  atDest,
  destCode,
  locById,
  busy,
  onQty,
  onRemove,
}: {
  l: BatchLine;
  atDest: boolean;
  destCode: string;
  locById: Map<string, LocLocation>;
  busy: boolean;
  onQty: (v: string) => void;
  onRemove: () => void;
}) {
  const locked = l.status === 'done' || l.status === 'queued' || l.status === 'sending';
  const tone =
    l.status === 'done'
      ? 'border-status-success/50'
      : l.status === 'queued'
        ? 'border-status-warn/50'
        : l.status === 'error'
          ? 'border-status-danger/50'
          : atDest
            ? 'border-status-warn/50'
            : 'border-line';

  return (
    <li className={`rounded-panel border bg-surface p-3 ${tone}`}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-ink">
            {l.orderNo ? `${l.orderNo} · ` : ''}
            {l.itemRefId}
          </span>
          {l.drawingNo && (
            <span className="block text-xs text-ink-secondary">crtež {l.drawingNo}</span>
          )}
          {l.placements.length === 0 && (
            <span className="block text-xs text-ink-secondary">nema zabeleženog smeštaja</span>
          )}
        </span>
        {l.status === 'done' ? (
          <Check className="h-6 w-6 shrink-0 text-status-success" aria-label="Poslato" />
        ) : l.status === 'queued' ? (
          <span className="shrink-0 text-xs font-semibold text-status-warn">⏳ čeka</span>
        ) : l.status === 'sending' ? (
          <span className="shrink-0 text-xs text-ink-secondary">šaljem…</span>
        ) : (
          <button
            onClick={onRemove}
            disabled={busy}
            aria-label="Ukloni sa liste"
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-secondary disabled:opacity-50 active:bg-surface-2 ${FOCUS}`}
          >
            <Trash2 className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      {/* Zatečeno stanje — INFORMACIJA, ne izbor: pod „dodaj na policu" polazna
          lokacija se ne šalje, ali radnik treba da vidi gde deo već stoji. */}
      {l.placements.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {l.placements.map((p) => {
            const loc = locById.get(p.locationId);
            return (
              <span
                key={p.id}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-secondary"
              >
                sad: {loc ? loc.locationCode : p.locationId.slice(0, 8)} ·{' '}
                <strong>{String(p.quantity)}</strong>
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-ink-secondary">
          dodajem na {destCode}
        </span>
        <label className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs text-ink-secondary">kom</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={l.qty}
            disabled={locked}
            onChange={(e) => onQty(e.target.value)}
            aria-label={`Količina za ${l.itemRefId}`}
            className={`tnums h-11 w-20 rounded-control border border-line bg-surface-2 px-2 text-center text-md text-ink outline-none focus:border-accent disabled:opacity-60 ${FOCUS}`}
          />
        </label>
      </div>

      {/* Nije greška (i ne preskače se) — ali mora da se VIDI: šalje se dopuna
          količine na policu na kojoj deo već stoji. */}
      {atDest && l.status === 'pending' && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-status-warn">
          <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Već stoji na {destCode} — količina se DODAJE na zatečenu.
        </p>
      )}
      {l.error && <p className="mt-1.5 text-xs text-status-danger">{l.error}</p>}
    </li>
  );
}
