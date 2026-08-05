'use client';

import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Textarea } from '@/components/ui-kit/textarea';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import {
  useSaveServiceRevenueType,
  useServiceRevenueTypes,
  type ServiceRevenueTypeRow,
} from '@/api/podesavanja';

/**
 * PODEŠAVANJA → VRSTE USLUGE (šifarnik `service_revenue_types`, nalaz P10).
 * ============================================================================
 * Do 05.08.2026. se ovaj šifarnik menjao ISKLJUČIVO SQL-om nad produkcijom.
 *
 * Suština šifarnika (odluka vlasnika i knjigovođe, 05.08.2026): **komercijala ne bira
 * konto, nego bira ŠTA PRODAJE** — a konto prihoda, poreski tretman i napomena na papiru
 * slede iz tog jednog izbora. Ovaj ekran je druga strana te odluke: mesto gde knjigovođa
 * te tri stvari vezuje za jednu vrstu.
 *
 * ⚠️ PORESKI TRETMAN JE PADAJUĆA LISTA, NIKAD POLJE ZA KUCANJE. Vrednosti dolaze sa
 * servera (`meta.taxTreatments`), ne iz ovog fajla — prekucan spisak bi se razišao prvog
 * dana kad se doda četvrti tretman. Greška u kucanju („REVERSE-CHARGE") značila bi porez
 * obračunat na prometu na kom ga po zakonu obračunava kupac.
 */

/** Objašnjenje uz svaki tretman — bez njega je izbor tri nerazumljive engleske reči. */
const TRETMAN_OPIS: Record<string, string> = {
  TAXED: 'Mi obračunavamo PDV (po stopi stavke)',
  REVERSE_CHARGE: 'PDV obračunava KUPAC — poreski dužnik je primalac (čl. 10 st. 2 t. 1)',
  OUTSIDE_SCOPE: 'Bez PDV-a — mesto prometa je van Srbije (čl. 12 st. 3)',
};

function tretmanLabel(v: string): string {
  return TRETMAN_OPIS[v] ? `${v} — ${TRETMAN_OPIS[v]}` : v;
}

