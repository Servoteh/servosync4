'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import {
  HALL_TYPES,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_LABEL,
  SHELF_TYPES,
  lookupLocDrawing,
  newClientEventUuid,
  useAllLocations,
  useCreateMovement,
  usePlacements,
  type LocLocation,
  type LocMovementType,
} from '@/api/lokacije';
import { isStorageLocation, LocationSelect } from './location-select';
import { computeInitialRemainder } from './initial-remainder';
import { normalizeLocMovementKeys } from './label-build';
import { ScanOverlay } from './scan-overlay';
import { enqueueMovement } from '@/lib/offlineQueue';
import type { MovementVars } from '@/api/lokacije';

/** Mrežni pad (fetch nije stigao do servera) → gurni u offline queue umesto tvrdog pada. */
function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const status = (e as { status?: number } | null)?.status;
  if (typeof status === 'number') return false; // server je odgovorio → nije mrežni pad
  const msg = String((e as { message?: string } | null)?.message ?? e ?? '').toLowerCase();
  return /failed to fetch|network|load failed|timeout|ecconn|offline/.test(msg);
}

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

export interface MovementPreset {
  itemRefTable?: string;
  itemRefId?: string;
  orderNo?: string;
  drawingNo?: string;
  toLocationId?: string;
  fromLocationId?: string;
  movementType?: LocMovementType;
  /** Sirov skeniran barkod (za banner „Skenirano: …" — paritet 1.0 parsed hint). */
  raw?: string;
  /** RNZ/compact `varijanta` — sužava lookup crteža (isti ident_broj, više varijanti). */
  varijanta?: string;
}

/** From-lokacija je nepotrebna za INITIAL_PLACEMENT / INVENTORY_ADJUSTMENT (paritet 1.0). */
function needsFrom(t: LocMovementType): boolean {
  return t !== 'INITIAL_PLACEMENT' && t !== 'INVENTORY_ADJUSTMENT';
}

/** Najbliži predak tipa HALA (šetnja parentId lancem) — paritet 1.0 `nearestHallAncestorId`. */
function nearestHallIdOf(l: LocLocation, byId: Map<string, LocLocation>): string | null {
  let cur: LocLocation | undefined = l;
  const seen = new Set<string>();
  for (let i = 0; i < 64 && cur; i++) {
    if (seen.has(cur.id)) return null;
    seen.add(cur.id);
    if (!cur.parentId) return null;
    const p = byId.get(cur.parentId);
    if (!p) return null;
    if ((HALL_TYPES as string[]).includes(p.locationType)) return p.id;
    cur = p;
  }
  return null;
}

/**
 * Brzo premeštanje — POST /locations/movements → loc_create_movement.
 *
 * Raspored i tekstovi = 1.0 „Premesti stavku" ekran (scanModal.js; mob paritet
 * 03.08.2026): Broj naloga → Broj TP → Broj crteža (hint „nije u barkodu" +
 * AUTO-DOČITAVANJE iz baze — RNZ barkod crtež NE NOSI, pa je polje do sada
 * ostajalo prazno posle skena) → trenutno stanje → tip pokreta (3.0 nadskup:
 * 11 tipova) → Sa lokacije → Količina → Na lokaciju (—HALA— filter za police +
 * skener) → Napomena; footer „Skeniraj ponovo" + „Izvrši premeštanje".
 *
 * Dočitavanje crteža (`lookupLocDrawing`, debounce 400ms) važi za SVA TRI ulaza
 * — kamera sken, stoni (wedge) čitač i ručno kucanje — jer se okida na promenu
 * PARA (nalog, TP), ne na izvor unosa. ERP vrednost gazi auto-popunjene
 * vrednosti (crtež sa „short" nalepnice / raniji lookup), ali NIKAD ručno
 * ukucan crtež (namerno odstupanje od 1.0, koji pri izmeni naloga/TP-a pregazi
 * i ručni unos — ovde je izbor bezbedniji: ništa se tiho ne briše).
 *
 * ISTI lookup nosi i broj KOMADA sa naloga (`pieceCount`, 057/26) — kad stavka
 * još nije nigde smeštena, „Količina" se auto-popuni (v. efekat kod
 * `autoQtyRef`); ručno uneta količina se, kao i crtež, nikad ne gazi.
 *
 * Idempotency ključ (client_event_uuid) po formi (jednom).
 */
