'use client';

// Izveštaji montera — lista + detalj + create-wizard + „Poveži predmet" (increment 4).
// Paritet 1.0 izvestajiView.js: grupisanje po predmetu (default), inline foto galerija,
// meta linija „Sačuvano · model", Osveži + debounce pretraga.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileDown, Layers, Link2, Plus, RefreshCw, Table2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDmy } from '@/lib/plan-montaze/date';
import { IZVESTAJ_STATUS, IZVESTAJ_STATUS_TONE, IZVESTAJ_AI_MODELI } from '@/lib/plan-montaze/constants';
import {
  useMontazaReports,
  useMontazaReport,
  useLinkPredmet,
  useMontazaAiModel,
  useSetMontazaAiModel,
  fetchPhotoSignedUrl,
  fetchReportPdfUrl,
  type IzvestajRow,
} from '@/api/plan-montaze';
import { IzvestajWizard } from './izvestaj-wizard';
import { PredmetPicker } from './predmet-picker';

const STATUS_FILTERS = [
  { key: '', label: 'Svi' },
  ...Object.entries(IZVESTAJ_STATUS).map(([key, label]) => ({ key, label })),
];

function statusBadge(code: string) {
  return <StatusBadge tone={IZVESTAJ_STATUS_TONE[code] ?? 'neutral'} label={IZVESTAJ_STATUS[code] ?? code} />;
}

/* ── Grupisanje po BigTehn predmetu (paritet 1.0 groupedListHtml) ── */

/** Lista može (ali ne mora) nositi predmet_item_id — koristi ga za ključ kad postoji. */
type RowMaybePredmetId = IzvestajRow & { predmet_item_id?: number | null };

interface PredmetGrupa {
  key: string;
  hasPredmet: boolean;
  broj: string;
  naziv: string;
  klijent: string;
  items: IzvestajRow[];
}

/** Grupiši izveštaje po predmetu; grupe sa predmetom prve (sort po broju), „bez predmeta" poslednja. */
function groupByPredmet(rows: IzvestajRow[]): PredmetGrupa[] {
  const groups = new Map<string, PredmetGrupa>();
  for (const r of rows as RowMaybePredmetId[]) {
    const key =
      r.predmet_item_id != null ? `id:${r.predmet_item_id}` : r.predmet_broj ? `broj:${r.predmet_broj}` : 'none';
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        hasPredmet: key !== 'none',
        broj: r.predmet_broj ?? '',
        naziv: r.naziv_projekta ?? '',
        klijent: r.klijent ?? '',
        items: [],
      };
      groups.set(key, g);
    }
    g.items.push(r);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.hasPredmet !== b.hasPredmet) return a.hasPredmet ? -1 : 1;
    return a.broj.localeCompare(b.broj, 'sr', { numeric: true });
  });
}

