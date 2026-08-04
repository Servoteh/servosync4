'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Plus, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column, type RowAction, type SortState } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { useListQueryState } from '@/lib/use-id-param';
import { exportTableToCsv, type CsvColumn } from '@/lib/table-csv';
import { formatDecimal, formatNumber } from '@/lib/format';
import {
  useArtikliSkrol,
  useItemLookups,
  fetchArtikliZaIzvoz,
  isItemSortColumn,
  ARTIKLI_SKROL_KAPA,
  type CodeRef,
  type ItemListParams,
  type ItemRow,
  type ItemSortColumn,
  type ItemSortDir,
} from '@/api/masters';

/**
 * Matični podaci — Artikli (obrazac „Lista", DESIGN_SYSTEM §4.1): filter traka +
 * gusta tabela sa server-side filterom, sortom i SKROLOM (strane se nadovezuju).
 *
 * PARITET SA BIGBITOM (zahtev vlasnika 04.08.2026 — „sve treba da bude kao u
 * BigBitu… svi korisnici su navikli"):
 *  • KOLONE su onim redosledom kojim ih crta BigBit forma „Pregled artikala"
 *    (izvor: izvoz forme iz `OnLine_BigBit_APL.MDB`, `Detail` sekcija sortirana po
 *    `Left` koordinati): Kataloški broj · Naziv · J.m. · Polica · Težina · Grupa ·
 *    Podgrupa · PodPodgrupa · VP cena · MP cena · Tarifa robe · PPD · Debljina
 *    ploče · Kg u kom. · Devizna cena · Kng. šifra 1 · Kng. šifra 2 · PLU · ID ·
 *    Bar kod · Ext. šifra · INO naziv. Redosled i labele se NE „poboljšavaju".
 *  • DUGMAD ispod filtera su BigBit red radnji nad izabranim artiklom (Detaljno
 *    artikal · Kartica artikla · Recepti · KNG artikli · Promena tarifa poreza) —
 *    isti spisak je i na desni klik na red.
 *  • „PodPodgrupa" je BigBit labela kolone `Poreklo` — u UI-ju se zove tako kako
 *    je korisnici zovu, iako polje u bazi nosi staro ime.
 *  • Kolona „ID" je BigBit „Šifra artikla" = `items.external_item_id`, NIKAD
 *    `items.id` (BIGBIT_ARTIKLI.md §5.1). Red otvoren u 4.0 nema BigBit šifru
 *    (vrednost 0) pa dobija oznaku „4.0", da se nula ne pročita kao šifra.
 *
 * ŠTO SE VIDI, A ŠTO NE (mereno na produkciji 04.08.2026, 92.592 artikla):
 * filteri „Dimenzija" (5 artikala je ima), „Kvalitet" (2) i „Samo aktivni" (svi su
 * aktivni — filter je no-op) skinuti su sa ekrana; `ItemListParams` ih i dalje nosi,
 * pa se vraćaju u jednoj liniji kad podaci to zasluže. Retko korišćeni filteri
 * (kat. broj, deo naziva, dupli kat. brojevi) stoje pod „Više filtera", da vidljiva
 * traka ostane jedan red.
 *
 * Podatak je BigBit cache (`items`). Unos i izmena imaju pun ekran
 * (`/artikli/nov`, `/artikli/detalj?id=N&rezim=izmena`), ali su ZAKLJUČANI dok
 * `items` ne uđe u zaštićeni skup sync-a — ekran to objašnjava i kaže šta da se
 * uradi (v. `_forma/pravila.ts`, `BRANA_ARTIKAL`). Detalj i kartica su STATIČKE
 * rute `?id=N` (nikad `[id]` segment — static export ga ne izvozi).
 */

/** Odlaganje upita dok se kuca — bez njega je svako slovo jedan upit nad 92k redova. */
const KUCANJE_MS = 300;

/**
 * Visina skrol-okvira tabele: ekran minus zaglavlje strane, filter traka, red
 * dugmadi i podnožje sa brojačem. `dvh`, nikad `vh` (DESIGN_SYSTEM §11.4) — `100vh`
 * je na iOS-u veliki viewport, pa bi dno tabele završilo pod trakom Safarija.
 */
const VISINA_TABELE = 'calc(100dvh - 21rem)';

/** Prazan filter — „Poništi filter" vraća tačno ovo stanje (BigBit `Ponisti filter`). */
const PRAZAN_FILTER = {
  trazi: '',
  katbroj: '',
  naziv: '',
  jm: '',
  grupa: '',
  podgrupa: '',
  podpodgrupa: '',
  polica: '',
  policaPrisustvo: '',
  dupli: '',
  sort: '',
  smer: '',
};

