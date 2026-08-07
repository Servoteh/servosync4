'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Download, List, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column, type RowAction, type SortState } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { listHref, useListQueryState, useZapamcenaPozicijaListe } from '@/lib/use-id-param';
import { exportTableToCsv, type CsvColumn } from '@/lib/table-csv';
import { formatDecimal, formatNumber } from '@/lib/format';
import { useItemLookups } from '@/api/masters';
import {
  fetchLagerZaIzvoz,
  isLagerSortColumn,
  useLagerSkrol,
  useMagacinOpcije,
  useSetMinimalnaKolicina,
  LAGER_SKROL_KAPA,
  type LagerListParams,
  type LagerRow,
  type LagerSortColumn,
  type LagerSortDir,
  type ReservationScope,
} from '@/api/lager';
import { PERMISSIONS } from '@/lib/permissions';

/**
 * LAGER LISTA — „drugi pregled artikala" (zahtev vlasnika 05.08.2026: „oba prikaza imaju
 * namenu"). `/artikli` odgovara na pitanje „kakav je artikal", ovaj ekran na „koliko ga
 * ima i koliko sme da se obeća".
 *
 * Obrazac je isti kao `/artikli` (DESIGN_SYSTEM §4.1 „Lista"): kompaktna filter traka,
 * gusta tabela sa server-side filterom i sortom, SKROL umesto strana, zamrznuto zaglavlje
 * i prve dve kolone, red radnji nad izabranim redom = meni na desni klik.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ODAKLE BROJEVI — i zašto ekran to piše na sebi
 * ─────────────────────────────────────────────────────────────────────────────────────
 * Robno se do cutover-a (april 2027) vodi ISKLJUČIVO u BigBit-u; 4.0 tabele zaliha su
 * na produkciji prazne (mereno 04.08.2026). Ovo je READ-ONLY ogledalo BigBit-a koje puni
 * noćni `.mdb` uvoz, pa ekran nema nijednu radnju koja piše.
 *
 * Dva podatka menjaju SVE brojeve na ekranu, a iz samih brojeva se ne vide:
 *  • POSLOVNA GODINA — BigBit svaku godinu otvara sopstvenim „Donosom po popisu", a uvoz
 *    ništa ne briše; posle 01.01. prost zbir bi udvostručio stanje. Backend zato uvek
 *    seče po godini i vraća `meta.year` + `meta.yearSource`.
 *  • DOMET REZERVACIJA — rezervacije se u BigBit-u ne gase (1.576 dokumenata od 2013.,
 *    ≈ 1,08 M jedinica prema ≈ 71 k iz 2026.). Podrazumevano se seku istom godinom.
 * Oba stoje ispisana ISPOD filter trake. Brojevi bez te rečenice su brojevi „neke"
 * godine — a to je tačno greška zbog koje bi ekran izgledao ispravno dok laže.
 *
 * NAPOMENA O REDU: jedan red je PAR (artikal, magacin), ne artikal — isti artikal sa
 * zalihom u dva magacina daje dva reda. Zato je ključ reda `itemId-warehouseId`.
 */

/** Odlaganje upita dok se kuca — bez njega je svako slovo jedna agregacija nad ogledalom. */
const KUCANJE_MS = 300;

/**
 * Visina skrol-okvira tabele: ekran minus zaglavlje strane, filter traka, red sa
 * obrazloženjem godine, red radnji i podnožje sa brojačem. `dvh`, nikad `vh`
 * (DESIGN_SYSTEM §11.4) — `100vh` je na iOS-u veliki viewport, pa bi dno tabele
 * završilo pod trakom Safarija.
 */
const VISINA_TABELE = 'calc(100dvh - 24rem)';

/**
 * Prazan filter — „Poništi filter" vraća tačno ovo stanje.
 *
 * Prazna vrednost svuda znači PODRAZUMEVANO PONAŠANJE BACKENDA, ne „isključeno":
 * `bezStanja: ''` je backend-ov `onlyWithStock = true`, a `'1'` ga isključuje. Tako
 * `useListQueryState` u URL upisuje samo ono što odstupa od podrazumevanog, pa je adresa
 * ekrana čitljiva i deljiva.
 */
const PRAZAN_FILTER = {
  trazi: '',
  magacin: '',
  grupa: '',
  /** `all` = rezervacije iz SVIH godina (podrazumevano je tekuća poslovna godina). */
  rez: '',
  /** Poslovna godina; prazno = poslednja zatečena u ogledalu. */
  godina: '',
  /** `1` = prikaži i artikle bez stanja (backend podrazumevano skriva stanje 0). */
  bezStanja: '',
  /** `1` = samo negativna stanja (radna lista za ispravke). */
  minus: '',
  sort: '',
  smer: '',
};

/** Ključevi filtera koji stoje pod „Više filtera" — traka ih ne prikazuje. */
const NAPREDNI_FILTERI = ['godina', 'bezStanja'] as const;

/** Sort i smer nisu filter — „Poništi filter" ih ne dira, i ne pale oznaku „ima filtera". */
const NIJE_FILTER = new Set(['sort', 'smer']);

/**
 * Kolone kod kojih PRVI klik na zaglavlje sortira OPADAJUĆE. Kod količina i cena se traži
 * „najveće" (gde je najviše robe, koji artikal drži najviše para), pa bi rastući prvi
 * klik značio dva klika za svaki takav upit.
 *
 * SLOBODNO je izuzetak i namerno kreće RASTUĆE: pitanje nad tom kolonom nije „gde ima
 * najviše" nego „gde sam u minusu", a to je njen donji kraj.
 */
const PRVI_KLIK_OPADAJUCE = new Set<LagerSortColumn>(['stock', 'reserved', 'wholesalePrice']);

const REZERVACIJE_OPCIJE = [
  { value: 'year', label: 'tekuća godina' },
  { value: 'all', label: 'sve godine' },
];

