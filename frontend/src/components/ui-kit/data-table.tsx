'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ContextMenu, type ContextMenuItem } from './context-menu';

/**
 * `useLayoutEffect` na serveru ne radi ništa i React na to upozorava pri
 * prerenderu — a `DataTable` se prerenderuje na SVAKOJ strani statičkog izvoza.
 * Grana je konstanta po okruženju, pa je redosled hukova stabilan.
 */
const useLayoutEffectIsomorphic = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface Column<T> {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right';
  numeric?: boolean;
  /** Kolona je sortabilna klikom na zaglavlje (traži `sort`+`onSortToggle` na tabeli). */
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

/** Stanje sortiranja po koloni (kontrolisano spolja — persist radi pozivalac). */
export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * Akcija nad JEDNIM redom — stavka menija koji se otvara dugmetom „…" u
 * poslednjoj koloni i desnim klikom na red. Isti oblik kao `ContextMenuItem`.
 */
export type RowAction = ContextMenuItem;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowActivate?: (row: T) => void;
  renderExpanded?: (row: T) => ReactNode;
  expandedKey?: string | number | null;
  empty?: ReactNode;
  loading?: boolean;
  /** Uključi native HTML5 prevlačenje redova (uz `onRowDrop`). */
  rowDraggable?: boolean;
  /** Poziva se pri spuštanju prevučenog reda na drugi (ključevi kao stringovi). */
  onRowDrop?: (dragKey: string, overKey: string) => void;
  /** Aktivno sortiranje (kontrolisano); indikator ▲/▼ na koloni. */
  sort?: SortState | null;
  /** Klik na sortabilno zaglavlje — pozivalac ciklira asc → desc → none. */
  onSortToggle?: (key: string) => void;
  /** Opcione dodatne klase po redu (npr. isticanje prekoračenih rokova — RB-22). */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Zaglavlje ostaje zalepljeno pri vertikalnom skrolu.
   * **Traži i `maxHeight`** — bez zadate visine okvir nikad ne skroluje po vertikali,
   * pa se `sticky top-0` zalepi za sopstveno mesto i efekta nema.
   */
  stickyHeader?: boolean;
  /**
   * Koliko PRVIH kolona ostaje zamrznuto uz levu ivicu pri vodoravnom skrolu
   * (šifra + naziv kod širokih šifarnika). Pomeraji se MERE iz zaglavlja, pa
   * kolone smeju biti proizvoljne širine.
   */
  frozenColumns?: number;
  /**
   * Visina okvira za skrol, npr. `calc(100dvh - 320px)`.
   * **`dvh`, nikad `vh`** (DESIGN_SYSTEM §11.4) — `100vh` je na iOS-u veliki
   * viewport, pa dno tabele završi pod donjom trakom Safarija.
   */
  maxHeight?: string;
  /**
   * RUČKA NA SKROL-OKVIR tabele (opciono, čisto aditivno).
   *
   * Uz `maxHeight`/`stickyHeader` tabela ne skroluje prozorom nego SOPSTVENIM okvirom,
   * pa `window.scrollY` o njoj ne zna ništa — ekran koji hoće da zapamti gde je
   * korisnik stao (povratak sa detalja na beskonačan skrol) nema drugog načina da
   * dohvati `scrollTop`.
   *
   * Prima i objektni i callback ref. Ekrani koji ga ne zadaju se renderuju identično.
   */
  scrollRef?: Ref<HTMLDivElement>;
  /**
   * Akcije nad redom. Postavljeno = tabela dobija poslednju kolonu sa dugmetom „…"
   * i isti meni na desni klik na red. Poziva se pri OTVARANJU menija, pa lista
   * sme da zavisi od stanja reda (npr. „Storniraj" onemogućeno na proknjiženom).
   */
  rowActions?: (row: T) => RowAction[];
  /**
   * KONTROLISAN IZBOR (opciono) — ključ izabranog reda, u istom obliku koji vraća
   * `rowKey`. Zadato = akcentna traka i `aria-selected` prate NJEGA, a ne interni
   * indeks; `null` znači „ništa nije izabrano" i tada nijedan red nije istaknut.
   *
   * Izostavljeno (podrazumevano za ~120 ekrana) = tabela vodi izbor sama, kao i
   * pre uvođenja ovog propa: kreće od prvog reda i pomera ga strelicama.
   *
   * Zašto postoji: interni izbor je INDEKS i starta na 0, pa prvi red izgleda
   * izabrano i pre nego što ga je korisnik dodirnuo. Ekran koji na osnovu izbora
   * pali dugmad („radi nad izabranim artiklom") tada tvrdi suprotno od onoga što
   * se vidi — traka stoji na prvom redu, a dugmad su siva uz „prvo izaberi red".
   * Isto se ponavljalo posle svake promene filtera (nova lista, stari indeks).
   */
  selectedKey?: string | number | null;
  /**
   * Izbor se pomerio: klik na red, desni klik, dugme „…" ili ↑/↓.
   *
   * Ide ISKLJUČIVO uz `selectedKey` — kad je izbor kontrolisan, izvor istine je
   * spolja, pa je ovo jedini način da ga tastatura i pokazivač pomere. Bez
   * `selectedKey` se ne poziva: tabela tada izbor vodi sama i pozivalac nema šta
   * sa tom informacijom da radi (a nekontrolisana grana ostaje netaknuta).
   */
  onSelectionChange?: (row: T) => void;
}

