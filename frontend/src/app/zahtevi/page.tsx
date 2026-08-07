'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Star } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Tabs, KpiTile } from '@/components/ui-kit/tabs';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import { useListQueryState, useZapamcenaPozicijaListe } from '@/lib/use-id-param';
import {
  useZahtevi,
  useInboxMeta,
  usePodnosioci,
  ZAHTEV_STATUS,
  REQUEST_KIND_LABEL,
  type ChangeRequest,
  type RequestKind,
} from '@/api/zahtevi';
import { HelpProvider, HelpToggleButton, HelpBanner } from '@/components/ui-kit/help-mode';
import { HelpSpot } from '@/components/ui-kit/help-spot';
import { HelpTour } from '@/components/ui-kit/help-tour';
import { statusMeta } from './_lib/status';
import { PRAZNI_FILTERI_ZAHTEVA, STANJE_LISTE_ZAHTEVA } from './_lib/list-state';
import { HELP, ADMIN_TOUR } from './_lib/help';
import { moduleOptions, kindOptions } from './_lib/form';
import { NagradeTab } from './_components/nagrade-tab';
import { OdlukeTab } from './_components/odluke-tab';

const TAKE = 50;

/** ★ prikaz ocene (0–5) — finalScore (admin potvrda) ima prednost nad aiScore (predlog). */
function ScoreCell({ r }: { r: ChangeRequest }) {
  const score = r.finalScore ?? r.aiScore;
  if (score == null) return <span className="text-ink-disabled">—</span>;
  return (
    <span
      className="inline-flex items-center gap-1 tnums text-ink"
      title={r.finalScore != null ? 'Potvrđena ocena' : 'AI predlog (nije potvrđen)'}
    >
      <Star
        className={r.finalScore != null ? 'h-3.5 w-3.5 text-status-warn' : 'h-3.5 w-3.5 text-ink-disabled'}
        aria-hidden
      />
      {score}
    </span>
  );
}

function kindLabel(kind: string | null): string {
  if (!kind) return '—';
  return REQUEST_KIND_LABEL[kind as RequestKind] ?? kind;
}

const baseColumns: Column<ChangeRequest>[] = [
  {
    key: 'reqNo',
    header: 'Broj',
    render: (r) => <span className="tnums font-semibold text-ink">{r.reqNo}</span>,
  },
  {
    key: 'title',
    header: 'Naslov',
    render: (r) => <span className="text-ink">{r.title}</span>,
  },
  {
    key: 'module',
    header: 'Modul',
    render: (r) => <span className="text-ink-secondary">{r.module ?? '—'}</span>,
  },
  {
    key: 'kind',
    header: 'Tip',
    render: (r) => <span className="text-ink-secondary">{kindLabel(r.kind)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = statusMeta(r.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'score',
    header: 'Ocena',
    align: 'right',
    render: (r) => <ScoreCell r={r} />,
  },
  {
    key: 'reward',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.rewardAmount ? (
        <span className="tnums text-ink">{formatDecimal(r.rewardAmount)} RSD</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'createdAt',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.createdAt)}</span>,
  },
];

/**
 * Admin lista ima i kolonu podnosioca (row-scope ne krije od admina). Ime se čita iz mape
 * id→ime (GET /zahtevi/podnosioci); ako mapa još nije stigla, fallback je `#id`.
 */
function makeAdminColumns(nameById: Map<number, string>): Column<ChangeRequest>[] {
  return [
    ...baseColumns.slice(0, 5),
    {
      key: 'author',
      header: 'Podnosilac',
      render: (r) => (
        <span className="text-ink-secondary">
          {nameById.get(r.createdByUserId) ?? `#${r.createdByUserId}`}
        </span>
      ),
    },
    ...baseColumns.slice(5),
  ];
}

/**
 * Korisnički pogled „Moji zahtevi" — BEZ kolona „Ocena ★" i „Iznos" (tihi režim nagrada,
 * presuda 24.07: korisnici ne vide ocene/iznose). reqNo/naslov/modul/tip/status + datum.
 */
const myColumns: Column<ChangeRequest>[] = [
  ...baseColumns.slice(0, 5),
  ...baseColumns.slice(7),
];

type AdminTab = 'inbox' | 'all' | 'nagrade' | 'odluke' | 'archive';

const STATUS_FILTER_OPTIONS = ZAHTEV_STATUS.map((s) => ({
  value: s,
  label: statusMeta(s).label,
}));

export default function ZahteviPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const isAdmin = can(PERMISSIONS.ZAHTEVI_ADMIN);

  /**
   * Ekran skroluje SOPSTVENI okvir (`html,body{height:100%}` + `flex-1 overflow-auto`),
   * pa `window.scrollY` o njemu ne zna ništa, a `DataTable` nema `maxHeight` (nije
   * skrol-kontejner). Okvir se zato drži u stanju i predaje pogledu, koji jedini zna
   * filtere i redove. Callback ref (ne `useRef`): okvir se pojavljuje tek posle kapije
   * prijave, a dolazak mora da okine render.
   */
  const [okvir, setOkvir] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const startTourOnNovi = () => router.push('/zahtevi/novi?tour=1');

  return (
    <HelpProvider moduleKey="zahtevi" registry={HELP}>
    <AppShell>
      <PageHeader
        title="Zahtevi"
        actions={
          <div className="flex items-center gap-2">
            <HelpToggleButton onStartTour={isAdmin ? undefined : startTourOnNovi} />
            <Button onClick={() => router.push('/zahtevi/novi')}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi zahtev
            </Button>
          </div>
        }
      />
      <div ref={setOkvir} className="flex-1 space-y-4 overflow-auto p-6">
        <HelpBanner onStartTour={isAdmin ? undefined : startTourOnNovi} />
        {isAdmin ? <AdminView okvir={okvir} /> : <MyRequestsView okvir={okvir} />}
      </div>
      <HelpTour steps={isAdmin ? ADMIN_TOUR : []} />
    </AppShell>
    </HelpProvider>
  );
}