/** Količina u srpskom formatu, 3 decimale (BigBit vodi kilaže i metraže). */
function kol(v: string | null | undefined): string {
  return formatDecimal(v, 3);
}

/** Naziv artikla za red koji `items` više ne poznaje — zaliha postoji, artikal je nestao. */
const NEPOZNAT_ARTIKAL = 'Artikal nije u šifarniku';

/**
 * Red bez kataloškog broja znači da `items` nema taj `item_id` (spoj je LEFT): artikal je
 * nestao iz BigBit šifarnika, a njegova zaliha u ogledalu je ostala. Takav red se PRIKAZUJE
 * (roba fizički postoji), ali kartice i detalj za njega vraćaju 404, pa se ne nude.
 */
function jeSiroce(r: LagerRow): boolean {
  return r.catalogNumber === null;
}

/**
 * Ključ reda = PAR (artikal, magacin). Sam `itemId` nije jedinstven — isti artikal sa
 * zalihom u dva magacina daje dva reda, pa bi React prikazao samo jedan od njih.
 */
function kljucReda(r: LagerRow): string {
  return `${r.itemId}-${r.warehouse.id}`;
}

/** Boja količine: minus je crven jer je radna stavka, nula i plus su običan tekst. */
function bojaKolicine(v: string | null): string {
  return Number(v) < 0 ? 'text-status-danger' : 'text-ink';
}

/** Poruka posle izmene minimalne količine — uspeh i greška se moraju razlikovati bojom. */
interface Poruka {
  vrsta: 'ok' | 'greska';
  tekst: string;
}

const columns: Column<LagerRow>[] = [
  {
    key: 'catalogNumber',
    header: 'Kataloški broj',
    sortable: true,
    render: (r) =>
      r.catalogNumber ? (
        <span className="tnums whitespace-nowrap font-semibold text-ink">{r.catalogNumber}</span>
      ) : (
        <span className="tnums whitespace-nowrap text-ink-disabled" title={NEPOZNAT_ARTIKAL}>
          #{r.itemId}
        </span>
      ),
  },
  {
    key: 'name',
    header: 'Naziv',
    sortable: true,
    render: (r) =>
      r.name ? (
        <span className="block max-w-[24rem] truncate text-ink" title={r.name}>
          {r.name}
        </span>
      ) : (
        <span className="text-status-warn" title="Zaliha postoji, ali artikla nema u šifarniku artikala">
          {NEPOZNAT_ARTIKAL}
        </span>
      ),
  },
  {
    key: 'unit',
    header: 'J.m.',
    sortable: true,
    render: (r) => <span className="whitespace-nowrap text-ink-secondary">{r.unit ?? '—'}</span>,
  },
  {
    key: 'shelf',
    header: 'Polica',
    sortable: true,
    render: (r) => <span className="whitespace-nowrap text-ink-secondary">{r.shelf ?? '—'}</span>,
  },
  {
    key: 'warehouse',
    header: 'Magacin',
    sortable: true,
    render: (r) => (
      <span className="whitespace-nowrap text-ink-secondary" title={`Magacin ${r.warehouse.id}`}>
        {r.warehouse.name}
      </span>
    ),
  },
  {
    key: 'stock',
    header: 'Stanje',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (r) => (
      <span className={cn('tnums font-semibold', bojaKolicine(r.stock))}>{kol(r.stock)}</span>
    ),
  },
  {
    key: 'reserved',
    header: 'Rezervisano',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (r) => (
      <span className={cn('tnums', Number(r.reserved) !== 0 ? 'text-ink' : 'text-ink-disabled')}>
        {kol(r.reserved)}
      </span>
    ),
  },
  {
    // SLOBODNO = STANJE − REZERVISANO. Minus znači da je roba obećana više puta nego što
    // je ima — to je jedina ćelija na ekranu koja traži radnju, pa je istaknuta.
    key: 'free',
    header: 'Slobodno',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (r) => (
      <span
        className={cn('tnums font-semibold', bojaKolicine(r.free))}
        title={Number(r.free) < 0 ? 'Rezervisano je više nego što ima na stanju' : undefined}
      >
        {kol(r.free)}
      </span>
    ),
  },
  {
    key: 'wholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (r) => <span className="tnums text-ink-secondary">{formatDecimal(r.wholesalePrice)}</span>,
  },
];

/**
 * MINIMALNA KOLIČINA — kolona se UVEK PRIKAZUJE, a menja se samo kad `smeIzmenu`.
 *
 * Vraća se kao funkcija, a ne kao konstanta, jer mora da zna dve stvari koje postoje
 * tek u komponenti: da li se sme menjati (`smeIzmenu`) i koji red je trenutno u
 * izmeni. Kolona se ubacuje između SLOBODNO i VP CENE — uz slobodnu količinu, jer se
 * prag poredi baš sa njom.
 *
 * 🔴 KAD SE NE SME MENJATI, NEMA NI NAGOVEŠTAJA IZMENE. Ćelija je običan tekst: bez
 * dugmeta, bez podvlake, bez `hover` pozadine i bez kursora koji poziva na klik.
 * Zahtev je izričit — ne sme da izgleda kao polje koje se otvara pa vrati grešku.
 * `title` u tom slučaju kaže GDE se prag unosi (BigBit), a ne šta se ovde ne može.
 *
 * `smeIzmenu` nosi OBA uslova (pravo korisnika I vlasništvo nad kolonom) — v.
 * `smeMinimalnu` u ekranu; ovde se više ne pita ko je od njih dva zakazao.
 */
