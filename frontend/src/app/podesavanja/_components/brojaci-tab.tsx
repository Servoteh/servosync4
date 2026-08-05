'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Pencil } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import {
  useDocumentSequences,
  useSetLastNumber,
  type SequenceRow,
} from '@/api/podesavanja';

/**
 * PODEŠAVANJA → BROJAČI DOKUMENATA (odluka O-F11, 05.08.2026).
 * ============================================================================
 * Vlasnik, doslovno: *„Startni broj moramo da možemo da unesemo negde u podešavanju.
 * U BigBitu sada npr. dupli klik na broj i nosiš podešavanje zadnjeg broja — i IFR i
 * profaktura i ponuda itd."*
 *
 * Zato je DUPLI KLIK NA BROJ ravnopravan ulaz u izmenu, pored dugmeta: to je navika
 * koju knjigovođa donosi iz BigBita, i jedini razlog zašto je baš tu. Dugme postoji
 * uz njega jer dupli klik ne postoji na dodirnom ekranu i nevidljiv je čitaču ekrana.
 *
 * ŠTA SE OVDE ZAPRAVO PROVERAVA: ne `last_number`, nego kolona **„Sledeći broj"** —
 * čovek prepoznaje `PROF-12/26`, ne „11". Zato je ta kolona istaknuta, a `last_number`
 * stoji pored nje kao vrednost koja se unosi.
 */
