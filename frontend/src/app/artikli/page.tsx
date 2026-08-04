'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Plus, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Select } from '@/components/ui-kit/select';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { useListQueryState } from '@/lib/use-id-param';
import { exportTableToCsv, type CsvColumn } from '@/lib/table-csv';
import { formatDecimal, formatNumber } from '@/lib/format';
import {
  useArtikli,
  useItemLookups,
  fetchArtikliZaIzvoz,
  rasterLabel,
  type CodeRef,
  type ItemListParams,
  type ItemRow,
} from '@/api/masters';

/**
 * Matični podaci — Artikli (obrazac „Lista", DESIGN_SYSTEM §4.1): filter bar +
 * gusta tabela sa server-side paginacijom.
 *
 * PARITET SA BIGBITOM (zahtev vlasnika 04.08.2026 — „sve treba da bude kao u
 * BigBitu… svi korisnici su navikli"):
 *  • KOLONE su onim redosledom kojim ih crta BigBit forma „Pregled artikala"
 *    (izvor: izvoz forme iz `OnLine_BigBit_APL.MDB`, `Detail` sekcija sortirana po
 *    `Left` koordinati): Kataloški broj · Naziv · J.m. · Polica · Težina · Grupa ·
 *    Podgrupa · PodPodgrupa · VP cena · MP cena · Tarifa robe · PPD · Debljina
 *    ploče · Kg u kom. · Devizna cena · Kng. šifra 1 · Kng. šifra 2 · PLU · ID ·
 *    Bar kod · Ext. šifra · INO naziv. Redosled i labele se NE „poboljšavaju".
 *  • FILTERI su isti kao na formi (kaskada grupa → podgrupa → PodPodgrupa, kat.
 *    broj, deo naziva, dimenzija, kvalitet, dupli kataloški brojevi) + jedno
 *    objedinjeno polje pretrage umesto tri BigBit combo-a (kat. broj / naziv /
 *    bar kod).
 *  • „PodPodgrupa" je BigBit labela kolone `Poreklo` — u UI-ju se zove tako kako
 *    je korisnici zovu, iako polje u bazi nosi staro ime.
 *  • Kolona „ID" je BigBit „Šifra artikla" = `items.external_item_id`, NIKAD
 *    `items.id` (BIGBIT_ARTIKLI.md §5.1). Red otvoren u 4.0 nema BigBit šifru
 *    (vrednost 0) pa dobija oznaku „4.0", da se nula ne pročita kao šifra.
 *
 * Podatak je BigBit cache (`items`, ~91k redova). Unos i izmena imaju pun ekran
 * (`/artikli/nov`, `/artikli/detalj?id=N&rezim=izmena`), ali su ZAKLJUČANI dok
 * `items` ne uđe u zaštićeni skup sync-a — ekran to objašnjava i kaže šta da se
 * uradi (v. `_forma/pravila.ts`, `BRANA_ARTIKAL`). Ovaj paket menja SAMO pregled i
 * izgled, brana ostaje. Detalj je STATIČKA ruta `?id=N` (nikad `[id]` segment —
 * static export ga ne izvozi, v. `artikli/detalj/page.tsx`).
 */

const PAGE_SIZE = 50;

/** Odlaganje upita dok se kuca — bez njega je svako slovo jedan upit nad 91k redova. */
const KUCANJE_MS = 300;

/** Prazan filter — „Poništi filter" vraća tačno ovo stanje (BigBit `Ponisti filter`). */
const PRAZAN_FILTER = {
  trazi: '',
  katbroj: '',
  naziv: '',
  grupa: '',
  podgrupa: '',
  podpodgrupa: '',
  dimenzija: '',
  kvalitet: '',
  dupli: '',
  aktivni: '',
  strana: '1',
};

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

