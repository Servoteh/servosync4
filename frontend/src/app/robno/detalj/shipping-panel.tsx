'use client';

import { useEffect, useMemo, useState } from 'react';
import { Truck, Save, X, Pencil } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  useUpdateShipping,
  ROBNO_KIND,
  ROBNO_STATUS,
  type StockDocumentDetail,
  type UpdateShippingPayload,
} from '@/api/robno';

/**
 * USLOVI OTPREME — polja koja štampa OTPREMNICA.
 *
 * Do 27.07.2026. tih kolona nije bilo, pa je otpremnica štampala četiri TVRDE KONSTANTE
 * („Roba je FCO: magacin isporučioca", „Način otpreme: sopstveni prevoz", „Mesto prometa:
 * magacin", datum otpreme = datum dokumenta) kao da su podaci. Otpremnica je prateća isprava
 * uz robu — papir je tvrdio činjenice koje niko nije uneo. Ovaj panel je mesto gde se te
 * činjenice zaista unose; dok su prazne, papir ostavlja LINIJU ZA RUČNI UPIS.
 *
 * KADA JE OTKLJUČAN: uvek osim kad je dokument ZAKLJUČAN (LOCKED). Namerno se dozvoljava i na
 * proknjiženom dokumentu — vozač, ruta i stvarni dan otpreme se saznaju posle knjiženja; da se
 * traži nacrt, magacin ih ne bi imao gde uneti. Isti guard stoji na backendu (409 na LOCKED).
 *
 * Šalju se SAMO izmenjena polja: prazno polje znači „obriši" (backend to i radi), pa slanje
 * celog objekta na svaki „Snimi" ne bi razlikovalo „nisam dirao" od „obriši".
 */

interface FieldDef {
  key: keyof FormState;
  label: string;
  hint?: string;
  placeholder: string;
  type?: 'text' | 'date';
  maxLength: number;
}

const FIELDS: FieldDef[] = [
  {
    key: 'fco',
    label: 'Roba je FCO (paritet isporuke)',
    placeholder: 'npr. FCO magacin isporučioca / FCO kupac',
    hint: 'Do kog mesta troškove i rizik snosi isporučilac.',
    maxLength: 100,
  },
  {
    key: 'shippingMethod',
    label: 'Način otpreme',
    placeholder: 'npr. sopstveni prevoz / kurir / preuzimanje',
    maxLength: 50,
  },
  {
    key: 'shippingDate',
    label: 'Datum otpreme',
    type: 'date',
    placeholder: '',
    hint: 'Odvojen od datuma dokumenta — otprema ume da bude i dan-dva kasnije.',
    maxLength: 10,
  },
  {
    key: 'deliveryPlace',
    label: 'Mesto isporuke',
    placeholder: 'adresa ili mesto predaje robe',
    maxLength: 150,
  },
  {
    key: 'route',
    label: 'Ruta',
    placeholder: 'npr. Beograd — Novi Sad',
    maxLength: 100,
  },
  {
    key: 'customerOrderRef',
    label: 'Po porudžbini od',
    placeholder: 'kupčev broj i datum porudžbine',
    hint: 'Kupčev broj, ne naš — upisuje se kako ga je kupac napisao.',
    maxLength: 100,
  },
];

interface FormState {
  fco: string;
  shippingMethod: string;
  shippingDate: string;
  deliveryPlace: string;
  route: string;
  customerOrderRef: string;
  note: string;
}

/** ISO timestamp → `yyyy-MM-dd` za `<input type="date">`; prazno ostaje prazno. */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function toForm(doc: StockDocumentDetail): FormState {
  return {
    fco: doc.fco ?? '',
    shippingMethod: doc.shippingMethod ?? '',
    shippingDate: toDateInput(doc.shippingDate),
    deliveryPlace: doc.deliveryPlace ?? '',
    route: doc.route ?? '',
    customerOrderRef: doc.customerOrderRef ?? '',
    note: doc.note ?? '',
  };
}