export function VrsteUslugeTab() {
  const q = useServiceRevenueTypes();
  const [edit, setEdit] = useState<ServiceRevenueTypeRow | 'nova' | null>(null);

  const rows = q.data?.data ?? [];
  const tretmani = q.data?.meta.taxTreatments ?? [];
  const trail = q.data?.meta.trail ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-md font-semibold text-ink">Vrste usluge</h2>
          <p className="mt-0.5 text-xs text-ink-secondary">
            Šta se prodaje → konto prihoda, poreski tretman i napomena na papiru. Komercijala
            na uslužnom računu bira vrstu, a ne konto. Ugašena vrsta se ne nudi na novim
            računima, ali zatečeni računi ostaju netaknuti.
          </p>
        </div>
        <Button onClick={() => setEdit('nova')}>
          <Plus className="mr-1.5 h-4 w-4" />
          Nova vrsta
        </Button>
      </div>

      {q.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Šifarnik je prazan" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                <th className="px-3 py-2">Šifra</th>
                <th className="px-3 py-2">Naziv</th>
                <th className="px-3 py-2">Konto prihoda</th>
                <th className="px-3 py-2">Ko obračunava PDV</th>
                <th className="px-3 py-2">Napomena na papiru</th>
                <th className="px-3 py-2 text-right">Računa</th>
                <th className="px-3 py-2">Stanje</th>
                <th className="px-3 py-2 text-right">Akcije</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b border-line-soft hover:bg-surface-2 ${
                    r.isActive ? '' : 'opacity-60'
                  }`}
                  onDoubleClick={() => setEdit(r)}
                  title="Dupli klik otvara izmenu"
                >
                  <td className="px-3 py-2 font-mono text-xs font-semibold text-ink">{r.code}</td>
                  <td className="px-3 py-2 text-ink">{r.name}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className="font-mono text-ink">{r.revenueAccountCode}</span>
                    <br />
                    <span className="text-ink-disabled">
                      {/* Konto van kontnog plana je zatečen red (unet SQL-om pre ovog ekrana) —
                          vidi se odmah, umesto da izađe tek kad knjiženje padne. */}
                      {r.revenueAccountName ?? '⚠ konto ne postoji u kontnom planu'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-secondary">
                    {TRETMAN_OPIS[r.vatTreatment] ?? r.vatTreatment}
                  </td>
                  <td className="px-3 py-2 text-2xs text-ink-secondary">{r.paperNote || '—'}</td>
                  <td className="px-3 py-2 text-right tnums text-xs text-ink-secondary">
                    {r.usedByInvoices}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.isActive ? (
                      <span className="text-status-success">aktivna</span>
                    ) : (
                      <span className="text-ink-disabled">ugašena</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end">
                      <button
                        onClick={() => setEdit(r)}
                        title={`Izmeni ${r.code}`}
                        aria-label={`Izmeni ${r.code}`}
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
      )}

      {/* Trag izmene — „ko, kad, sa čega na šta". */}
      {trail.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-ink">Trag izmene</h3>
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase text-ink-secondary">
                  <th className="px-3 py-2">Kad</th>
                  <th className="px-3 py-2">Ko</th>
                  <th className="px-3 py-2">Šta</th>
                  <th className="px-3 py-2">Izmena</th>
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
                      {t.action === 'CREATE' ? 'nova vrsta' : 'izmena'} · {t.code ?? t.id}
                    </td>
                    <td className="px-3 py-2 text-2xs text-ink-secondary">
                      {t.changes
                        ? Object.entries(t.changes)
                            .map(
                              ([k, v]) =>
                                `${k}: ${fmtVal(v.from)} → ${fmtVal(v.to)}`,
                            )
                            .join(' · ')
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {edit && (
        <IzmenaVrste
          row={edit === 'nova' ? null : edit}
          tretmani={tretmani}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(prazno)';
  if (typeof v === 'boolean') return v ? 'da' : 'ne';
  return String(v);
}

/** Dijalog: nova vrsta (`row === null`) ili izmena zatečene. */
function IzmenaVrste({
  row,
  tretmani,
  onClose,
}: {
  row: ServiceRevenueTypeRow | null;
  tretmani: string[];
  onClose: () => void;
}) {
  const save = useSaveServiceRevenueType();
  const [code, setCode] = useState(row?.code ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [account, setAccount] = useState(row?.revenueAccountCode ?? '');
  const [treatment, setTreatment] = useState(row?.vatTreatment ?? 'TAXED');
  const [paperNote, setPaperNote] = useState(row?.paperNote ?? '');
  const [isActive, setIsActive] = useState(row?.isActive ?? true);
  const [sortOrder, setSortOrder] = useState(String(row?.sortOrder ?? 0));
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    if (!code.trim()) return setErr('Unesi šifru.');
    if (!name.trim()) return setErr('Unesi naziv.');
    if (!account.trim()) return setErr('Unesi konto prihoda.');
    try {
      await save.mutateAsync({
        id: row?.id,
        // Pri izmeni se šifra šalje nepromenjena — server odbija preimenovanje
        // (program `USL` poznaje po imenu), ali ekran svejedno šalje celu formu.
        code: code.trim().toUpperCase(),
        name: name.trim(),
        revenueAccountCode: account.trim(),
        vatTreatment: treatment,
        paperNote: paperNote.trim() || null,
        isActive,
        sortOrder: Number(sortOrder) || 0,
      });
      toast(row ? 'Izmenjeno' : 'Dodato');
      onClose();
    } catch (ex) {
      // Poruke sa servera su konkretne (koji konto ne postoji, koja su potvrđena konta,
      // da je vrsta možda ugašena) — prikazuju se doslovno.
      setErr(ex instanceof ApiError ? ex.message : 'Čuvanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      size="lg"
      title={row ? `Vrsta usluge — ${row.code}` : 'Nova vrsta usluge'}
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

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="Šifra"
            required
            hint={row ? 'Šifra se ne menja — program je poznaje po imenu.' : 'Npr. USL, USL-INO, OTPAD'}
          >
            <Input
              value={code}
              disabled={!!row}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </FormField>
          <FormField label="Naziv" required hint="Tekst koji komercijala vidi na listi.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="Konto prihoda"
            required
            hint="Mora postojati u kontnom planu (6140, 6151, 6796, 6501…)."
          >
            <Input value={account} onChange={(e) => setAccount(e.target.value)} />
          </FormField>
          <FormField label="Ko obračunava PDV" required>
            <Select
              value={treatment}
              options={tretmani.map((t) => ({ value: t, label: tretmanLabel(t) }))}
              onChange={(e) => setTreatment(e.target.value)}
            />
          </FormField>
        </div>

        <FormField
          label="Napomena na papiru"
          hint="Ide na poreski dokument. Prazno = obrazac koristi rezervni tekst."
        >
          <Textarea
            rows={3}
            value={paperNote}
            onChange={(e) => setPaperNote(e.target.value)}
          />
        </FormField>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Redosled na listi" hint="Manji broj = više na listi.">
            <Input
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </FormField>
          <FormField label="Stanje">
            <label className="flex h-11 items-center gap-2 text-sm text-ink sm:h-9">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4"
              />
              Aktivna (nudi se na novim računima)
            </label>
          </FormField>
        </div>

        {row && row.usedByInvoices > 0 && (
          <p className="text-xs text-ink-secondary">
            Ovu vrstu već nosi <strong>{row.usedByInvoices}</strong> dokumenata. Izmena konta ili
            poreskog tretmana važi <strong>unapred</strong> — zatečeni računi zadržavaju ono sa
            čim su proknjiženi, pa im se papir i knjiženje ne menjaju.
          </p>
        )}
      </div>
    </Dialog>
  );
}