const columns: Column<ItemRow>[] = [
  {
    key: 'catalogNumber',
    header: 'Kataloški broj',
    render: (a) => (
      <span className="tnums whitespace-nowrap font-semibold text-ink">{a.catalogNumber}</span>
    ),
  },
  {
    key: 'name',
    header: 'Naziv',
    render: (a) => (
      <span className="block max-w-[22rem] truncate text-ink" title={a.name}>
        {a.name}
      </span>
    ),
  },
  {
    key: 'unit',
    header: 'J.m.',
    render: (a) => <span className="whitespace-nowrap text-ink-secondary">{txt(a.unit)}</span>,
  },
  {
    key: 'shelf',
    header: 'Polica',
    render: (a) => <span className="whitespace-nowrap text-ink-secondary">{txt(a.shelf)}</span>,
  },
  {
    key: 'weight',
    header: 'Težina',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.weight, 3)}</span>,
  },
  {
    key: 'groupCode',
    header: 'Grupa',
    render: (a) => sifraSaOpisom(a.groupCode, a.group),
  },
  {
    key: 'subgroupCode',
    header: 'Podgrupa',
    render: (a) => sifraSaOpisom(a.subgroupCode, a.subgroup),
  },
  {
    key: 'originCode',
    header: 'PodPodgrupa',
    render: (a) => sifraSaOpisom(a.originCode, a.origin),
  },
  {
    key: 'wholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink">{num(a.wholesalePrice)}</span>,
  },
  {
    key: 'retailPrice',
    header: 'MP cena',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.retailPrice)}</span>,
  },
  {
    key: 'goodsTaxRateCode',
    header: 'Tarifa robe',
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.goodsTaxRateCode)}</span>
    ),
  },
  {
    // BigBit ovde ima checkbox „Uvek porez na robu" — prikaz je „DA" ili crtica,
    // ne pilula: PPD nije status dokumenta nego osobina artikla (§7 se ne tiče).
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
    render: (a) => <span className="tnums text-ink-secondary">{num(a.thickness, 3)}</span>,
  },
  {
    key: 'box',
    header: 'Kg u kom.',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.box, 3)}</span>,
  },
  {
    key: 'fxSalePrice',
    header: 'Devizna cena',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink-secondary">{num(a.fxSalePrice)}</span>,
  },
  {
    key: 'accountingCode',
    header: 'Kng. šifra 1',
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.accountingCode)}</span>
    ),
  },
  {
    key: 'accountingCode2',
    header: 'Kng. šifra 2',
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
    render: (a) => <span className="tnums text-ink-secondary">{a.plu ?? '—'}</span>,
  },
  {
    // „ID" u BigBitu = Šifra artikla (`external_item_id`). Artikal otvoren u 4.0
    // je nema (0) — nula bi se pročitala kao šifra, pa stoji jasna oznaka.
    key: 'externalItemId',
    header: 'ID',
    align: 'right',
    numeric: true,
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
    render: (a) => (
      <span className="tnums whitespace-nowrap text-ink-secondary">{txt(a.barCode)}</span>
    ),
  },
  {
    key: 'externalCode',
    header: 'Ext. šifra',
    render: (a) => (
      <span className="whitespace-nowrap text-ink-secondary">{txt(a.externalCode)}</span>
    ),
  },
  {
    key: 'foreignName',
    header: 'INO naziv',
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

export default function ArtikliPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  // Filteri i strana žive U URL-u (frontend/CLAUDE.md §12) — povratak sa kartice
  // artikla vraća listu tačno kakva je bila, sa filterom i stranom.
  const { values, setValues } = useListQueryState(PRAZAN_FILTER);
  const page = Math.max(1, Number(values.strana) || 1);

  // Tekstualna polja se kucaju lokalno, pa se posle KUCANJE_MS upisuju u URL.
  const [tekst, setTekst] = useState({
    trazi: values.trazi,
    katbroj: values.katbroj,
    naziv: values.naziv,
  });
  useEffect(() => {
    setTekst({ trazi: values.trazi, katbroj: values.katbroj, naziv: values.naziv });
  }, [values.trazi, values.katbroj, values.naziv]);
  useEffect(() => {
    if (
      tekst.trazi === values.trazi &&
      tekst.katbroj === values.katbroj &&
      tekst.naziv === values.naziv
    ) {
      return;
    }
    const t = setTimeout(() => setValues({ ...tekst, strana: '1' }), KUCANJE_MS);
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

  /** Filter za server — jedan izvor i za listu i za izvoz. */
  const filters: ItemListParams = useMemo(
    () => ({
      q: values.trazi || undefined,
      catalogNumber: values.katbroj || undefined,
      name: values.naziv || undefined,
      groupCode: values.grupa || undefined,
      subgroupCode: values.podgrupa || undefined,
      originCode: values.podpodgrupa || undefined,
      rasterId: values.dimenzija ? Number(values.dimenzija) : undefined,
      qualityTypeId: values.kvalitet ? Number(values.kvalitet) : undefined,
      duplicateCatalogNumbers: values.dupli === '1' ? true : undefined,
      active: values.aktivni === '1' ? true : undefined,
    }),
    [values],
  );

  const list = useArtikli({ ...filters, page, pageSize: PAGE_SIZE });
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

  const rasterOptions = useMemo(
    () =>
      (sifarnici?.rasters ?? []).map((r) => ({ value: String(r.id), label: rasterLabel(r) })),
    [sifarnici],
  );

  const qualityOptions = useMemo(
    () =>
      (sifarnici?.qualityTypes ?? []).map((k) => ({
        value: String(k.id),
        label: k.description ? `${k.code} — ${k.description}` : k.code,
      })),
    [sifarnici],
  );

  /** Promena gornjeg nivoa poništava niže — inače filter ostane na nemogućem paru. */
  function promeniGrupu(v: string) {
    setValues({ grupa: v, podgrupa: '', podpodgrupa: '', strana: '1' });
  }
  function promeniPodgrupu(v: string) {
    setValues({ podgrupa: v, podpodgrupa: '', strana: '1' });
  }

  function ponistiFilter() {
    setTekst({ trazi: '', katbroj: '', naziv: '' });
    setValues(PRAZAN_FILTER);
    setIzvozPoruka(null);
  }

  /**
   * „Export" izvozi CELU filtriranu listu, ne tekuću stranu (BigBit tako radi).
   * Platformsko dugme `ExportCsvButton` ovde ne može — ono prima gotove redove, a
   * ovde se do njih dolazi tek posle klika (server-side filter nad ~91k redova);
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

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const imaFilter = Object.keys(PRAZAN_FILTER).some(
    (k) => k !== 'strana' && values[k as keyof typeof PRAZAN_FILTER] !== '',
  );

  return (
    <AppShell>
      <PageHeader
        title="Artikli"
        count={meta ? `${formatNumber(meta.total)} artikala` : undefined}
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

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {/* Filter bar — isti skup i iste labele kao BigBit forma. */}
        <section className="rounded-panel border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <FormField label="Pronađi artikal">
              <Input
                value={tekst.trazi}
                onChange={(e) => setTekst((t) => ({ ...t, trazi: e.target.value }))}
                placeholder="kat. broj, naziv, bar kod, ext. šifra"
              />
            </FormField>

            <FormField label="…kat. broj">
              <Input
                value={tekst.katbroj}
                onChange={(e) => setTekst((t) => ({ ...t, katbroj: e.target.value }))}
                placeholder="početak broja"
              />
            </FormField>

            <FormField label="…deo naziva">
              <Input
                value={tekst.naziv}
                onChange={(e) => setTekst((t) => ({ ...t, naziv: e.target.value }))}
                placeholder="deo naziva"
              />
            </FormField>

            <FormField label="…grupu">
              <Select
                placeholder="sve grupe"
                value={values.grupa}
                onChange={(e) => promeniGrupu(e.target.value)}
                options={groupOptions}
              />
            </FormField>

            <FormField label="…podgrupu">
              <Select
                placeholder="sve podgrupe"
                value={values.podgrupa}
                onChange={(e) => promeniPodgrupu(e.target.value)}
                options={subgroupOptions}
              />
            </FormField>

            <FormField label="…PodPodgrupu">
              <Select
                placeholder="sve PodPodgrupe"
                value={values.podpodgrupa}
                onChange={(e) => setValues({ podpodgrupa: e.target.value, strana: '1' })}
                options={originOptions}
              />
            </FormField>

            <FormField label="…dimenziju">
              <Select
                placeholder="sve dimenzije"
                value={values.dimenzija}
                onChange={(e) => setValues({ dimenzija: e.target.value, strana: '1' })}
                options={rasterOptions}
              />
            </FormField>

            <FormField label="…kvalitet">
              <Select
                placeholder="svi kvaliteti"
                value={values.kvalitet}
                onChange={(e) => setValues({ kvalitet: e.target.value, strana: '1' })}
                options={qualityOptions}
              />
            </FormField>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={values.dupli === '1'}
                onChange={(e) => setValues({ dupli: e.target.checked ? '1' : '', strana: '1' })}
              />
              Prikaži artikle sa duplim kataloškim brojem
            </label>

            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 accent-accent"
                checked={values.aktivni === '1'}
                onChange={(e) =>
                  setValues({ aktivni: e.target.checked ? '1' : '', strana: '1' })
                }
              />
              Samo aktivni
            </label>

            <Button
              type="button"
              variant="secondary"
              onClick={ponistiFilter}
              disabled={!imaFilter}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              Poništi filter
            </Button>

            {izvozPoruka && <span className="text-sm text-ink-secondary">{izvozPoruka}</span>}
          </div>

          {lookups.error && (
            <p className="mt-3 text-sm text-ink-secondary">
              Šifarnici filtera nisu učitani — padajuće liste su prazne, pretraga i ostali
              filteri rade normalno.
            </p>
          )}
        </section>

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        {/* 22 kolone ne staju na ekran: skrol je UNUTAR tabele (DataTable nosi
            `overflow-x-auto`), a `min-w-0` sprečava da širina tabele razvuče
            stranu — strana se nikad ne pomera vodoravno (DESIGN_SYSTEM §11). */}
        <div className="min-w-0">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(a) => a.id}
            loading={list.isLoading}
            onRowActivate={(a) => router.push(`/artikli/detalj?id=${a.id}`)}
            empty={
              <EmptyState
                title="Nema artikala"
                hint="Nijedan artikal ne odgovara filteru — poništi filter ili proširi pretragu."
              />
            }
          />
        </div>

        {meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setValues({ strana: String(Math.max(1, page - 1)) })}
            onNext={() => setValues({ strana: String(Math.min(meta.totalPages, page + 1)) })}
          />
        )}

        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a — unos i izmena su zaključani (ekran unosa objašnjava zašto)
        </p>
      </div>
    </AppShell>
  );
}
