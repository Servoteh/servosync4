'use client';

// „Dodaj u nacrt" iz PDM crteža (red liste / detalj / čvor sastavnice) — legacy
// „Sastavnica delova za sklop" akcija: projektant hvata crtež u nacrt primopredaje.
// Dva puta (Nenad 16.07): (1) u POSTOJEĆI otvoren nacrt — POST /handover-drafts/:id/items
// (useAppendDraftItems), ili (2) NOVI nacrt sa ovim crtežom — router.push('/nacrti?noviCrtez=…')
// (Agent D taj param obrađuje u /nacrti). Toast po `meta.added/skipped`. Tastatura
// (DESIGN_SYSTEM §8): Esc zatvara (kit Dialog), Enter potvrđuje kad je izbor validan.
//
// Zahtev 027/26 (Igor 26.07): „kada se dodaje iz PDM crteži treba staviti polje gde
// upisujemo broj komada pre ubacivanja u nacrt primopredaje" — polje „Broj komada"
// (default 1) šalje se kao `quantity` uz stavku. Kod puta „novi nacrt" količina ide
// kroz URL (`?kom=`), pa je forma novog nacrta preuzme za glavni crtež.
//
// Dopuna 027/26 (Igor 30.07): kad je izabrani crtež SKLOP (ima pozicije u
// sastavnici — rekurzivni flat iz GET /pdm/drawings/:id/bom), pre ubacivanja se
// pita „Ubaciti i sve pozicije?" (AssemblyPositionsPrompt): „Da" → sklop + sve
// proizvodne ODOBRENE pozicije kao stavke (količina = potreba × broj komada,
// pozicija nosi mainDrawingId sklopa); „Ne" → samo crtež sklopa (staro
// ponašanje). Kod puta „novi nacrt" odluka putuje kroz URL (`?pozicije=da|ne`)
// pa je forma novog nacrta poštuje umesto da pita ponovo. X/Esc na pitanju =
// otkaži (vrati se u ovaj dijalog, ništa se ne ubacuje).

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { formatNumber } from '@/lib/format';
import {
  useAppendDraftItems,
  useOpenDraftsLookup,
  type AppendDraftItemInput,
} from '@/api/handovers';
import { useBom, isApprovedPdmStatus } from '@/api/pdm';
import {
  AssemblyPositionsPrompt,
  positionsCountLabel,
} from '@/components/assembly-positions-prompt';

/** Broj + naziv crteža koji se dodaje — prikaz u zaglavlju dijaloga. */
export interface AddToDraftTarget {
  drawingId: number;
  drawingNumber: string;
  name: string | null;
}

type Mode = 'existing' | 'new';

