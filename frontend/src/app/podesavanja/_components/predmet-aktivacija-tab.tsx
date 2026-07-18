'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Star, Plus, X, ChevronUp, ChevronDown, History, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import {
  usePredmetAktivacija,
  usePredmetPrioritet,
  useTogglePredmet,
  useSetPredmetPrioritet,
  useSetPredmetPrioritetMax,
  usePredmetPrioritetPrev,
} from '@/api/podesavanja';

// ============================================================================
// Podešavanja → Podešavanje predmeta (WRITE — P11). Pun paritet 1.0
// `podesavanjePredmeta/{index,predmetiTable,napomenaModal}.js`.
//   • Aktivan / Projektovanje i montaža / Napomena → useTogglePredmet (POST /:itemId).
//     Checkbox se vizuelno preklopi u onChange; na uspeh invalidacija liste potvrđuje stanje,
//     na otkaz/grešku `bump()` forsira re-render → checkbox se vrati na server istinu.
//   • ⭐ prioritet (lista + max + „vrati prethodnu") → server istina (usePredmetPrioritet),
//     mutacije šalju CELU listu (swap/push). `prioBusy` ref = mutex protiv preklapanja.
// Gating na nivou page-a (SETTINGS_PREDMET_AKTIVACIJA = admin/menadzment); ovde bez dodatnog.
// ============================================================================

const PRIORITET_MAX_CEILING = 50;

type FilterKey = 'all' | 'prioritet' | 'active' | 'inactive';

/** Sirov red iz `list_predmet_aktivacija_admin()` (jsonb, snake_case; prosleđeno kroz BE). */
interface PredmetRowT {
  item_id: number;
  broj_predmeta: string | null;
  naziv_predmeta: string | null;
  customer_name: string | null;
  je_aktivan: boolean | null;
  je_projektovanje_montaza: boolean | null;
  azurirao_email: string | null;
  azurirano_at: string | null;
  napomena: string | null;
}

function num(v: unknown): number {
  return Number(v);
}
function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** Normalizuj BE odgovor (niz | { data: niz } | null) u tipizovane redove. */
function normalizeRows(raw: unknown): PredmetRowT[] {
  const arr = Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data ?? []);
  const list = Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
  return list.map((r) => ({
    item_id: num(r.item_id),
    broj_predmeta: (r.broj_predmeta as string) ?? null,
    naziv_predmeta: (r.naziv_predmeta as string) ?? null,
    customer_name: (r.customer_name as string) ?? null,
    je_aktivan: (r.je_aktivan as boolean) ?? false,
    je_projektovanje_montaza: (r.je_projektovanje_montaza as boolean) ?? false,
    azurirao_email: (r.azurirao_email as string) ?? null,
    azurirano_at: (r.azurirano_at as string) ?? null,
    napomena: (r.napomena as string) ?? null,
  }));
}

/** Poruka greške iz ApiError (skraćena) za toast. */
function saveErr(e: unknown): string {
  if (e instanceof ApiError) {
    const raw = (e.message || '').trim();
    if (raw) return raw.length > 180 ? `⚠ ${raw.slice(0, 180).trim()}…` : `⚠ ${raw}`;
  }
  return '⚠ Snimanje nije uspelo.';
}