/** Ključevi filtera koji stoje pod „Više filtera" — traka ih ne prikazuje. */
const NAPREDNI_FILTERI = ['katbroj', 'naziv', 'jm', 'dupli'] as const;

/** Sort i smer nisu filter — „Poništi filter" ih ne dira, i ne pale oznaku „ima filtera". */
const NIJE_FILTER = new Set(['sort', 'smer']);

/**
 * Kolone kod kojih PRVI klik na zaglavlje sortira OPADAJUĆE. Kod veličina se traži
 * „najveće" (najskuplji artikal, najteži komad), pa bi rastući prvi klik značio dva
 * klika za svaki takav upit.
 *
 * Kolona „ID" (BigBit šifra artikla) i PLU nisu ista stvar iako su brojevi — PLU je
 * ovde jer ga BigBit koristi kao redni broj vage; „ID" ostaje rastući, kao svaka šifra.
 */
const PRVI_KLIK_OPADAJUCE = new Set<ItemSortColumn>([
  'weight',
  'wholesalePrice',
  'retailPrice',
  'thickness',
  'box',
  'fxSalePrice',
  'plu',
]);

/** Opcije filtera prisustva police (BigBit forma ovo nema — dolazi iz 4.0 pregleda). */
const POLICA_OPCIJE = [
  { value: 'with', label: 'samo sa policom' },
  { value: 'without', label: 'bez police' },
];

/**
 * Broj u srpskom formatu (nula se prikazuje, prazno → „—"). Prima i broj i string:
 * cene su `Decimal` pa stižu kao STRING (BACKEND_RULES §6), a legacy `Float` kolone
 * (težina, debljina, kg u komadu) kao broj.
 */
function num(v: number | string | null | undefined, maxFrac = 2): string {
  return formatDecimal(v, maxFrac);
}

/** Tekst ili „—" (prazan string se tretira kao odsutan). */
function txt(v: string | null | undefined): string {
  return v && v.trim() !== '' ? v : '—';
}

/** Šifra iz šifarnika: tabularna, a opis (kad ga sync ima) stoji kao tooltip. */
function sifraSaOpisom(kod: string | null, ref: CodeRef | null) {
  return (
    <span
      className="tnums whitespace-nowrap text-ink-secondary"
      title={ref?.description ?? undefined}
    >
      {txt(kod)}
    </span>
  );
}

/**
 * Sve kolone su `sortable` osim „PPD" — ona jedina nije u backend allowlist-u
 * (`ITEM_SORT_COLUMNS`), pa bi klik na njeno zaglavlje vratio 400.
 */