/** Srpska množina uz broj upisanih stavki: 1 stavka · 2–4 stavke · ostalo stavki. */
function stavkeLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${formatNumber(n)} stavka`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return `${formatNumber(n)} stavke`;
  return `${formatNumber(n)} stavki`;
}

const selectInput =
  'w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink ' +
  'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

export function AddToDraftDialog({
  target,
  open,
  onClose,
}: {
  target: AddToDraftTarget;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const lookup = useOpenDraftsLookup();
  const append = useAppendDraftItems();
  const drafts = lookup.data ?? [];

  const [mode, setMode] = useState<Mode>('existing');
  const [draftId, setDraftId] = useState<number | ''>('');
  // Broj komada za izradu (027/26) — unosi se PRE ubacivanja; default 1.
  const [quantity, setQuantity] = useState('1');
  // Dopuna 027/26: pitanje „ubaciti i sve pozicije?" je otvoreno (sklop sa decom).
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset pri svakom otvaranju; ako nema otvorenih nacrta forsiraj „novi".
  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setDraftId('');
    setQuantity('1');
    setAsking(false);
    setError(null);
  }, [open, target.drawingId]);

  const noOpenDrafts = !lookup.isLoading && drafts.length === 0;
  const effectiveMode: Mode = noOpenDrafts ? 'new' : mode;

  // Dopuna 027/26: sastavnica ciljnog crteža — da li je SKLOP i koje pozicije
  // nosi. Isti skup kao auto-popuna novog nacrta (drafts-tab): rekurzivni flat
  // agregat, proizvodni (ne-nabavni) delovi; ODOBRENI ulaze, neodobreni se
  // preskaču uz napomenu (backend bi ceo batch odbio sa 422). Pad upita (retke
  // mreže/500) NE blokira dodavanje — ponaša se kao deo bez pozicija.
  const bom = useBom(target.drawingId, open);
  const flat =
    bom.data?.data.drawing.id === target.drawingId ? bom.data.data.flat : [];
  const producible = flat.filter((r) => r.drawing && !r.drawing.isProcurement);
  const positions = producible.filter((r) => isApprovedPdmStatus(r.drawing!.pdmStatus));
  const skippedUnapproved = producible
    .filter((r) => !isApprovedPdmStatus(r.drawing!.pdmStatus))
    .map((r) => r.drawing!.drawingNumber);

  // Ista validacija kao backend DTO: ceo broj ≥ 1 (inače 400).
  const qty = Number(quantity);
  const qtyValid = Number.isInteger(qty) && qty >= 1;

  // Dok se sastavnica ne razreši ne znamo da li treba pitati za pozicije —
  // „Dodaj" čeka (greška upita NE čeka: fallback = bez pozicija, vidi gore).
  const canSubmit =
    qtyValid &&
    !bom.isLoading &&
    (effectiveMode === 'new' ? true : draftId !== '' && !append.isPending);

  function submit() {
    if (!canSubmit || asking) return;
    setError(null);
    // Sklop sa pozicijama → prvo pitanje Da/Ne (dopuna 027/26); bez pozicija
    // (deo, prazna/nabavna sastavnica) → odmah ubaci samo crtež, bez pitanja.
    if (positions.length > 0) {
      setAsking(true);
      return;
    }
    proceed(false);
  }

  /** Izvrši ubacivanje — `includePositions` = odgovor na pitanje (ili false bez pitanja). */
  function proceed(includePositions: boolean) {
    setAsking(false);

    if (effectiveMode === 'new') {
      onClose();
      // `kom` = broj komada sklopa u novom nacrtu (forma ga preuzme u zaglavlje,
      // a auto-popuna sastavnice množi količine pozicija njime). `pozicije` =
      // odgovor na pitanje — forma ga poštuje umesto da pita ponovo; bez
      // pozicija se ne šalje (forma ionako nema šta da popuni).
      const poz = positions.length > 0 ? `&pozicije=${includePositions ? 'da' : 'ne'}` : '';
      router.push(`/nacrti?noviCrtez=${target.drawingId}&kom=${qty}${poz}`);
      return;
    }

    // Postojeći nacrt — sklop (crtež + količina), uz „Da" i sve pozicije:
    // količina pozicije = potreba po 1 komadu sklopa × uneti broj komada,
    // provenance = mainDrawingId sklopa + potreba (kolona „Vodeći sklop").
    const items: AppendDraftItemInput[] = [
      { drawingId: target.drawingId, quantity: qty },
      ...(includePositions
        ? positions.map((p) => ({
            drawingId: p.drawing!.id,
            quantity: p.totalQuantity * qty,
            mainDrawingId: target.drawingId,
            quantityDefinedInDrawing: p.totalQuantity,
          }))
        : []),
    ];
    append.mutate(
      { id: draftId as number, items },
      {
        onSuccess: (res) => {
          const { added, skipped } = res.meta;
          const draft = drafts.find((d) => d.id === draftId);
          const label = draft ? draft.draftNumber : String(draftId);
          // `skipped` su BROJEVI crteža (string niz) — crteži koji su već u
          // nacrtu (backend dedup — pozicija se NE duplira, samo preskače).
          const parts: string[] = [];
          if (added > 0) {
            parts.push(
              includePositions
                ? `Dodato u nacrt ${label} — sklop + pozicije (${stavkeLabel(added)}).`
                : `Dodato u nacrt ${label} — ${formatNumber(qty)} kom.`,
            );
          } else {
            parts.push(`Ništa nije dodato — sve je već u nacrtu ${label}.`);
          }
          if (skipped.length > 0)
            parts.push(`Preskočeno (već u nacrtu): ${skipped.join(', ')}.`);
          if (includePositions && skippedUnapproved.length > 0)
            parts.push(`Neodobreni u PDM-u (nisu ubačeni): ${skippedUnapproved.join(', ')}.`);
          toast(parts.join(' '));
          onClose();
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : 'Greška pri dodavanju u nacrt.'),
      },
    );
  }

  // Enter potvrđuje kad je izbor validan (Esc zatvara kroz kit Dialog). Ref čuva
  // svež closure; Enter na dugmetu ostaje klik tog dugmeta (ne kradem ga).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      e.preventDefault();
      submitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodaj u nacrt"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={append.isPending} disabled={!canSubmit}>
            {effectiveMode === 'new' ? 'Otvori novi nacrt' : 'Dodaj'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-ink-secondary">
          Crtež{' '}
          <span className="tnums font-semibold text-ink">{target.drawingNumber}</span>
          {target.name ? ` · ${target.name}` : ''}
        </p>

        {/* Dopuna 027/26: „Dodaj" čeka sastavnicu (da zna da li da pita za
            pozicije) — vidljiv razlog zašto je dugme sivo; sklop dobija i
            najavu koliko pozicija nosi. */}
        {bom.isLoading && (
          <p className="text-xs text-ink-disabled">Proveravam sastavnicu crteža…</p>
        )}
        {!bom.isLoading && positions.length > 0 && (
          <p className="text-xs text-ink-secondary">
            Sklop ima {positionsCountLabel(positions.length)} u sastavnici — pre ubacivanja
            bira se da li ulaze i pozicije.
          </p>
        )}

        {/* 027/26: broj komada se upisuje PRE ubacivanja u nacrt. U postojeći
            nacrt ide kao količina za izradu te stavke; u novi nacrt kao broj
            komada sklopa (auto-popuna sastavnice njime množi pozicije). */}
        <FormField
          label="Broj komada"
          required
          error={qtyValid ? undefined : 'Mora biti ceo broj ≥ 1.'}
          hint={
            effectiveMode === 'new'
              ? 'Broj komada sklopa u novom nacrtu.'
              : 'Količina za izradu ove stavke u nacrtu.'
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="w-28"
          />
        </FormField>

        <fieldset className="space-y-2">
          <label
            className="flex items-start gap-2"
            aria-disabled={noOpenDrafts || undefined}
          >
            <input
              type="radio"
              name="add-to-draft-mode"
              className="mt-0.5"
              checked={effectiveMode === 'existing'}
              disabled={noOpenDrafts}
              onChange={() => setMode('existing')}
            />
            <span className={noOpenDrafts ? 'text-ink-disabled' : 'text-ink'}>
              U postojeći nacrt
            </span>
          </label>

          {effectiveMode === 'existing' && (
            <div className="pl-6">
              {lookup.isLoading ? (
                <span className="text-ink-disabled">Učitavanje nacrta…</span>
              ) : (
                <select
                  value={draftId === '' ? '' : String(draftId)}
                  onChange={(e) =>
                    setDraftId(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className={selectInput}
                >
                  <option value="">Izaberi nacrt…</option>
                  {drafts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.draftNumber}
                      {d.subject ? ` · ${d.subject}` : ''}
                      {d.designerName ? ` (${d.designerName})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="add-to-draft-mode"
              className="mt-0.5"
              checked={effectiveMode === 'new'}
              onChange={() => setMode('new')}
            />
            <span className="text-ink">Novi nacrt sa ovim crtežom</span>
          </label>
        </fieldset>

        {noOpenDrafts && (
          <p className="text-xs text-ink-secondary">
            Nema otvorenih nacrta — crtež se dodaje u novi nacrt.
          </p>
        )}

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>

    {/* Dopuna 027/26: pitanje za pozicije sklopa — sibling dijalog preko ovog
        (escape-layer daje Esc gornjem sloju). X/Esc = otkaži: vraća u ovaj
        dijalog bez ubacivanja („Ne" je eksplicitno dugme, ne dismiss). */}
    <AssemblyPositionsPrompt
      open={asking}
      drawingNumber={target.drawingNumber}
      count={positions.length}
      skippedUnapproved={skippedUnapproved}
      onYes={() => proceed(true)}
      onNo={() => proceed(false)}
      onDismiss={() => setAsking(false)}
    />
    </>
  );
}