/**
 * MESTO U LISTI ZAHTEVA — zajedničko za oba pogleda.
 *
 * Skrol-okvir je strana, a ne tabela, pa ga vlasnik (`ZahteviPage`) predaje ovamo, gde su
 * filteri i redovi. `potpis` je ceo skup URL vrednosti (uključujući `tab` i `strana`):
 * promena bilo čega je drugi sadržaj i skrol tada treba da ide na vrh.
 * `straneUKesu: 1` je pošteno za serverski paginiranu listu — grana „odustani" se ne pali.
 */
function useSkrolZahteva({
  okvir,
  values,
  resolved,
  imaPodatke,
  redova,
  crtaSeLista = true,
}: {
  okvir: HTMLDivElement | null;
  values: Record<string, string>;
  resolved: boolean;
  imaPodatke: boolean;
  redova: number;
  /**
   * 🔴 `false` na tabovima koji NE crtaju listu zahteva (Nagrade, Odluke) — 07.08.2026.
   *
   * Upit liste ide bez obzira na tab, pa su `imaPodatke` i `redova` tačni i tamo gde
   * tabele nema. Restauracija se izvodi TAČNO JEDNOM (`resenoRef`): kad bi `spremno`
   * postalo `true` nad DOM-om tuđeg taba, jedina prilika da se vrati mesto potrošila bi
   * se u prazno, a upis bi preko zapisa prelio skrol tog drugog taba.
   */
  crtaSeLista?: boolean;
}) {
  const { okvirRef } = useZapamcenaPozicijaListe({
    kljuc: '/zahtevi',
    potpis: JSON.stringify(values),
    spremno: crtaSeLista && resolved && redova > 0,
    straneUKesu: crtaSeLista && imaPodatke ? 1 : 0,
    redova,
  });
  useEffect(() => {
    okvirRef(okvir);
  }, [okvir, okvirRef]);
}

/* ────────────────────────────────────────────────────── korisnik: „Moji zahtevi" */

function MyRequestsView({ okvir }: { okvir: HTMLDivElement | null }) {
  const router = useRouter();
  // Strana živi U URL-u — korisnik sa preko 50 zahteva se posle svakog otvorenog
  // detalja vraćao na stranu 1.
  const { values, resolved, setValues } = useListQueryState({ strana: '1' });
  const page = Math.max(1, Number(values.strana) || 1);
  // „Sve svoje" — bez filtera po statusu (korisnik ima malo zahteva); jednostavno.
  const list = useZahtevi({ page, pageSize: TAKE }, { enabled: resolved });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  useSkrolZahteva({ okvir, values, resolved, imaPodatke: !!list.data, redova: rows.length });

  // Tihi režim nagrada (presuda 24.07): korisnik NE vidi ocene/iznose — kartica „Moje
  // nagrade ovog meseca" i kolone Ocena/Iznos su uklonjene; obračun radi administrator.
  return (
    <>
      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <HelpSpot id="zahtevi.lista.kolone">
        <DataTable
          columns={myColumns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => router.push(`/zahtevi/detalj?id=${r.id}`)}
          loading={!resolved || list.isPending}
          empty={
            <EmptyState
              title="Nemate zahteva"
              hint={'Podnesite prvi zahtev — bug, dorada ili nova funkcija. Dugme „Novi zahtev" je gore desno.'}
            />
          }
        />
      </HelpSpot>

      {totalPages > 1 && (
        <Pager
          page={page}
          totalPages={totalPages}
          onPrev={() => setValues({ strana: String(Math.max(1, page - 1)) })}
          onNext={() => setValues({ strana: String(Math.min(totalPages, page + 1)) })}
        />
      )}
      <p className="text-2xs text-ink-secondary">
        Ukupno {formatNumber(total)} vaših zahteva.
      </p>
    </>
  );
}