const columns: Column<ItemRow>[] = [
  {
    key: 'catalogNumber',
    header: 'Kataloški broj',
    sortable: true,
    render: (a) => (
      <span className="tnums whitespace-nowrap font-semibold text-ink">{a.catalogNumber}</span>
    ),
  },
  {
    key: 'name',
    header: 'Naziv',
    sortable: true,
    render: (a) => (
      <span className="block max-w-[22rem] truncate text-ink" title={a.name}>
        {a.name}
      </span>
    ),
  },
  {
    key: 'unit',
    header: 'J.m.',
    sortable: true,
    render: (a) => <span className="whitespace-nowrap text-ink-secondary">{txt(a.unit)}</span>,
  },
  {
    key: 'shelf',
    header: 'Polica',
    sortable: true,
    render: (a) => <span className="whitespace-nowrap text-ink-secondary">{txt(a.shelf)}</span>,
  },
  {
    key: 'weight',
    header: 'Težina',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.weight, 3)}</span>,
  },
  {
    key: 'groupCode',
    header: 'Grupa',
    sortable: true,
    render: (a) => sifraSaOpisom(a.groupCode, a.group),
  },
  {
    key: 'subgroupCode',
    header: 'Podgrupa',
    sortable: true,
    render: (a) => sifraSaOpisom(a.subgroupCode, a.subgroup),
  },
  {
    key: 'originCode',
    header: 'PodPodgrupa',
    sortable: true,
    render: (a) => sifraSaOpisom(a.originCode, a.origin),
  },
  {
    key: 'wholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink">{num(a.wholesalePrice)}</span>,
  },
  {
    key: 'retailPrice',
    header: 'MP cena',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.retailPrice)}</span>,
  },
  {
    key: 'goodsTaxRateCode',
    header: 'Tarifa robe',
    sortable: true,
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.goodsTaxRateCode)}</span>
    ),
  },
  {
    // BigBit ovde ima checkbox „Uvek porez na robu" — prikaz je „DA" ili crtica,
    // ne pilula: PPD nije status dokumenta nego osobina artikla (§7 se ne tiče).
    // Jedina kolona bez sorta: nije u backend allowlist-u (klik = 400).
    key: 'alwaysTaxGoods',
    header: 'PPD',
    render: (a) => (
      <span className="text-ink-secondary" title="Uvek porez na robu">
        {a.alwaysTaxGoods ? 'DA' : '—'}
      </span>
    ),
  },
  {
    key: 'thickness',
    header: 'Debljina ploče',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.thickness, 3)}</span>,
  },
  {
    key: 'box',
    header: 'Kg u kom.',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.box, 3)}</span>,
  },
  {
    key: 'fxSalePrice',
    header: 'Devizna cena',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.fxSalePrice)}</span>,
  },
  {
    key: 'accountingCode',
    header: 'Kng. šifra 1',
    sortable: true,
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.accountingCode)}</span>
    ),
  },
  {
    key: 'accountingCode2',
    header: 'Kng. šifra 2',
    sortable: true,
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.accountingCode2)}</span>
    ),
  },
  {
    // PLU je ŠIFRA, ne količina — ide sirovo, bez grupisanja hiljada. Kroz
    // `formatDecimal` bi se 58143 prikazalo kao „58.143", što korisnik čita kao
    // decimalu i ne može da ga uporedi sa BigBitom (BigBit šifre ne grupiše).
    // Isti postupak kao kolona „ID" niže.
    key: 'plu',
    header: 'PLU',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) => <span className="tnums text-ink-secondary">{a.plu ?? '—'}</span>,
  },
  {
    // „ID" u BigBitu = Šifra artikla (`external_item_id`). Artikal otvoren u 4.0
    // je nema (0) — nula bi se pročitala kao šifra, pa stoji jasna oznaka.
    key: 'externalItemId',
    header: 'ID',
    align: 'right',
    numeric: true,
    sortable: true,
    render: (a) =>
      a.externalItemId ? (
        <span className="tnums text-ink-secondary">{a.externalItemId}</span>
      ) : (
        <span
          className="text-ink-disabled"
          title={
            a.native
              ? 'Artikal otvoren u 4.0 — nema BigBit šifru'
              : 'Artikal iz BigBit-a bez upisane šifre'
          }
        >
          {a.native ? '4.0' : '—'}
        </span>
      ),
  },
  {
    key: 'barCode',
    header: 'Bar kod',
    sortable: true,
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.barCode)}</span>
    ),
  },
  {
    key: 'externalCode',
    header: 'Ext. šifra',
    sortable: true,
    render: (a) => (
      <span className="whitespace-nowrap text-ink-secondary">{txt(a.externalCode)}</span>
    ),
  },
  {
    key: 'foreignName',
    header: 'INO naziv',
    sortable: true,
    render: (a) => (
      <span
        className="block max-w-[16rem] truncate text-ink-secondary"
        title={a.foreignName ?? undefined}
      >
        {txt(a.foreignName)}
      </span>
    ),
  },
];

/**
 * CSV kolone = ISTIH 22, istim redosledom (BigBit dugme „Export"). Brojevi idu sa
 * zarezom kao decimalnim znakom — Excel u sr lokalizaciji ih inače čita kao tekst
 * (isti obrazac kao lager lista, `robno/lager-panel.tsx`).
 */
const csvDec = (v: number | string | null | undefined): string =>
  v === null || v === undefined || v === '' ? '' : String(v).replace('.', ',');

const csvColumns: CsvColumn<ItemRow>[] = [
  { header: 'Kataloški broj', value: (a) => a.catalogNumber },
  { header: 'Naziv', value: (a) => a.name },
  { header: 'J.m.', value: (a) => a.unit ?? '' },
  { header: 'Polica', value: (a) => a.shelf ?? '' },
  { header: 'Težina', value: (a) => csvDec(a.weight) },
  { header: 'Grupa', value: (a) => a.groupCode },
  { header: 'Podgrupa', value: (a) => a.subgroupCode },
  { header: 'PodPodgrupa', value: (a) => a.originCode },
  { header: 'VP cena', value: (a) => csvDec(a.wholesalePrice) },
  { header: 'MP cena', value: (a) => csvDec(a.retailPrice) },
  { header: 'Tarifa robe', value: (a) => a.goodsTaxRateCode },
  { header: 'PPD', value: (a) => (a.alwaysTaxGoods ? 'DA' : '') },
  { header: 'Debljina ploče', value: (a) => csvDec(a.thickness) },
  { header: 'Kg u kom.', value: (a) => csvDec(a.box) },
  { header: 'Devizna cena', value: (a) => csvDec(a.fxSalePrice) },
  { header: 'Kng. šifra 1', value: (a) => a.accountingCode ?? '' },
  { header: 'Kng. šifra 2', value: (a) => a.accountingCode2 ?? '' },
  { header: 'PLU', value: (a) => a.plu ?? '' },
  // Prazno za 4.0-native red: on BigBit šifru nema, a nula bi u Excelu bila šifra.
  { header: 'ID', value: (a) => a.externalItemId || '' },
  { header: 'Bar kod', value: (a) => a.barCode ?? '' },
  { header: 'Ext. šifra', value: (a) => a.externalCode ?? '' },
  { header: 'INO naziv', value: (a) => a.foreignName ?? '' },
];