export function ShippingPanel({ doc }: { doc: StockDocumentDetail }) {
  const server = useMemo(() => toForm(doc), [doc]);
  const [form, setForm] = useState<FormState>(server);
  const [editing, setEditing] = useState(false);
  const save = useUpdateShipping();

  // Kad stigne svež dokument (posle snimanja/osvežavanja), poravnaj formu — osim
  // dok korisnik kuca, da mu se unos ne pobriše ispod prstiju.
  useEffect(() => {
    if (!editing) setForm(server);
  }, [server, editing]);

  const locked = doc.status === ROBNO_STATUS.LOCKED;
  // Linije za ručni upis štampaju SAMO obrasci koji putuju sa robom (otpremnica,
  // prenosnica, trebovanje — v. `SHIPPING_LINES_VARIANTS` u štampi). Na primci,
  // nivelaciji i kalkulaciji prazno polje se ne štampa uopšte, pa panel to ne sme
  // da obeća — magacioner bi odštampao papir očekujući liniju koje nema.
  const travelsWithGoods =
    doc.kind === ROBNO_KIND.IZ || doc.kind === ROBNO_KIND.PRENOS;
  const hasAny =
    server.fco !== '' ||
    server.shippingMethod !== '' ||
    server.shippingDate !== '' ||
    server.deliveryPlace !== '' ||
    server.route !== '' ||
    server.customerOrderRef !== '' ||
    server.note !== '';

  function setField(key: keyof FormState, value: string) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function cancel() {
    setForm(server);
    setEditing(false);
  }

  async function submit() {
    // Samo IZMENJENA polja — prazno polje je „obriši", pa se neizmenjena ne šalju.
    const patch: UpdateShippingPayload = {};
    (Object.keys(form) as (keyof FormState)[]).forEach((key) => {
      if (form[key] !== server[key]) {
        patch[key] = form[key].trim() === '' ? null : form[key].trim();
      }
    });
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    try {
      await save.mutateAsync({ id: doc.id, patch });
      setEditing(false);
      toast('Uslovi otpreme su snimljeni.');
    } catch (e) {
      // 403 iz `PermissionsGuard` stiže kao engleski „Forbidden resource" — čovek
      // koji nema pravo izmene mora da dobije objašnjenje na svom jeziku, a ne
      // Nest-ov podrazumevani tekst (isti obrazac kao tab „Podaci firme").
      if (e instanceof ApiError && e.status === 403) {
        toast('Nemate dozvolu za izmenu uslova otpreme.');
        return;
      }
      toast((e as Error).message || 'Snimanje nije uspelo — pokušajte ponovo.');
    }
  }

  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-md font-semibold text-ink">
          <Truck className="h-4 w-4 text-ink-secondary" aria-hidden />
          Uslovi otpreme
        </h2>
        {!editing ? (
          <Button
            variant="ghost"
            onClick={() => setEditing(true)}
            disabled={locked}
            title={
              locked
                ? 'Dokument je zaključan — uslovi otpreme se više ne menjaju.'
                : 'Unesi uslove otpreme koje štampa otpremnica'
            }
          >
            <Pencil className="h-4 w-4" aria-hidden />
            {hasAny ? 'Izmeni' : 'Unesi'}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={cancel} disabled={save.isPending}>
              <X className="h-4 w-4" aria-hidden />
              Odustani
            </Button>
            <Button onClick={submit} loading={save.isPending}>
              <Save className="h-4 w-4" aria-hidden />
              Snimi
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <FormField key={f.key} label={f.label} hint={f.hint}>
                <Input
                  type={f.type ?? 'text'}
                  value={form[f.key]}
                  maxLength={f.maxLength}
                  placeholder={f.placeholder}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              </FormField>
            ))}
          </div>
          <FormField
            label="Napomena"
            hint="Ispisuje se na dnu odštampanog dokumenta; prazna napomena se ne štampa."
          >
            <Textarea
              value={form.note}
              placeholder="npr. roba se isporučuje u dve palete; ambalaža povratna"
              onChange={(e) => setField('note', e.target.value)}
            />
          </FormField>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  {f.label}
                </dt>
                <dd className="mt-1 text-sm">
                  {server[f.key] ? (
                    <span className="text-ink">
                      {f.type === 'date'
                        ? formatDate(doc.shippingDate)
                        : server[f.key]}
                    </span>
                  ) : (
                    <span className="text-ink-disabled">
                      {travelsWithGoods
                        ? 'nije uneto — na papiru ostaje linija za ručni upis'
                        : 'nije uneto — na ovom obrascu se prazno polje ne štampa'}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {server.note && (
            <div className="mt-4 border-t border-line-soft pt-4">
              <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                Napomena
              </dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">{server.note}</dd>
            </div>
          )}
        </>
      )}
    </section>
  );
}
