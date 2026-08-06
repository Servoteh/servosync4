'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Factory,
  GripVertical,
  Link2,
  Plus,
  Search,
  Undo2,
} from 'lucide-react';
import {
  useGantt,
  useGanttOverlay,
  useGanttReorder,
  useGanttShiftChain,
  useMachineHalls,
  type GanttRow,
  type ShiftChainPlan,
} from '@/api/plan-proizvodnje';
import { newClientId } from '@/api/plan-montaze';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal } from '@/lib/format';
import { toast } from '@/lib/toast';
import { HaleDialog } from './hale-dialog';
import { GantStavkaDialog } from './gant-stavka-dialog';
import { DodajNaPlanDialog } from './gant-dodaj-dialog';
import { GantLanacDialog, ucitajPlanLanca } from './gant-lanac-dialog';
import {
  BAR_TOP,
  DAY_MS,
  DAY_W,
  GROUP_H,
  NO_HALL,
  ROW_H,
  addDays,
  barEnd,
  barGeometry,
  buildSuccessorIndex,
  chainFrom,
  compareRows,
  dayDiff,
  groupKey,
  groupRows,
  makeGroupKey,
  isoDay,
  layoutRows,
  linkPath,
  machineRangeMinutes,
  reorderByDrop,
  rowKey,
  scrapBadge,
  scrapText,
  shiftPreview,
  startOfDay,
  type GanttSort,
  type HallGroup,
} from './gant-utils';
import { LS, lsGet, lsSet } from './pp-storage';

/**
 * Tab „Gant" (zahtev 046/26, faza F0+F1) — planiranje mašinske proizvodnje na vremenskoj
 * osi, nalik MS Project-u. Redovi su grupisani **Hala → mašina** (hala dolazi iz RUČNOG
 * šifrarnika `plan_proizvodnje_machine_halls`; mašine bez dodele idu u „Bez hale").
 *
 * ⚠️ PARALELAN POGLED (odluka vlasnika): planirani termini NE menjaju raspored — ručni
 * redosled smene (`shift_sort_order`, tab „Po mašini") ostaje master. Ovde se samo crta i
 * pomera plan; nijedan postojeći sort/bucket ne zavisi od `planned_*` polja.
 *
 * Zahtev 070/26 (Strahinja): redovi se ređaju RUČNO, prevlačenjem kvačice u levoj koloni —
 * isti gest, isti endpoint (`/overlays/reorder`) i isto polje (`shift_sort_order`) kao tab
 * „Po mašini". Da bi prevučeni red imao gde da se vidi, poredak redova unutar mašine mora
 * da vodi `shift_sort_order` — ali to NIJE postalo podrazumevano: prekidač „Ređaj po" nudi
 * „terminu" (PODRAZUMEVANO, tačno kao pre 070/26) i „ručnom redosledu", a izbor se pamti
 * po korisniku (`pp-storage`, LS). Odluka vlasnika: nikome se ekran ne prevrće preko noći
 * (mereno: na mašini 3.32 svih 12 barova menja mesto, lista prestaje da bude hronološka).
 * Master rasporeda time nije pomeren — ostao je `shift_sort_order`, samo ga sad piše i
 * gant. Termini (`planned_*`) ga i dalje NE diraju.
 *
 * Stavka bez `planned_start_at` NIJE na osi (nema bara) — na plan se stavlja dugmetom
 * „Dodaj na plan". Trajanje je podrazumevano iz tehnologije (TPZ + TK × kom) uz ručni
 * override; početak/kraj se pomeraju prevlačenjem bara (dan-granularnost) ili tastaturom
 * (←/→ pomeri, Shift+←/→ produži/skrati), a precizno se kucaju u dijalogu stavke.
 *
 * Paket C (Strahinjine primedbe na Paket A):
 *  - C1 veze: „uslov" (prethodna stavka) se postavlja PREVLAČENJEM — kružna hvataljka na
 *    kraju bara → pusti na drugi bar → taj bar (sledbenik) dobija prevučeni kao uslov.
 *    Isti mehanizam podataka kao dijalog (overlay `predecessor_work_order_id/line` kroz
 *    POST /overlays). Veze se crtaju kao SVG „elbow" linije sa strelicom (v. `LinkLayer`);
 *    klik na liniju briše vezu uz potvrdu. ESC / puštanje van bara otkazuje gest.
 *  - C2 kolona „Sklop": kom sklopu pozicija pripada po 053 strukturi praćenja
 *    (BE `sklop_naziv` — override → auto sastavnica; virtuelni sklop = negativan id).
 *
 * Static export bezbedno: bez `[id]` ruta i bez `useSearchParams` (tab živi u `?tab=` kroz
 * `useQueryTab` u `page.tsx`).
 */

/** Širina leve kolone (naziv stavke) u px — deljena sa zaglavljem. */
const LABEL_W = 300;
/** Širina kolone „Sklop" (C2) u px — kompaktna, pun naziv u tooltip-u. */
const SKLOP_W = 112;
/** X početak vremenske ose (posle kolona naziva i sklopa) — sidro za SVG linije veza. */
const AXIS_X = LABEL_W + SKLOP_W;
/** Ponuđene dužine prozora (dana). */
const RANGES = [14, 30, 60] as const;
/**
 * Tvrda granica broja iscrtanih redova. BE feed ide do 5000 stavki (a „Prikaži i stavke
 * van plana" ih pušta SVE na osu), pa bi jedan klik pravio stotine hiljada DOM čvorova i
 * ledio tab na pogonskim mašinama. Plan se planira filtrirano (hala/mašina/RN) — višak se
 * odseca uz vidljivu poruku, a ne uz zamrznutu karticu.
 */
const MAX_ROWS = 300;
/**
 * Gornja granica jednog upisa redosleda (070/26) — `OverlayReorderDto` prima najviše
 * 2.000 stavki. Skup za renumeraciju je iscrtane stavke mašine (≤ `MAX_ROWS`) + one koje
 * već nose ručni redosled, pa se u praksi meri desetinama; granica je brana, ne režim.
 */
const REORDER_MAX = 2000;
/** Prevlačenje preko ovog praga (px) NIJE klik — bar se pomerao, dijalog se ne otvara. */
const DRAG_SLOP = 4;
/**
 * Vertikalne linije mreže dana kao CSS pozadina — ranije `days` (do 60) zasebnih div-ova
 * PO REDU; boje se samo vikend/danas kolone (v. `DayGrid`).
 */
const DAY_GRID_BG = `repeating-linear-gradient(to right, transparent 0 ${DAY_W - 1}px, var(--color-line-soft) ${DAY_W - 1}px ${DAY_W}px)`;

/**
 * Prag iznad kog se pomeranje lanca PITA (075/26). Ispod praga gest ide bez ijednog
 * klika — kratak lanac je očigledna posledica veza koje je planer sam napravio.
 */
const CHAIN_CONFIRM_OVER = 8;
/** Koliko dugo traka „Poništi" stoji u zaglavlju ganta (ms). */
const UNDO_MS = 30_000;

type DragMode = 'move' | 'resize';
interface DragState {
  key: string;
  mode: DragMode;
  startX: number;
  deltaDays: number;
  /**
   * 075/26 — ključevi SVIH sledbenika sidra, popunjeni JEDNOM na `pointerdown`.
   * Indeks nad do 5.000 redova ne sme da se gradi na svakom `pointermove`.
   */
  chain: string[];
}

/**
 * 075/26 — lanac koji je vizuelno POMEREN dok čeka potvrdu u dijalogu. Barovi se crtaju
 * na novim mestima, a podaci su nepromenjeni.
 *
 * 🔴 Mora da se obriše u SVAKOJ izlaznoj grani (uspeh, greška, otkazivanje, 409,
 * `pointercancel`, unmount). Ako ostane, ekran laže — barovi stoje na terminima koji
 * nisu upisani, a to je najgori mogući ishod ovog gesta.
 */
interface PendingShift {
  /** `opKey` sidra — jedini red koji se pomera i kad je završen. */
  anchor: string;
  keys: Set<string>;
  deltaDays: number;
}

/** Vizuelni pomak jednog bara tokom gesta (podskup `DragState`-a koji `Bar` čita). */
interface GestPomak {
  mode: DragMode;
  deltaDays: number;
}

/**
 * Gest povezivanja (C1): pointerdown na kružnoj hvataljci kraja bara → prevlačenje do
 * bara-mete → meta (sledbenik) dobija izvor kao „uslov". Koordinate su relativne na
 * TELO ose (`bodyRef`) da gumena linija živi u istom prostoru kao SVG sloj veza.
 */