/**
 * Dugme „Dodaj u nacrt" + interni dijalog, zaštićeno `PRIMOPREDAJE_WRITE`.
 * Jedan potrošač za sva tri mesta (red liste / detalj / čvor sastavnice) —
 * `variant`:
 *   - `button` (default) — standardno sekundarno dugme (red/detalj),
 *   - `compact` — sitno ikonica+tekst za gustu sastavnicu (čvor stabla).
 * `stopRowActivate` sprečava da klik u redu tabele okine expand reda.
 */
export function AddToDraftButton({
  target,
  variant = 'button',
  stopRowActivate,
}: {
  target: AddToDraftTarget;
  variant?: 'button' | 'compact';
  stopRowActivate?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const onClick = (e: MouseEvent) => {
    if (stopRowActivate) e.stopPropagation();
    setOpen(true);
  };

  return (
    <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
      {variant === 'compact' ? (
        <button
          type="button"
          onClick={onClick}
          title="Dodaj crtež u nacrt primopredaje"
          aria-label="Dodaj u nacrt"
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-line px-1.5 py-0.5 text-2xs font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink"
        >
          <FilePlus2 className="h-3 w-3" aria-hidden />
          U nacrt
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2 hover:text-ink"
        >
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
          Dodaj u nacrt
        </button>
      )}
      {/* Dijalog se montira tek na prvi otvor da lookup ne krene bez potrebe. */}
      {open && (
        <AddToDraftDialog target={target} open={open} onClose={() => setOpen(false)} />
      )}
    </Can>
  );
}