export function MovementDialog({
  preset,
  autoMovementType = false,
  onClose,
}: {
  preset?: MovementPreset;
  /**
   * 058/26 (mobilni dijalog — Duško: „obriši tab Tip pokreta, potpuno
   * nepotreban"): sakrij sekciju „Tip pokreta" i IZVODI tip iz konteksta.
   * Paritet 1.0, koji izbor tipa uopšte NEMA — izvodi ga pri slanju
   * (scanModal.js:2378 `returnToUnplaced ? CORRECTION : isInitial ?
   * INITIAL_PLACEMENT : TRANSFER`). Pravila ovde:
   *   „Neraspoređeno" ✓          → CORRECTION (postojeći `effectiveType` put)
   *   izabrana polazna lokacija  → TRANSFER
   *   bez polazne, ima smeštaja  → TRANSFER (BE auto-razrešava polaznu)
   *   bez polazne, nema smeštaja → INITIAL_PLACEMENT (prvo zaduženje)
   * Slučaj „ne može jednoznačno" NE postoji: preostali tipovi (SCRAP, servis,
   * teren, inventar…) su desktop tokovi — desktop (bez ovog prop-a) i dalje
   * prikazuje pun izbor od 11 tipova. BE i dalje PRIMA tip — menja se samo ko
   * ga bira.
   */
  autoMovementType?: boolean;
  onClose: () => void;
}) {
  const create = useCreateMovement();
  const locs = useAllLocations('true');
  const locList = useMemo<LocLocation[]>(() => locs.data ?? [], [locs.data]);
  const locById = useMemo(() => new Map(locList.map((l) => [l.id, l])), [locList]);

  const [clientEventUuid] = useState(newClientEventUuid);
  const [orderNo, setOrderNo] = useState(preset?.orderNo ?? '');
  const [itemRefId, setItemRefId] = useState(preset?.itemRefId ?? '');
  const [drawingNo, setDrawingNo] = useState(preset?.drawingNo ?? '');
  const [movementType, setMovementType] = useState<LocMovementType>(
    preset?.movementType ?? (preset?.itemRefId && !preset?.fromLocationId ? 'INITIAL_PLACEMENT' : 'TRANSFER'),
  );
  const [fromLocationId, setFromLocationId] = useState<string | null>(preset?.fromLocationId ?? null);
  const [toLocationId, setToLocationId] = useState<string | null>(preset?.toLocationId ?? null);
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [returnToUnplaced, setReturnToUnplaced] = useState(false);
  // 059/26 B2: korisnik je EKSPLICITNO izabrao „Uloži preostalo sa naloga" —
  // 058 derivacija tipa to mora da poštuje (bez ovoga bi je refetch placements-a
  // mogao vratiti na TRANSFER i dugme bi tiho prestalo da važi). Čisti se
  // izborom konkretne polazne police ili promenom para (nalog, TP).
  const [remainderChosen, setRemainderChosen] = useState(false);
  const [showMachines, setShowMachines] = useState(false);
  const [hallFilterId, setHallFilterId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [scan, setScan] = useState<null | 'item' | 'from' | 'to'>(null);

  // Poslednji SKEN (iz preseta ili ponovnog skena u formi) — banner „Skenirano: …"
  // (paritet 1.0 parsed hint) + `varijanta` za suženje lookup-a crteža.
  const [scanInfo, setScanInfo] = useState<{
    raw: string;
    varijanta?: string;
    orderNo: string;
    itemRefId: string;
  } | null>(
    preset?.raw
      ? {
          raw: preset.raw,
          varijanta: preset.varijanta,
          orderNo: preset.orderNo ?? '',
          itemRefId: preset.itemRefId ?? '',
        }
      : null,
  );

  // ── Auto-dočitavanje broja crteža (KOREN prijave 03.08: RNZ ga NE NOSI) ────
  // ERP vrednost + revizija iz poslednjeg lookup-a; `autoDrawingRef` pamti šta
  // je AUTO upisano (crtež sa short nalepnice pri mount-u / raniji lookup) I ZA
  // KOJI PAR (nalog, TP) — samo AUTO vrednost sme da se pregazi/očisti, a
  // vrednost sa short nalepnice važi za SVOJ par i kad je baza ne zna.
  // `lookupDone` odvaja „još tražim" od „nema u planu".
  const [erpDrawing, setErpDrawing] = useState('');
  const [erpRevision, setErpRevision] = useState('');
  /**
   * Ukupno komada na nalogu iz poslednjeg lookup-a — SIROVO (1.0 `komada_total`;
   * i 0 je validna vrednost). JEDNO stanje za oba potrošača: auto-popunu
   * Količine (057/26 — koristi samo > 0) i računicu „Uloži preostalo sa naloga
   * (K kom)" + poruku „kompletno uložen" (059/26).
   */
  const [erpPieceCount, setErpPieceCount] = useState<number | null>(null);
  const [lookupDone, setLookupDone] = useState(false);
  // Separator para je NUL kao ESCAPE sekvenca (ne literalni bajt — literalni
  // U+0000 je ceo fajl činio „binarnim" za git diff/review; runtime identično).
  const pairKey = (o: string, t: string) => `${o.trim()}\u0000${t.trim()}`;
  const autoDrawingRef = useRef<{ value: string; pair: string }>({
    value: preset?.drawingNo ?? '',
    pair: pairKey(preset?.orderNo ?? '', preset?.itemRefId ?? ''),
  });

  useEffect(() => {
    const o = orderNo.trim();
    const t = itemRefId.trim();
    setErpDrawing('');
    setErpRevision('');
    setErpPieceCount(null);
    // Promena para (nalog, TP) poništava i izbor „uloži preostalo" (059/26 B2)
    // — preostalo novog para tek treba da se izračuna.
    setRemainderChosen(false);
    setLookupDone(false);
    if (!o || !t) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // `varijanta` važi samo dok su polja identična skeniranom paru — čim
      // korisnik izmeni nalog/TP, filter varijante više ne sme da sužava.
      const fromScanPair =
        scanInfo && o === scanInfo.orderNo.trim() && t === scanInfo.itemRefId.trim();
      lookupLocDrawing(o, t, fromScanPair ? scanInfo.varijanta : undefined)
        .then(({ data }) => {
          if (cancelled) return;
          setLookupDone(true);
          // Komada sa naloga — SIROVO (057/26 + 059/26): BE šalje sanitizovan
          // broj ili null; stariji BE polje ne šalje (undefined) → null (autofill
          // i računica preostalog se tiho preskaču). Pravilo „samo > 0" važi
          // JEDINO za autofill Količine i primenjuje se tamo, ne ovde — 0 je za
          // računicu preostatka validna vrednost.
          setErpPieceCount(
            data.found &&
              typeof data.pieceCount === 'number' &&
              Number.isFinite(data.pieceCount)
              ? data.pieceCount
              : null,
          );
          const curPair = pairKey(o, t);
          if (data.found && data.drawingNo) {
            setErpDrawing(data.drawingNo);
            setErpRevision(data.revision);
            setDrawingNo((prev) => {
              const p = prev.trim();
              if (p === '' || p === autoDrawingRef.current.value || p === data.drawingNo) {
                autoDrawingRef.current = { value: data.drawingNo, pair: curPair };
                return data.drawingNo;
              }
              return prev; // ručno ukucan crtež se ne gazi
            });
          } else {
            // m1 (verify 03.08): NOVI par ništa nije našao → stara AUTO vrednost
            // se NE SME zadržati u polju (poslao bi se jučerašnji crtež za drugi
            // TP). Čisti se SAMO auto vrednost TUĐEG para: ručno kucan crtež
            // ostaje, a crtež sa short nalepnice ostaje za SVOJ (skenirani) par.
            setDrawingNo((prev) => {
              const p = prev.trim();
              const auto = autoDrawingRef.current;
              if (p !== '' && p === auto.value && auto.pair !== curPair) {
                autoDrawingRef.current = { value: '', pair: curPair };
                return ''; // banner tada vodi na ručni prepis sa nalepnice
              }
              return prev;
            });
          }
        })
        .catch(() => {
          // Best-effort (paritet 1.0 „ERP cache: greška") — polje ostaje editabilno.
          if (!cancelled) setLookupDone(true);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [orderNo, itemRefId, scanInfo]);

  const itemRefTable = preset?.itemRefTable ?? 'bigtehn_rn';

  // Trenutno stanje pre premeštanja (paritet 1.0 renderState) — stvarni placement-i stavke.
  const trimmedItem = itemRefId.trim();
  const placementsQ = usePlacements(
    { itemRefId: trimmedItem, itemRefTable, orderNo: orderNo.trim() || undefined, pageSize: 50 },
    trimmedItem.length > 0,
  );
  const currentPlacements = useMemo(
    () => (placementsQ.data?.data ?? []).filter((p) => Number(p.quantity) > 0),
    [placementsQ.data],
  );
  const placedTotal = currentPlacements.reduce((a, p) => a + Number(p.quantity || 0), 0);
  /** Smeštaji za AKTUELAN par su stigli (ne prazan međurezultat dok query traje). */
  const placementsReady =
    trimmedItem.length > 0 && !placementsQ.isLoading && placementsQ.data != null;

  // ── Auto-popuna KOLIČINE iz naloga (057/26 — 1.0 „qty iz ERP snapshot-a") ──
  // 1.0 scanModal `reloadPlacementsOnly` (:1632–1642): kad ERP zna nalog, a
  // stavka NIJE nigde smeštena, Količina se popuni brojem komada sa naloga.
  // Duško (057/26): sken `9811-3/54` ostavljao 1, a nalog nosi 9 kom (izmereno:
  // work_orders.piece_count=9). `autoQtyRef` je ISTI obrazac kao `autoDrawingRef`:
  // pamti šta je AUTO upisano i za koji par — RUČNO uneta količina se nikad ne
  // gazi, a zaostala auto vrednost TUĐEG para se vraća na default '1' (da
  // jučerašnjih 9 kom ne ode uz drugi TP). Kad stavka IMA smeštaje, autofill se
  // NE radi: količinu tada vodi tok „Sa lokacije" (ulaganje preostatka / prenos
  // sa police — zahtev 059, poseban paket; u 1.0 `populateFromSelect`).
  const autoQtyRef = useRef<{ value: string; pair: string }>({
    value: '1',
    pair: pairKey(preset?.orderNo ?? '', preset?.itemRefId ?? ''),
  });
  useEffect(() => {
    if (!lookupDone || !placementsReady) return;
    const curPair = pairKey(orderNo, itemRefId);
    setQuantity((prev) => {
      const p = prev.trim();
      const auto = autoQtyRef.current;
      if (p !== '' && p !== auto.value) return prev; // ručno uneta količina se ne gazi
      // Autofill SAMO za pozitivan broj komada (057/26 pravilo) — sirovo stanje
      // sme da nosi i 0 (za 059/26 poruku „kompletno uložen"), ali 0 se ne upisuje.
      if (erpPieceCount != null && erpPieceCount > 0 && currentPlacements.length === 0) {
        autoQtyRef.current = { value: String(erpPieceCount), pair: curPair };
        return String(erpPieceCount);
      }
      if (auto.pair !== curPair) {
        // Novi par bez osnova za autofill → očisti SAMO tuđu auto vrednost.
        autoQtyRef.current = { value: '1', pair: curPair };
        return '1';
      }
      return prev;
    });
  }, [lookupDone, placementsReady, erpPieceCount, currentPlacements, orderNo, itemRefId]);

  // ── 059/26: „Uloži preostalo sa naloga (K kom)" — paritet 1.0 populateFromSelect ──
  // K = max(0, komada_total − Σ smeštenog) (1.0 `computeLocInitialRemainder`,
  // lokacijeFilters.js:123). Računa se SAMO uz konkretan nalog (1.0: „'Sa
  // lokacije' ima smisla samo kada smo scope-ovali na jedan nalog") i tek kad su
  // I lookup I placements gotovi (B1: u debounce prozoru / za nenađen RN K ne
  // sme na tren postati 0 i lažno javiti „kompletno uložen"). Server ovu granicu
  // NE sprovodi (živa `loc_create_movement` nema exceeds_order_quantity —
  // izmereno 03.08) — brana je klijentska, kao u 1.0.
  const orderScoped = orderNo.trim() !== '';
  const initialRemainder =
    orderScoped && lookupDone && placementsReady
      ? computeInitialRemainder(erpPieceCount, currentPlacements)
      : null;
  // Data glitch: uloženo VIŠE od naloga → preostalo 0 + upozorenje (ne negativno).
  const overPlaced =
    initialRemainder != null && erpPieceCount != null && placedTotal > erpPieceCount;

  // ── 058/26: tip pokreta se IZVODI umesto da se pita (pravila u prop docu) ──
  // Dok se smeštaji za ukucan par još učitavaju, zadrži zatečeni tip (preset sa
  // skena je već izveden ISTIM pravilom u /mob/lokacije: records → TRANSFER,
  // inače INITIAL) — bez tog čekanja bi prazan međurezultat na tren „video"
  // 0 smeštaja i zaljuljao formu na INITIAL pa nazad.
  useEffect(() => {
    if (!autoMovementType) return;
    if (fromLocationId) {
      setMovementType('TRANSFER');
      return;
    }
    // 059/26 B2: eksplicitno izabrano ulaganje preostatka — refetch placements-a
    // ne sme da ga pregazi (ako K u međuvremenu padne na 0, submit brana i dalje
    // zaustavlja sa jasnom porukom umesto tihe promene tipa).
    if (remainderChosen) {
      setMovementType('INITIAL_PLACEMENT');
      return;
    }
    // `isLoading` (ne `!placementsReady`): pad query-ja (offline) znači „smeštaji
    // nepoznati" → prazno → INITIAL, isto kao 1.0 offline (from-select bez opcija).
    if (trimmedItem.length > 0 && placementsQ.isLoading) return;
    if (currentPlacements.length === 0) {
      setMovementType('INITIAL_PLACEMENT');
      return;
    }
    // Ima smeštaja, polazna NIJE izabrana (059/26 t.4 — zatvara M1 iz verify-ja
    // 058): podrazumevano je ULAGANJE preostatka sa naloga (1.0 default
    // `LOC_FROM_UNPLACED_VALUE`, scanModal.js:1558) — TRANSFER tek uz
    // EKSPLICITNU polaznu (chip / „Sa lokacije" / preset). Time nestaje slučaj
    // „hoće da uloži još sa naloga, a sistem tiho premesti sa police A na B".
    // Izuzetak K=0 (sve uloženo): nema šta da se uloži → ne guraj INITIAL;
    // ostaje TRANSFER put, a panel stanja traži izbor polazne police.
    setMovementType(initialRemainder === 0 ? 'TRANSFER' : 'INITIAL_PLACEMENT');
  }, [autoMovementType, fromLocationId, remainderChosen, trimmedItem, placementsQ.isLoading, currentPlacements, initialRemainder]);

  // Skladišni podskup za OBA pickera premeštanja („Sa lokacije" i „Na lokaciju")
  // — reversi zaduženja (ZADU-*), M.* folderi mašina i sl. VAN (prijava 04.08:
  // „Zaduzeno: …" redovi u izboru police). Puni `locList` i dalje hrani labele
  // trenutnog stanja/istorije (locById) — filter je samo na OPCIJAMA izbora.
  const storageList = useMemo(() => locList.filter(isStorageLocation), [locList]);
  // ── „Na lokaciju" — hale za —HALA— filter (police su scoped po hali; 1.0) ──
  const halls = useMemo(
    () =>
      storageList
        .filter((l) => (HALL_TYPES as string[]).includes(l.locationType))
        .sort((a, b) =>
          a.locationCode.localeCompare(b.locationCode, 'sr', { numeric: true, sensitivity: 'base' }),
        ),
    [storageList],
  );
  // „Prikaži i mašine kao destinaciju" (paritet 1.0) — mašine skrivene dok se ne
  // čekira; —HALA— filter sužava SAMO police (kavezi su globalni, hale/ostalo
  // ostaju u listi — paritet 1.0 populateToSelect).
  const destLocations = useMemo(() => {
    const base = showMachines
      ? storageList
      : storageList.filter((l) => l.locationType !== 'MACHINE');
    if (!hallFilterId) return base;
    return base.filter((l) => {
      if (!(SHELF_TYPES as string[]).includes(l.locationType)) return true;
      return nearestHallIdOf(l, locById) === hallFilterId;
    });
  }, [storageList, showMachines, hallFilterId, locById]);
  // „Neraspoređeno" (paritet 1.0) uvek traži polaznu lokaciju (vraća komad sa police
  // u nesmešteni pool); inače from je nepotreban za INITIAL_PLACEMENT/INVENTORY.
  const needFrom = returnToUnplaced || needsFrom(movementType);
  const needTo = !returnToUnplaced && movementType !== 'SCRAP';

  // Banner (paritet 1.0 parsed hint): sken ili ručni par + odakle je crtež.
  const fromScan =
    scanInfo && orderNo.trim() === scanInfo.orderNo.trim() && itemRefId.trim() === scanInfo.itemRefId.trim();
  const showBanner = !!fromScan || (orderNo.trim() !== '' && itemRefId.trim() !== '');

  /**
   * 059/26: klik na „Uloži preostalo sa naloga (K kom)" — izvor = neuloženi pool
   * sa naloga (INITIAL_PLACEMENT: DB fn ignoriše from), količina = K (korisnik
   * sme da je smanji; upis ovde se za autofill računa kao „ručni" pa ga 057
   * efekat ne gazi). Paritet 1.0: prva opcija u „Sa lokacije" selektu.
   */
  function applyRemainderOption() {
    if (initialRemainder == null || initialRemainder <= 0) return;
    setRemainderChosen(true);
    setMovementType('INITIAL_PLACEMENT');
    setFromLocationId(null);
    setReturnToUnplaced(false);
    setQuantity(String(initialRemainder));
    setError(null);
  }

  /** Eksplicitan izbor polazne (chip / „Sa lokacije") poništava „uloži preostalo" (B2). */
  function pickFromLocation(id: string | null) {
    setFromLocationId(id);
    if (id) setRemainderChosen(false);
  }

  async function submit() {
    setError(null);
    if (!itemRefId.trim()) return setError('Broj TP (sa barkoda) je obavezan.');
    // 058/26: izveden tip zavisi od smeštaja — dok se oni još učitavaju, slanje
    // bi moglo da ode sa pogrešnim tipom (INITIAL umesto TRANSFER dupliralo bi
    // stanje police). Realno se ne dešava (čovek kuca duže od query-ja), ali
    // brana je jeftina, a šteta nije.
    // ⚠️ Namerno `isLoading`, NE `!placementsReady`: pad query-ja (offline) ne
    // sme trajno da zaključa slanje — offline queue je nosiv tok, a 1.0 offline
    // isto završi kao INITIAL (from-select bez opcija).
    if (autoMovementType && trimmedItem.length > 0 && placementsQ.isLoading)
      return setError('Sačekaj tren — učitavam trenutno stanje stavke (od njega zavisi vrsta upisa).');
    if (needTo && !toLocationId) return setError('Izaberi odredišnu lokaciju ili „Neraspoređeno".');
    if (returnToUnplaced && !fromLocationId)
      return setError('Za „Neraspoređeno" izaberi polaznu policu u polju „Sa lokacije".');
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return setError('Količina mora biti veća od 0.');

    // 059/26 brana (paritet 1.0 scanModal.js:2332): INITIAL ne sme preko
    // preostalog na nalogu — server (`loc_create_movement`) ovo NE proverava,
    // brana je klijentska. Važi za oba režima (ručni tip i 058 izveden tip).
    const isInitial = !returnToUnplaced && movementType === 'INITIAL_PLACEMENT';
    if (isInitial && initialRemainder != null && qty > initialRemainder) {
      return setError(
        initialRemainder === 0
          ? `Nalog je već kompletno uložen (${placedTotal} od ${erpPieceCount} kom.) — nema preostalog za ulaganje sa naloga.`
          : `Količina (${qty}) premašuje preostalo na nalogu (${initialRemainder} kom).`,
      );
    }

    // Paritet 1.0 modals.js:1838 — kanonizuj nalog+TP pre slanja (dash/slash/9400).
    const norm = normalizeLocMovementKeys(orderNo, itemRefId);
    // Neraspoređeno → CORRECTION bez odredišta, sa polaznom (modals.js:1866/1955).
    const effectiveType: LocMovementType = returnToUnplaced ? 'CORRECTION' : movementType;

    // Isti clientEventUuid nosi i online POST i offline queue → idempotentan retry
    // (DB fn vraća {idempotent:true} bez dupliranja pokreta).
    const payload: MovementVars = {
      clientEventUuid,
      itemRefTable,
      itemRefId: norm.itemRefId,
      movementType: effectiveType,
      orderNo: norm.orderNo || undefined,
      drawingNo: drawingNo.trim() || undefined,
      quantity: qty,
      toLocationId: needTo ? toLocationId ?? undefined : undefined,
      fromLocationId: needFrom ? fromLocationId ?? undefined : undefined,
      movementReason: reason.trim() || undefined,
      note: note.trim() || undefined,
    };

    // Offline: bez pokušaja mreže — direktno u queue (paritet 1.0 !navigator.onLine).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      queueAndReport(payload);
      return;
    }

    try {
      await create.mutateAsync(payload);
      onClose();
    } catch (e) {
      // Mreža pala u toku RPC-a → queue (payload nosi isti UUID, idempotentno).
      if (isNetworkError(e)) {
        queueAndReport(payload);
        return;
      }
      setError(e instanceof Error ? e.message : 'Premeštanje nije uspelo.');
    }
  }

  function queueAndReport(payload: MovementVars) {
    try {
      enqueueMovement(payload);
      setError(null);
      // Neutralna poruka za OBA konteksta: desktop („Neposlato" baner je na
      // Početnoj tabli, ne na admin Sync tabu) i mobilni (badge u zaglavlju).
      setQueued(
        'Zapis je sačuvan lokalno i šalje se automatski čim se mreža vrati. ' +
          'Broj neposlatih vidiš u zaglavlju (mobilni) / na Početnoj tabli (desktop).',
      );
    } catch (e) {
      // Upis u lokalni queue NIJE uspeo (quota / privatni režim / storage isključen) —
      // zapis NIJE sačuvan. Prikaži STVARNU grešku (bez lažnog zelenog uspeha) da
      // korisnik pokuša ponovo ili sačeka mrežu; queued baner se ne postavlja.
      setQueued(null);
      const detail = e instanceof Error ? e.message : String(e);
      setError(
        'Premeštanje NIJE sačuvano — lokalno skladište je puno ili nedostupno. ' +
          'Poveži se na mrežu i pokušaj ponovo, ili oslobodi prostor. (' + detail + ')',
      );
    }
  }

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="Premesti stavku"
        footer={
          <div className="flex justify-end gap-2">
            {queued ? (
              <Button variant="secondary" onClick={onClose}>Zatvori</Button>
            ) : (
              <>
                {/* Paritet 1.0 footer: [Skeniraj ponovo] [Izvrši premeštanje]
                    (zatvaranje = ✕ u zaglavlju dijaloga). */}
                <Button variant="secondary" onClick={() => setScan('item')}>Skeniraj ponovo</Button>
                <Button loading={create.isPending} onClick={() => void submit()}>Izvrši premeštanje</Button>
              </>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          {/* „Skenirano / Ručno" banner — paritet 1.0 parsed hint (pokazuje ODAKLE
              je crtež: iz plana/BigTehn, sa nalepnice, ili da ga treba prepisati). */}
          {showBanner && (
            <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2 text-xs text-ink-secondary">
              {fromScan && scanInfo ? (
                <>Skenirano: <strong className="text-ink">{scanInfo.raw}</strong></>
              ) : (
                <>Ručno: <strong className="text-ink">{orderNo.trim()}</strong> / <strong className="text-ink">{itemRefId.trim()}</strong></>
              )}
              {' '}→ nalog <strong className="text-ink">{orderNo.trim() || '—'}</strong>, TP{' '}
              <strong className="text-ink">{itemRefId.trim() || '—'}</strong>
              {drawingNo.trim() ? (
                <>
                  , crtež <strong className="text-ink">{drawingNo.trim()}</strong>
                  {erpDrawing && drawingNo.trim() === erpDrawing && (
                    <em>{erpRevision ? ` (rev. ${erpRevision})` : ''} (iz plana / BigTehn)</em>
                  )}
                </>
              ) : lookupDone ? (
                <em> (upiši broj crteža sa teksta nalepnice)</em>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Broj naloga">
              <input className={INPUT} value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="npr. 7351" />
            </FormField>
            <FormField label="Broj TP" required>
              <div className="flex gap-1.5">
                {/* min-w-0: bez ovoga input (flex item, intrinzični min-width) gura
                    skener dugme van ivice dijaloga na telefonu (grid kolona ~140px). */}
                <input className={`${INPUT} min-w-0`} value={itemRefId} onChange={(e) => setItemRefId(e.target.value)} placeholder="npr. 1088" />
                <button
                  type="button"
                  onClick={() => setScan('item')}
                  className="shrink-0 rounded-control border border-line bg-surface-2 px-2 text-ink-secondary hover:bg-surface"
                  aria-label="Skeniraj stavku"
                  title="Skeniraj stavku"
                >
                  <ScanLine className="h-4 w-4" />
                </button>
              </div>
            </FormField>
          </div>

          <FormField
            label="Broj crteža"
            hint="Prepiši sa teksta nalepnice — nije u barkodu. Popunjava se automatski kad par (nalog, TP) postoji u planu."
          >
            <input className={INPUT} value={drawingNo} onChange={(e) => setDrawingNo(e.target.value)} placeholder="npr. 1128816" />
            {erpRevision && erpDrawing && drawingNo.trim() === erpDrawing ? (
              <p className="mt-1 text-xs text-ink-secondary">Revizija crteža (BigTehn): {erpRevision}</p>
            ) : null}
          </FormField>

          {/* Trenutno stanje pre premeštanja — stvarni placement-i stavke (paritet 1.0). */}
          {trimmedItem.length > 0 && (
            <div className="rounded-control border border-line-soft bg-surface-2 px-3 py-2">
              {placementsQ.isLoading ? (
                <p className="text-xs text-ink-secondary">Učitavam trenutno stanje…</p>
              ) : currentPlacements.length === 0 ? (
                <>
                  <p className="text-xs text-ink-secondary">Crtež + nalog još nisu smešteni (novi unos = INITIAL_PLACEMENT).</p>
                  {/* 059/26: čim RN znamo, reci koliko nalog ukupno nosi. */}
                  {orderScoped && erpPieceCount != null && erpPieceCount >= 0 && (
                    <p className="mt-1 text-xs text-ink-secondary">Na nalogu: {erpPieceCount} kom.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="mb-1.5 text-xs font-medium text-ink">
                    {orderNo.trim()
                      ? `Nalog ${orderNo.trim()} — trenutno (ukupno ${placedTotal} kom.) — klik = polazna:`
                      : `Trenutno smešteno (ukupno ${placedTotal} kom.) — klik = polazna:`}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {currentPlacements.map((p) => {
                      const loc = locById.get(p.locationId);
                      const lbl = loc ? `${loc.locationCode}${loc.name ? ` — ${loc.name}` : ''}` : p.locationId.slice(0, 8);
                      const active = fromLocationId === p.locationId;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => pickFromLocation(p.locationId)}
                          className={`rounded-full border px-2 py-0.5 text-xs ${active ? 'border-accent bg-accent-subtle text-accent' : 'border-line text-ink-secondary hover:bg-surface'}`}
                          title="Postavi kao polaznu lokaciju"
                        >
                          {lbl} · <strong>{String(p.quantity)}</strong>
                        </button>
                      );
                    })}
                  </div>
                  {/* ── 059/26 izvor = neuloženi pool sa naloga ──────────────────
                      Paritet 1.0 populateFromSelect: prva (i podrazumevana)
                      opcija „— Uloži preostalo sa naloga (K kom; bez prenosa sa
                      police) —". Odstupanje po zahtevu: kad je K=0 opcija se NE
                      nudi (1.0 je prikazivao „(0 kom)" i blokirao tek na
                      submit-u) — umesto nje jasan tekst da je nalog kompletno
                      uložen + poziv da se za prenos izabere polazna. */}
                  {initialRemainder != null && initialRemainder > 0 && (
                    <button
                      type="button"
                      onClick={applyRemainderOption}
                      className={`mt-1.5 block w-full rounded-control border px-2.5 py-1.5 text-left text-xs ${
                        !returnToUnplaced && movementType === 'INITIAL_PLACEMENT'
                          ? 'border-accent bg-accent-subtle text-accent'
                          : 'border-line text-ink-secondary hover:bg-surface'
                      }`}
                      title="Izvor = neuloženi deo naloga (INITIAL_PLACEMENT); postavlja i količinu — možeš je smanjiti"
                    >
                      — Uloži preostalo sa naloga ({initialRemainder} kom; bez prenosa sa police) —
                    </button>
                  )}
                  {initialRemainder === 0 && !overPlaced && (
                    <p className="mt-1.5 text-xs text-ink-secondary">
                      ✓ Nalog je kompletno uložen ({placedTotal} od {erpPieceCount} kom.) — nema
                      preostalog za ulaganje sa naloga. Za prenos klikni polaznu policu iznad.
                    </p>
                  )}
                  {overPlaced && (
                    <p className="mt-1.5 text-xs text-status-warn">
                      ⚠ Uloženo ({placedTotal} kom.) je više od količine naloga ({erpPieceCount} kom.)
                      — preostalo za ulaganje: 0. Proveri podatke (mogući dupli unos). Za prenos
                      klikni polaznu policu iznad.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* 058/26: na mobilnom (autoMovementType) sekcija NE postoji — tip se
              izvodi automatski (pravila u prop docu); desktop zadržava pun izbor. */}
          {!autoMovementType && (
            <FormField label="Tip pokreta" required>
              <select
                className={INPUT}
                value={movementType}
                onChange={(e) => setMovementType(e.target.value as LocMovementType)}
              >
                {MOVEMENT_TYPES.map((t) => (
                  <option key={t} value={t}>{MOVEMENT_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </FormField>
          )}

          {needFrom && (
            <FormField
              label="Sa lokacije"
              required={returnToUnplaced}
              hint={returnToUnplaced ? 'Obavezno za „Neraspoređeno" — polica sa koje se vraća' : 'Ostavi prazno za auto-razrešavanje trenutne lokacije'}
            >
              <LocationSelect
                locations={storageList}
                value={fromLocationId}
                onChange={pickFromLocation}
                onScan={() => setScan('from')}
                shelvesFirst
                placeholder="Pretraži policu/kavez/mašinu…"
              />
            </FormField>
          )}

          {/* Količina PRE odredišta — redosled 1.0 forme (Sa lokacije → Količina → Na lokaciju). */}
          <FormField label="Količina" required>
            <input className={INPUT} type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </FormField>

          {movementType !== 'SCRAP' && (
            <>
              {needTo && (
                <FormField label="Na lokaciju" required>
                  {/* —HALA— filter (paritet 1.0): šifra police je scoped po hali,
                      pa izbor hale sužava listu polica; kavezi/hale/ostalo ostaju. */}
                  <select
                    className={`${INPUT} mb-1.5`}
                    value={hallFilterId ?? ''}
                    onChange={(e) => setHallFilterId(e.target.value || null)}
                    aria-label="Hala (filter za police)"
                  >
                    <option value="">—HALA—</option>
                    {halls.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.locationCode}{h.name ? ` — ${h.name}` : ''}
                      </option>
                    ))}
                  </select>
                  <LocationSelect
                    locations={destLocations}
                    value={toLocationId}
                    onChange={setToLocationId}
                    onScan={() => setScan('to')}
                    groupByHall
                    shelvesFirst
                    placeholder="Pretraži policu/kavez/mašinu…"
                  />
                  <label className="mt-1.5 flex items-center gap-2 text-xs text-ink-secondary">
                    <input type="checkbox" checked={showMachines} onChange={(e) => setShowMachines(e.target.checked)} />
                    Prikaži i mašine kao destinaciju
                  </label>
                </FormField>
              )}
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={returnToUnplaced}
                  onChange={(e) => setReturnToUnplaced(e.target.checked)}
                />
                Neraspoređeno (vrati sa police u nesmešteni pool — bez odredišta)
              </label>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Razlog">
              <input className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="opciono" />
            </FormField>
            <FormField label="Napomena">
              <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} placeholder="opciono" />
            </FormField>
          </div>

          {queued && (
            <div className="rounded-control border border-status-info/40 bg-status-info-bg px-3 py-2 text-sm text-status-info">
              {queued}
            </div>
          )}
          {error && <p className="text-sm text-status-danger">{error}</p>}
        </div>
      </Dialog>

      {scan === 'item' && (
        <ScanOverlay
          title="Skeniraj stavku"
          accept={['ITEM']}
          onResult={(r) => {
            if (r.kind === 'ITEM') {
              setOrderNo(r.parsed.orderNo);
              setItemRefId(r.parsed.itemRefId);
              setScanInfo({
                raw: r.parsed.raw,
                varijanta: r.parsed.varijanta,
                orderNo: r.parsed.orderNo,
                itemRefId: r.parsed.itemRefId,
              });
              if (r.parsed.drawingNo) {
                // „Short" nalepnica JEDINA nosi crtež u barkodu — upiši ga kao
                // AUTO vrednost SVOG para (ERP lookup sme da je precizira; 1.0
                // prioritet; lookup bez pogotka je NE briše — sken je izvor).
                autoDrawingRef.current = {
                  value: r.parsed.drawingNo,
                  pair: pairKey(r.parsed.orderNo, r.parsed.itemRefId),
                };
                setDrawingNo(r.parsed.drawingNo);
              }
            }
          }}
          onClose={() => setScan(null)}
        />
      )}
      {(scan === 'from' || scan === 'to') && (
        <ScanOverlay
          title={scan === 'from' ? 'Skeniraj polaznu lokaciju' : 'Skeniraj odredišnu lokaciju'}
          accept={['SHELF']}
          onResult={(r) => {
            if (r.kind === 'SHELF' && r.record) {
              if (scan === 'from') pickFromLocation(r.record.id);
              else {
                setToLocationId(r.record.id);
                // Kompozitni barkod nosi i halu — postavi —HALA— filter da izabrana
                // polica ostane u listi (paritet 1.0 applyScanDestinationSuccess).
                setHallFilterId(r.presetHallFilterId ?? null);
              }
            }
          }}
          onClose={() => setScan(null)}
        />
      )}
    </>
  );
}