export function PredmetAktivacijaTab() {
  const listQ = usePredmetAktivacija();
  const prioQ = usePredmetPrioritet();

  const toggleM = useTogglePredmet();
  const setPrioM = useSetPredmetPrioritet();
  const setMaxM = useSetPredmetPrioritetMax();
  const prevM = usePredmetPrioritetPrev();

  const rows = useMemo(() => normalizeRows(listQ.data?.data), [listQ.data]);
  const prioIds = prioQ.data?.data?.ids ?? [];
  const prioMax = prioQ.data?.data?.max ?? 10;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [maxInput, setMaxInput] = useState<string>('');
  const [napModal, setNapModal] = useState<{ id: number; initial: string; title: string } | null>(null);
  // Nonce: forsira reconciliaciju kontrolisanih checkbox-ova nazad na server istinu kada se
  // izmena otkaže/padne (native checkbox se vizuelno preklopi u onChange; bez re-rendera ostaje
  // razdešen jer se `checked` ne menja) — paritet 1.0 `input.checked = oldAkt`.
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);

  // Mutex: sprečava preklapanje prioritet operacija (toggle/gore/dole/max/prev) — kao 1.0 `_prioBusy`.
  const prioBusy = useRef(false);

  // ---- Filtriranje + sort (prioritetni prvi, po poziciji u listi) ----
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (filter === 'active' && !r.je_aktivan) return false;
      if (filter === 'inactive' && r.je_aktivan) return false;
      if (filter === 'prioritet' && !prioIds.includes(r.item_id)) return false;
      if (!q) return true;
      const sif = str(r.broj_predmeta).toLowerCase();
      const naz = str(r.naziv_predmeta).toLowerCase();
      return sif.includes(q) || naz.includes(q);
    });
    list.sort((a, b) => {
      const ia = prioIds.indexOf(a.item_id);
      const ib = prioIds.indexOf(b.item_id);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return 0;
    });
    return list;
  }, [rows, search, filter, prioIds]);

  const prioCount = prioIds.length;
  const canAddMore = prioCount < prioMax;

  // ---- Toggle aktivan ----
  async function onToggleAktivan(r: PredmetRowT, next: boolean) {
    const opis = [str(r.broj_predmeta) || `#${r.item_id}`, str(r.naziv_predmeta)].filter(Boolean).join(' — ');
    const upoz = next
      ? 'Predmet će ući u Plan proizvodnje i u listu u Praćenju proizvodnje (uz ostala podešavanja).'
      : 'Predmet će biti uklonjen iz Plana proizvodnje i iz liste u Praćenju proizvodnje, bez brisanja podataka u bazi.';
    const akcija = next ? 'aktivirate' : 'deaktivirate';
    if (!confirm(`Da li ste sigurni da želite da ${akcija} predmet?\n\n${opis}\n\n${upoz}\n\nNastaviti?`)) {
      bump(); // vrati vizuelno preklopljen checkbox na server istinu
      return;
    }
    try {
      await toggleM.mutateAsync({ itemId: r.item_id, aktivan: next });
      toast('Sačuvano');
    } catch (e) {
      bump();
      toast(saveErr(e)); // lista se ponovo dovlači invalidacijom → rollback na server istinu
    }
  }

  // ---- Toggle projektovanje/montaža ----
  async function onToggleProj(r: PredmetRowT, next: boolean) {
    const opis = [str(r.broj_predmeta) || `#${r.item_id}`, str(r.naziv_predmeta)].filter(Boolean).join(' — ');
    const akcija = next ? 'uključite' : 'isključite';
    if (
      !confirm(
        `Da li želite da ${akcija} predmet za projektovanje i montažu?\n\n${opis}\n\n` +
          'Samo ručno uključeni predmeti ulaze u te preglede (uz kolonu Aktivan).\n\nNastaviti?',
      )
    ) {
      bump();
      return;
    }
    try {
      // `aktivan` se MORA slati (RPC uvek prepisuje je_aktivan) — šaljemo tekuću vrednost
      // reda; menja se samo projektovanje-flag (paritet 1.0 predmetiTable).
      await toggleM.mutateAsync({ itemId: r.item_id, aktivan: !!r.je_aktivan, projektovanjeMontaza: next });
      toast('Sačuvano');
    } catch (e) {
      bump();
      toast(saveErr(e));
    }
  }

  // ---- Napomena (modal): '' = obriši, string = postavi ----
  async function saveNapomena(id: number, text: string) {
    try {
      // `aktivan` obavezan (RPC prepisuje je_aktivan) — očitaj tekuću vrednost reda.
      const cur = rows.find((x) => x.item_id === id)?.je_aktivan ?? false;
      await toggleM.mutateAsync({ itemId: id, aktivan: !!cur, napomena: text });
      toast('Sačuvano');
      setNapModal(null);
    } catch (e) {
      toast(saveErr(e));
    }
  }

  // ---- Prioritet: cela lista se šalje (swap/push). Mutex protiv preklapanja. ----
  async function commitPrio(nextIds: number[], msg?: string) {
    if (prioBusy.current) return;
    prioBusy.current = true;
    try {
      await setPrioM.mutateAsync({ itemIds: nextIds });
      if (msg) toast(msg);
    } catch (e) {
      toast(saveErr(e)); // invalidacija vraća server istinu
    } finally {
      prioBusy.current = false;
    }
  }

  function addPrio(r: PredmetRowT) {
    if (prioBusy.current) return;
    if (prioIds.includes(r.item_id)) return;
    if (prioIds.length >= prioMax) {
      toast(`Lista prioriteta je puna (max ${prioMax}). Ukloni neki ili povećaj „Maks".`);
      return;
    }
    void commitPrio([...prioIds, r.item_id], `⭐ Dodat u prioritet: ${str(r.broj_predmeta) || r.item_id}`);
  }
  function removePrio(r: PredmetRowT) {
    if (prioBusy.current) return;
    void commitPrio(
      prioIds.filter((x) => x !== r.item_id),
      `Uklonjen iz prioriteta: ${str(r.broj_predmeta) || r.item_id}`,
    );
  }
  function moveUp(id: number) {
    if (prioBusy.current) return;
    const ix = prioIds.indexOf(id);
    if (ix <= 0) return;
    const next = prioIds.slice();
    [next[ix - 1], next[ix]] = [next[ix], next[ix - 1]];
    void commitPrio(next);
  }
  function moveDown(id: number) {
    if (prioBusy.current) return;
    const ix = prioIds.indexOf(id);
    if (ix < 0 || ix >= prioIds.length - 1) return;
    const next = prioIds.slice();
    [next[ix], next[ix + 1]] = [next[ix + 1], next[ix]];
    void commitPrio(next);
  }

  async function saveMax() {
    if (prioBusy.current) return;
    const n = Math.trunc(Number(maxInput));
    if (!Number.isFinite(n) || n < 1 || n > PRIORITET_MAX_CEILING) {
      toast(`Unesi broj između 1 i ${PRIORITET_MAX_CEILING}.`);
      return;
    }
    if (n === prioMax) {
      toast('Maksimum je već postavljen na tu vrednost.');
      return;
    }
    prioBusy.current = true;
    try {
      await setMaxM.mutateAsync({ max: n });
      toast(`Maksimum prioriteta: ${n}`);
      setMaxInput('');
    } catch (e) {
      toast(saveErr(e));
    } finally {
      prioBusy.current = false;
    }
  }

  async function restorePrev() {
    if (prioBusy.current) return;
    prioBusy.current = true;
    try {
      const res = await prevM.mutateAsync();
      const prev = (res?.data?.ids ?? []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
      if (!prev.length) {
        toast('Nema prethodne sačuvane liste u istoriji.');
        return;
      }
      const names = prev
        .map((id, i) => {
          const r = rows.find((x) => x.item_id === id);
          return `${i + 1}. ${r ? str(r.broj_predmeta) || id : id}`;
        })
        .join('\n');
      if (!confirm(`Vratiti prethodnu listu prioriteta (${prev.length})?\n\n${names}\n\nTrenutna lista će biti zamenjena.`)) {
        return;
      }
      await setPrioM.mutateAsync({ itemIds: prev });
      toast('↩ Prethodna lista prioriteta je vraćena');
    } catch (e) {
      toast(saveErr(e));
    } finally {
      prioBusy.current = false;
    }
  }

  // ------------------------------------------------------------------ render

  if (listQ.isLoading) {
    return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;
  }
  if (listQ.isError) {
    return (
      <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-ink">
        Lista predmeta trenutno nije dostupna (mreža ili server). Pokušajte ponovo za nekoliko trenutaka.
      </div>
    );
  }

  const busy = setPrioM.isPending || setMaxM.isPending || prevM.isPending;

  return (
    <div className="space-y-3">
      {/* Uvodna napomena — paritet 1.0 form-hint */}
      <div>
        <h2 className="text-md font-semibold text-ink">Podešavanje predmeta</h2>
        <p className="mt-1 max-w-4xl text-xs text-ink-secondary">
          Kolona <strong className="text-ink">Aktivan</strong> kontroliše Plan proizvodnje i Praćenje proizvodnje. Kolona{' '}
          <strong className="text-ink">Projektovanje i montaža</strong> filtrira prikaz u modulima projektovanja i plana montaže — vide se samo
          predmeti koji su Aktivan i ovde ručno uključeni. Za projektovanje/montažu svi predmeti su podrazumevano isključeni; uključite samo one
          koje želite. Za Plan i Praćenje novi predmeti iz BigTehn cache-a i dalje dolaze kao aktivni dok ih ne isključite u koloni Aktivan.
        </p>
      </div>

      {/* Traka: brojači + max + vrati prethodnu */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <span className="rounded bg-surface-2 px-2 py-1">
          {visible.length} prikazano / {rows.length} ukupno
        </span>
        <span className="inline-flex items-center gap-1">
          Top prioritet:{' '}
          <strong className="text-accent">
            {prioCount}/{prioMax}
          </strong>
          {!canAddMore && <span> — lista popunjena</span>}
        </span>
        <span className="inline-flex items-center gap-1.5" title={`Maksimalan broj prioritetnih predmeta (1–${PRIORITET_MAX_CEILING})`}>
          Maks:
          <Input
            type="number"
            min={1}
            max={PRIORITET_MAX_CEILING}
            step={1}
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
            placeholder={String(prioMax)}
            className="h-8 w-16 px-2 text-center"
            disabled={busy}
          />
          <Button variant="secondary" onClick={() => void saveMax()} loading={setMaxM.isPending} className="h-8 px-3 text-sm">
            Sačuvaj
          </Button>
        </span>
        <Button
          variant="secondary"
          onClick={() => void restorePrev()}
          loading={prevM.isPending}
          disabled={busy}
          className="ml-auto h-8 gap-1.5 px-3 text-sm"
          title="Vrati prethodnu sačuvanu listu prioriteta (iz istorije)"
        >
          <History className="h-3.5 w-3.5" aria-hidden /> Vrati prethodnu listu
        </Button>
      </div>

      {/* Pretraga + filter */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Šifra ili naziv…"
          className="max-w-60"
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as FilterKey)}
          className="h-9 max-w-48 rounded-control border border-line bg-surface px-3 text-base text-ink focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          <option value="all">Svi predmeti</option>
          <option value="prioritet">Samo prioritet</option>
          <option value="active">Aktivni</option>
          <option value="inactive">Neaktivni</option>
        </select>
      </div>

      {/* Tabela */}
      {visible.length === 0 ? (
        <EmptyState title="Nema redova za filter." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="w-10 px-2 py-2 text-center" title="Prioritet (prikazuju se prvi u svim pregledima)">
                  <Star className="mx-auto h-3.5 w-3.5" aria-hidden />
                </th>
                <th className="px-3 py-2">Šifra</th>
                <th className="px-3 py-2">Naziv</th>
                <th className="px-3 py-2">Komitent</th>
                <th className="w-16 px-2 py-2 text-center">Aktivan</th>
                <th className="w-28 px-2 py-2 text-center leading-tight" title="Vidljivost u modulima projektovanja i plana montaže (uz Aktivan)">
                  Projektovanje
                  <br />i montaža
                </th>
                <th className="px-3 py-2">Poslednja izmena</th>
                <th className="px-3 py-2">Napomena</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const pos = prioIds.indexOf(r.item_id);
                const inPrio = pos !== -1;
                return (
                  <tr
                    key={r.item_id}
                    className={`border-b border-line-soft hover:bg-surface-2 ${inPrio ? 'bg-accent-subtle/40' : ''}`}
                  >
                    {/* prioritet ćelija */}
                    <td className="px-2 py-1.5 align-middle text-center">
                      {inPrio ? (
                        <div className="flex items-center justify-center gap-1">
                          <span className="min-w-4 text-2xs font-bold text-accent">{pos + 1}</span>
                          <span className="flex flex-col">
                            <IconBtn label="Pomeri gore" disabled={pos === 0 || busy} onClick={() => moveUp(r.item_id)}>
                              <ChevronUp className="h-3 w-3" />
                            </IconBtn>
                            <IconBtn label="Pomeri dole" disabled={pos === prioIds.length - 1 || busy} onClick={() => moveDown(r.item_id)}>
                              <ChevronDown className="h-3 w-3" />
                            </IconBtn>
                          </span>
                          <IconBtn label="Ukloni iz prioriteta" tone="danger" disabled={busy} onClick={() => removePrio(r)}>
                            <X className="h-3 w-3" />
                          </IconBtn>
                        </div>
                      ) : (
                        <div className="flex justify-center">
                          <IconBtn label="Dodaj u prioritet" disabled={busy} onClick={() => addPrio(r)}>
                            <Plus className="h-3.5 w-3.5" />
                          </IconBtn>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-ink">{str(r.broj_predmeta)}</td>
                    <td className="px-3 py-1.5 text-ink">{str(r.naziv_predmeta)}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{str(r.customer_name)}</td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!r.je_aktivan}
                        disabled={toggleM.isPending}
                        onChange={(e) => void onToggleAktivan(r, e.target.checked)}
                        aria-label="Aktivan"
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={!!r.je_projektovanje_montaza}
                        disabled={toggleM.isPending}
                        onChange={(e) => void onToggleProj(r, e.target.checked)}
                        aria-label="Projektovanje i montaža"
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-xs text-ink-secondary">
                      {str(r.azurirao_email) || '—'}
                      <br />
                      <span className="text-ink-disabled">{formatDateTime(r.azurirano_at)}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => setNapModal({ id: r.item_id, initial: str(r.napomena), title: 'Napomena za predmet' })}
                        className="inline-flex max-w-60 items-center gap-1.5 truncate rounded-control border border-line bg-surface px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
                        title="Izmeni napomenu"
                      >
                        <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">{str(r.napomena).trim() || '—'}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legenda prioriteta */}
      {prioCount > 0 && (
        <div className="rounded-panel border border-line bg-surface-2 px-3.5 py-2.5">
          <div className="mb-1.5 text-2xs font-bold uppercase tracking-wide text-ink-secondary">
            Prioritetni redosled (prikazuje se u svim pregledima)
          </div>
          <div className="flex flex-wrap gap-2">
            {prioIds.map((id, i) => {
              const r = rows.find((x) => x.item_id === id);
              if (!r) return null;
              return (
                <span key={id} className="text-xs text-ink-secondary">
                  {i + 1}. {str(r.broj_predmeta)} {str(r.naziv_predmeta)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Napomena modal */}
      <NapomenaModal state={napModal} onClose={() => setNapModal(null)} onSave={saveNapomena} saving={toggleM.isPending} />
    </div>
  );
}

/** Mala ikona-dugme za prioritet ćeliju (gore/dole/dodaj/ukloni). */
function IconBtn({
  children,
  label,
  onClick,
  disabled,
  tone,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid h-5 w-5 place-items-center rounded text-ink-secondary hover:bg-surface-2 disabled:opacity-30 ${
        tone === 'danger' ? 'hover:text-status-danger' : 'hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/** Modal za napomenu — prazno = OBRIŠI ('' → clear), tekst = postavi (paritet 1.0 napomenaModal). */
function NapomenaModal({
  state,
  onClose,
  onSave,
  saving,
}: {
  state: { id: number; initial: string; title: string } | null;
  onClose: () => void;
  onSave: (id: number, text: string) => void;
  saving: boolean;
}) {
  return (
    <Dialog open={!!state} onClose={onClose} title={state?.title ?? 'Napomena'}>
      {/* Telo (textarea + dugmad) je keyed po id-u → svaki otvor seeduje početnu vrednost. */}
      {state && <NapomenaBody key={state.id} state={state} onClose={onClose} onSave={onSave} saving={saving} />}
    </Dialog>
  );
}

/**
 * Telo modala — samostalno drži tekst (seeduje se početnom napomenom kroz `key` re-mount).
 * Save šalje trim-ovan tekst: '' briše napomenu, string je postavlja (RPC razlikuje keep/clear).
 */
function NapomenaBody({
  state,
  onClose,
  onSave,
  saving,
}: {
  state: { id: number; initial: string };
  onClose: () => void;
  onSave: (id: number, text: string) => void;
  saving: boolean;
}) {
  const [v, setV] = useState(state.initial);
  return (
    <div className="space-y-4">
      <Textarea
        autoFocus
        rows={4}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Slobodan tekst… (prazno briše napomenu)"
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Otkaži
        </Button>
        <Button onClick={() => onSave(state.id, v.trim())} loading={saving}>
          Sačuvaj
        </Button>
      </div>
    </div>
  );
}