export function IzvestajiTab() {
  const canCreate = useCan()(PERMISSIONS.MONTAZA_IZVESTAJI);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [grouped, setGrouped] = useState(true); // 1.0 default = po projektu
  const debounceRef = useRef<number | null>(null);

  const list = useMontazaReports({ q: q || undefined, status: status || undefined });
  const rows = useMemo(() => list.data?.data ?? [], [list.data]);
  const groups = useMemo(() => (grouped ? groupByPredmet(rows) : []), [grouped, rows]);

  // Debounce pretrage (~300ms) — tek smiren unos ide u query key.
  function onSearch(v: string) {
    setQInput(v);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setQ(v), 300);
  }
  useEffect(
    () => () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    },
    [],
  );

  if (mode === 'create') return <IzvestajWizard onClose={() => setMode('list')} />;

  const cols: Column<IzvestajRow>[] = [
    {
      key: 'broj',
      header: 'Broj',
      render: (r) => <span className="tnums font-medium text-ink">{r.broj_izvestaja || '—'}</span>,
    },
    {
      key: 'datum',
      header: 'Datum',
      render: (r) => <span className="tnums text-ink-secondary">{formatDmy(r.datum_rada) || '—'}</span>,
    },
    {
      key: 'predmet',
      header: 'Predmet / projekat',
      render: (r) => (
        <span className="text-ink">
          {r.predmet_broj ? <span className="tnums font-medium">{r.predmet_broj}</span> : null}
          {r.predmet_broj && r.naziv_projekta ? ' · ' : ''}
          <span className="text-ink-secondary">{r.naziv_projekta || (r.predmet_broj ? '' : '—')}</span>
        </span>
      ),
    },
    { key: 'klijent', header: 'Klijent', render: (r) => r.klijent || '—' },
    { key: 'lokacija', header: 'Lokacija', render: (r) => r.lokacija || '—' },
    { key: 'autor', header: 'Autor', render: (r) => <span className="text-ink-secondary">{r.autor_ime || '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => statusBadge(r.status) },
  ];

  const empty = (
    <EmptyState
      title={list.isError ? 'Greška pri učitavanju' : 'Nema izveštaja'}
      hint={
        list.isError
          ? 'Pokušajte ponovo ili proverite prijavu.'
          : 'Kad monteri počnu da unose izveštaje, pojaviće se ovde.'
      }
    />
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={qInput}
          onChange={onSearch}
          placeholder="Broj, predmet, projekat, klijent, lokacija, autor…"
        />
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatus(f.key)}
              className={
                status === f.key
                  ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setGrouped((g) => !g)}
          title="Prikaz"
          className="flex items-center gap-1 rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2"
        >
          {grouped ? <Layers className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
          {grouped ? 'Po projektu' : 'Lista'}
        </button>
        <button
          type="button"
          onClick={() => void list.refetch()}
          title="Osveži"
          aria-label="Osveži"
          className="flex items-center rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2"
        >
          <RefreshCw className={list.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden />
        </button>
        <span className="ml-auto text-sm text-ink-secondary">{rows.length} izveštaja</span>
        <AiModelControl />
        {canCreate && (
          <Button onClick={() => setMode('create')}>
            <Plus className="h-4 w-4" aria-hidden /> Novi izveštaj
          </Button>
        )}
      </div>

      {grouped ? (
        list.isLoading ? (
          <div className="p-3 text-sm text-ink-secondary">Učitavanje…</div>
        ) : rows.length === 0 ? (
          empty
        ) : (
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.key} className="overflow-hidden rounded-control border border-line">
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
                  <span className="text-sm font-medium text-ink">
                    {g.hasPredmet ? (
                      <>
                        <span className="tnums">{g.broj || '(bez broja)'}</span>
                        {g.naziv ? <span> — {g.naziv}</span> : null}
                      </>
                    ) : (
                      'Bez predmeta / projekta'
                    )}
                  </span>
                  {g.klijent && <span className="text-xs text-ink-secondary">{g.klijent}</span>}
                  <span className="tnums ml-auto rounded-full border border-line bg-surface px-2 py-0.5 text-xs text-ink-secondary">
                    {g.items.length}
                  </span>
                </div>
                <div className="divide-y divide-line">
                  {g.items.map((r) => (
                    <div key={r.id}>
                      <button
                        type="button"
                        onClick={() => setOpenId((cur) => (cur === r.id ? null : r.id))}
                        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left text-sm hover:bg-surface-2"
                      >
                        {openId === r.id ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
                        )}
                        <span className="tnums font-medium text-ink">{r.broj_izvestaja || '—'}</span>
                        <span className="text-ink-disabled">·</span>
                        <span className="tnums text-ink-secondary">{formatDmy(r.datum_rada) || '—'}</span>
                        {r.lokacija && (
                          <>
                            <span className="text-ink-disabled">·</span>
                            <span className="text-ink-secondary">{r.lokacija}</span>
                          </>
                        )}
                        {r.autor_ime && (
                          <>
                            <span className="text-ink-disabled">·</span>
                            <span className="text-ink-secondary">{r.autor_ime}</span>
                          </>
                        )}
                        <span className="ml-auto">{statusBadge(r.status)}</span>
                      </button>
                      {openId === r.id && (
                        <div className="border-t border-line">
                          <IzvestajDetalj id={r.id} row={r} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowActivate={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
          expandedKey={openId}
          renderExpanded={(r) => <IzvestajDetalj id={r.id} row={r} />}
          empty={empty}
        />
      )}
    </div>
  );
}

/** Detalj izveštaja: puni tekst + inline foto galerija (signed URL-ovi) + PDF + poveži predmet. */
function IzvestajDetalj({ id, row }: { id: string; row: IzvestajRow }) {
  const canManage = useCan()(PERMISSIONS.MONTAZA_IZVESTAJI);
  const detail = useMontazaReport(id);
  const link = useLinkPredmet();
  const d = detail.data?.data;
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Inline galerija: čim detalj stigne, potpiši URL-ove SVIH fotki (privatni bucket).
  // null = još učitava; zapis sa null vrednošću = potpis pao (fallback dugme).
  const fotke = d?.fotke;
  const [fotoUrls, setFotoUrls] = useState<Record<string, string | null> | null>(null);
  useEffect(() => {
    if (!fotke?.length) return;
    let alive = true;
    void Promise.all(
      fotke.map(async (f) => {
        try {
          const res = await fetchPhotoSignedUrl(f.id);
          return [f.id, res.data?.url ?? null] as const;
        } catch {
          return [f.id, null] as const;
        }
      }),
    ).then((pairs) => {
      if (alive) setFotoUrls(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [fotke]);

  async function openPhoto(photoId: string) {
    setBusy(photoId);
    try {
      const res = await fetchPhotoSignedUrl(photoId);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } finally {
      setBusy(null);
    }
  }

  async function openPdf() {
    setBusy('pdf');
    try {
      const res = await fetchReportPdfUrl(id);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } finally {
      setBusy(null);
    }
  }

  if (detail.isLoading) return <div className="p-3 text-sm text-ink-secondary">Učitavanje detalja…</div>;
  if (detail.isError || !d) return <div className="p-3 text-sm text-status-danger">Greška pri učitavanju detalja.</div>;

  const clanovi = Array.isArray(d.dodatniClanovi) ? d.dodatniClanovi : [];
  const aiModel = d.aiModel ?? row.ai_model;

  async function linkPredmet(sel: { predmet_item_id: number; predmet_broj: string; naziv_projekta: string; klijent: string } | null) {
    await link.mutateAsync({
      id,
      predmetItemId: sel ? sel.predmet_item_id : null,
      predmetBroj: sel?.predmet_broj,
      nazivProjekta: sel?.naziv_projekta,
      klijent: sel?.klijent,
    });
  }

  return (
    <div className="space-y-3 p-2">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1 text-sm">
        <Meta label="Predmet / projekat" value={[d.predmetBroj, d.nazivProjekta].filter(Boolean).join(' — ') || '—'} />
        <Meta label="Rad od–do" value={[d.pocetakRada, d.krajRada].filter(Boolean).join(' – ') || '—'} />
        <Meta label="Klijent" value={d.klijent || '—'} />
        <Meta label="Lokacija" value={d.lokacija || '—'} />
        {clanovi.length > 0 && <Meta label="Dodatni članovi" value={clanovi.join(', ')} />}
        {canManage && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="flex items-center gap-1 self-end rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden /> Poveži / ispravi predmet
          </button>
        )}
      </div>

      <Section title="Opis radova" text={d.opisRadova} />
      <Section title="Problemi" text={d.problemi} />
      <Section title="Otvorene stavke" text={d.otvoreneStavke} />

      {d.fotke.length > 0 && (
        <div>
          <div className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">
            Foto-dokumentacija ({d.fotke.length})
          </div>
          <div className="mt-1 flex flex-wrap gap-3">
            {d.fotke.map((f) => {
              const url = fotoUrls?.[f.id];
              return (
                <figure key={f.id} className="w-36">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" title={f.opis ?? undefined}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={`Foto ${f.redniBroj}`}
                        className="h-28 w-36 rounded-control border border-line object-cover"
                      />
                    </a>
                  ) : fotoUrls ? (
                    // Potpisivanje palo — fallback: dugme koje pokuša ponovo na klik.
                    <button
                      type="button"
                      onClick={() => void openPhoto(f.id)}
                      disabled={busy === f.id}
                      className="grid h-28 w-36 place-items-center rounded-control border border-line text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
                      title={f.opis ?? undefined}
                    >
                      Foto {f.redniBroj}
                    </button>
                  ) : (
                    <div className="grid h-28 w-36 place-items-center rounded-control border border-line bg-surface-2 text-xs text-ink-disabled">
                      Učitavam…
                    </div>
                  )}
                  <figcaption className="mt-0.5 truncate text-xs text-ink-secondary" title={f.opis ?? undefined}>
                    {f.redniBroj}. {f.opis || ''}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      )}

      {(d.pdfPath || row.pdf_path) && (
        <div className="flex justify-end pt-1">
          <Button variant="secondary" onClick={openPdf} loading={busy === 'pdf'} className="h-8 px-3 text-sm">
            <FileDown className="h-4 w-4" aria-hidden /> Otvori PDF
          </Button>
        </div>
      )}

      {row.sirovi_tekst && (
        <details className="text-xs text-ink-secondary">
          <summary className="cursor-pointer select-none">Sirovi tekst (pre AI obrade)</summary>
          <p className="mt-1 whitespace-pre-wrap">{row.sirovi_tekst}</p>
        </details>
      )}

      <div className="text-xs text-ink-disabled">
        Sačuvano: {formatDmy(d.createdAt) || '—'}
        {aiModel ? ` · model: ${aiModel}` : ''}
      </div>

      {canManage && (
        <PredmetPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(sel) => void linkPredmet(sel)}
          onClear={() => void linkPredmet(null)}
        />
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</div>
      <div className="text-ink">{value}</div>
    </div>
  );
}

/** AI model za strukturiranje izveštaja — admin-only izbor (montaza.ai_admin). */
function AiModelControl() {
  const isAdmin = useCan()(PERMISSIONS.MONTAZA_AI_ADMIN);
  const model = useMontazaAiModel();
  const setModel = useSetMontazaAiModel();
  if (!isAdmin) return null;
  const current = model.data?.data?.model ?? '';
  return (
    <label className="flex items-center gap-1 text-xs text-ink-secondary" title="AI model za strukturiranje izveštaja">
      AI:
      <select
        value={current}
        disabled={model.isLoading || setModel.isPending}
        onChange={(e) => setModel.mutate(e.target.value)}
        className="h-8 rounded-control border border-line bg-surface px-1.5 text-xs text-ink disabled:opacity-60"
      >
        {!current && <option value="">—</option>}
        {IZVESTAJ_AI_MODELI.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </label>
  );
}

function Section({ title, text }: { title: string; text: string | null }) {
  if (!text?.trim()) return null;
  return (
    <div>
      <div className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{title}</div>
      <p className="whitespace-pre-wrap text-sm text-ink">{text}</p>
    </div>
  );
}