function kolonaMinimalna(opts: {
  smeIzmenu: boolean;
  /** Kolonom vlada BigBit — objašnjenje umesto ponude izmene (v. `title` niže). */
  uBigBitu: boolean;
  uIzmeni: number | null;
  nacrt: string;
  cuvaSe: boolean;
  /** Sveže sačuvane vrednosti — dok osvežavanje liste ne stigne (v. `sveze` u ekranu). */
  sveze: Record<number, string | null>;
  pocni: (r: LagerRow) => void;
  promeni: (v: string) => void;
  potvrdi: (r: LagerRow) => void;
  odustani: () => void;
}): Column<LagerRow> {
  const prikaz = (r: LagerRow): string | null =>
    r.itemId in opts.sveze ? opts.sveze[r.itemId] : r.minQuantity;

  return {
    key: 'minQuantity',
    header: 'Min. kol.',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (r) => {
      if (opts.smeIzmenu && opts.uIzmeni === r.itemId) {
        return (
          <input
            autoFocus
            value={opts.nacrt}
            disabled={opts.cuvaSe}
            aria-label={`Minimalna količina za ${r.catalogNumber ?? `#${r.itemId}`}`}
            onChange={(e) => opts.promeni(e.target.value)}
            // Klik u polje ne sme da bubble-uje u red (izbor/otvaranje kartice).
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') opts.potvrdi(r);
              if (e.key === 'Escape') opts.odustani();
            }}
            // Blur ODUSTAJE, ne čuva: klik bilo gde po ekranu ne sme tiho da upiše
            // broj koji je magacioner tek počeo da kuca. Snima se Enter-om ili
            // dugmetom — svesnom radnjom.
            onBlur={() => {
              if (!opts.cuvaSe) opts.odustani();
            }}
            className="tnums w-20 rounded-control border border-accent bg-surface px-1 py-0.5 text-right text-sm text-ink outline-none"
          />
        );
      }

      const v = prikaz(r);
      const tekst = v === null ? '—' : formatDecimal(v, 3);

      if (!opts.smeIzmenu)
        return (
          <span
            className={cn('tnums', v === null ? 'text-ink-disabled' : 'text-ink-secondary')}
            title={
              // Kad kolonom vlada BigBit, `title` UPUĆUJE — objašnjenje mora da bude
              // tu gde čovek gleda broj, a ne tek u greški posle pokušaja izmene.
              opts.uBigBitu
                ? `Minimalna količina se unosi u BigBit-u${
                    v === null ? ' (za ovaj artikal nije postavljena)' : ''
                  } — ovde se samo prikazuje`
                : v === null
                  ? 'Minimalna količina nije postavljena'
                  : undefined
            }
          >
            {tekst}
          </span>
        );

      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            opts.pocni(r);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={
            v === null
              ? 'Minimalna količina nije postavljena — klikni da upišeš'
              : 'Klikni da izmeniš minimalnu količinu'
          }
          className={cn(
            'tnums w-full rounded-control px-1 text-right underline decoration-dotted underline-offset-4 hover:bg-surface-2',
            v === null ? 'text-ink-disabled' : 'text-ink',
          )}
        >
          {tekst}
        </button>
      );
    },
  };
}