export function BrojaciTab() {
  const [year, setYear] = useState<number | undefined>(undefined);
  const q = useDocumentSequences(year);
  const [edit, setEdit] = useState<SequenceRow | null>(null);

  const rows = q.data?.data.rows ?? [];
  const years = q.data?.data.years ?? [];
  const trail = q.data?.data.trail ?? [];

  // Serije su stabilan spisak iz koda (5), godine se menjaju — grupisanje po godini
  // drži zajedno ono što se zajedno i podešava (cela godina pri preuzimanju).
  const byYear = useMemo(() => {
    const m = new Map<number, SequenceRow[]>();
    for (const r of rows) m.set(r.year, [...(m.get(r.year) ?? []), r]);
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [rows]);

  const upozorenja = rows.filter((r) => r.warning);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-md font-semibold text-ink">Brojači dokumenata</h2>
        <p className="mt-0.5 text-xs text-ink-secondary">
          Od kog broja kreće svaka serija. Upisuje se <strong>poslednji izdati</strong> broj —
          sledeći dokument dobija prvi sledeći. Postavlja se jednom, pri preuzimanju posla iz
          BigBita; svaka nova godina posle toga kreće od 1 bez ijednog unosa.
        </p>
      </div>

      {/* Upozorenja na vrhu: brojač ispod knjige je jedina stvar zbog koje se ovaj
          ekran otvara vanredno, pa ne sme da se traži po tabeli. */}
      {upozorenja.length > 0 && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-danger" />
            <div className="space-y-1 text-sm text-status-danger">
              {upozorenja.map((r) => (
                <p key={`${r.seriesKey}-${r.year}`}>
                  <strong>
                    {r.seriesLabel} {r.year}.
                  </strong>{' '}
                  {r.warning}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px]">
          <FormField label="Godina">
            <Select
              value={year != null ? String(year) : ''}
              placeholder="Sve godine"
              options={years.map((y) => ({ value: String(y), label: `${y}.` }))}
              onChange={(e) => setYear(e.target.value ? Number(e.target.value) : undefined)}
            />
          </FormField>
        </div>
      </div>

      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : (
        byYear.map(([y, serije]) => (
          <div key={y} className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">{y}.</h3>
            <div className="overflow-x-auto rounded-panel border border-line bg-surface">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                    <th className="px-3 py-2">Serija</th>
                    <th className="px-3 py-2">Vrste dokumenata</th>
                    <th className="px-3 py-2 text-right">Poslednji izdati</th>
                    <th className="px-3 py-2">Sledeći broj</th>
                    <th className="px-3 py-2">U knjizi već postoji</th>
                    <th className="px-3 py-2">Poslednja izmena</th>
                    <th className="px-3 py-2 text-right">Akcije</th>
                  </tr>
                </thead>
                <tbody>
                  {serije.map((r) => (
                    <tr
                      key={`${r.seriesKey}-${r.year}`}
                      className="border-b border-line-soft hover:bg-surface-2"
                      // Navika iz BigBita: „dupli klik na broj i nosiš podešavanje
                      // zadnjeg broja". Dugme desno radi isto — dupli klik ne postoji
                      // na dodirnom ekranu.
                      onDoubleClick={() => setEdit(r)}
                      title="Dupli klik otvara izmenu poslednjeg broja"
                    >
                      <td className="px-3 py-2 font-medium text-ink">{r.seriesLabel}</td>
                      <td className="px-3 py-2 text-2xs text-ink-secondary">
                        {r.documentTypes.join(', ')}
                        {r.prefix ? ` · prefiks ${r.prefix}` : ' · bez prefiksa'}
                      </td>
                      <td className="px-3 py-2 text-right tnums">
                        {r.neverIssued ? (
                          // Prazan registar NIJE prazna strana: serija bez reda u bazi
                          // se vidi i prima upis (na produkciji je tabela imala 0 redova).
                          <span className="text-ink-disabled">još nije izdat nijedan broj</span>
                        ) : (
                          <span className="text-ink">{r.lastNumber}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs font-semibold text-ink">
                        {r.nextNumber}
                      </td>
                      <td className="px-3 py-2 tnums text-xs text-ink-secondary">
                        {r.book.maxNumber ? (
                          <>
                            {r.book.maxNumber}{' '}
                            <span className="text-ink-disabled">
                              ({r.book.entryCount} st.)
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-2xs text-ink-secondary">
                        {r.lastChange ? (
                          <>
                            {r.lastChange.from ?? 0} → {r.lastChange.to}
                            <br />
                            <span className="text-ink-disabled">
                              {r.lastChange.byEmail ?? 'nepoznat'} ·{' '}
                              {formatDateTime(r.lastChange.at)}
                            </span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end">
                          <button
                            onClick={() => setEdit(r)}
                            title={`Izmeni poslednji broj — ${r.seriesLabel} ${r.year}.`}
                            aria-label={`Izmeni poslednji broj — ${r.seriesLabel} ${r.year}.`}
                            className="rounded p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {/* Trag izmene — „ko, kad, sa čega na šta". Odvojeno od tabele jer je istorija,
          ne stanje; u tabeli stoji samo poslednja izmena po redu. */}
      {trail.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Trag izmene</h3>
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                  <th className="px-3 py-2">Kad</th>
                  <th className="px-3 py-2">Ko</th>
                  <th className="px-3 py-2">Serija / godina</th>
                  <th className="px-3 py-2">Sa</th>
                  <th className="px-3 py-2">Na</th>
                  <th className="px-3 py-2">Napomena</th>
                </tr>
              </thead>
              <tbody>
                {trail.map((t, i) => (
                  <tr key={`${t.at}-${i}`} className="border-b border-line-soft">
                    <td className="px-3 py-2 tnums text-xs text-ink-secondary">
                      {formatDateTime(t.at)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink">{t.byEmail ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-ink-secondary">
                      {t.seriesKey} · {t.year}
                    </td>
                    <td className="px-3 py-2 tnums text-xs text-ink-secondary">{t.from ?? 0}</td>
                    <td className="px-3 py-2 tnums text-xs font-semibold text-ink">{t.to}</td>
                    <td className="px-3 py-2 text-xs text-ink-secondary">{t.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {edit && <IzmenaBrojaca row={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Dijalog: upis poslednjeg izdatog broja za jednu seriju i godinu. */
function IzmenaBrojaca({ row, onClose }: { row: SequenceRow; onClose: () => void }) {
  const save = useSetLastNumber();
  const [value, setValue] = useState(String(row.lastNumber ?? 0));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const parsed = Number(value);
  const valid = /^\d+$/.test(value.trim()) && Number.isInteger(parsed);
  // Pregled sledećeg broja se računa UŽIVO dok se kuca: to je jedina provera koju
  // čovek stvarno ume da uradi — prepoznaje `262/26`, ne „261".
  const preview = valid ? `${row.prefix}${parsed + 1}/${String(row.year % 100).padStart(2, '0')}` : '—';

  async function submit() {
    setErr(null);
    if (!valid) return setErr('Unesi ceo broj (0 ili veći).');
    try {
      await save.mutateAsync({
        seriesKey: row.seriesKey,
        year: row.year,
        lastNumber: parsed,
        companyId: row.companyId,
        note: note.trim() || undefined,
      });
      toast('Brojač sačuvan');
      onClose();
    } catch (ex) {
      // 422 sa servera nosi izmereno objašnjenje (koji broj knjiga već ima i šta da se
      // upiše) — prikazuje se doslovno, jer je konkretniji od bilo kog opšteg teksta.
      setErr(ex instanceof ApiError ? ex.message : 'Čuvanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title={`${row.seriesLabel} — ${row.year}.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={save.isPending}>
            Sačuvaj
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-2 py-1.5 text-sm text-status-danger">
            {err}
          </p>
        )}

        <FormField
          label="Poslednji izdati broj"
          required
          hint="Sledeći dokument dobija prvi sledeći broj. 0 = još nijedan nije izdat."
        >
          <Input
            autoFocus
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </FormField>

        <div className="rounded-control bg-surface-2 px-3 py-2 text-sm">
          <span className="text-ink-secondary">Sledeći dokument dobija broj: </span>
          <span className="font-mono font-semibold text-ink">{preview}</span>
        </div>

        {row.book.maxNumber && (
          // Bez ovog reda čovek nema odakle da zna koji broj da upiše, pa bi ekran
          // rešavao samo pola problema (polje bez podatka je pogađanje).
          <p className="text-xs text-ink-secondary">
            U glavnoj knjizi za {row.year}. već postoji dokument{' '}
            <strong className="font-mono">{row.book.maxNumber}</strong> ({row.book.entryCount}{' '}
            stavki knjiženja). Broj manji od <strong>{row.book.maxSeq}</strong> se odbija — dva
            dokumenta sa istim brojem bi se u saldakontima spojila u jednu otvorenu stavku.
          </p>
        )}

        <FormField label="Napomena (ulazi u trag izmene)">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="npr. preuzimanje posla 01.04.2027"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </FormField>
      </div>
    </Dialog>
  );
}