/** Kompaktna ćelija filter trake — labela 12px iznad kontrole (idiom `/robno`, `/izvodi`). */
function Polje({
  labela,
  sirina,
  children,
}: {
  labela: string;
  sirina: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {labela}
      <div className={sirina}>{children}</div>
    </label>
  );
}

export default function ArtikliPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

  // Filteri i sort žive U URL-u (frontend/CLAUDE.md §12) — povratak sa detalja
  // artikla vraća listu tačno kakva je bila. Strane nema: lista se skroluje.
  const { values, setValues } = useListQueryState(PRAZAN_FILTER);

  // Tekstualna polja se kucaju lokalno, pa se posle KUCANJE_MS upisuju u URL.
  // `jm` je ovde zbog TEKSTUALNOG rezervnog polja (šifarnik jedinica nije stigao);
  // kad se J.m. bira iz padajuće liste, `values.jm` se upisuje odmah, a ovaj snimak
  // se poravna kroz sinhronizaciju ispod — druge grane nema.
  const [tekst, setTekst] = useState({
    trazi: values.trazi,
    katbroj: values.katbroj,
    naziv: values.naziv,
    jm: values.jm,
    polica: values.polica,
  });
  useEffect(() => {
    setTekst({
      trazi: values.trazi,
      katbroj: values.katbroj,
      naziv: values.naziv,
      jm: values.jm,
      polica: values.polica,
    });
  }, [values.trazi, values.katbroj, values.naziv, values.jm, values.polica]);
  useEffect(() => {
    if (
      tekst.trazi === values.trazi &&
      tekst.katbroj === values.katbroj &&
      tekst.naziv === values.naziv &&
      tekst.jm === values.jm &&
      tekst.polica === values.polica
    ) {
      return;
    }
    const t = setTimeout(() => setValues(tekst), KUCANJE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tekst]);

  const [izvozUToku, setIzvozUToku] = useState(false);
  const [izvozPoruka, setIzvozPoruka] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Alt+N = nov zapis u aktivnom modulu (DESIGN_SYSTEM §8). Ne otima kucanje u polju.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      const cilj = e.target as HTMLElement | null;
      const tag = cilj?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      router.push('/artikli/nov');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  /** Sort iz URL-a — nepoznata kolona se ćutke odbacuje (backend bi je vratio kao 400). */
  const sort: SortState | null = useMemo(() => {
    if (!isItemSortColumn(values.sort)) return null;
    return { key: values.sort, dir: values.smer === 'desc' ? 'desc' : 'asc' };
  }, [values.sort, values.smer]);

  /** Filter za server — jedan izvor i za listu i za izvoz. */
  const filters: ItemListParams = useMemo(
    () => ({
      q: values.trazi || undefined,
      catalogNumber: values.katbroj || undefined,
      name: values.naziv || undefined,
      unit: values.jm || undefined,
      groupCode: values.grupa || undefined,
      subgroupCode: values.podgrupa || undefined,
      originCode: values.podpodgrupa || undefined,
      shelf: values.polica || undefined,
      shelfPresence:
        values.policaPrisustvo === 'with' || values.policaPrisustvo === 'without'
          ? values.policaPrisustvo
          : undefined,
      duplicateCatalogNumbers: values.dupli === '1' ? true : undefined,
      // `sort.key` je već prošao `isItemSortColumn` pri čitanju iz URL-a.
      sort: sort ? (sort.key as ItemSortColumn) : undefined,
      dir: sort?.dir,
    }),
    [values, sort],
  );

  const { upit, redovi, ukupno, ucitano, naKapi } = useArtikliSkrol(filters);
  const lookups = useItemLookups();
  const sifarnici = lookups.data?.data;

  const groupOptions = useMemo(
    () =>
      (sifarnici?.groups ?? []).map((g) => ({
        value: g.code,
        label: g.description ? `${g.code} — ${g.description}` : g.code,
      })),
    [sifarnici],
  );

  /** Kaskada: izabrana grupa sužava podgrupe (BigBit `FilterZaGrupu_AfterUpdate`). */
  const subgroupOptions = useMemo(() => {
    const sve = sifarnici?.subgroups ?? [];
    const lista = values.grupa ? sve.filter((s) => s.parentGroup === values.grupa) : sve;
    return lista.map((s) => ({
      value: s.code,
      label: s.description ? `${s.code} — ${s.description}` : s.code,
    }));
  }, [sifarnici, values.grupa]);

  /**
   * Jedinice mere — `lookups.units` je DISTINCT iz `items` (nema svoj šifarnik), pa je
   * spisak tačno ono što u podacima postoji. Filter traži TAČNO poklapanje: „KOM" i
   * „KOM." su dve različite jedinice i prefiks bi ih pomešao.
   */
  const jmOptions = useMemo(() => {
    const jedinice = sifarnici?.units ?? [];
    // Vrednost koja nije u spisku (stara adresa, otkucano u rezervnom polju) mora
    // ostati VIDLJIVA u kontroli — inače lista pokazuje „sve", a filter i dalje radi
    // po njoj, pa ekran laže o tome šta je filtrirano.
    const sve =
      values.jm && !jedinice.includes(values.jm) ? [values.jm, ...jedinice] : jedinice;
    return sve.map((u) => ({ value: u, label: u }));
  }, [sifarnici, values.jm]);

  /** Ima li šifarnik jedinica uopšte — bez njega J.m. filter pada na tekstualno polje. */
  const imaJedinica = (sifarnici?.units?.length ?? 0) > 0;

  /** Druga stepenica kaskade: izabrana podgrupa sužava PodPodgrupe. */
  const originOptions = useMemo(() => {
    const sve = sifarnici?.origins ?? [];
    const lista = values.podgrupa
      ? sve.filter((o) => o.subgroupCode === values.podgrupa)
      : sve;
    return lista.map((o) => ({
      value: o.code,
      label: o.description ? `${o.code} — ${o.description}` : o.code,
    }));
  }, [sifarnici, values.podgrupa]);

  /** Promena gornjeg nivoa poništava niže — inače filter ostane na nemogućem paru. */
  function promeniGrupu(v: string) {
    setValues({ grupa: v, podgrupa: '', podpodgrupa: '' });
  }
  function promeniPodgrupu(v: string) {
    setValues({ podgrupa: v, podpodgrupa: '' });
  }

  /**
   * Klik na zaglavlje: nova kolona → prvi smer (numeričke opadajuće), isti smer →
   * obrnut, drugi klik u istom smeru → nazad na BigBit redosled. Sort ide u URL, pa
   * ga povratak sa detalja zadrži.
   */
  const prebaciSort = useCallback(
    (key: string) => {
      if (!isItemSortColumn(key)) return;
      const prvi: ItemSortDir = PRVI_KLIK_OPADAJUCE.has(key) ? 'desc' : 'asc';
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

  const imaFilter = Object.entries(values).some(
    ([k, v]) => !NIJE_FILTER.has(k) && v !== '',
  );
  const imaNaprednih = NAPREDNI_FILTERI.some((k) => values[k] !== '');

  /** „Više filtera" se samo otvara kad filter iz njega već radi — da ne bude nevidljiv. */
  const [viseOtvoreno, setViseOtvoreno] = useState(false);
  useEffect(() => {
    if (imaNaprednih) setViseOtvoreno(true);
  }, [imaNaprednih]);

  function ponistiFilter() {
    setTekst({ trazi: '', katbroj: '', naziv: '', jm: '', polica: '' });
    setValues({ ...PRAZAN_FILTER, sort: values.sort, smer: values.smer });
    setIzvozPoruka(null);
  }

  // ─── Izbor reda ────────────────────────────────────────────────────────────
  // Klik BIRA red, dupli klik / Enter OTVARA detalj (BigBit navika: red radnji
  // iznad liste radi nad izabranim artiklom).
  //
  // IZBOR JE KONTROLISAN ODAVDE (`selectedKey` + `onSelectionChange`): ovo stanje je
  // jedini izvor i za akcentnu traku u tabeli i za dugmad iznad nje. Bez toga tabela
  // vodi svoj izbor kao INDEKS koji starta na 0 — pa prvi red izgleda izabrano, a
  // dugmad stoje siva sa „prvo izaberi artikal"; isto se ponavljalo i posle svake
  // promene filtera.
  //
  // Izabrani red se drži i u ref-u: Enter iz tela tabele bubble-uje do rukovaoca
  // ispod, a `useState` vrednost u zatvaranju bi bila stara ako bi izbor i Enter
  // ikad pali u isti događaj.
  const [izabran, setIzabran] = useState<ItemRow | null>(null);
  const izabranRef = useRef<ItemRow | null>(null);
  const izaberi = useCallback((red: ItemRow | null) => {
    izabranRef.current = red;
    setIzabran(red);
  }, []);

  // Promena filtera ili sorta poništava izbor: red iz prethodnog spiska ne mora
  // uopšte biti u novom, a dugmad iznad liste bi radila nad njim.
  useEffect(() => {
    izaberi(null);
  }, [filters, izaberi]);

  // `data-row-index` postavlja `DataTable` (samo kad ima `rowActions`) — preko njega
  // se iz DOM-a vraća red na koji se događaj odnosi (dupli klik).
  const redIzTr = useCallback(
    (tr: Element | null): ItemRow | null => {
      if (!tr) return null;
      // Atribut MORA postojati: `Number(null)` je 0 i `Number('')` je 0, pa bi <tr>
      // bez indeksa (prošireni red, red „nema podataka") tiho vratio PRVI artikal.
      const atr = tr.getAttribute('data-row-index');
      if (atr === null || atr.trim() === '') return null;
      const i = Number(atr);
      return Number.isInteger(i) && i >= 0 ? redovi[i] ?? null : null;
    },
    [redovi],
  );

  /** Red pod pokazivačem. */
  const redIzDogadjaja = useCallback(
    (cilj: EventTarget | null): ItemRow | null => {
      const el = cilj instanceof Element ? cilj : null;
      return redIzTr(el?.closest('tr[data-row-index]') ?? null);
    },
    [redIzTr],
  );

  const otvoriDetalj = useCallback(
    (red: ItemRow | null) => {
      if (red) router.push(`/artikli/detalj?id=${red.id}`);
    },
    [router],
  );

  const mozeKarticu = can(PERMISSIONS.ROBNO_READ);

  /**
   * RED RADNJI NAD ARTIKLOM — jedan izvor za dugmad ispod filtera I za meni na
   * desni klik, da se ne raziđu. Redosled i labele su BigBit-ovi.
   *
   * „Kartica artikla" čita robna kretanja (`/robno/item-card`, pravo `robno.read`),
   * koje `/artikli` (pravo `directory.read`) ne podrazumeva — kome ga nema, stavka
   * se ne nudi uopšte umesto da vodi u 403.
   */
  const akcijeZaRed = useCallback(
    (red: ItemRow | null): RowAction[] => {
      const nemaReda = red ? undefined : 'Prvo izaberi artikal u listi (klik na red).';
      const stavke: RowAction[] = [
        {
          kljuc: 'detalj',
          labela: 'Detaljno artikal',
          onemoguceno: nemaReda,
          onSelect: () => otvoriDetalj(red),
        },
      ];
      if (mozeKarticu) {
        stavke.push({
          kljuc: 'kartica',
          labela: 'Kartica artikla',
          onemoguceno: nemaReda,
          onSelect: () => {
            if (red) router.push(`/artikli/kartica?id=${red.id}`);
          },
        });
      }
      stavke.push(
        {
          kljuc: 'recepti',
          labela: 'Recepti',
          onemoguceno: 'BigBit T_Recepti je prazan (0 zapisa)',
          onSelect: () => {},
        },
        {
          kljuc: 'kng',
          labela: 'KNG artikli',
          onemoguceno: 'KNG šifarnik ima 2 zapisa — ekran stiže kasnije',
          onSelect: () => {},
        },
        {
          kljuc: 'tarife',
          labela: 'Promena tarifa poreza',
          onemoguceno: 'Masovna izmena cena/tarifa — poseban paket',
          onSelect: () => {},
        },
      );
      return stavke;
    },
    [mozeKarticu, otvoriDetalj, router],
  );

  const akcijeIznad = akcijeZaRed(izabran);

  /**
   * „Export" izvozi CELU filtriranu listu, ne učitane redove (BigBit tako radi).
   * Platformsko dugme `ExportCsvButton` ovde ne može — ono prima gotove redove, a
   * ovde se do njih dolazi tek posle klika (server-side filter nad ~92k redova);
   * koristi se isti motor izvoza, `lib/table-csv.ts`.
   */
  async function izveziFiltriranuListu() {
    setIzvozUToku(true);
    setIzvozPoruka(null);
    try {
      const { rows: sve, total, truncated } = await fetchArtikliZaIzvoz(filters);
      if (sve.length === 0) {
        setIzvozPoruka('Nema redova za izvoz — filter ne vraća nijedan artikal.');
        return;
      }
      exportTableToCsv(csvColumns, sve, `artikli-${new Date().toISOString().slice(0, 10)}`);
      setIzvozPoruka(
        truncated
          ? `Izvezeno prvih ${formatNumber(sve.length)} od ${formatNumber(total)} artikala — suzi filter za ostatak.`
          : `Izvezeno ${formatNumber(sve.length)} artikala.`,
      );
    } catch (e) {
      setIzvozPoruka(`Izvoz nije uspeo: ${(e as Error).message}`);
    } finally {
      setIzvozUToku(false);
    }
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Artikli"
        count={upit.data ? `${formatNumber(ukupno)} artikala` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={izveziFiltriranuListu}
              loading={izvozUToku}
              title="Izvezi filtriranu listu u CSV (Excel)"
              aria-label="Export"
              className="max-sm:w-9 max-sm:px-0"
            >
              {!izvozUToku && <Download className="h-4 w-4" aria-hidden />}
              <span className="max-sm:hidden">Export</span>
            </Button>
            {/* Na 360 px ostaje samo ikona — naslov i akcije imaju prednost (§11). */}
            <Button
              onClick={() => router.push('/artikli/nov')}
              title="Nov artikal (Alt+N)"
              aria-label="Nov artikal"
              className="max-sm:w-9 max-sm:px-0"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Nov artikal</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-3 overflow-auto p-6">
        {/* Filter traka — lagana, jedan red gde stane (idiom `/robno`, `/izvodi`). */}
        <div className="flex flex-wrap items-end gap-3">
          <Polje labela="Pronađi artikal" sirina="w-64">
            <Input
              value={tekst.trazi}
              onChange={(e) => setTekst((t) => ({ ...t, trazi: e.target.value }))}
              placeholder="kat. broj, naziv, bar kod, ext. šifra"
            />
          </Polje>

          <Polje labela="Grupa" sirina="w-44">
            <Select
              placeholder="sve"
              value={values.grupa}
              onChange={(e) => promeniGrupu(e.target.value)}
              options={groupOptions}
            />
          </Polje>

          <Polje labela="Podgrupa" sirina="w-44">
            <Select
              placeholder="sve"
              value={values.podgrupa}
              onChange={(e) => promeniPodgrupu(e.target.value)}
              options={subgroupOptions}
            />
          </Polje>

          <Polje labela="PodPodgrupa" sirina="w-44">
            <Select
              placeholder="sve"
              value={values.podpodgrupa}
              onChange={(e) => setValues({ podpodgrupa: e.target.value })}
              options={originOptions}
            />
          </Polje>

          <Polje labela="Polica" sirina="w-32">
            <Input
              value={tekst.polica}
              onChange={(e) => setTekst((t) => ({ ...t, polica: e.target.value }))}
              placeholder="npr. A"
              title={'Prefiks oznake police: „A“ vraća ceo red A (A-1, A-1-3…)'}
            />
          </Polje>

          <Polje labela="Prisustvo police" sirina="w-40">
            <Select
              placeholder="sve"
              value={values.policaPrisustvo}
              onChange={(e) => setValues({ policaPrisustvo: e.target.value })}
              options={POLICA_OPCIJE}
            />
          </Polje>

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
            <Polje labela="…kat. broj" sirina="w-40">
              <Input
                value={tekst.katbroj}
                onChange={(e) => setTekst((t) => ({ ...t, katbroj: e.target.value }))}
                placeholder="početak broja"
              />
            </Polje>

            <Polje labela="…deo naziva" sirina="w-56">
              <Input
                value={tekst.naziv}
                onChange={(e) => setTekst((t) => ({ ...t, naziv: e.target.value }))}
                placeholder="deo naziva"
              />
            </Polje>

            {/* J.m. — padajuća lista dok šifarnik stoji, inače obično tekstualno polje:
                filter mora da radi i kad `lookups` padne (traka iznad to i kaže). */}
            <Polje labela="J.m." sirina="w-32">
              {imaJedinica ? (
                <Select
                  placeholder="sve"
                  value={values.jm}
                  onChange={(e) => setValues({ jm: e.target.value })}
                  options={jmOptions}
                  title="Jedinica mere — tačno poklapanje"
                />
              ) : (
                <Input
                  value={tekst.jm}
                  onChange={(e) => setTekst((t) => ({ ...t, jm: e.target.value }))}
                  placeholder="npr. KOM"
                  title="Jedinica mere — tačno poklapanje (spisak jedinica nije učitan)"
                />
              )}
            </Polje>

            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={values.dupli === '1'}
                onChange={(e) => setValues({ dupli: e.target.checked ? '1' : '' })}
              />
              Prikaži artikle sa duplim kataloškim brojem
            </label>
          </div>
        </details>

        {/* Red radnji nad IZABRANIM artiklom (BigBit redosled i labele). Isti spisak
            je i na desni klik na red — jedan izvor, `akcijeZaRed`. */}
        <div className="flex flex-wrap items-center gap-2">
          {akcijeIznad.map((a) =>
            a.onemoguceno ? (
              // `aria-disabled`, ne `disabled`: pravi `disabled` element u Firefox-u
              // ne prima pokazivač, pa se `title` (razlog) nikad ne prikaže i korisnik
              // ne sazna ZAŠTO dugme ne radi (isto pravilo kao `ContextMenu`).
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
                Izabran: <span className="tnums">{izabran.catalogNumber}</span> — {izabran.name}
              </>
            ) : (
              'Klikni red da izabereš artikal · dupli klik ili Enter otvara detalj'
            )}
          </span>
        </div>

        {upit.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(upit.error as Error).message}
          </div>
        )}

        {lookups.error && (
          <p className="text-sm text-ink-secondary">
            Šifarnici filtera nisu učitani — padajuće liste su prazne, pretraga i ostali
            filteri rade normalno.
          </p>
        )}

        {/* 22 kolone ne staju na ekran: skrol je UNUTAR tabele (zamrznuto zaglavlje +
            prve dve kolone), a `min-w-0` sprečava da širina tabele razvuče stranu —
            strana se nikad ne pomera vodoravno (DESIGN_SYSTEM §11).
            Dupli klik i Enter se hvataju OVDE jer `DataTable` nema svoj „otvori":
            oba događaja bubble-uju iz reda (`onRowActivate` je već upisao izbor). */}
        <div
          className="min-w-0"
          onDoubleClick={(e) => {
            // Samo dupli klik NA RED otvara detalj: dupli klik po zaglavlju (sort) ili
            // po dugmetu „…" ne sme da odvede sa ekrana.
            if (!(e.target instanceof Element)) return;
            if (e.target.closest('button, a, input, label')) return;
            otvoriDetalj(redIzDogadjaja(e.target));
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Samo Enter iz TELA TABELE otvara detalj. Bez ove granice bi ga otvorio
            // i Enter na dugmetu „…" i na stavci menija akcija (oba su unutar ovog
            // okvira i oba bubble-uju dovde) — ista granica koju `DataTable` vuče
            // svojim `e.target !== e.currentTarget` zbog buga 009/26.
            if (!(e.target instanceof HTMLElement) || e.target.tagName !== 'TBODY') return;
            otvoriDetalj(izabranRef.current);
          }}
        >
          {/* Izbor je KONTROLISAN odavde: `selectedKey` je ono što se ističe, a
              `onSelectionChange` javlja svaki pomeraj (klik, desni klik, dugme „…",
              ↑/↓). Zato ekranu više ne trebaju sinhronizacije iz DOM-a — istaknut
              red i red nad kojim dugmad rade su ista stvar po konstrukciji. */}
          <DataTable
            columns={columns}
            rows={redovi}
            rowKey={(a) => a.id}
            loading={upit.isLoading}
            sort={sort}
            onSortToggle={prebaciSort}
            stickyHeader
            frozenColumns={2}
            maxHeight={VISINA_TABELE}
            rowActions={akcijeZaRed}
            selectedKey={izabran?.id ?? null}
            onSelectionChange={izaberi}
            empty={
              <EmptyState
                title="Nema artikala"
                hint="Nijedan artikal ne odgovara filteru — poništi filter ili proširi pretragu."
              />
            }
          />
        </div>

        {/* Brojač + dovlačenje NA ZAHTEV. Automatsko dovlačenje na dolazak dna se ne
            koristi: na dodirnom ekranu odskok na dnu okine posmatrača više puta i
            pošalje plotun zahteva. */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink-secondary">
            Prikazano {formatNumber(ucitano)} od {formatNumber(ukupno)}
          </span>

          {upit.hasNextPage && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void upit.fetchNextPage()}
              loading={upit.isFetchingNextPage}
            >
              Učitaj još
            </Button>
          )}

          {naKapi && (
            <span className="text-sm text-status-warn">
              Prikazano {formatNumber(ARTIKLI_SKROL_KAPA)} od {formatNumber(ukupno)} — suzi
              pretragu ili izvezi u Excel
            </span>
          )}

          {izvozPoruka && <span className="text-sm text-ink-secondary">{izvozPoruka}</span>}
        </div>

        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a — unos i izmena su zaključani (ekran unosa objašnjava zašto)
        </p>
      </div>
    </AppShell>
  );
}
