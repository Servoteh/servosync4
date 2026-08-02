'use client';

import { useEffect, useMemo, useState } from 'react';
import { Building2, Landmark, Save } from 'lucide-react';
import { ApiError } from '@/api/client';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import {
  useCompanyDetails,
  useSaveCompanyDetails,
  type CompanyDetails,
  type SaveCompanyDetailsVars,
} from '@/api/podesavanja';

// ============================================================================
// PODACI FIRME — ono što se ŠTAMPA na svakom dokumentu.
//
// ZAŠTO OVAJ EKRAN POSTOJI: tabela `companies` do 27.07.2026. nije imala nijednog
// pisca u backendu — podaci su stizali isključivo iz BigBit sinhronizacije. Zbog toga
// IBAN i SWIFT, koje ino faktura ČITA i ispisuje, nisu mogli nigde da se unesu, pa je
// izvozni račun izlazio bez podataka za plaćanje.
//
// SKUP POLJA JE NAMERNO UZAK — samo ono što ide na papir. BigBit zastavice ponašanja
// (`kepu*`, `pos*`, `autoLock*`, `galeb*`) NISU ovde: one menjaju knjigovodstveni
// obračun i ne smeju da se preklapaju iz forme bez odluke knjigovođe.
// ============================================================================

type Key = keyof Omit<CompanyDetails, 'id'>;

interface FieldDef {
  key: Key;
  label: string;
  hint?: string;
  placeholder?: string;
  maxLength: number;
  /** Polje se ne sme isprazniti (ispisuje se u zaglavlju svakog dokumenta). */
  required?: boolean;
}

const IDENTITY: FieldDef[] = [
  { key: 'companyName', label: 'Naziv firme', maxLength: 150, required: true },
  { key: 'address', label: 'Adresa', maxLength: 50 },
  { key: 'city', label: 'Mesto', maxLength: 50 },
  { key: 'municipality', label: 'Opština', maxLength: 50 },
  { key: 'taxId', label: 'PIB', maxLength: 20 },
  { key: 'registrationNumber', label: 'Matični broj', maxLength: 50 },
  { key: 'businessActivity', label: 'Delatnost', maxLength: 255 },
  { key: 'businessActivityCode', label: 'Šifra delatnosti', maxLength: 50 },
  { key: 'phone', label: 'Telefon', maxLength: 50 },
  { key: 'fax', label: 'Faks', maxLength: 50 },
  { key: 'email', label: 'E-pošta', maxLength: 30 },
  { key: 'webAddress', label: 'Veb adresa', maxLength: 50 },
  {
    key: 'owner',
    label: 'Odgovorno lice',
    maxLength: 50,
    hint: 'Ime u potpisnom bloku propisanih obrazaca.',
  },
  { key: 'invoiceIssuingPlace', label: 'Mesto izdavanja računa', maxLength: 50 },
  {
    key: 'footerText',
    label: 'Tekst u podnožju',
    maxLength: 255,
    hint: 'Npr. broj rešenja o registraciji — ide u podnožje memoranduma.',
  },
];

const PAYMENT: FieldDef[] = [
  {
    key: 'bankAccount',
    label: 'Tekući račun (domaći)',
    maxLength: 50,
    placeholder: '160-0000000123456-78',
    hint: 'Ispisuje se u zaglavlju svakog dokumenta.',
  },
  {
    key: 'iban',
    label: 'IBAN (ino plaćanje)',
    maxLength: 40,
    placeholder: 'RS35 1600 0000 0000 0000 00',
    hint: 'Razmaci su dozvoljeni pri kucanju — čuva se bez njih. Ispravnost se proverava (MOD-97).',
  },
  {
    key: 'swift',
    label: 'SWIFT / BIC',
    maxLength: 11,
    placeholder: 'DBDBRSBG',
    hint: '8 ili 11 znakova. Bez IBAN-a i SWIFT-a ino faktura nema podatke za uplatu.',
  },
];

type FormState = Record<Key, string>;