interface LinkDragState {
  sourceKey: string;
  x: number;
  y: number;
  /** Bar pod kursorom (≠ izvor) — kandidat za sledbenika; null = puštanje otkazuje. */
  targetKey: string | null;
}

/**
 * Prevlačenje REDA radi ručnog redosleda (zahtev 070/26). Native HTML5 drag — ISTI
 * mehanizam kao „Po mašini" (`ops-table.tsx`) — ali sa hvatištem: `draggable` stoji SAMO
 * na kvačici (`GripVertical`) u levoj koloni, jer red nosi i barove sa pointer-gestovima (pomeranje,
 * resize, povezivanje) i dugme koje otvara dijalog stavke; `draggable` nad celim redom
 * bi im otimao gest. `group` je ključ grupe mašine — prevlačenje van svoje mašine se
 * odbija (promena mašine je „Premesti", ne redosled).
 */
interface RowDragState {
  key: string;
  group: string;
  /** Ključevi skupa u trenutku `dragstart` — brana od pozadinskog refetch-a (v. `onRowDrop`). */
  snapshot: string[];
}

export function GanttTab() {
  const [hall, setHall] = useState('');
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState<number>(30);
  const [rangeStart, setRangeStart] = useState<Date>(() => addDays(startOfDay(new Date()), -3));
  const [showUnplanned, setShowUnplanned] = useState(false);
  /**
   * 070/26 — „Ređaj po": `termin` (PODRAZUMEVANO, ponašanje pre 070/26) ili `rucni`.
   * Izbor je korisnikov i pamti se u `localStorage` (isti obrazac kao ostala podešavanja
   * ovog modula — `pp-storage.ts`; bez nove tabele i bez migracije). Početna vrednost se
   * NE čita u `useState` inicijalizatoru nego u `useEffect` (static export prerenderuje
   * stranu — čitanje LS-a u prvom renderu razilazi SSR i klijent markup).
   */
  const [sortMode, setSortMode] = useState<GanttSort>('termin');
  useEffect(() => {
    if (lsGet(LS.gantSort) === 'rucni') setSortMode('rucni');
  }, []);
  const [openHalls, setOpenHalls] = useState(false);
  const [openAdd, setOpenAdd] = useState(false);
  const [detail, setDetail] = useState<GanttRow | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [linkDrag, setLinkDrag] = useState<LinkDragState | null>(null);
  // 075/26 — kaskada: pregled koji čeka potvrdu + traka „Poništi" posle upisa.
  const [pendingShift, setPendingShift] = useState<PendingShift | null>(null);
  const [chainPlan, setChainPlan] = useState<ShiftChainPlan | null>(null);
  const [lastShift, setLastShift] = useState<ShiftChainPlan | null>(null);
  // 070/26 — ručni redosled redova prevlačenjem. `rowDrag` u ref-u (a ne samo u stanju)
  // jer `dragstart`/`drop` idu kroz native događaje bez ponovnog rendera između.
  const rowDragRef = useRef<RowDragState | null>(null);
  const [dropHint, setDropHint] = useState<{ key: string; after: boolean } | null>(null);

  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  // `sort` ide i na BE: feed se SEČE po BE poretku (`LIMIT`), a crta po FE `compareRows`
  // — ta dva moraju biti isti režim, inače rez uzme druge redove od onih koje prikaz
  // stavlja na vrh. Ključ upita nosi `sort`, pa promena režima povlači svež feed.
  const gantt = useGantt({ hall: hall || undefined, q: q || undefined, sort: sortMode });
  const halls = useMachineHalls();
  const save = useGanttOverlay({ ok: 'Termin sačuvan' });
  const link = useGanttOverlay({ ok: 'Veza sačuvana', err: 'Veza nije sačuvana.' });
  const reorder = useGanttReorder();
  const shift = useGanttShiftChain();

  const rows = useMemo(() => gantt.data?.data ?? [], [gantt.data]);
  const planned = useMemo(() => rows.filter((r) => !!r.planned_start_at), [rows]);
  const candidates = showUnplanned ? rows : planned;
  const visible = useMemo(
    () => (candidates.length > MAX_ROWS ? candidates.slice(0, MAX_ROWS) : candidates),
    [candidates],
  );
  const cutOff = candidates.length - visible.length;
  const groups = useMemo(() => groupRows(visible, sortMode), [visible, sortMode]);

  /**
   * 070/26 — skup stavki mašine koji prevlačenje RENUMERIŠE (`shift_sort_order` = 1..n).
   * Unija dve grupe, poređana istim kanonom kao prikaz:
   *   (a) stavke te mašine koje su ISCRTANE (ono što planer vidi i ređa),
   *   (b) stavke te mašine koje VEĆ nose ručni redosled — makar bile van plana i van
   *       iscrtanog isečka.
   *
   * (b) je uslov da se prikazi ne raziđu: `shift_sort_order` čita i tab „Po mašini", pa
   * bi upis 1..n samo nad vidljivim (podrazumevano se vide SAMO stavke na planu) pravio
   * duple brojeve sa zatečenim ručnim rasporedom te mašine (izmereno 05.08.2026: mašina
   * 3.32 ima 12 stavki na gantu i 22 sa ručnim redosledom).
   *
   * Zašto NE ceo red mašine: najveće mašine imaju 4.389 / 3.829 / 2.186 otvorenih
   * operacija (izmereno), a `/overlays/reorder` prima najviše 2.000 stavki — pun red bi
   * pucao na 400 i držao dugačku transakciju. Stavke bez ručnog redosleda ionako ostaju
   * `NULL` i u oba taba idu POSLE ručnih (NULLS LAST), pa ih renumeracija ne dotiče.
   *
   * `complete` = grupa je CELA iscrtana (iscrtanih redova te mašine = koliko ih tekući
   * prikaz uopšte nudi). Bez toga bi `MAX_ROWS` rez tiho krao stavke: mašina na rezu
   * dobije 1..n nad iscrtanim delom, a njen neiscrtani ostatak ostaje `NULL` i u „Po
   * mašini" (`shift_sort_order` je prvi ključ, NULLS LAST) padne na DNO — ispod redova
   * ispred kojih je bio, a planer to nigde ne vidi. Dostižno danas: sa „Prikaži i stavke
   * van plana" HALA 2B ima 325 otvorenih operacija > `MAX_ROWS`, pa mašina 3.15 sedi na
   * rezu (iscrtano 34 od 59).
   */
  const reorderGroups = useMemo(() => {
    const drawn = new Set(visible.map(rowKey));
    const m = new Map<string, { rows: GanttRow[]; complete: boolean }>();
    const ponudjeno = new Map<string, number>();
    // Koliko redova te mašine tekući prikaz NUDI (pre `MAX_ROWS` reza) — merilo za
    // `complete`. `candidates` je ono što su filteri propustili; `visible` je isečak.
    for (const r of candidates) {
      const k = groupKey(r);
      ponudjeno.set(k, (ponudjeno.get(k) ?? 0) + 1);
    }
    const iscrtano = new Map<string, number>();
    for (const r of visible) {
      const k = groupKey(r);
      iscrtano.set(k, (iscrtano.get(k) ?? 0) + 1);
    }
    for (const r of rows) {
      if (!drawn.has(rowKey(r)) && r.shift_sort_order == null) continue;
      const k = groupKey(r);
      const g = m.get(k);
      if (g) g.rows.push(r);
      else m.set(k, { rows: [r], complete: iscrtano.get(k) === ponudjeno.get(k) });
    }
    for (const g of m.values()) g.rows.sort((a, b) => compareRows(a, b, 'rucni'));
    return m;
  }, [rows, visible, candidates]);

  /**
   * Prevlačenje traži: pravo izmene, režim „po ručnom redosledu" i POUZDAN presek reda
   * mašine (isti oprez kao „Po mašini" / 1.0 `canDragInCurrentView` — pretraga po
   * crtežu/RN daje isečak, pa bi renumeracija ćutke pomerila ono što je filter sakrio).
   *
   * Zašto se u režimu „po terminu" NE prevlači: tamo redove ređa `planned_start_at`, pa
   * upisan `shift_sort_order` ne bi imao nikakav vidljiv efekat — gest bi lagao. Druga
   * mogućnost (prevlačenje koje samo prebaci režim) je odbijena: jedan gest bi tada
   * preuredio SVE grupe odjednom, a to je baš prevrtanje ekrana koje je vlasnik odbio.
   * Umesto toga hvatište je odsutno, a pomoćni tekst kaže gde je prekidač.
   */
  const truncated = gantt.data?.meta?.truncated === true;
  const canReorder = canEdit && !q && sortMode === 'rucni';

  /**
   * Odsečen feed (`truncated`, prod: 16k kandidata na 5.000) seče NAJVIŠE JEDNU grupu —
   * BE ređa `hall, effective_machine_code, …`, pa su stavke mašine uzastopne i nepotpuna
   * može biti samo POSLEDNJA. Njoj se prevlačenje zabranjuje (ne vidimo joj ceo ručni
   * raspored); sve ostale mašine u feed-u su kompletne. Zabrana celog taba ne dolazi u
   * obzir — bez filtera je feed odsečen skoro uvek.
   */
  const boundaryGroup = truncated && rows.length > 0 ? groupKey(rows[rows.length - 1]) : null;

  /** Puštanje reda: nova lista skupa mašine → `/overlays/reorder` (shift_sort_order 1..n). */
  function onRowDrop(target: GanttRow, after: boolean) {
    const d = rowDragRef.current;
    rowDragRef.current = null;
    setDropHint(null);
    if (!canReorder || !d) return;
    const gk = groupKey(target);
    if (gk !== d.group) {
      toast('⚠ Redosled se menja unutar iste mašine — za drugu mašinu koristi „Premesti".');
      return;
    }
    const g = reorderGroups.get(gk);
    if (!g || !g.complete) return;
    // Pozadinski refetch ganta (refetchOnWindowFocus, invalidacija posle tuđeg upisa) ume
    // da stigne IZMEĐU `dragstart` i `drop` — tada je pozicija puštanja računata nad
    // starim prikazom, a upis bi pošao od novog. Skup snimljen na `dragstart` mora da se
    // poklapa sa tekućim, inače se odustaje (planer ponovi gest nad onim što vidi).
    const sada = g.rows.map(rowKey);
    if (sada.length !== d.snapshot.length || sada.some((k, i) => k !== d.snapshot[i])) {
      toast('⚠ Prikaz je u međuvremenu osvežen — prevuci ponovo.');
      return;
    }
    if (g.rows.length > REORDER_MAX) {
      toast(`⚠ Previše stavki za jedan upis (${g.rows.length}) — suzi prikaz.`);
      return;
    }
    const next = reorderByDrop(g.rows, d.key, rowKey(target), after);
    if (!next) return;
    reorder.mutate({ orderedRows: next });
  }

  /** Spisak hala za filter (iz šifrarnika, ne iz feed-a — vidi se i prazna hala). */
  const hallOptions = useMemo(() => {
    const set = new Set<string>();
    for (const h of halls.data?.data ?? []) if (h.hall) set.add(h.hall);
    return [...set].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [halls.data]);

  const dayList = useMemo(
    () => Array.from({ length: days }, (_, i) => addDays(rangeStart, i)),
    [rangeStart, days],
  );
  const todayIdx = dayDiff(startOfDay(new Date()), rangeStart);

  /** Samo kolone koje se BOJE (vikend/danas) — linije mreže crta CSS pozadina. */
  const gridCells = useMemo(
    () =>
      dayList
        .map((d, i) => ({ i, weekend: isWeekend(d), today: i === todayIdx }))
        .filter((c) => c.weekend || c.today),
    [dayList, todayIdx],
  );

  // ── Kaskadno pomeranje lanca (075/26) ──────────────────────────────────────
  //
  // Prikaz se osvežava u TRI SLOJA, redom:
  //  1. tokom prevlačenja — `chainSet` + `shiftPreview` pomeraju barove i sidra veza
  //     uživo (najbolji napor nad onim što FE vidi);
  //  2. odmah po odgovoru — keš se krpi po `data.stavke` iz ODGOVORA, ne po pregledu:
  //     tu se ispravlja svaka razlika između FE predviđanja i onoga što je server
  //     stvarno upisao (i pomeraju se redovi koje FE nikad nije video kao vezu);
  //  3. `onSettled` — jedna invalidacija ganta → merodavan refetch.

  /** Redovi kojima je vezni gest pomerio bar (drag u toku ili čekanje potvrde). */
  const chainSet = useMemo(() => {
    if (pendingShift) return pendingShift.keys;
    if (drag?.mode === 'move') return new Set([drag.key, ...drag.chain]);
    return null;
  }, [drag, pendingShift]);

  /**
   * Vizuelni pomak jednog bara tokom gesta — JEDAN račun za `Bar` i za sloj veza
   * (`LinkLayer`), da linija ne ostane zakačena za staru poziciju bara.
   *
   * Ogledalo pravila iz `shiftPreview`: sidro se pomera uvek, sledbenik se preskače kad
   * je ZAVRŠEN ili nema planiran početak. Bez tog izuzimanja bi se bar koji server neće
   * dirati vizuelno pomerio, pa vratio nazad po refetch-u.
   */
  const gestPomak = (key: string, r: GanttRow): GestPomak | null => {
    if (drag && drag.key === key) return drag;
    const sidro = drag?.mode === 'move' ? drag.key : (pendingShift?.anchor ?? null);
    const delta = drag?.mode === 'move' ? drag.deltaDays : (pendingShift?.deltaDays ?? 0);
    if (sidro === null || chainSet?.has(key) !== true) return null;
    if (!r.planned_start_at) return null;
    if (key !== sidro && r.is_completed_effective === true) return null;
    return { mode: 'move', deltaDays: delta };
  };

  /** Koliko stavki plana NIJE iscrtano — jedina zaštita od tihe razlike ekran↔baza. */
  const nijeNaEkranu = (stavke: { work_order_id: string; line_id: string }[]) => {
    const vidljivi = layoutRows(groups).map;
    return stavke.filter((s) => !vidljivi.has(`${s.work_order_id}:${s.line_id}`)).length;
  };

  /** Ishod kaskade: SERVEROVI brojevi + broj koji zna samo klijent (van ekrana). */
  function prikaziRezultat(plan: ShiftChainPlan) {
    const t = plan.totals;
    const van = nijeNaEkranu(plan.stavke);
    const delovi = [`Pomereno ${t.pomereno}`];
    if (t.preskoceno > 0) {
      const ostalo = t.preskoceno - t.preskoceno_zavrsenih;
      const razlozi = [
        t.preskoceno_zavrsenih > 0 ? `${t.preskoceno_zavrsenih} završenih` : null,
        ostalo > 0 ? `${ostalo} bez termina / van plana` : null,
      ]
        .filter(Boolean)
        .join(', ');
      delovi.push(`preskočeno ${t.preskoceno}${razlozi ? ` (${razlozi})` : ''}`);
    }
    if (van > 0) delovi.push(`${van} nije na ekranu`);
    toast(`✓ ${delovi.join(' · ')}`);
    setLastShift(plan);
  }

  /** Brzi put — bez ijednog klika. `expectedHash` se šalje samo kad ga imamo. */
  function posaljiKaskadu(row: GanttRow, deltaDays: number, kljucevi: string[], expectedHash?: string) {
    shift.mutate(
      {
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        deltaDays,
        clientEventId: newClientId(),
        expectedHash,
        optimistic: shiftPreview(rows, rowKey(row), kljucevi, deltaDays),
      },
      {
        onSuccess: (r) => {
          setPendingShift(null);
          prikaziRezultat(r.data);
        },
        onError: () => setPendingShift(null),
      },
    );
  }

  /**
   * Puštanje bara u režimu „pomeri" (075/26). Pomera se SIDRO i ceo lanac sledbenika za
   * ISTI broj dana — razmaci se čuvaju (10 od 30 izmerenih razmaka je pozitivno, jedan
   * je i negativan; lepljenje za kraj prethodnika bi ih uništilo).
   *
   * 🔴 FE GEJT SME DA GREŠI SAMO U BEZBEDNOM SMERU. „Neizvesno" je svaki prikaz u kom
   * FE ne može da vidi ceo lanac: aktivan filter hale/pretrage, odsečen feed, ili čvor
   * lanca koji nije među iscrtanim redovima.
   *
   * ⚠️ ODSTUPANJE OD SPECIFIKACIJE (svesno, zbog svakodnevne upotrebe): „neizvesno" NE
   * otvara dijalog odmah, nego prvo pita SERVER (`dryRun`). Strahinja radi sa filterom
   * hale skoro uvek, pa bi pravilo „neizvesno → dijalog" tražilo potvrdu za SVAKI potez,
   * uključujući pomeranje jednog bara BEZ ijednog sledbenika — a to je tačno navika koja
   * nauči čoveka da klikće naslepo. Bezbednost je očuvana: kad je neizvesno, FE NIKAD ne
   * upisuje naslepo — pita, pa upisuje tek ako je server potvrdio da je zahvat mali,
   * bez preskočenih i tačno onakav kakav je FE predvideo (uz `expectedHash`).
   */
  async function pomeriLanac(d: DragState) {
    const row = rows.find((r) => rowKey(r) === d.key);
    if (!row?.planned_start_at) return;
    const kljucevi = [d.key, ...d.chain];
    const vidljivi = layoutRows(groups).map;
    const neizvesno =
      !!hall || !!q || truncated || kljucevi.some((k) => !vidljivi.has(k));
    // Završenost se gleda SAMO na sledbenicima — sidro se pomera uvek (isto pravilo
    // kao serverski `needs_confirm`), pa završen bar koji je planer sam uhvatio ne
    // otvara dijalog.
    const zavrsenSledbenik = d.chain.some(
      (k) => rows.find((r) => rowKey(r) === k)?.is_completed_effective === true,
    );

    if (kljucevi.length <= CHAIN_CONFIRM_OVER && !zavrsenSledbenik && !neizvesno) {
      posaljiKaskadu(row, d.deltaDays, kljucevi);
      return;
    }

    // Neizvesno ili veliko → pregled pa odluka.
    setPendingShift({ anchor: d.key, keys: new Set(kljucevi), deltaDays: d.deltaDays });
    const res = await ucitajPlanLanca(row.work_order_id, row.line_id, d.deltaDays);
    if ('greska' in res) {
      setPendingShift(null);
      toast(`⚠ ${res.greska}`);
      return;
    }
    const plan = res.plan;
    if (plan.ciklus) {
      setPendingShift(null);
      toast(`⚠ Veze prave petlju (${plan.ciklus.ivica}) — razveži pa pomeri.`);
      return;
    }
    const kaoStoSmoVideli =
      plan.totals.pomereno === kljucevi.length && plan.totals.preskoceno === 0;
    if (!plan.needs_confirm && kaoStoSmoVideli) {
      posaljiKaskadu(row, d.deltaDays, kljucevi, plan.hash);
      return;
    }
    setChainPlan(plan);
  }

  // ── Drag (pomeranje / promena trajanja bara) ───────────────────────────────
  // Pointer eventi na `window` dok traje prevlačenje: bar sme da izađe iz svog reda,
  // a `pointercancel` (skrol na dodiru) mora da poništi radnju bez upisa.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const commitRef = useRef(pomeriLanac);
  commitRef.current = pomeriLanac;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round((e.clientX - d.startX) / DAY_W);
      if (delta !== d.deltaDays) setDrag({ ...d, deltaDays: delta });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || d.deltaDays === 0) return;
      if (d.mode === 'move') {
        // 075/26: pomeranje ide kroz KASKADU (server razrešava lanac).
        void commitRef.current(d);
        return;
      }
      // `resize` NE kaskadira: menja samo kraj, delte u danima nema, a produžavanje
      // bara bi gurnulo ceo red čekanja na mašini.
      const row = rows.find((r) => rowKey(r) === d.key);
      if (!row?.planned_start_at) return;
      const start = new Date(row.planned_start_at);
      const end = barEnd(row);
      const nextEnd = addDays(end, d.deltaDays);
      // Kraj ne sme pre početka — minimum je isti dan (30 min vidljivog bara).
      const floor = new Date(start.getTime() + 30 * 60_000);
      const eff = nextEnd.getTime() < floor.getTime() ? floor : nextEnd;
      save.mutate({
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedEndAt: eff.toISOString(),
        plannedDurationMinutes: Math.max(1, Math.round((eff.getTime() - start.getTime()) / 60_000)),
      });
    };
    const onCancel = () => {
      setDrag(null);
      setPendingShift(null); // ekran ne sme da ostane sa pomerenim barovima
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [drag, rows, save]);

  // Traka „Poništi" nestaje sama; `pendingShift` se čisti i pri odlasku sa taba
  // (unmount) — inače bi se sledeći ulazak zatekao sa pomerenim barovima bez podataka.
  useEffect(() => {
    if (!lastShift) return;
    const t = setTimeout(() => setLastShift(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [lastShift]);
  useEffect(() => () => setPendingShift(null), []);

  // ── Povezivanje prevlačenjem (C1) ──────────────────────────────────────────
  // Odvojen gest od pomeranja/resize-a bara: počinje ISKLJUČIVO na kružnoj hvataljci
  // (stopPropagation), pa postojeći drag ostaje netaknut. Praćenje mete ide preko
  // `elementFromPoint` + `data-barkey` (SVG sloj je pointer-events:none tokom gesta,
  // pa ne zaklanja barove). ESC ili puštanje van bara otkazuje bez upisa.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const linkDragRef = useRef<LinkDragState | null>(null);
  linkDragRef.current = linkDrag;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const linkMutRef = useRef(link);
  linkMutRef.current = link;

  const linkActive = !!linkDrag;
  useEffect(() => {
    if (!linkActive) return;
    const onMove = (e: PointerEvent) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      const d = linkDragRef.current;
      if (!rect || !d) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const keyAttr =
        (el instanceof Element ? el.closest('[data-barkey]') : null)?.getAttribute('data-barkey') ?? null;
      setLinkDrag({
        ...d,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        targetKey: keyAttr && keyAttr !== d.sourceKey ? keyAttr : null,
      });
    };
    const finish = (commit: boolean) => {
      const d = linkDragRef.current;
      setLinkDrag(null);
      if (!commit || !d?.targetKey) return;
      const all = rowsRef.current;
      const source = all.find((r) => rowKey(r) === d.sourceKey);
      const target = all.find((r) => rowKey(r) === d.targetKey);
      if (!source || !target) return;
      if (
        target.predecessor_work_order_id === source.work_order_id &&
        target.predecessor_line === source.line_id
      ) {
        toast('Veza već postoji.');
        return;
      }
      // Meta = SLEDBENIK: dobija prevučeni bar kao uslov (isti PATCH kao dijalog stavke).
      linkMutRef.current.mutate({
        workOrderId: target.work_order_id,
        lineId: target.line_id,
        predecessorWorkOrderId: source.work_order_id,
        predecessorLine: source.line_id,
      });
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [linkActive]);

  function startLink(sourceKey: string, clientX: number, clientY: number) {
    const rect = bodyRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLinkDrag({ sourceKey, x: clientX - rect.left, y: clientY - rect.top, targetKey: null });
  }

  /** Klik na liniju veze → brisanje uslova SLEDBENIKA (uz potvrdu). */
  function deleteLink(succ: GanttRow, pred: GanttRow) {
    const lbl = (r: GanttRow) => `${r.rn_ident_broj ?? r.work_order_id} op. ${String(r.operacija ?? '—')}`;
    if (!window.confirm(`Obrisati vezu ${lbl(pred)} → ${lbl(succ)}?`)) return;
    link.mutate({
      workOrderId: succ.work_order_id,
      lineId: succ.line_id,
      predecessorWorkOrderId: null,
      predecessorLine: null,
    });
  }

  /**
   * Redni brojevi stavki na mašini otvorene stavke (Paket A numeracija `redniBroj + 1`)
   * — dijalog kroz njih dozvoljava „poveži rednim brojem" (Strahinjina alternativa).
   */
  const detailOrdinals = useMemo(() => {
    if (!detail) return undefined;
    const dKey = rowKey(detail);
    for (const g of groups) {
      for (const m of g.machines) {
        if (m.rows.some((r) => rowKey(r) === dKey)) {
          return m.rows.map((row, i) => ({ broj: i + 1, row }));
        }
      }
    }
    return undefined;
  }, [groups, detail]);

  /**
   * Tastatura nad fokusiranim barom: ←/→ pomeri dan, Shift+←/→ produži/skrati.
   *
   * 075/26: ←/→ ide kroz ISTU kaskadu kao prevlačenje, ali BEZ dijaloga — jedan dan je
   * najmanje iznenađujuća radnja, a ponovljeni pritisci ne smeju da otvaraju modal.
   * Bez ovoga bi tastatura ostala jedini tihi način da se lanac razbije.
   */
  function onBarKey(e: React.KeyboardEvent, row: GanttRow) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setDetail(row);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (!row.planned_start_at) return;
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    const start = new Date(row.planned_start_at);
    const end = barEnd(row);
    if (e.shiftKey) {
      // Shift+←/→ menja SAMO kraj (resize) — ne kaskadira, isti razlog kao hvataljka.
      const nextEnd = addDays(end, step);
      if (nextEnd.getTime() <= start.getTime()) return;
      save.mutate({
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedEndAt: nextEnd.toISOString(),
        plannedDurationMinutes: Math.max(1, Math.round((nextEnd.getTime() - start.getTime()) / 60_000)),
      });
      return;
    }
    const key = rowKey(row);
    const kljucevi = [key, ...chainFrom(key, buildSuccessorIndex(rows))];
    posaljiKaskadu(row, step, kljucevi);
  }

  const timelineW = days * DAY_W;

  return (
    <div className="space-y-3">
      {/* ── Alatna traka ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2">
          <CalendarDays className="h-4 w-4 text-ink-disabled" aria-hidden />
          <input
            type="date"
            aria-label="Početak prozora"
            value={isoDay(rangeStart)}
            onChange={(e) => e.target.value && setRangeStart(startOfDay(new Date(`${e.target.value}T00:00:00`)))}
            className="h-8 bg-transparent text-sm text-ink outline-none"
          />
        </div>
        <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Dužina prozora">
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                'h-8 px-3 text-xs transition-colors',
                days === d ? 'bg-accent text-accent-fg' : 'bg-surface text-ink-secondary hover:bg-surface-2',
              )}
            >
              {d} dana
            </button>
          ))}
        </div>
        <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setRangeStart(addDays(startOfDay(new Date()), -3))}>
          Danas
        </Button>

        <select
          aria-label="Filter hale"
          value={hall}
          onChange={(e) => setHall(e.target.value)}
          className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Sve hale</option>
          {hallOptions.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
          <option value="-">Bez hale</option>
        </select>

        <form
          className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(rawQ.trim());
          }}
        >
          <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
          <input
            value={rawQ}
            onChange={(e) => setRawQ(e.target.value)}
            placeholder="Crtež / RN / naziv"
            aria-label="Filter po crtežu, RN-u ili nazivu"
            className="h-8 w-44 bg-transparent text-sm text-ink outline-none placeholder:text-ink-disabled"
          />
        </form>

        <label className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={showUnplanned} onChange={(e) => setShowUnplanned(e.target.checked)} />
          Prikaži i stavke van plana
        </label>

        {/* 070/26 — „Ređaj po": redosled REDOVA unutar mašine. Podrazumevano „termin"
            (ponašanje pre 070/26); „ručni redosled" je jedini režim u kom prevlačenje
            ima vidljiv efekat. Izbor se pamti po korisniku (LS, `pp-storage`). */}
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
          <ArrowDownUp className="h-4 w-4 text-ink-disabled" aria-hidden /> Ređaj po
          <select
            aria-label="Redosled redova unutar mašine"
            value={sortMode}
            onChange={(e) => {
              const v: GanttSort = e.target.value === 'rucni' ? 'rucni' : 'termin';
              setSortMode(v);
              lsSet(LS.gantSort, v);
            }}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
          >
            <option value="termin">terminu</option>
            <option value="rucni">ručnom redosledu</option>
          </select>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setOpenHalls(true)}>
            <Factory className="h-4 w-4" aria-hidden /> Hale
          </Button>
          <Button className="h-8 px-3 text-xs" onClick={() => setOpenAdd(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj na plan
          </Button>
        </div>
      </div>

      {/* 075/26 — traka „Poništi" posle kaskade. NAMERNO nije u toastu: `lib/toast.ts`
          prima SAMO tekst, traje 3,2 s i nema dugme; graditi dugme u njemu bi bio nov
          mehanizam zbog jedne trake. Poništavanje je tačno inverzno (kalendarski dan je
          invertibilan u fiksnoj zoni), a `expectedHash` iz `hash_after` brani od
          poništavanja PREKO tuđe izmene. */}
      {lastShift?.sidro ? (
        <div className="flex items-center gap-2 rounded-panel border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-secondary">
          <Undo2 className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
          <span>
            Pomereno {lastShift.totals.pomereno}{' '}
            {lastShift.totals.pomereno === 1 ? 'pozicija' : 'pozicija'} za{' '}
            {lastShift.delta_dana > 0 ? `+${lastShift.delta_dana}` : lastShift.delta_dana}{' '}
            {Math.abs(lastShift.delta_dana) === 1 ? 'dan' : 'dana'}.
          </span>
          <Button
            variant="secondary"
            className="ml-auto h-7 px-2 text-xs"
            loading={shift.isPending}
            onClick={() => {
              const p = lastShift;
              if (!p.sidro) return;
              shift.mutate(
                {
                  workOrderId: p.sidro.work_order_id,
                  lineId: p.sidro.line_id,
                  deltaDays: -p.delta_dana,
                  clientEventId: newClientId(),
                  expectedHash: p.hash_after ?? undefined,
                },
                {
                  onSuccess: () => {
                    setLastShift(null);
                    toast('✓ Pomeranje poništeno');
                  },
                },
              );
            }}
          >
            Poništi
          </Button>
        </div>
      ) : null}

      <p className="text-2xs text-ink-disabled">
        {planned.length} stavki na planu. Prevuci bar da pomeriš termin, prevuci desnu ivicu da promeniš
        trajanje, klikni za detalje. Veza (uslov): prevuci kružić sa kraja bara na drugi bar — klik na
        liniju briše vezu, ESC otkazuje.{' '}
        {/* 075/26 (Strahinja): gest je promenio ZNAČENJE — pomeranje bara sada nosi i sve
            vezane pozicije ispod. To mora da piše ovde, a ne samo u kartici pozicije. */}
        <span>
          Pomeranje bara nosi i sve <b>vezane pozicije ispod</b> — za isti broj dana, pa razmaci
          između njih ostaju isti. Završene pozicije i one bez termina se preskaču. Razvlačenje
          ivice menja samo tu poziciju.{' '}
        </span>
        {/* 070/26: redosled redova je ISTI ručni redosled smene koji piše i tab „Po mašini".
            Rečenica o prevlačenju se KRIJE na uređajima bez pokazivača (`hover: none`) —
            HTML5 drag-and-drop se na dodir uopšte ne pokreće, pa bi bila prazno obećanje. */}
        {canReorder ? (
          <span className="[@media(pointer:coarse)]:hidden">
            Redosled stavki unutar mašine: prevuci kvačicu
            <GripVertical className="mx-0.5 inline h-3 w-3 align-text-bottom" aria-hidden />
            levo od naziva — to je isti ručni redosled smene koji se vidi i menja u tabu „Po mašini".
            {cutOff > 0 || truncated
              ? ' Grupe koje se ne vide cele (odsečen prikaz) se ne ređaju — suzi filter halom ili prozor.'
              : ''}
          </span>
        ) : !canEdit ? (
          'Redosled stavki menja planer sa pravom izmene.'
        ) : q ? (
          'Redosled stavki se ne prevlači dok traje pretraga (prikaz je isečak reda mašine).'
        ) : (
          <span className="[@media(pointer:coarse)]:hidden">
            Za ručno ređanje stavki prebaci „Ređaj po" na <b>ručnom redosledu</b> — u režimu „po
            terminu" redove ređa planirani početak, pa ručni redosled ne bi imao vidljiv efekat.
          </span>
        )}
      </p>

      {/* ── Osa ── */}
      {gantt.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          Učitavanje plana…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          {showUnplanned
            ? 'Nema operacija za zadate filtere.'
            : 'Nijedna stavka još nije na planu. Klikni „Dodaj na plan" da postaviš prvi termin.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <div style={{ minWidth: AXIS_X + timelineW }}>
            {/* zaglavlje dana */}
            <div className="sticky top-0 z-20 flex border-b border-line bg-surface-2">
              <div
                className="shrink-0 border-r border-line px-3 py-1.5 text-2xs uppercase tracking-wider text-ink-secondary"
                style={{ width: LABEL_W }}
              >
                Hala / mašina / stavka
              </div>
              {/* C2: kompaktna kolona — kom sklopu pozicija pripada (pun naziv u tooltip-u). */}
              <div
                className="shrink-0 border-r border-line px-2 py-1.5 text-2xs uppercase tracking-wider text-ink-secondary"
                style={{ width: SKLOP_W }}
              >
                Sklop
              </div>
              <div className="relative flex" style={{ width: timelineW }}>
                {dayList.map((d, i) => (
                  <div
                    key={i}
                    className={cn(
                      'shrink-0 border-r border-line-soft py-1 text-center text-2xs',
                      isWeekend(d) ? 'bg-surface text-ink-disabled' : 'text-ink-secondary',
                      i === todayIdx && 'bg-accent/10 font-semibold text-ink',
                    )}
                    style={{ width: DAY_W }}
                    title={formatDate(d.toISOString())}
                  >
                    <div className="tnums">{d.getDate()}.</div>
                    <div className="tnums text-ink-disabled">{d.getMonth() + 1}.</div>
                  </div>
                ))}
              </div>
            </div>

            {/* grupe — u `relative` telu, da SVG sloj veza (C1) živi u istom sadržaju
                (skroluje se zajedno sa barovima) i da gest povezivanja ima koordinatni
                prostor (v. `bodyRef`). Visine redova su FIKSNE (ROW_H/GROUP_H) — sloj
                veza računa y-pozicije bez merenja DOM-a. */}
            <div
              ref={bodyRef}
              className={cn('relative', linkActive && 'cursor-crosshair select-none')}
            >
              {groups.map((g) => (
                <div key={g.hall}>
                  <div
                    className="flex items-center border-b border-line bg-surface-2/70"
                    style={{ height: GROUP_H }}
                  >
                    <div
                      className="shrink-0 truncate px-3 text-xs font-semibold uppercase tracking-wide text-ink"
                      style={{ width: AXIS_X }}
                    >
                      {g.hall === NO_HALL ? 'Bez hale' : g.hall}
                    </div>
                    <div style={{ width: timelineW }} />
                  </div>
                  {g.machines.map((m) => {
                    // A1 (046/26): zbir planiranih sati stavki mašine u prikazanom prozoru.
                    const minuti = machineRangeMinutes(m.rows, rangeStart, days);
                    // 070/26: ručni redosled se prevlači unutar grupe mašine. Isključene su
                    // grupe koje ne vidimo cele — poslednja grupa odsečenog BE feed-a
                    // (`boundaryGroup`) i svaka koju je `MAX_ROWS` rez presekao (`complete`).
                    const gk = makeGroupKey(g.hall, m.machine);
                    const rg = reorderGroups.get(gk);
                    const groupReorderable =
                      canReorder && gk !== boundaryGroup && rg?.complete === true && m.rows.length > 1;
                    return (
                    <div key={`${g.hall}:${m.machine}`}>
                      {/* A3 (046/26): red mašine kao vidljiv razdelnik grupa — nijansa
                          pozadine (surface-2) + puna `line` ivica gore/dole, umesto
                          stapanja sa redovima stavki (bez novih boja — postojeći tokeni). */}
                      <div
                        className="flex items-center border-y border-line bg-surface-2/40"
                        style={{ height: GROUP_H }}
                      >
                        <div
                          className="shrink-0 truncate px-3 pl-5 text-xs font-medium text-ink-secondary"
                          style={{ width: AXIS_X }}
                        >
                          {m.machine}
                          {m.machineName ? <span className="ml-1 text-ink-disabled">· {m.machineName}</span> : null}
                          <span className="ml-1 text-ink-disabled">({m.rows.length})</span>
                          {minuti > 0 ? (
                            <span
                              className="ml-1 tnums text-ink-disabled"
                              title="Zbir planiranih sati stavki ove mašine u prikazanom opsegu (override ili TPZ + TK × kom)"
                            >
                              · {formatDecimal(minuti / 60, 1)} h
                            </span>
                          ) : null}
                        </div>
                        <div style={{ width: timelineW }} />
                      </div>
                      {m.rows.map((r, redniBroj) => {
                        const key = rowKey(r);
                        // 075/26: bar prati gest i kad NIJE uhvaćen — ako je u lancu
                        // sidra. Bez toga planer vuče jedan bar, ostatak stoji, „elbow"
                        // linije usput skaču u back-link rutu, pa sve poskoči tek po
                        // puštanju: gest izgleda pokvareno iako upis radi ispravno.
                        const d = gestPomak(key, r);
                        return (
                          <div
                            key={key}
                            className={cn(
                              'group/row flex border-b border-line-soft hover:bg-surface-2',
                              // 070/26: meta puštanja — akcentna linija na ivici ka kojoj se umeće
                              // (inset shadow, isti obrazac kao ručno ređanje faza u Montaži).
                              dropHint?.key === key && !dropHint.after && 'shadow-[inset_0_2px_0_var(--accent)]',
                              dropHint?.key === key && dropHint.after && 'shadow-[inset_0_-2px_0_var(--accent)]',
                            )}
                            style={{ height: ROW_H }}
                            onDragOver={
                              groupReorderable
                                ? (e) => {
                                    if (!rowDragRef.current) return;
                                    e.preventDefault();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const after = e.clientY - rect.top >= rect.height / 2;
                                    // `dragover` se pali desetinama puta u sekundi — stanje se menja
                                    // SAMO kad se meta stvarno promeni (inače re-render celog ganta).
                                    setDropHint((h) => (h && h.key === key && h.after === after ? h : { key, after }));
                                  }
                                : undefined
                            }
                            onDragLeave={groupReorderable ? () => setDropHint((h) => (h?.key === key ? null : h)) : undefined}
                            onDrop={
                              groupReorderable
                                ? (e) => {
                                    e.preventDefault();
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    onRowDrop(r, e.clientY - rect.top >= rect.height / 2);
                                  }
                                : undefined
                            }
                          >
                            <div
                              className="flex h-full shrink-0 items-center gap-1 overflow-hidden px-3 pl-2 text-xs leading-tight"
                              style={{ width: LABEL_W }}
                            >
                              {/* 070/26: hvatište za ručni redosled. Nenametljivo (vidljivo tek na
                                  hover reda), namerno ODVOJENO od naziva — klik na naziv i dalje
                                  otvara dijalog stavke, a barovi zadržavaju svoje pointer-gestove. */}
                              {/* Hvatište POSTOJI samo kad prevlačenje stvarno radi. Kad ne
                                  radi, zauzima isti prostor (`invisible`) da se nazivi ne
                                  pomeraju, ali je van pristupačnog stabla (`aria-hidden`):
                                  nema tastaturnog puta za ovaj gest, pa čitač ekrana ne sme
                                  da najavi kontrolu koja se ne može upotrebiti. Na dodirnim
                                  uređajima (`hover: none`) se ne crta uopšte — HTML5 drag
                                  tamo ne postoji, a `group-hover` nikad ne okine. */}
                              <span
                                aria-hidden
                                draggable={groupReorderable}
                                onDragStart={
                                  groupReorderable
                                    ? (e) => {
                                        e.dataTransfer.effectAllowed = 'move';
                                        rowDragRef.current = {
                                          key,
                                          group: gk,
                                          snapshot: (rg?.rows ?? []).map(rowKey),
                                        };
                                      }
                                    : undefined
                                }
                                onDragEnd={() => {
                                  rowDragRef.current = null;
                                  setDropHint(null);
                                }}
                                title={
                                  groupReorderable
                                    ? 'Prevuci za ručni redosled (isti redosled kao tab „Po mašini")'
                                    : undefined
                                }
                                className={cn(
                                  'shrink-0 text-ink-disabled [@media(pointer:coarse)]:hidden',
                                  groupReorderable
                                    ? 'cursor-grab opacity-0 transition-opacity group-hover/row:opacity-100 active:cursor-grabbing'
                                    : 'invisible',
                                )}
                              >
                                <GripVertical className="h-3.5 w-3.5" aria-hidden />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col justify-center">
                                <button
                                  type="button"
                                  onClick={() => setDetail(r)}
                                  className="block w-full truncate text-left text-ink hover:underline"
                                  title={`${r.broj_crteza ?? ''} · ${r.naziv_dela ?? ''}`}
                                >
                                  {/* A2 (046/26): redni broj stavke unutar mašine po prikazanom
                                      redosledu — dijalog stavke ga prima kao „poveži rednim brojem" (C1). */}
                                  <span className="tnums text-ink-disabled">{redniBroj + 1}.</span>{' '}
                                  <span className="tnums text-ink-secondary">{r.rn_ident_broj ?? '—'}</span>{' '}
                                  {r.naziv_dela ?? r.broj_crteza ?? '(bez naziva)'}
                                </button>
                                <span className="flex items-center gap-1 truncate text-2xs text-ink-disabled">
                                  {/* 069/26 (Strahinja): „umesto štiklirano da je gotovo, da piše
                                      škart". Bedž stoji OVDE, a ne samo na baru, jer je bar na
                                      produkciji median 10px širok — reč se tamo ne bi pročitala.
                                      Pun ton (ne tekst na svetloj podlozi) zbog kontrasta: token
                                      `--status-warn` u svetloj temi daje 2.34:1, ispod AA. */}
                                  {scrapBadge(r) ? (
                                    <span
                                      className="shrink-0 rounded-control bg-status-warn px-1 font-semibold tracking-wide text-surface"
                                      title={scrapText(r)}
                                    >
                                      ŠKART
                                    </span>
                                  ) : null}
                                  <span className="truncate">
                                    op. {String(r.operacija ?? '—')} · {r.opis_rada ?? '—'} · {r.komada_total ?? 0} kom
                                  </span>
                                </span>
                              </div>
                            </div>
                            {/* C2: sklop kome pozicija pripada (053 struktura praćenja). Bez sklopa → prazno. */}
                            <div
                              className="flex h-full shrink-0 items-center overflow-hidden border-r border-line-soft px-2 text-2xs text-ink-secondary"
                              style={{ width: SKLOP_W }}
                              title={
                                r.sklop_naziv
                                  ? `${r.sklop_naziv}${r.sklop_rn_ident ? ` · RN ${r.sklop_rn_ident}` : ' · virtuelni sklop'}`
                                  : undefined
                              }
                            >
                              <span className="truncate">{r.sklop_naziv ?? ''}</span>
                            </div>
                            <div className="relative" style={{ width: timelineW }}>
                              <DayGrid cells={gridCells} width={timelineW} />
                              {r.planned_start_at ? (
                                <Bar
                                  row={r}
                                  barKey={key}
                                  rangeStart={rangeStart}
                                  days={days}
                                  dragDelta={d?.deltaDays ?? 0}
                                  dragMode={d?.mode ?? null}
                                  linkTarget={linkDrag?.targetKey === key}
                                  linkSource={linkDrag?.sourceKey === key}
                                  onOpen={() => setDetail(r)}
                                  onKeyDown={(e) => onBarKey(e, r)}
                                  // 075/26: lanac se razrešava JEDNOM, na `pointerdown`
                                  // — indeks nad do 5.000 redova ne sme u `pointermove`.
                                  onDragStart={(mode, x) =>
                                    setDrag({
                                      key,
                                      mode,
                                      startX: x,
                                      deltaDays: 0,
                                      chain:
                                        mode === 'move'
                                          ? chainFrom(key, buildSuccessorIndex(rows))
                                          : [],
                                    })
                                  }
                                  onLinkStart={(x, y) => startLink(key, x, y)}
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setDetail(r)}
                                  className="relative z-10 ml-1 mt-2 rounded-control border border-dashed border-line px-2 py-0.5 text-2xs text-ink-disabled hover:border-accent hover:text-accent"
                                >
                                  Nije na planu — postavi termin
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    );
                  })}
                </div>
              ))}
              <LinkLayer
                groups={groups}
                rangeStart={rangeStart}
                days={days}
                width={AXIS_X + timelineW}
                shiftOf={gestPomak}
                linkDrag={linkDrag}
                onDelete={deleteLink}
              />
            </div>
          </div>
        </div>
      )}

      {cutOff > 0 ? (
        <p className="text-2xs text-status-warn">
          Iscrtano prvih {MAX_ROWS} redova (još {cutOff} nije prikazano) — suzi filter
          (hala / crtež / RN) ili skloni „Prikaži i stavke van plana".
        </p>
      ) : null}
      {gantt.data?.meta?.truncated ? (
        <p className="text-2xs text-status-warn">
          Prikaz je skraćen na {gantt.data.meta.limit} stavki — suzi filter (hala / crtež / RN).
        </p>
      ) : null}

      {openHalls && <HaleDialog open onClose={() => setOpenHalls(false)} />}
      {openAdd && (
        <DodajNaPlanDialog
          open
          onClose={() => setOpenAdd(false)}
          rows={rows.filter((r) => !r.planned_start_at)}
          defaultDay={startOfDay(new Date())}
        />
      )}
      {detail && (
        <GantStavkaDialog
          open
          row={rows.find((r) => rowKey(r) === rowKey(detail)) ?? detail}
          ordinals={detailOrdinals}
          onClose={() => setDetail(null)}
        />
      )}
      {/* 075/26 — potvrda kaskade. `pendingShift` drži barove vizuelno pomerene dok
          dijalog stoji, i briše se u SVAKOJ izlaznoj grani (potvrda, odustajanje,
          greška, 409) — ekran ne sme da ostane pomeren nad nepromenjenim podacima. */}
      {chainPlan && (
        <GantLanacDialog
          open
          plan={chainPlan}
          nevidljivih={nijeNaEkranu(chainPlan.stavke)}
          onClose={() => {
            setChainPlan(null);
            setPendingShift(null);
          }}
          onDone={(p) => {
            setPendingShift(null);
            prikaziRezultat(p);
          }}
        />
      )}
    </div>
  );
}

interface GridCell {
  i: number;
  weekend: boolean;
  today: boolean;
}

/**
 * Pozadinska mreža jednog reda: linije dana su CSS gradijent, a div-ovi postoje SAMO za
 * obojene kolone (vikend/danas) — sa ~60 na ~10 čvorova po redu. `memo` + stabilne props
 * (memoizovan `cells`) drže mrežu van re-rendera koji prati prevlačenje bara.
 */
const DayGrid = memo(function DayGrid({ cells, width }: { cells: GridCell[]; width: number }) {
  return (
    <div
      className="absolute inset-0"
      style={{ width, backgroundImage: DAY_GRID_BG, backgroundSize: `${DAY_W}px 100%` }}
    >
      {cells.map((c) => (
        <div
          key={c.i}
          className={cn('absolute inset-y-0', c.weekend && 'bg-surface-2/50', c.today && 'bg-accent/5')}
          style={{ left: c.i * DAY_W, width: DAY_W }}
        />
      ))}
    </div>
  );
});

/** Bar jedne stavke: pozicija/širina iz termina, boja iz spremnosti/završenosti. */
function Bar({
  row,
  barKey,
  rangeStart,
  days,
  dragDelta,
  dragMode,
  linkTarget,
  linkSource,
  onOpen,
  onKeyDown,
  onDragStart,
  onLinkStart,
}: {
  row: GanttRow;
  /** rowKey — na DOM-u kao `data-barkey`, meta hit-test gesta povezivanja (C1). */
  barKey: string;
  rangeStart: Date;
  days: number;
  dragDelta: number;
  dragMode: DragMode | null;
  /** Bar je trenutni kandidat-sledbenik gesta povezivanja → prsten. */
  linkTarget: boolean;
  /** Bar je izvor aktivnog gesta povezivanja → hvataljka ostaje vidljiva. */
  linkSource: boolean;
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDragStart: (mode: DragMode, clientX: number) => void;
  onLinkStart: (clientX: number, clientY: number) => void;
}) {
  // Prevlačenje završava pointerup-om nad ISTIM dugmetom → pregledač ispali i `click`.
  // Bez praga (`DRAG_SLOP`) bi se posle svakog pomeranja bara otvarao i modal stavke.
  // Hook mora pre svakog uslovnog `return` (bar ume da ispadne iz prozora).
  const down = useRef<{ x: number; y: number } | null>(null);

  const start = new Date(row.planned_start_at as string);
  const end = barEnd(row);
  const shiftMs = (dragMode === 'move' ? dragDelta : 0) * DAY_MS;
  const growMs = (dragMode === 'resize' ? dragDelta : 0) * DAY_MS;
  // Geometrija deljena sa slojem veza (`barGeometry`) — linija pogađa tačno ivicu bara.
  const geom = barGeometry(row, rangeStart, days, shiftMs, growMs);
  // Van prozora → ne crtaj (i ne pravi vodoravni skrol duplo šireg bara).
  if (!geom?.visible) return null;
  const { left, width, clipLeft, clipRight } = geom;

  const done = row.is_completed_effective === true;
  const ready = row.is_ready_for_machine === true;
  // 069/26 (Strahinja): pozicija sa NENADOKNAĐENIM škartom ne nosi kvačicu nego oznaku
  // „ŠKART". BE šalje `scrap_outstanding`; račun je i ovde zbog optimističkog prikaza
  // odmah posle klika na „Završeno" (stari BE bez kolone → pada na isti FE račun).
  // ⚠️ Ton bara NAMERNO i dalje sudi po spremnosti: škart je stanje KVALITETA, spremnost
  // je stanje REDOSLEDA — da je škart preuzeo boju, bar bi prestao da kaže sme li da ide
  // na mašinu, a tooltip bi i dalje pisao „Spremno" i protivrečio boji.
  const skart = scrapBadge(row);
  const tone = done
    ? 'bg-surface-2 border-line text-ink-secondary'
    : ready
      ? 'bg-status-success-bg border-status-success/50 text-status-success'
      : 'bg-status-danger-bg border-status-danger/50 text-status-danger';

  return (
    <div
      data-barkey={barKey}
      className={cn('absolute z-10 h-6', linkTarget && 'rounded-control ring-2 ring-accent')}
      style={{ left, width, top: BAR_TOP }}
    >
      <button
        type="button"
        onClick={(ev) => {
          const d = down.current;
          down.current = null;
          if (d && (Math.abs(ev.clientX - d.x) > DRAG_SLOP || Math.abs(ev.clientY - d.y) > DRAG_SLOP)) return;
          onOpen();
        }}
        onKeyDown={onKeyDown}
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          down.current = { x: ev.clientX, y: ev.clientY };
          onDragStart('move', ev.clientX);
        }}
        title={`${row.rn_ident_broj ?? ''} · ${row.naziv_dela ?? ''}\n${formatDate(start.toISOString())} → ${formatDate(end.toISOString())}\n${row.is_urgent ? 'HITNO · ' : ''}${ready ? 'Spremno' : 'Nije spremno'}${
          skart ? `\n${scrapText(row)}` : ''
        }${clipLeft || clipRight ? '\n(bar se nastavlja van vidljivog prozora)' : ''}`}
        className={cn(
          'flex h-6 w-full cursor-grab items-center gap-1 overflow-hidden border px-1.5 text-2xs',
          'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] active:cursor-grabbing',
          // Odsečena ivica ostaje ravna (ravan rub = „ima još van prozora").
          clipLeft ? 'rounded-r-control' : clipRight ? 'rounded-l-control' : 'rounded-control',
          tone,
          row.is_urgent && !done && 'ring-1 ring-status-danger',
        )}
      >
        {clipLeft ? <ChevronLeft className="h-3 w-3 shrink-0 opacity-70" aria-hidden /> : null}
        {row.predecessor_work_order_id ? <Link2 className="h-3 w-3 shrink-0" aria-hidden /> : null}
        {done ? (
          <>
            <span aria-hidden>✓</span>
            {/* Kvačica je bila samo `aria-hidden` ✓ — čitaču ekrana se „gotovo" nije javljalo
                nigde. Oznaka škarta se čuje jer je običan tekst; ovo izjednačava to dvoje. */}
            <span className="sr-only">gotovo</span>
          </>
        ) : null}
        {/* 069/26: reč u baru je BONUS, ne nosilac signala — izmereno na produkciji da je
            median širina bara 10px (28 od 32 ispod 20px), pa se ovde reč najčešće i ne
            vidi. Nosilac je bedž u LEVOJ koloni, koja je fiksnih 300px. Zato je uslovljen
            stvarnom širinom i sme da se skupi (`min-w-0`), da ne pojede broj crteža. */}
        {!done && skart && width >= 56 ? (
          <span className="min-w-0 truncate font-semibold tracking-wide">ŠKART</span>
        ) : null}
        <span className="truncate">
          {row.broj_crteza ?? row.rn_ident_broj ?? '—'} · op. {String(row.operacija ?? '—')}
        </span>
        {clipRight ? <ChevronRight className="ml-auto h-3 w-3 shrink-0 opacity-70" aria-hidden /> : null}
      </button>
      {/* Hvatište za promenu trajanja — samo kad je pravi kraj bara u prozoru. */}
      {clipRight ? null : (
        <span
          role="separator"
          aria-label="Promeni trajanje"
          onPointerDown={(ev) => {
            ev.stopPropagation();
            if (ev.button !== 0) return;
            onDragStart('resize', ev.clientX);
          }}
          className="absolute right-0 top-0 h-6 w-1.5 cursor-ew-resize rounded-r-control bg-ink/20 hover:bg-ink/40"
        />
      )}
      {/* C1: kružna hvataljka za POVEZIVANJE — namerno VAN bara (desno od kraja), da se
          jasno razdvoji od resize hvatišta na ivici; kursor crosshair vs ew-resize.
          Vidljiva na hover reda (group/row) i dok je gest aktivan iz ovog bara. */}
      {clipRight ? null : (
        <span
          role="button"
          data-linkhandle
          aria-label="Poveži: prevuci na drugi bar — ta stavka dobija ovu kao uslov"
          title="Poveži: prevuci na drugi bar — ta stavka dobija ovu kao uslov (ESC otkazuje)"
          onPointerDown={(ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            if (ev.button !== 0) return;
            onLinkStart(ev.clientX, ev.clientY);
          }}
          className={cn(
            'absolute -right-2.5 top-1/2 z-20 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full',
            'border-2 border-accent bg-surface opacity-0 transition-opacity',
            'group-hover/row:opacity-100 focus-visible:opacity-100',
            linkSource && 'opacity-100',
          )}
        />
      )}
    </div>
  );
}

/**
 * SVG sloj veza (C1) — MS Project stil: elbow linija sa KRAJA bara prethodnika u
 * POČETAK bara sledbenika, sa strelicom. Živi u telu ose (skroluje se sa sadržajem),
 * pointer-events:none osim nevidljive „hit" linije za klik-brisanje.
 *
 * Performanse: crta SAMO veze čiji su OBA kraja među iscrtanim redovima (`groups` je
 * već isečen na MAX_ROWS) i čije su obe stavke na planu — max ~300 redova → zanemarljiv
 * broj putanja. y-pozicije iz `layoutRows` (fiksne visine), x iz `barGeometry` (ista
 * matematika kao Bar, uklj. živi drag pomak — linija prati bar dok se vuče).
 */
function LinkLayer({
  groups,
  rangeStart,
  days,
  width,
  shiftOf,
  linkDrag,
  onDelete,
}: {
  groups: HallGroup[];
  rangeStart: Date;
  days: number;
  width: number;
  /**
   * 075/26 — vizuelni pomak reda tokom gesta. Bio je `drag` (samo uhvaćen bar), a sada
   * je funkcija: kaskada pomera i sledbenike, pa i njihova sidra veza moraju da prate.
   */
  shiftOf: (key: string, row: GanttRow) => GestPomak | null;
  linkDrag: LinkDragState | null;
  onDelete: (succ: GanttRow, pred: GanttRow) => void;
}) {
  const { map, totalH } = useMemo(() => layoutRows(groups), [groups]);

  const geomOf = (row: GanttRow, key: string) => {
    const d = shiftOf(key, row);
    const shiftMs = (d?.mode === 'move' ? d.deltaDays : 0) * DAY_MS;
    const growMs = (d?.mode === 'resize' ? d.deltaDays : 0) * DAY_MS;
    return barGeometry(row, rangeStart, days, shiftMs, growMs);
  };

  const links: { key: string; d: string; pred: GanttRow; succ: GanttRow }[] = [];
  for (const [key, rl] of map) {
    const r = rl.row;
    if (!r.predecessor_work_order_id || !r.predecessor_line || !r.planned_start_at) continue;
    const pred = map.get(`${r.predecessor_work_order_id}:${r.predecessor_line}`);
    if (!pred?.row.planned_start_at) continue;
    const gp = geomOf(pred.row, rowKey(pred.row));
    const gs = geomOf(r, key);
    if (!gp || !gs) continue;
    // Sidra: kraj prethodnika → početak sledbenika; bar ceo van prozora se sidri na
    // ivici (geometrija je klipovana), pa se vidi da veza postoji i „nastavlja se".
    const x1 = AXIS_X + gp.left + gp.width;
    const y1 = pred.top + ROW_H / 2;
    const x2 = AXIS_X + gs.left;
    const y2 = rl.top + ROW_H / 2;
    links.push({ key, d: linkPath(x1, y1, x2, y2, rl.top), pred: pred.row, succ: r });
  }

  // Gumena linija aktivnog gesta: kraj izvornog bara → kursor.
  let rubber: { x1: number; y1: number } | null = null;
  if (linkDrag) {
    const src = map.get(linkDrag.sourceKey);
    const g = src ? geomOf(src.row, linkDrag.sourceKey) : null;
    if (src && g) rubber = { x1: AXIS_X + g.left + g.width, y1: src.top + ROW_H / 2 };
  }

  if (links.length === 0 && !rubber) return null;
  const lbl = (r: GanttRow) => `${r.rn_ident_broj ?? r.work_order_id} op. ${String(r.operacija ?? '—')}`;

  return (
    <svg
      className="absolute left-0 top-0 z-20 text-accent"
      style={{ pointerEvents: 'none' }}
      width={width}
      height={totalH}
      aria-hidden
    >
      <defs>
        <marker
          id="pp-gant-strelica"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
        </marker>
      </defs>
      {links.map((l) => (
        <g key={l.key}>
          <path
            d={l.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            opacity={0.8}
            markerEnd="url(#pp-gant-strelica)"
          />
          {/* Nevidljiva široka linija = klik-meta za brisanje (tanka se ne pogađa mišem).
              Tokom gesta povezivanja se gasi da ne zaklanja hit-test barova. */}
          <path
            d={l.d}
            fill="none"
            stroke="transparent"
            strokeWidth={9}
            style={{ pointerEvents: linkDrag ? 'none' : 'stroke', cursor: 'pointer' }}
            onClick={() => onDelete(l.succ, l.pred)}
          >
            <title>{`Uslov: ${lbl(l.pred)} → ${lbl(l.succ)} — klik briše vezu`}</title>
          </path>
        </g>
      ))}
      {rubber && linkDrag ? (
        <g>
          <path
            d={`M ${rubber.x1} ${rubber.y1} L ${linkDrag.x} ${linkDrag.y}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <circle cx={linkDrag.x} cy={linkDrag.y} r={3} fill="currentColor" />
        </g>
      ) : null}
    </svg>
  );
}

function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}
