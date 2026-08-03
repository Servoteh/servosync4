'use client';

import { useMemo, useState } from 'react';
import { ScanLine, X } from 'lucide-react';
import { LOC_TYPE_LABEL, type LocLocation } from '@/api/lokacije';
import { formatNumber } from '@/lib/format';

/**
 * Pretraživi izbor lokacije iz učitane liste aktivnih lokacija (klijentski filter
 * po šifri / nazivu / path_cached). Opcioni `onScan` dodaje dugme za skener police.
 * `kinds` opciono ograničava tipove (npr. samo hale za premeštaj kaveza).
 */
const HALL_SET = new Set(['WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP']);

/** Police u širem smislu (paritet `SHELF_TYPES`) — mete magacionerskih tokova. */
const SHELF_SET = new Set(['SHELF', 'RACK', 'BIN']);

/**
 * Koliko opcija ulazi u DOM (i na prazan upit i na rezultat pretrage).
 *
 * Prijava iz pogona 01.08: „aplikacija ne prikazuje sve police, a stara ih
 * prikazuje". Podaci su bili tu (1.357 aktivnih lokacija, 1.111 polica; backend
 * ih uredno vraća) — lista je sekla na 40 BEZ ijedne poruke da ostatak postoji,
 * pa je tražena polica često bila van liste i bez traga da je treba iskucati.
 * 200 redova je za DOM bezbolno, a drastično smanjuje šansu za taj promašaj.
 */
export const LOC_OPTION_LIMIT = 200;

// ── Sortiranje 1.0 (src/lib/lokacijeSort.js) ─────────────────────────────────
// Prirodno `sr` poređenje (brojevi kao brojevi — A10 POSLE A2, ne posle A1) +
// kavezi `KV 1…KV 12` po broju. 3.0 je do 03.08.2026 zadržavao serverski
// redosled (pathCached asc, leksikografski) pa je redosled polica odstupao od
// 1.0 navika magacionera — dropdown-ovi sada sortiraju ISTIM redosledom kao 1.0.

/** Prirodno `sr` poređenje šifri (paritet 1.0 `compareLocationCodeNatural`). */
function naturalSr(a: string, b: string): number {
  return a.localeCompare(b, 'sr', { numeric: true, sensitivity: 'base' });
}