/** CSV = iste kolone, istim redosledom; decimalni zarez, jer Excel sr inače čita tekst. */
const csvDec = (v: string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : v.replace('.', ',');

const csvColumns: CsvColumn<LagerRow>[] = [
  { header: 'Kataloški broj', value: (r) => r.catalogNumber ?? `#${r.itemId}` },
  { header: 'Naziv', value: (r) => r.name ?? NEPOZNAT_ARTIKAL },
  { header: 'J.m.', value: (r) => r.unit ?? '' },
  { header: 'Polica', value: (r) => r.shelf ?? '' },
  { header: 'Magacin', value: (r) => r.warehouse.name },
  { header: 'Stanje', value: (r) => csvDec(r.stock) },
  { header: 'Rezervisano', value: (r) => csvDec(r.reserved) },
  { header: 'Slobodno', value: (r) => csvDec(r.free) },
  // Prazno ostaje prazno i u CSV-u: „prag nije postavljen" nije „prag je nula".
  { header: 'Min. kol.', value: (r) => csvDec(r.minQuantity) },
  { header: 'VP cena', value: (r) => csvDec(r.wholesalePrice) },
];

/** Kompaktna ćelija filter trake — labela 12px iznad kontrole (idiom `/artikli`, `/robno`). */
function Polje({ labela, sirina, children }: { labela: string; sirina: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {labela}
      <div className={sirina}>{children}</div>
    </label>
  );
}

export default function LagerPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

  // Filteri i sort žive U URL-u (frontend/CLAUDE.md §12) — povratak sa kartice vraća listu
  // tačno kakva je bila, a adresa lagera se sme poslati kolegi u poruci.
  // `resolved` je false do prvog efekta, dok se filteri ne pročitaju iz adrese. Bez njega
  // bi prvi render posle povratka sa detalja poslao NEFILTRIRAN upit od 200 redova i
  // upisao ga u keš — pa bi se lista na tren prikazala nefiltrirana.
  const { values, resolved, setValues } = useListQueryState(PRAZAN_FILTER);

  // Tekstualno polje se kuca lokalno, pa se posle KUCANJE_MS upisuje u URL.
  const [trazi, setTrazi] = useState(values.trazi);
  useEffect(() => setTrazi(values.trazi), [values.trazi]);
  useEffect(() => {
    if (trazi === values.trazi) return;
    const t = setTimeout(() => setValues({ trazi }), KUCANJE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trazi]);

  const [izvozUToku, setIzvozUToku] = useState(false);
  const [izvozPoruka, setIzvozPoruka] = useState<string | null>(null);

  // ─── Minimalna količina ────────────────────────────────────────────────────
  // Pravo NEMA nijedna rola — nose ga troje imenovanih kroz `user_permission_overrides`
  // (odluka vlasnika 06.08.2026). Pravo je SAMO PRVI od dva uslova: drugi je ko vlada
  // kolonom (`meta.minQuantityOwner`), v. `smeMinimalnu` ispod.
  const imaPravoNaMinimalnu = can(PERMISSIONS.MASTERS_MIN_QUANTITY);
  const upisMinimalne = useSetMinimalnaKolicina();
  const [uIzmeni, setUIzmeni] = useState<number | null>(null);
  const [nacrt, setNacrt] = useState('');
  const [minPoruka, setMinPoruka] = useState<Poruka | null>(null);
  /**
   * Sveže sačuvane vrednosti dok osvežavanje liste ne stigne.
   *
   * Bez ovoga bi ćelija posle snimanja na tren pokazala STARU vrednost (mutacija
   * poništi keš, ali `useInfiniteQuery` mora ponovo da dovuče sve učitane strane) —
   * a magacioner bi pomislio da unos nije primljen i upisao ga opet.
   * Briše se pri svakoj promeni filtera: tada je u pitanju nov upit, pa nasleđene
   * vrednosti više nemaju veze sa onim što se prikazuje.
   */
  const [sveze, setSveze] = useState<Record<number, string | null>>({});

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  /** Sort iz URL-a — nepoznata kolona se ćutke odbacuje (backend bi je vratio kao 400). */
  const sort: SortState | null = useMemo(() => {
    if (!isLagerSortColumn(values.sort)) return null;
    return { key: values.sort, dir: values.smer === 'desc' ? 'desc' : 'asc' };
  }, [values.sort, values.smer]);

  /** Godina iz URL-a — samo ispravan četvorocifren broj ide na server. */
  const godina = useMemo(() => {
    const n = Number(values.godina);
    return Number.isInteger(n) && n >= 1990 && n <= 2100 ? n : undefined;
  }, [values.godina]);

  /**
   * Magacin iz URL-a. Vrednost se PROVERAVA jer je URL korisnički unos: `Number('abc')`
   * je `NaN`, a `NaN` bi u adresi zahteva završio kao `warehouseId=NaN` i backend bi
   * vratio 400 — ceo ekran bi pao zbog jednog prelomljenog linka.
   */
  const magacinBroj = useMemo(() => {
    const n = Number(values.magacin);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }, [values.magacin]);

  /** Filter za server — jedan izvor i za listu i za izvoz. */
  const filters: LagerListParams = useMemo(
    () => ({
      q: values.trazi || undefined,
      warehouseId: magacinBroj,
      groupCode: values.grupa || undefined,
      // `false` se šalje IZRIČITO: izostavljen parametar backend čita kao `true`.
      onlyWithStock: values.bezStanja === '1' ? false : undefined,
      onlyNegative: values.minus === '1' ? true : undefined,
      year: godina,
      reservationScope: values.rez === 'all' ? ('all' as ReservationScope) : undefined,
      sort: sort ? (sort.key as LagerSortColumn) : undefined,
      dir: sort?.dir,
    }),
    [values, sort, godina, magacinBroj],
  );

  const { upit, redovi, meta, ukupno, ucitano, naKapi, strane } = useLagerSkrol(filters, {
    enabled: resolved,
  });

  /**
   * MESTO U LISTI preko odlaska na detalj/karticu (prijava vlasnika 07.08.2026).
   *
   * Potpis je ceo serverski filter — svaka njegova promena je druga lista, pa se zapis
   * briše i skrol vraća na vrh. `spremno` traži da redovi budu STVARNO u DOM-u: pre toga
   * okvir nema visinu i `scrollTop` bi pregledač odsekao na 0.
   */
  const potpisFiltera = useMemo(() => JSON.stringify(filters), [filters]);
  const { okvirRef, izgubljenoRedova } = useZapamcenaPozicijaListe({
    kljuc: '/artikli/lager',
    potpis: potpisFiltera,
    spremno: resolved && redovi.length > 0,
    straneUKesu: strane,
    redova: redovi.length,
  });

  /**
   * SME LI SE „Min. kol." MENJATI — DVA USLOVA, OBA OBAVEZNA.
   *
   * 1) korisnik ima pravo `masters.min_quantity` (troje imenovanih), i
   * 2) kolonom vlada 4.0, što javlja BACKEND kroz `meta.minQuantityOwner`.
   *
   * 🔴 DANAS JE DRUGI USLOV NETAČAN i polje se NE OTVARA NIKOME — ni onome ko ima
   * pravo. Vlasnik, 06.08.2026: „ovde nema UNOSA dok ne krenemo da radimo sa APP.
   * Rekli smo da ćemo samo čitati podatke iz BigBita." Prag se do prelaska
   * (01.04.2027) unosi u BigBit-u, jer bi ga noćni uvoz u 03:45 vratio na staro.
   *
   * ⚠️ Nepoznata/izostavljena vrednost NIKAD se ne tumači kao „4.0": stariji backend
   * (ili neuspeo upit) ostavlja `meta` prazan, a gejt na ekranu sme da greši SAMO u
   * bezbednom smeru — bolje sakriveno polje koje radi nego ponuđeno koje vraća 409.
   */
  const kolonuDrzi40 = meta?.minQuantityOwner === '4.0';
  const smeMinimalnu = imaPravoNaMinimalnu && kolonuDrzi40;

  const lookups = useItemLookups();
  const groupOptions = useMemo(
    () =>
      (lookups.data?.data?.groups ?? []).map((g) => ({
        value: g.code,
        label: g.description ? `${g.code} — ${g.description}` : g.code,
      })),
    [lookups.data],
  );

  // Magacini: 4.0 šifarnik + magacini koje ogledalo stvarno nosi (BigBit vozi i 44, koji
  // 4.0 ne mora imati) + izabrani, da ne nestane kad filter ne vrati nijedan red.
  const magaciniIzPodataka = useMemo(() => redovi.map((r) => r.warehouse), [redovi]);
  const magacini = useMagacinOpcije(magaciniIzPodataka, magacinBroj ?? null);

  /**
   * Klik na zaglavlje: nova kolona → prvi smer (količine i cene opadajuće), isti smer →
   * obrnut, drugi klik u istom smeru → nazad na podrazumevani redosled.
   */
  const prebaciSort = useCallback(
    (key: string) => {
      if (!isLagerSortColumn(key)) return;
      const prvi: LagerSortDir = PRVI_KLIK_OPADAJUCE.has(key) ? 'desc' : 'asc';
      if (values.sort !== key) {
        setValues({ sort: key, smer: prvi });
        return;
      }
      const trenutni = values.smer === 'desc' ? 'desc' : 'asc';
      if (trenutni === prvi) setValues({ sort: key, smer: prvi === 'asc' ? 'desc' : 'asc' });
      else setValues({ sort: '', smer: '' });
    },
    [values.sort, values.smer, setValues],
  );

  const imaFilter = Object.entries(values).some(([k, v]) => !NIJE_FILTER.has(k) && v !== '');
  const imaNaprednih = NAPREDNI_FILTERI.some((k) => values[k] !== '');

  /** „Više filtera" se samo otvara kad filter iz njega već radi — da ne bude nevidljiv. */
  const [viseOtvoreno, setViseOtvoreno] = useState(false);
  useEffect(() => {
    if (imaNaprednih) setViseOtvoreno(true);
  }, [imaNaprednih]);

  function ponistiFilter() {
    setTrazi('');
    setValues({ ...PRAZAN_FILTER, sort: values.sort, smer: values.smer });
    setIzvozPoruka(null);
  }

  // ─── Izbor reda ────────────────────────────────────────────────────────────
  // Klik BIRA red, dupli klik / Enter OTVARA karticu. Izbor je KONTROLISAN odavde
  // (`selectedKey` + `onSelectionChange`), pa su istaknut red i red nad kojim dugmad
  // rade ista stvar po konstrukciji — isti obrazac kao lista artikala.
  const [izabran, setIzabran] = useState<LagerRow | null>(null);
  const izabranRef = useRef<LagerRow | null>(null);
  const izaberi = useCallback((red: LagerRow | null) => {
    izabranRef.current = red;
    setIzabran(red);
  }, []);

  // Promena filtera ili sorta poništava izbor: red iz prethodnog spiska ne mora uopšte
  // biti u novom, a dugmad iznad liste bi radila nad njim.
  //
  // Isto važi i za unos minimalne količine: otvoreno polje bi posle promene filtera
  // stajalo nad DRUGIM artiklom (`uIzmeni` je `itemId`, a redosled se promenio), a
  // sveže vrednosti bi se prikazivale u listi kojoj ne pripadaju.
  useEffect(() => {
    izaberi(null);
    setUIzmeni(null);
    setNacrt('');
    setSveze({});
    setMinPoruka(null);
  }, [filters, izaberi]);

  const redIzDogadjaja = useCallback(
    (cilj: EventTarget | null): LagerRow | null => {
      const el = cilj instanceof Element ? cilj : null;
      const tr = el?.closest('tr[data-row-index]') ?? null;
      if (!tr) return null;
      // Atribut MORA postojati: `Number(null)` i `Number('')` su 0, pa bi <tr> bez indeksa
      // (red „nema podataka") tiho vratio PRVI red lagera.
      const atr = tr.getAttribute('data-row-index');
      if (atr === null || atr.trim() === '') return null;
      const i = Number(atr);
      return Number.isInteger(i) && i >= 0 ? redovi[i] ?? null : null;
    },
    [redovi],
  );

  /**
   * Otvori karticu artikla na traženom tabu. Magacin reda putuje u adresi — kartica
   * otvorena iz reda „magacin 2" mora da pokaže magacin 2, a ne zbir svih magacina.
   */
  const otvoriKarticu = useCallback(
    (red: LagerRow | null, tab: 'robno' | 'profakture' | 'narudzbine') => {
      if (!red || jeSiroce(red)) return;
      // `izvor=lager` da „Nazad" sa kartice vrati OVDE (sa filterima), a ne na pregled
      // artikala — kartica ima dva ravnopravna ulaza.
      router.push(
        `/artikli/kartica?id=${red.itemId}&tab=${tab}&magacin=${red.warehouse.id}&izvor=lager`,
      );
    },
    [router],
  );

  /**
   * RED RADNJI NAD REDOM LAGERA — jedan izvor za dugmad iznad tabele I za meni na desni
   * klik, da se ne raziđu. Sve četiri rade nad `items.id`, pa red čiji artikal `items`
   * ne poznaje (`jeSiroce`) dobija objašnjenje umesto linka u 404.
   */
  const akcijeZaRed = useCallback(
    (red: LagerRow | null): RowAction[] => {
      const razlog = !red
        ? 'Prvo izaberi red u listi (klik na red).'
        : jeSiroce(red)
          ? 'Artikal nije u šifarniku artikala — kartica i detalj se ne mogu otvoriti.'
          : undefined;
      return [
        {
          kljuc: 'kartica',
          labela: 'Kartica artikla',
          onemoguceno: razlog,
          onSelect: () => otvoriKarticu(red, 'robno'),
        },
        {
          kljuc: 'profakture',
          labela: 'Kartica profaktura',
          onemoguceno: razlog,
          onSelect: () => otvoriKarticu(red, 'profakture'),
        },
        {
          kljuc: 'narudzbine',
          labela: 'Kartica narudžbina',
          onemoguceno: razlog,
          onSelect: () => otvoriKarticu(red, 'narudzbine'),
        },
        {
          kljuc: 'detalj',
          labela: 'Detaljno artikal',
          onemoguceno: razlog,
          onSelect: () => {
            // `izvor=lager` iz ISTOG razloga kao kod kartice iznad: bez njega je detalj
            // vraćao na PREGLED ARTIKALA, sa filterima te druge liste — vlasnik je to
            // prijavio kao „vrati me na početnu stranu" (07.08.2026).
            if (red) router.push(`/artikli/detalj?id=${red.itemId}&izvor=lager`);
          },
        },
      ];
    },
    [otvoriKarticu, router],
  );

  const akcijeIznad = akcijeZaRed(izabran);

  // ─── Unos minimalne količine ───────────────────────────────────────────────

  const pocniMinimalnu = useCallback((r: LagerRow) => {
    setMinPoruka(null);
    setUIzmeni(r.itemId);
    // Polje kreće od zatečene vrednosti; prazno = „prag nije postavljen".
    setNacrt(r.minQuantity ?? '');
  }, []);

  const odustaniMinimalnu = useCallback(() => {
    setUIzmeni(null);
    setNacrt('');
  }, []);

  /**
   * Snimanje: prazno polje znači OBRIŠI PRAG (`null`), a `0` je prag nula — dve
   * različite stvari i backend ih razlikuje. Poruka posle snimanja kaže ŠTA je
   * promenjeno („2 → 5"), ne samo „sačuvano": magacioner mora da vidi da je
   * pogodio pravi red, jer isti artikal ume da stoji u više magacina.
   */
  const potvrdiMinimalnu = useCallback(
    (r: LagerRow) => {
      const uneto = nacrt.trim();
      const vrednost = uneto === '' ? null : uneto;
      const staro = r.minQuantity;
      const oznaka = r.catalogNumber ?? `#${r.itemId}`;

      // Bez izmene se ne šalje zahtev — ni upis, ni trag u `updated_by`.
      if ((staro ?? '') === (vrednost ?? '')) {
        odustaniMinimalnu();
        return;
      }

      upisMinimalne.mutate(
        { itemId: r.itemId, minQuantity: vrednost },
        {
          onSuccess: (res) => {
            const noviTekst = res.minQuantity === null ? '(nije postavljena)' : String(res.minQuantity);
            const stariTekst =
              res.previousMinQuantity === null ? '(nije postavljena)' : String(res.previousMinQuantity);
            setSveze((p) => ({
              ...p,
              [r.itemId]: res.minQuantity === null ? null : String(res.minQuantity),
            }));
            setMinPoruka({
              vrsta: 'ok',
              tekst: `Minimalna količina · ${oznaka} — ${res.name ?? r.name ?? ''}: ${stariTekst} → ${noviTekst}. Sačuvano.`,
            });
            odustaniMinimalnu();
          },
          onError: (e) => {
            // Polje OSTAJE otvoreno sa unetom vrednošću — da se ne kuca ponovo.
            setMinPoruka({
              vrsta: 'greska',
              tekst: `Minimalna količina za ${oznaka} NIJE sačuvana: ${(e as Error).message}`,
            });
          },
        },
      );
    },
    [nacrt, odustaniMinimalnu, upisMinimalne],
  );

  /** Kolone: statične + „Min. kol." ubačena uz SLOBODNO (prag se poredi sa njim). */
  const kolone = useMemo(() => {
    const min = kolonaMinimalna({
      smeIzmenu: smeMinimalnu,
      uBigBitu: !kolonuDrzi40,
      uIzmeni,
      nacrt,
      cuvaSe: upisMinimalne.isPending,
      sveze,
      pocni: pocniMinimalnu,
      promeni: setNacrt,
      potvrdi: potvrdiMinimalnu,
      odustani: odustaniMinimalnu,
    });
    const at = columns.findIndex((c) => c.key === 'free');
    const out = [...columns];
    out.splice(at + 1, 0, min);
    return out;
  }, [
    smeMinimalnu,
    kolonuDrzi40,
    uIzmeni,
    nacrt,
    upisMinimalne.isPending,
    sveze,
    pocniMinimalnu,
    potvrdiMinimalnu,
    odustaniMinimalnu,
  ]);

  /**
   * „Export" izvozi CELU filtriranu listu, ne učitane redove — kad skrol stane na kapi,
   * izvoz je jedini način da se dođe do ostatka. Platformsko dugme `ExportCsvButton` ovde
   * ne može (prima gotove redove), ali motor izvoza je isti (`lib/table-csv.ts`).
   */
  async function izveziFiltriranuListu() {
    setIzvozUToku(true);
    setIzvozPoruka(null);
    try {
      const { rows: sve, total, truncated } = await fetchLagerZaIzvoz(filters);
      if (sve.length === 0) {
        setIzvozPoruka('Nema redova za izvoz — filter ne vraća nijedan red lagera.');
        return;
      }
      const oznakaGodine = meta ? `-${meta.year}` : '';
      exportTableToCsv(csvColumns, sve, `lager${oznakaGodine}-${new Date().toISOString().slice(0, 10)}`);
      setIzvozPoruka(
        truncated
          ? `Izvezeno prvih ${formatNumber(sve.length)} od ${formatNumber(total)} redova — suzi filter za ostatak.`
          : `Izvezeno ${formatNumber(sve.length)} redova.`,
      );
    } catch (e) {
      setIzvozPoruka(`Izvoz nije uspeo: ${(e as Error).message}`);
    } finally {
      setIzvozUToku(false);
    }
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Lager lista"
        // `resolved` iz istog razloga kao `enabled` na upitu: dok filteri iz adrese nisu
        // pročitani, keš pod PODRAZUMEVANIM ključem vraća broj NEFILTRIRANE liste.
        count={resolved && upit.data ? `${formatNumber(ukupno)} redova` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={izveziFiltriranuListu}
              loading={izvozUToku}
              title="Izvezi filtriranu lager listu u CSV (Excel)"
              aria-label="Export"
              className="max-sm:w-9 max-sm:px-0"
            >
              {!izvozUToku && <Download className="h-4 w-4" aria-hidden />}
              <span className="max-sm:hidden">Export</span>
            </Button>
            {/* Dva ravnopravna pregleda: ovde se gleda KOLIKO ima, tamo KAKAV je artikal. */}
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push(listHref('/artikli'))}
              title="Pregled artikala (matični podaci, 22 kolone)"
              aria-label="Pregled artikala"
              className="max-sm:w-9 max-sm:px-0"
            >
              <List className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Pregled artikala</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-3 overflow-auto p-6">
        {/* Filter traka — jedan red gde stane (idiom `/artikli`, `/robno`, `/izvodi`). */}
        <div className="flex flex-wrap items-end gap-3">
          <Polje labela="Pronađi artikal" sirina="w-64">
            <Input
              value={trazi}
              onChange={(e) => setTrazi(e.target.value)}
              placeholder="kataloški broj ili naziv"
            />
          </Polje>

          <Polje labela="Magacin" sirina="w-52">
            <Select
              placeholder={magacini.isLoading ? 'učitavanje…' : 'svi magacini'}
              value={values.magacin}
              onChange={(e) => setValues({ magacin: e.target.value })}
              options={magacini.options}
            />
          </Polje>

          <Polje labela="Grupa" sirina="w-44">
            <Select
              placeholder="sve"
              value={values.grupa}
              onChange={(e) => setValues({ grupa: e.target.value })}
              options={groupOptions}
            />
          </Polje>

          <Polje labela="Rezervacije" sirina="w-40">
            <Select
              placeholder="tekuća godina"
              value={values.rez}
              onChange={(e) => setValues({ rez: e.target.value })}
              options={REZERVACIJE_OPCIJE}
              title="Koje rezervacije ulaze u kolonu SLOBODNO — samo tekuća poslovna godina ili sve godine iz BigBita"
            />
          </Polje>

          <label className="flex items-center gap-2 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={values.minus === '1'}
              onChange={(e) => setValues({ minus: e.target.checked ? '1' : '' })}
            />
            Samo negativna stanja
          </label>

          {imaFilter && (
            <Button type="button" variant="secondary" onClick={ponistiFilter}>
              <RotateCcw className="h-4 w-4" aria-hidden />
              Poništi filter
            </Button>
          )}
        </div>

        {/* Retki filteri — sklopljeni, da vidljiva traka ostane jedan red. */}
        <details
          open={viseOtvoreno}
          onToggle={(e) => setViseOtvoreno((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="inline-flex cursor-pointer select-none items-center rounded-control px-1 text-xs text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]">
            Više filtera
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <Polje labela="Poslovna godina" sirina="w-32">
              <Input
                type="number"
                min={1990}
                max={2100}
                value={values.godina}
                onChange={(e) => setValues({ godina: e.target.value })}
                placeholder={meta ? String(meta.year) : 'poslednja'}
                title="Prazno = poslednja godina zatečena u ogledalu BigBita"
              />
            </Polje>

            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={values.bezStanja === '1'}
                onChange={(e) => setValues({ bezStanja: e.target.checked ? '1' : '' })}
              />
              Prikaži i artikle bez stanja (nula)
            </label>
          </div>
        </details>

        {/* OBRAZLOŽENJE BROJEVA — nije ukras: bez ove rečenice ekran prikazuje brojeve
            jedne poslovne godine, a korisnik ne zna koje ni koje rezervacije su u njima. */}
        {meta && (
          <p className="text-sm text-ink-secondary">
            Poslovna godina <span className="tnums font-semibold text-ink">{meta.year}</span>
            {meta.yearSource === 'latest' && ' (poslednja zatečena u BigBit-u)'}
            {meta.yearSource === 'query' && ' (izabrana ručno)'}
            {meta.yearSource === 'fallback' && ' (ogledalo je prazno — prikazana je kalendarska godina)'}
            {' · rezervacije: '}
            {meta.reservationScope === 'year'
              ? 'samo iz tekuće godine'
              : 'iz svih godina (uključuje i rezervacije koje BigBit nikad nije zatvorio)'}
            {!meta.onlyWithStock && ' · prikazani su i artikli sa stanjem 0'}
            {meta.onlyNegative && ' · samo negativna stanja'}
          </p>
        )}

        {/* Red radnji nad IZABRANIM redom. Isti spisak je i na desni klik — jedan izvor. */}
        <div className="flex flex-wrap items-center gap-2">
          {akcijeIznad.map((a) =>
            a.onemoguceno ? (
              // `aria-disabled`, ne `disabled`: pravi `disabled` element u Firefox-u ne
              // prima pokazivač, pa se `title` (razlog) nikad ne prikaže.
              <Button
                key={a.kljuc}
                type="button"
                variant="secondary"
                aria-disabled
                title={a.onemoguceno}
                onClick={(e) => e.preventDefault()}
                className="cursor-not-allowed opacity-50"
              >
                {a.labela}
              </Button>
            ) : (
              <Button key={a.kljuc} type="button" variant="secondary" onClick={a.onSelect}>
                {a.labela}
              </Button>
            ),
          )}

          <span className={cn('text-sm', izabran ? 'text-ink-secondary' : 'text-ink-disabled')}>
            {izabran ? (
              <>
                Izabran: <span className="tnums">{izabran.catalogNumber ?? `#${izabran.itemId}`}</span>
                {' — '}
                {izabran.name ?? NEPOZNAT_ARTIKAL} · {izabran.warehouse.name}
              </>
            ) : (
              'Klikni red da izabereš stavku · dupli klik ili Enter otvara karticu artikla'
            )}
          </span>
        </div>

        {/* Ishod izmene minimalne količine — stoji IZNAD tabele, uz red radnji, da se
            vidi bez skrolovanja i pošto se izmena dešava u redu koji može biti bilo gde. */}
        {minPoruka && (
          <div
            role="status"
            className={cn(
              'rounded-panel border px-4 py-2 text-sm',
              minPoruka.vrsta === 'ok'
                ? 'border-status-success/40 bg-status-success-bg text-status-success'
                : 'border-status-danger/40 bg-status-danger-bg text-status-danger',
            )}
          >
            {minPoruka.tekst}
          </div>
        )}

        {upit.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(upit.error as Error).message}
          </div>
        )}

        {lookups.error && (
          <p className="text-sm text-ink-secondary">
            Šifarnik grupa nije učitan — padajuća lista grupa je prazna, ostali filteri rade
            normalno.
          </p>
        )}

        {/* `!!` jer `useQuery.error` ima tip `unknown` — gola vrednost nije ReactNode. */}
        {!!magacini.error && (
          <p className="text-sm text-ink-secondary">
            Šifarnik magacina nije učitan — u listi magacina stoje samo oni koji se vide u
            učitanim redovima.
          </p>
        )}

        {/* Skrol je UNUTAR tabele (zamrznuto zaglavlje + prve dve kolone), a `min-w-0`
            sprečava da širina tabele razvuče stranu — strana se nikad ne pomera vodoravno
            (DESIGN_SYSTEM §11). Dupli klik i Enter se hvataju OVDE jer `DataTable` nema
            svoj „otvori": oba bubble-uju iz reda (`onSelectionChange` je već upisao izbor). */}
        <div
          className="min-w-0"
          onDoubleClick={(e) => {
            // Dupli klik po zaglavlju (sort) ili po dugmetu „…" ne sme da odvede sa ekrana.
            if (!(e.target instanceof Element)) return;
            if (e.target.closest('button, a, input, label')) return;
            otvoriKarticu(redIzDogadjaja(e.target), 'robno');
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Samo Enter iz TELA TABELE otvara karticu — bez ove granice bi je otvorio i
            // Enter na dugmetu „…" i na stavci menija akcija (bug 009/26).
            if (!(e.target instanceof HTMLElement) || e.target.tagName !== 'TBODY') return;
            otvoriKarticu(izabranRef.current, 'robno');
          }}
        >
          <DataTable
            columns={kolone}
            rows={redovi}
            rowKey={kljucReda}
            // `!resolved` MORA ući u učitavanje: dok se filteri čitaju iz adrese upit je
            // isključen, pa je `isLoading` false i tabela bi na tren treperila kao prazna.
            loading={!resolved || upit.isLoading}
            sort={sort}
            onSortToggle={prebaciSort}
            stickyHeader
            frozenColumns={2}
            maxHeight={VISINA_TABELE}
            // Tabela skroluje sopstveni okvir, ne prozor — ovo je jedina ručka na njega.
            scrollRef={okvirRef}
            rowActions={akcijeZaRed}
            selectedKey={izabran ? kljucReda(izabran) : null}
            onSelectionChange={izaberi}
            empty={
              <EmptyState
                title="Nema zaliha"
                hint={
                  values.bezStanja === '1'
                    ? 'Nijedan artikal ne odgovara filteru — poništi filter ili proširi pretragu.'
                    : 'Nijedan artikal sa stanjem ne odgovara filteru. Pod „Više filtera" uključi „Prikaži i artikle bez stanja" ili proveri poslovnu godinu.'
                }
              />
            }
          />
        </div>

        {/* Brojač + dovlačenje NA ZAHTEV. Automatsko dovlačenje na dolazak dna se ne
            koristi: na dodirnom ekranu odskok na dnu okine posmatrača više puta. */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Brojači su izvan tabele, pa ih `loading` na `DataTable` ne pokriva: dok filteri
              iz adrese nisu pročitani, `ucitano`/`ukupno` dolaze iz keša NEFILTRIRANE liste. */}
          {resolved && (
            <span className="text-sm text-ink-secondary">
              Prikazano {formatNumber(ucitano)} od {formatNumber(ukupno)}
            </span>
          )}

          {/* Bio je ovde duže nego što keš živi (ili je lista otvorena u novom tabu), pa
              se zapamćeno mesto NE vraća — dovlačenje 15 strana redom bi bio plotun
              zahteva nad ogledalom. Umesto toga se kaže dokle je ranije bio stigao, a
              „Učitaj još" stoji odmah pored. */}
          {izgubljenoRedova > ucitano && (
            <span className="text-sm text-ink-secondary">
              ranije učitano {formatNumber(izgubljenoRedova)} redova
            </span>
          )}

          {/* I dugme čeka `resolved`: klik pre toga bi dovukao stranu 2 POGREŠNOG ključa. */}
          {resolved && upit.hasNextPage && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void upit.fetchNextPage()}
              loading={upit.isFetchingNextPage}
            >
              Učitaj još
            </Button>
          )}

          {resolved && naKapi && (
            <span className="text-sm text-status-warn">
              Prikazano {formatNumber(LAGER_SKROL_KAPA)} od {formatNumber(ukupno)} — suzi filter
              ili izvezi u Excel
            </span>
          )}

          {izvozPoruka && <span className="text-sm text-ink-secondary">{izvozPoruka}</span>}
        </div>

        {/* Ekran mora sam da kaže šta je čije. Za MIN. KOL. to nije kozmetika: kolona se
            vidi i korisna je, ali se do prelaska ne menja ovde — a čovek koji vidi broj bez
            objašnjenja pretpostavlja da može da ga ispravi. Rečenica mu unapred kaže gde se
            unosi, umesto da to sazna iz greške posle klika. */}
        <p className="text-sm text-ink-disabled">
          Zalihe iz BigBit-a (noćno ogledalo, samo za čitanje) · STANJE = knjižen promet tekuće
          poslovne godine · SLOBODNO = STANJE − REZERVISANO
          {smeMinimalnu
            ? ' · MIN. KOL. se unosi ovde (klikni vrednost) — prazno polje briše prag'
            : ' · MIN. KOL. se unosi u BigBit-u i ovde se samo prikazuje — izmena upisana ovde nestala bi pri noćnom uvozu u 03:45'}
        </p>
      </div>
    </AppShell>
  );
}