/* ────────────────────────────────────────────────────────────── admin: tabovi */

const INBOX_STATUSES = ['SUBMITTED', 'ANALYZED', 'TESTING'] as const;

function AdminView({ okvir }: { okvir: HTMLDivElement | null }) {
  const router = useRouter();
  const can = useCan();
  const canDecisionsRead = can(PERMISSIONS.ZAHTEVI_DECISIONS_READ);
  const canDecisionsWrite = can(PERMISSIONS.ZAHTEVI_DECISIONS_WRITE);
  /**
   * CELO STANJE LISTE ŽIVI U URL-u (frontend/CLAUDE.md §12).
   *
   * Do 07.08.2026 je bilo sedam golih `useState`-ova, pa je povratak sa detalja
   * (remount strane) vraćao tab na Inbox i brisao status, modul, tip, podnosioca,
   * pretragu i stranu — doslovno „vrati me na početnu stranu" iz prijave vlasnika.
   *
   * Tab ide kroz `useListQueryState`, a NE kroz `useQueryTab`: `useQueryTab` piše
   * `history.replaceState` i ne upisuje u `sessionStorage`, pa ga `listHref` ne vidi;
   * uz to bi dva pisca istog URL-a gazila jedno drugo. `useQueryTab` je za module sa
   * podmenijem u sidebaru — `/zahtevi` ga nema. Presedan: `glavna-knjiga/page.tsx`.
   */
  const { values, resolved, setValues } = useListQueryState(STANJE_LISTE_ZAHTEVA);
  const tab = values.tab as AdminTab;
  const page = Math.max(1, Number(values.strana) || 1);
  const status = values.status;
  const module = values.modul;
  const kind = values.tip;
  const q = values.trazi;
  const createdBy = values.podnosilac;

  // Nacrt pretrage ostaje lokalan — u URL ide tek na Enter (isti obrazac kao `trazi`
  // na lageru), da adresa ne dobija unos po otkucanom karakteru.
  const [qInput, setQInput] = useState(values.trazi);
  useEffect(() => {
    setQInput(values.trazi);
  }, [values.trazi]);

  const inboxMeta = useInboxMeta(true);
  // Podnosioci (admin): opcije filtera + izvor imena za kolonu „Podnosilac".
  const podnosioci = usePodnosioci(true);
  const podnosiociRows = useMemo(() => podnosioci.data?.data ?? [], [podnosioci.data]);
  const podnosilacOptions = useMemo(
    () => podnosiociRows.map((p) => ({ value: String(p.id), label: `${p.name} (${p.count})` })),
    [podnosiociRows],
  );
  const nameById = useMemo(
    () => new Map(podnosiociRows.map((p) => [p.id, p.name])),
    [podnosiociRows],
  );
  const adminColumns = useMemo(() => makeAdminColumns(nameById), [nameById]);


  // Filter po tabu: Inbox = statusi koji čekaju admina; Arhiva = ARCHIVED; Svi = filteri.
  const effectiveStatus =
    tab === 'inbox'
      ? status || undefined // inbox: bez izbora = svi „čekajući" (klijentski filter dole)
      : tab === 'archive'
        ? 'ARCHIVED'
        : status || undefined;

  const list = useZahtevi(
    {
      page,
      pageSize: TAKE,
      status: effectiveStatus,
      module: module || undefined,
      kind: kind || undefined,
      q: q || undefined,
      // Filter po podnosiocu radi samo na tabu „Svi zahtevi" (tamo je i kontrola).
      createdBy: tab === 'all' && createdBy ? Number(createdBy) : undefined,
    },
    { enabled: resolved },
  );

  const allRows = list.data?.data ?? [];
  // Inbox bez izabranog statusa: prikaži samo redove u „čekajućim" statusima.
  const rows =
    tab === 'inbox' && !status
      ? allRows.filter((r) => (INBOX_STATUSES as readonly string[]).includes(r.status))
      : allRows;

  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  const counts = inboxMeta.data?.data.byStatus ?? {};
  const inboxTotal = inboxMeta.data?.data.total ?? 0;

  // Tabovi koji prikazuju listu zahteva (nagrade/odluke imaju svoj sadržaj).
  const isListTab = tab === 'inbox' || tab === 'all' || tab === 'archive';

  useSkrolZahteva({
    okvir,
    values,
    resolved,
    imaPodatke: !!list.data,
    redova: rows.length,
    crtaSeLista: isListTab,
  });

  function applySearch() {
    setValues({ trazi: qInput.trim(), strana: '1' });
  }
  function clearFilters() {
    setValues(PRAZNI_FILTERI_ZAHTEVA);
    setQInput('');
  }

  return (
    <>
      <HelpSpot id="zahtevi.admin.tabovi" variant="inline">
        <Tabs<AdminTab>
          ariaLabel="Prikaz zahteva"
          value={tab}
          // Promena taba čisti filtere (Inbox i „Svi" imaju različite kontrole), ali
          // mora u JEDNOM upisu: dva uzastopna `setValues` = dva `router.replace` i dva
          // zapisa u `sessionStorage`, pa bi Nazad pregledača prolazio kroz međustanje.
          onChange={(t) => {
            setValues({ ...PRAZNI_FILTERI_ZAHTEVA, tab: t });
            setQInput('');
          }}
          tabs={[
            { key: 'inbox', label: `Inbox${inboxTotal ? ` (${inboxTotal})` : ''}` },
            { key: 'all', label: 'Svi zahtevi' },
            { key: 'nagrade', label: 'Nagrade' },
            ...(canDecisionsRead
              ? ([{ key: 'odluke', label: 'Odluke' }] as const)
              : []),
            { key: 'archive', label: 'Arhiva' },
          ]}
        />
      </HelpSpot>

      {tab === 'nagrade' && <NagradeTab />}
      {tab === 'odluke' && canDecisionsRead && (
        <OdlukeTab canWrite={canDecisionsWrite} />
      )}

      {tab === 'inbox' && (
        <HelpSpot id="zahtevi.admin.inbox.kpi">
        <div className="flex flex-wrap gap-3">
          <KpiTile
            value={counts.SUBMITTED ?? 0}
            label="Podneti — čeka pregled"
            tone="warn"
            onClick={() => setValues({ status: 'SUBMITTED', strana: '1' })}
            active={status === 'SUBMITTED'}
          />
          <KpiTile
            value={counts.ANALYZED ?? 0}
            label="AI obrađen — čeka odluku"
            tone="warn"
            onClick={() => setValues({ status: 'ANALYZED', strana: '1' })}
            active={status === 'ANALYZED'}
          />
          <KpiTile
            value={counts.TESTING ?? 0}
            label="Na testiranju"
            tone="info"
            onClick={() => setValues({ status: 'TESTING', strana: '1' })}
            active={status === 'TESTING'}
          />
          {status && (
            <button
              onClick={() => setValues({ status: '', strana: '1' })}
              className="self-center rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Prikaži sve
            </button>
          )}
        </div>
        </HelpSpot>
      )}

      {tab === 'all' && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-52">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => setValues({ status: e.target.value, strana: '1' })}
                options={STATUS_FILTER_OPTIONS}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Modul
            <div className="w-44">
              <Select
                placeholder="Svi"
                value={module}
                onChange={(e) => setValues({ modul: e.target.value, strana: '1' })}
                options={moduleOptions()}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Tip
            <div className="w-44">
              <Select
                placeholder="Svi"
                value={kind}
                onChange={(e) => setValues({ tip: e.target.value, strana: '1' })}
                options={kindOptions}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Podnosilac
            <div className="w-56">
              <Select
                placeholder="Svi"
                value={createdBy}
                onChange={(e) => setValues({ podnosilac: e.target.value, strana: '1' })}
                options={podnosilacOptions}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Pretraga
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySearch();
              }}
              placeholder="Naslov, opis, broj…"
              className="h-9 w-56 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>
          {(status || module || kind || createdBy || q) && (
            <button
              onClick={clearFilters}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>
      )}

      {isListTab && list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      {isListTab && (
        <HelpSpot id="zahtevi.admin.tabela">
        <DataTable
          columns={adminColumns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => router.push(`/zahtevi/detalj?id=${r.id}`)}
          loading={!resolved || list.isPending}
          empty={
            <EmptyState
              title={tab === 'inbox' ? 'Inbox je prazan' : tab === 'archive' ? 'Arhiva je prazna' : 'Nema zahteva'}
              hint={
                tab === 'inbox'
                  ? 'Nema zahteva koji čekaju vašu odluku.'
                  : 'Promenite filtere ili sačekajte nove zahteve.'
              }
            />
          }
        />
        </HelpSpot>
      )}

      {isListTab && totalPages > 1 && tab !== 'inbox' && (
        <Pager
          page={page}
          totalPages={totalPages}
          onPrev={() => setValues({ strana: String(Math.max(1, page - 1)) })}
          onNext={() => setValues({ strana: String(Math.min(totalPages, page + 1)) })}
        />
      )}
      {isListTab && tab !== 'inbox' && (
        <p className="text-2xs text-ink-secondary">Ukupno {formatNumber(total)} zahteva.</p>
      )}
    </>
  );
}