/** Broj iz globalne šifre kaveza `KV N` (paritet 1.0 `cageCodeNumber`). */
function cageCodeNumber(code: string): number {
  const m = code.trim().match(/^KV (\d+)$/i);
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * Razred za redosled grupa u listi — paritet 1.0 „Na lokaciju" selecta:
 * 📍 POLICE → 🧺 KAVEZI → 🏭 HALE → ostalo (mašine/škart/…).
 * Bez `shelvesFirst` (npr. izbor hale u formama) razredi se ne primenjuju.
 */
function locClassRank(l: LocLocation): number {
  if (SHELF_SET.has(l.locationType)) return 0;
  if (l.locationType === 'CAGE') return 1;
  if (HALL_SET.has(l.locationType)) return 2;
  return 3;
}

/**
 * Ključ prirodnog sortiranja: `pathCached` nosi „hala > polica" pa prirodno
 * poređenje po njemu daje 1.0 redosled „prvo hala (A–Z), pa polica (A–Z)"
 * (paritet `sortShelvesByHallThenCode`) bez šetnje po parentId lancu.
 */
function locSortKey(l: LocLocation): string {
  return l.pathCached || l.locationCode;
}

/** Puno 1.0 poređenje dve lokacije (razred → KV broj → prirodno po ključu). */
function compareLocOptions(a: LocLocation, b: LocLocation, byClass: boolean): number {
  if (byClass) {
    const dr = locClassRank(a) - locClassRank(b);
    if (dr !== 0) return dr;
    if (a.locationType === 'CAGE' && b.locationType === 'CAGE') {
      const na = cageCodeNumber(a.locationCode);
      const nb = cageCodeNumber(b.locationCode);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    }
  }
  return naturalSr(locSortKey(a), locSortKey(b));
}

/**
 * Klijentski filter opcija lokacije + 1.0 redosled + sečenje na `limit`.
 *
 * Izdvojeno iz komponente jer mobilni batch ekran (`/mob/lokacije/batch`) ima
 * SVOJ punoekranski izbor police — semantika (šta se pretražuje, koliko se
 * prikazuje, šta ide prvo) mora biti identična na oba mesta, inače se ista
 * prijava vraća sa drugog ekrana.
 *
 * Redosled = 1.0 (v. komparatore iznad) i primenjuje se I NA POGOTKE pretrage —
 * 1.0 select je uvek sortiran katalog, pa „isti redosled kao stara aplikacija"
 * važi u oba stanja (do 03.08.2026 su pogoci zadržavali serverski redosled).
 *
 * `total` je broj kandidata PRE sečenja — pozivalac iz njega gradi poruku o
 * ostatku (v. `locOptionsTruncatedHint`).
 */
export function filterLocationOptions(
  base: LocLocation[],
  query: string,
  opts: { shelvesFirst?: boolean; limit?: number } = {},
): { items: LocLocation[]; total: number } {
  const limit = opts.limit ?? LOC_OPTION_LIMIT;
  const s = query.trim().toLowerCase();
  const hits = s
    ? base.filter(
        (l) =>
          l.locationCode.toLowerCase().includes(s) ||
          (l.name ?? '').toLowerCase().includes(s) ||
          (l.pathCached ?? '').toLowerCase().includes(s),
      )
    : base;
  const ordered = [...hits].sort((a, b) => compareLocOptions(a, b, !!opts.shelvesFirst));
  return { items: ordered.slice(0, limit), total: hits.length };
}

/**
 * Diskretna poruka o odsečenom ostatku; `null` kad lista nije odsečena.
 * Bez nje korisnik nema NAČIN da sazna da lista ima nastavak — to je bio ceo
 * bug (3 vidljive police od 1.111), pa je poruka deo popravke, ne ukras.
 */
export function locOptionsTruncatedHint(
  shown: number,
  total: number,
  hasQuery: boolean,
): string | null {
  if (total <= shown) return null;
  return `Prikazano prvih ${formatNumber(shown)} od ${formatNumber(total)} — ${
    hasQuery ? 'dopuni upit da suziš listu.' : 'kucaj deo šifre ili naziva za pretragu.'
  }`;
}

export function LocationSelect({
  locations,
  value,
  onChange,
  onScan,
  placeholder = 'Pretraži lokaciju…',
  kinds,
  groupByHall = false,
  shelvesFirst = false,
}: {
  locations: LocLocation[];
  value: string | null;
  onChange: (id: string | null) => void;
  onScan?: () => void;
  placeholder?: string;
  kinds?: string[];
  /** Grupiši rezultate po nadređenoj hali (optgroup — paritet 1.0 grupisana destinacija). */
  groupByHall?: boolean;
  /**
   * Na prazan upit prvo ponudi police/regale/kese — magacionerski tokovi („sa
   * lokacije" / „na lokaciju", batch odredište) skoro uvek ciljaju policu.
   * NE uključivati tamo gde se bira HALA (roditelj lokacije u formi): tamo bi
   * police potisnule tačan odgovor sa vrha liste.
   */
  shelvesFirst?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => (value ? locations.find((l) => l.id === value) ?? null : null),
    [value, locations],
  );

  const base = useMemo(
    () => (kinds ? locations.filter((l) => kinds.includes(l.locationType)) : locations),
    [locations, kinds],
  );
  const { items: filtered, total } = useMemo(
    () => filterLocationOptions(base, q, { shelvesFirst }),
    [base, q, shelvesFirst],
  );
  const moreHint = locOptionsTruncatedHint(filtered.length, total, q.trim() !== '');

  // Grupisanje po hali: nađi najbližeg pretka tipa HALA (šetnja parentId unutar liste).
  const groups = useMemo(() => {
    if (!groupByHall) return null;
    const byId = new Map(locations.map((l) => [l.id, l]));
    const hallLabelOf = (l: LocLocation): string => {
      let cur: LocLocation | undefined = l;
      const seen = new Set<string>();
      for (let i = 0; i < 32 && cur; i++) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        if (HALL_SET.has(cur.locationType)) return `${cur.locationCode}${cur.name ? ` — ${cur.name}` : ''}`;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return 'Ostalo';
    };
    const map = new Map<string, LocLocation[]>();
    for (const l of filtered) {
      const key = hallLabelOf(l);
      const arr = map.get(key);
      if (arr) arr.push(l);
      else map.set(key, [l]);
    }
    return [...map.entries()];
  }, [filtered, groupByHall, locations]);

  const renderOption = (l: LocLocation) => (
    <button
      type="button"
      key={l.id}
      onMouseDown={(e) => { e.preventDefault(); onChange(l.id); setOpen(false); setQ(''); }}
      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
    >
      <span className="text-sm text-ink">
        {l.locationCode}
        <span className="text-ink-disabled"> · {LOC_TYPE_LABEL[l.locationType] ?? l.locationType}</span>
      </span>
      {l.pathCached && <span className="text-xs text-ink-disabled">{l.pathCached}</span>}
    </button>
  );

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
        <span className="truncate">
          <span className="font-medium">{selected.locationCode}</span>
          <span className="text-ink-secondary"> · {LOC_TYPE_LABEL[selected.locationType] ?? selected.locationType}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} aria-label="Ukloni izbor" className="ml-2 shrink-0 text-ink-secondary hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <div className="relative flex-1">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-accent"
        />
        {open && (
          // Visina: na telefonu 60vh (≈ 6+ stavki od po dva reda) pa se ODMAH vidi
          // da lista ima nastavak; na ≥640px ostaje zatečenih 224px (dropdown u
          // dijalogu ne sme da preraste modal, a miš ima vidljiv scrollbar).
          <div className="absolute z-10 mt-1 max-h-[min(60vh,26rem)] w-full overflow-auto rounded-control border border-line bg-surface shadow-lg sm:max-h-56">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-ink-disabled">Nema rezultata.</div>
            ) : (
              <>
                {groups
                  ? groups.map(([label, items]) => (
                      <div key={label}>
                        <div className="sticky top-0 bg-surface-2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">{label}</div>
                        {items.map(renderOption)}
                      </div>
                    ))
                  : filtered.map(renderOption)}
                {moreHint && (
                  // Lepljivo na dnu — poruka na kraju 200 redova ne bi bila viđena,
                  // a ceo smisao joj je da se vidi bez skrolovanja. `preventDefault`
                  // sprečava da slučajan tap po poruci zatvori listu (blur).
                  <div
                    onMouseDown={(e) => e.preventDefault()}
                    className="sticky bottom-0 border-t border-line bg-surface-2 px-3 py-1.5 text-2xs leading-snug text-ink-secondary"
                  >
                    {moreHint}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {onScan && (
        <button
          type="button"
          onClick={onScan}
          className="shrink-0 rounded-control border border-line bg-surface-2 px-2 text-ink-secondary hover:bg-surface"
          aria-label="Skeniraj lokaciju"
          title="Skeniraj lokaciju"
        >
          <ScanLine className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