/**
 * Vraća `true` ako je meta desnog klika ugnežđena kontrola — tada NE otimamo
 * nativni meni pregledača (kopiranje teksta iz polja, „otvori link u novoj kartici").
 *
 * Isti razlog kao guard u `onKeyDown` (bug 009/26): `renderExpanded` crta detalj
 * UNUTAR `<tbody>`, uključujući polja i ne-portal dijaloge, pa svaki događaj iz
 * njih bubble-uje do reda.
 */
function jeUgnezdenaKontrola(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  // Naše sopstveno dugme „…" je izuzetak — desni klik na njega otvara isti meni.
  if (el.closest('[data-row-menu-trigger]')) return false;
  return !!el.closest(
    'input, textarea, select, button, a, label, [contenteditable="true"], [role="button"], [role="dialog"]',
  );
}

/**
 * Gusta tabela (DESIGN_SYSTEM.md §5): red ~35px, zaglavlje uppercase,
 * tastatura ↑/↓ + Enter, selektovan red = akcentna traka levo + blaga pozadina.
 *
 * Opcije `stickyHeader` / `frozenColumns` / `maxHeight` / `rowActions` i
 * `selectedKey` / `onSelectionChange` su ADITIVNE: tabela koja ih ne zada
 * renderuje se isto kao pre njihovog uvođenja (komponentu koristi ~120 ekrana).
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowActivate,
  renderExpanded,
  expandedKey,
  empty,
  loading,
  rowDraggable,
  onRowDrop,
  sort,
  onSortToggle,
  rowClassName,
  stickyHeader,
  frozenColumns,
  maxHeight,
  scrollRef,
  rowActions,
  selectedKey,
  onSelectionChange,
}: DataTableProps<T>) {
  const [focus, setFocus] = useState(0);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const dnd = !!rowDraggable && !!onRowDrop;

  // ─── Izbor reda ──────────────────────────────────────────────────────────
  // Jedna te ista stvar mora biti i ono što se VIDI (akcentna traka,
  // `aria-selected`) i ono na osnovu čega ekran radi. Zato izbor ima dva režima,
  // a nikad oba izvora istovremeno:
  //   • kontrolisan (`selectedKey` ZADAT, sme i `null`) — istaknut je red čiji se
  //     ključ poklapa; ništa se ne ističe dok pozivalac ne izabere red;
  //   • nekontrolisan (prop izostavljen) — interni indeks `focus`, kao i pre.
  const kontrolisan = selectedKey !== undefined;

  /** Indeks istaknutog reda; −1 = nema izbora (moguće samo u kontrolisanom režimu). */
  function indexIzbora(): number {
    if (!kontrolisan) return focus;
    if (selectedKey == null) return -1;
    return rows.findIndex((r) => rowKey(r) === selectedKey);
  }

  /** Izbor pomeren pokazivačem (klik / desni klik / dugme „…"). */
  function postaviIzbor(i: number, row: T) {
    if (kontrolisan) onSelectionChange?.(row);
    else setFocus(i);
  }

  /** ↑/↓ nad telom tabele. */
  function pomeriIzbor(korak: 1 | -1) {
    const uOpsegu = (i: number) => Math.min(Math.max(i, 0), rows.length - 1);
    if (!kontrolisan) {
      // Nekontrolisana grana ostaje BAJT-ISTA: funkcionalno ažuriranje, jer se pri
      // držanju strelice događaji nižu brže nego što se velika tabela prekrtava.
      setFocus((f) => uOpsegu(f + korak));
      return;
    }
    const i = indexIzbora();
    // Bez izbora prva strelica hvata kraj u smeru kretanja: ↓ prvi red, ↑ poslednji.
    const sledeci = i < 0 ? (korak === 1 ? 0 : rows.length - 1) : uOpsegu(i + korak);
    const row = rows[sledeci];
    if (row) onSelectionChange?.(row);
  }

  /** Otvoren meni akcija: red + tačka otvaranja (viewport koordinate). */
  const [menu, setMenu] = useState<{ row: T; x: number; y: number } | null>(null);
  const zatvoriMeni = useCallback(() => setMenu(null), []);

  // ─── Zamrznute kolone ────────────────────────────────────────────────────
  // `left` pomeraj se ne može zapisati u klasu jer širine kolona zavise od
  // sadržaja: mere se iz ćelija zaglavlja i primenjuju kao dinamički `style`
  // (jedini dozvoljen inline stil — DESIGN_SYSTEM §2).
  const frozen = Math.max(0, Math.min(frozenColumns ?? 0, columns.length));
  const tableRef = useRef<HTMLTableElement>(null);
  const headRefs = useRef<(HTMLTableCellElement | null)[]>([]);
  const [frozenOffsets, setFrozenOffsets] = useState<number[]>([]);

  useLayoutEffectIsomorphic(() => {
    if (frozen <= 0) {
      setFrozenOffsets((prev) => (prev.length ? [] : prev));
      return;
    }
    const izmeri = () => {
      const sledeci: number[] = [];
      let zbir = 0;
      for (let i = 0; i < frozen; i++) {
        sledeci.push(zbir);
        zbir += headRefs.current[i]?.offsetWidth ?? 0;
      }
      setFrozenOffsets((prev) =>
        prev.length === sledeci.length && prev.every((v, i) => v === sledeci[i]) ? prev : sledeci,
      );
    };
    izmeri();
    if (typeof ResizeObserver === 'undefined') return;
    // Širina kolone se menja i bez promene props-a (novi red sa dužim nazivom,
    // promena širine prozora) — bez posmatrača bi zamrznute kolone „iskliznule".
    // Posmatraju se i SAME zamrznute ćelije: tabela ume da zadrži ukupnu širinu
    // dok se kolone unutar nje preraspodele, pa posmatrač samo nad `<table>` to
    // ne bi video.
    const ro = new ResizeObserver(izmeri);
    if (tableRef.current) ro.observe(tableRef.current);
    for (let i = 0; i < frozen; i++) {
      const th = headRefs.current[i];
      if (th) ro.observe(th);
    }
    return () => ro.disconnect();
  }, [frozen, columns.length, rows.length]);

  const otvoriMeni = useCallback((row: T, x: number, y: number) => setMenu({ row, x, y }), []);

  function onKeyDown(e: KeyboardEvent<HTMLTableSectionElement>) {
    // Prečice tabele (↑/↓/Enter) pripadaju TELU TABELE — i to samo dok ono samo
    // drži fokus. Čim je fokus u ugnežđenoj kontroli (polje, dugme, dijalog),
    // tasteri pripadaju NJOJ i ovde se ne diraju.
    //
    // Bug 009/26 („pisanje u radnom nalogu", prijavljen dvaput — 27.07. i 03.08.):
    // `renderExpanded` crta detalj RN-a UNUTAR ovog `<tbody>`, a `Dialog` nije
    // portal — pa mu tasteri iz polja bubble-uju čak dovde. Enter u polju „Opis
    // rada" je zato padao na granu ispod: `preventDefault()` bi pojeo novi red,
    // a `onRowActivate` sklopio prošireni red → dijalog se demontira i OTKUCANI
    // TEKST NESTANE. Isto je važilo za ↑/↓ (pomeranje kursora u textarea,
    // koračanje u brojčanim poljima).
    if (e.target !== e.currentTarget) return;
    if (!rows.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pomeriIzbor(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pomeriIzbor(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Indeks ume da bude van opsega ako se `rows` suzio (promena filtera/pretrage)
      // a strelice još nisu pomerile izbor, ili −1 kad kontrolisani izbor nije
      // postavljen — bez guarda je `rows[i]` undefined.
      const row = rows[indexIzbora()];
      if (row) onRowActivate?.(row);
    } else if (rowActions && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      // Tastaturni ekvivalent desnog klika (tastatura-prvo, §1.3).
      e.preventDefault();
      const i = indexIzbora();
      const row = rows[i];
      if (!row) return;
      const tr = bodyRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${i}"]`);
      const r = tr?.getBoundingClientRect();
      otvoriMeni(row, r?.left ?? 0, r?.bottom ?? 0);
    }
  }

  const colCount = columns.length + (rowActions ? 1 : 0);
  const stavkeMenija = menu && rowActions ? rowActions(menu.row) : [];

  return (
    <>
    <div
      ref={scrollRef}
      className={cn(
        'overflow-x-auto rounded-panel border border-line bg-surface',
        // Zamrznuto zaglavlje traži da OVAJ okvir bude skrol-kontejner po obe ose.
        (maxHeight || stickyHeader) && 'overflow-auto',
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table ref={tableRef} className="w-full text-sm">
        <thead className={stickyHeader ? 'sticky top-0 z-20' : undefined}>
          <tr className="border-b border-line bg-surface-2 text-left">
            {columns.map((c, i) => {
              const sortableHere = !!c.sortable && !!onSortToggle;
              const active = sort?.key === c.key ? sort : null;
              const zamrznuta = i < frozen;
              return (
                <th
                  key={c.key}
                  ref={(el) => {
                    headRefs.current[i] = el;
                  }}
                  aria-sort={active ? (active.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cn(
                    'h-9 px-4 font-semibold uppercase tracking-[0.08em] text-ink-secondary',
                    'text-2xs',
                    c.align === 'right' && 'text-right',
                    // Lepljiva ćelija mora nositi SVOJU pozadinu: pozadina reda
                    // ostaje u toku tabele i ne putuje sa ćelijom, pa bi se
                    // ispod zamrznute kolone videlo ono što klizi pored nje.
                    stickyHeader && 'bg-surface-2',
                    zamrznuta && 'sticky z-30 bg-surface-2',
                    zamrznuta && i === frozen - 1 && 'border-r border-line',
                  )}
                  style={zamrznuta ? { left: frozenOffsets[i] ?? 0 } : undefined}
                >
                  {sortableHere ? (
                    <button
                      type="button"
                      onClick={() => onSortToggle(c.key)}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-ink',
                        'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
                        active && 'text-ink',
                      )}
                      title="Sortiraj po koloni"
                    >
                      {c.header}
                      <span aria-hidden className="text-[9px] leading-none">
                        {active ? (active.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th
                className={cn(
                  'h-9 w-10 px-2 font-semibold uppercase tracking-[0.08em] text-ink-secondary',
                  'text-2xs',
                  stickyHeader && 'bg-surface-2',
                )}
              >
                <span className="sr-only">Akcije</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody
          ref={bodyRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="focus-visible:outline-none"
        >
          {loading ? (
            <tr>
              <td colSpan={colCount} className="px-4 py-10 text-center text-ink-disabled">
                Učitavanje…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="p-0">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row);
              // Istaknut red = IZABRAN red: kontrolisano po ključu (bez izbora se
              // ne ističe ništa), inače po internom indeksu — kao i pre.
              const istaknut = kontrolisan ? selectedKey != null && selectedKey === key : i === focus;
              const isExpanded = expandedKey != null && expandedKey === key;
              return (
                <FragmentRow key={key}>
                  <tr
                    data-row-index={rowActions ? i : undefined}
                    onClick={() => {
                      postaviIzbor(i, row);
                      onRowActivate?.(row);
                    }}
                    onContextMenu={
                      rowActions
                        ? (e) => {
                            if (jeUgnezdenaKontrola(e.target)) return;
                            e.preventDefault();
                            postaviIzbor(i, row);
                            otvoriMeni(row, e.clientX, e.clientY);
                          }
                        : undefined
                    }
                    aria-selected={istaknut}
                    draggable={dnd || undefined}
                    onDragStart={
                      dnd
                        ? (e) => {
                            e.dataTransfer.setData('text/plain', String(key));
                            e.dataTransfer.effectAllowed = 'move';
                          }
                        : undefined
                    }
                    onDragOver={
                      dnd
                        ? (e) => {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dropTarget !== String(key)) setDropTarget(String(key));
                          }
                        : undefined
                    }
                    onDragLeave={
                      dnd
                        ? () => {
                            setDropTarget((t) => (t === String(key) ? null : t));
                          }
                        : undefined
                    }
                    onDrop={
                      dnd
                        ? (e) => {
                            e.preventDefault();
                            const dragKey = e.dataTransfer.getData('text/plain');
                            setDropTarget(null);
                            if (dragKey) onRowDrop?.(dragKey, String(key));
                          }
                        : undefined
                    }
                    className={cn(
                      'h-[var(--table-row-height)] cursor-pointer border-b border-line-soft',
                      'hover:bg-surface-2',
                      istaknut && 'bg-accent-subtle',
                      // Akcentna traka izbora stoji na REDU samo kad nema zamrznutih kolona.
                      // Sa `frozenColumns` prva ćelija je `sticky` sa neprozirnom pozadinom i
                      // `left: 0`, pa se crta PREKO tih 3px — izabran red bi ostao bez trake.
                      // Zato se u tom slučaju traka premešta na prvu ćeliju (ispod).
                      istaknut && frozen === 0 && 'shadow-[inset_3px_0_0_var(--accent)]',
                      dnd && dropTarget === String(key) && 'border-t-2 border-t-accent',
                      // `group` je samo marker za `group-hover:` na zamrznutim
                      // ćelijama; bez zamrznutih kolona se ne dodaje (DOM ostaje isti).
                      frozen > 0 && 'group',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((c, ci) => {
                      const zamrznuta = ci < frozen;
                      return (
                        <td
                          key={c.key}
                          className={cn(
                            'px-4 text-ink',
                            c.align === 'right' && 'text-right',
                            c.numeric && 'tnums',
                            // Redosled je isti kao na `<tr>`: osnovna pozadina,
                            // pa selekcija, a `group-hover` (veća specifičnost)
                            // pobeđuje na prelazu miša — tačno kao danas na redu.
                            zamrznuta && 'sticky z-10 bg-surface group-hover:bg-surface-2',
                            zamrznuta && istaknut && 'bg-accent-subtle',
                            // Traka izbora sa `<tr>` (v. gore): zamrznuta ćelija bi je pokrila,
                            // pa je nosi prva ćelija. Bez zamrznutih kolona ovo se ne dodaje.
                            istaknut && frozen > 0 && ci === 0 && 'shadow-[inset_3px_0_0_var(--accent)]',
                            zamrznuta && ci === frozen - 1 && 'border-r border-line',
                          )}
                          style={zamrznuta ? { left: frozenOffsets[ci] ?? 0 } : undefined}
                        >
                          {c.render(row)}
                        </td>
                      );
                    })}
                    {rowActions && (
                      <td className="px-2 text-right">
                        <button
                          type="button"
                          data-row-menu-trigger=""
                          aria-haspopup="menu"
                          aria-label="Akcije nad redom"
                          title="Akcije nad redom"
                          onClick={(e) => {
                            // Klik na „…" BIRA red, ali ga ne aktivira — inače bi
                            // se uz meni otvorio i detalj/prošireni red.
                            e.stopPropagation();
                            postaviIzbor(i, row);
                            const r = e.currentTarget.getBoundingClientRect();
                            // Otvaranje od DESNE ivice dugmeta: uz desnu ivicu
                            // ekrana se meni prevrne ulevo i ostane poravnat.
                            otvoriMeni(row, r.right, r.bottom);
                          }}
                          className={cn(
                            'inline-grid h-7 w-7 place-items-center rounded-control text-ink-secondary',
                            'max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
                            'hover:bg-surface-2 hover:text-ink active:bg-line-soft',
                            'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
                          )}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </button>
                      </td>
                    )}
                  </tr>
                  {isExpanded && renderExpanded && (
                    <tr className="border-b border-line-soft bg-surface-2/60">
                      <td colSpan={colCount} className="px-4 py-3">
                        {renderExpanded(row)}
                      </td>
                    </tr>
                  )}
                </FragmentRow>
              );
            })
          )}
        </tbody>
      </table>
    </div>

    {/* Van skrol-okvira: meni je `position: fixed` i ne sme da zavisi od
        `overflow`/konteksta slaganja tabele. Bez `rowActions` se ne renderuje
        ništa — DOM ekrana koji ne koristi akcije ostaje nepromenjen. */}
    {rowActions && (
      <ContextMenu
        origin={menu ? { x: menu.x, y: menu.y } : null}
        items={stavkeMenija}
        onClose={zatvoriMeni}
        ariaLabel="Akcije nad redom"
      />
    )}
    </>
  );
}

// Small helper so each logical row (+ its expansion) shares one key.
function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