function toForm(c: CompanyDetails | null | undefined): FormState {
  const get = (k: Key) => {
    const v = c?.[k];
    return v == null ? '' : String(v);
  };
  const out = {} as FormState;
  for (const f of [...IDENTITY, ...PAYMENT]) out[f.key] = get(f.key);
  return out;
}

export function FirmaTab() {
  const q = useCompanyDetails();
  const saveM = useSaveCompanyDetails();
  const server = q.data?.data ?? null;
  const initial = useMemo(() => toForm(server), [server]);

  const [form, setForm] = useState<FormState>(initial);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setForm(initial);
  }, [initial, dirty]);

  function setField(key: Key, value: string) {
    setDirty(true);
    setForm((p) => ({ ...p, [key]: value }));
  }

  async function save() {
    // Samo IZMENJENA polja — prazno polje znači „obriši", pa slanje celog objekta
    // ne bi razlikovalo „nisam dirao" od „obriši".
    const patch: SaveCompanyDetailsVars = {};
    (Object.keys(form) as Key[]).forEach((k) => {
      if (form[k] !== initial[k]) {
        (patch as Record<string, string | null>)[k] =
          form[k].trim() === '' ? null : form[k].trim();
      }
    });
    if (Object.keys(patch).length === 0) {
      setDirty(false);
      toast('Nema izmena za snimanje.');
      return;
    }
    try {
      await saveM.mutateAsync(patch);
      setDirty(false);
      toast('Podaci firme su snimljeni.');
    } catch (e) {
      // 422 sa backenda nosi razumljivu srpsku poruku (npr. „IBAN ne prolazi kontrolu
      // ispravnosti (MOD-97)") — ona je korisnija od generičkog teksta, pa se prikazuje.
      const msg =
        e instanceof ApiError && e.status === 403
          ? 'Nemate dozvolu za izmenu podataka firme.'
          : (e as Error).message || 'Snimanje nije uspelo — pokušajte ponovo.';
      toast(msg);
    }
  }

  if (q.isLoading)
    return <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>;

  if (q.error)
    return (
      <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
        {(q.error as Error).message ||
          'Podaci firme nisu učitani. Ako u bazi nema nijedne firme, prvo je mora uneti administrator baze.'}
      </div>
    );

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Ovo su podaci koji se <strong>štampaju na svakom dokumentu</strong> — zaglavlje
        memoranduma i podaci za plaćanje. Prazno polje se ne štampa (papir ostaje bez tog
        reda), pa je bolje ostaviti prazno nego upisati približnu vrednost.
      </p>

      <Section title="Identitet firme" icon={Building2} fields={IDENTITY} form={form} onChange={setField} />
      <Section
        title="Podaci za plaćanje"
        icon={Landmark}
        fields={PAYMENT}
        form={form}
        onChange={setField}
        note="IBAN i SWIFT čita ino (izvozna) faktura. Dok su prazni, izvozni račun izlazi bez podataka za uplatu."
      />

      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-xs text-ink-secondary">Ima nesnimljenih izmena.</span>}
        <Button onClick={save} loading={saveM.isPending} disabled={!dirty}>
          <Save className="h-4 w-4" aria-hidden />
          Snimi izmene
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  fields,
  form,
  onChange,
  note,
}: {
  title: string;
  icon: typeof Building2;
  fields: FieldDef[];
  form: FormState;
  onChange: (k: Key, v: string) => void;
  note?: string;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <h3 className="mb-1 flex items-center gap-2 text-md font-semibold text-ink">
        <Icon className="h-4 w-4 text-ink-secondary" aria-hidden />
        {title}
      </h3>
      {note && <p className="mb-4 text-xs text-ink-secondary">{note}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((f) => (
          <FormField key={f.key} label={f.label} required={f.required} hint={f.hint}>
            <Input
              value={form[f.key]}
              maxLength={f.maxLength}
              placeholder={f.placeholder}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          </FormField>
        ))}
      </div>
    </section>
  );
}
