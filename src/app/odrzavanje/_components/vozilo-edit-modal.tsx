'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useCreateVehicle,
  useCreateVehicleOwner,
  useDrivers,
  usePatchVehicleCore,
  usePatchVehicleTollTag,
  useUpsertVehicleDetails,
  useVehicle,
  useVehicleOwners,
  type VehicleDetail,
} from '@/api/odrzavanje';
import { GPS_PROVIDER_LABEL, USAGE_LABEL, VEHICLE_KIND_LABEL, isoToDateInput } from './common';

const KIND_KEYS = Object.keys(VEHICLE_KIND_LABEL);
const USAGE_KEYS = Object.keys(USAGE_LABEL);
const GPS_KEYS = Object.keys(GPS_PROVIDER_LABEL);

const sval = (v: unknown): string => (v == null ? '' : String(v));
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/**
 * Pun create+edit modal vozila (H6/H7 — paritet 1.0 openVehicleModal,
 * maintVehiclesPanel.js:348-678). Sva master-polja + primarni vozač picker +
 * vlasnik „+ Novi" inline + TAG + objedinjene napomene + legacy servisna polja READ-ONLY.
 * `vehicleId` prazan = create; inače edit (patch core + upsert details + guarded toll-tag).
 */
export function VoziloEditModal({
  vehicleId,
  onClose,
  onSaved,
}: {
  vehicleId?: string | null;
  onClose: () => void;
  onSaved?: (id?: string) => void;
}) {
  const isCreate = !vehicleId;
  const vehicle = useVehicle(vehicleId ?? null);
  const d = vehicle.data?.data;

  if (!isCreate && (vehicle.isLoading || !d)) {
    return (
      <Dialog open onClose={onClose} title="Detalji vozila">
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      </Dialog>
    );
  }
  return <Form isCreate={isCreate} vehicleId={vehicleId ?? null} d={d ?? null} onClose={onClose} onSaved={onSaved} />;
}

function Form({
  isCreate,
  vehicleId,
  d,
  onClose,
  onSaved,
}: {
  isCreate: boolean;
  vehicleId: string | null;
  d: VehicleDetail | null;
  onClose: () => void;
  onSaved?: (id?: string) => void;
}) {
  const det = (d?.details ?? null) as Record<string, unknown> | null;
  const owners = useVehicleOwners();
  const drivers = useDrivers();
  const create = useCreateVehicle();
  const patchCore = usePatchVehicleCore();
  const upsert = useUpsertVehicleDetails();
  const tollPatch = usePatchVehicleTollTag();
  const createOwner = useCreateVehicleOwner();

  const [assetCode, setAssetCode] = useState('');
  const [name, setName] = useState(sval(d?.name));
  const [registrationPlate, setPlate] = useState(sval(det?.registrationPlate));
  const [vehicleKind, setKind] = useState(sval(det?.vehicleKind));
  const [ownerId, setOwnerId] = useState(sval(det?.ownerId ?? d?.owner?.ownerId));
  const [primaryDriverId, setDriver] = useState(sval(det?.primaryDriverId));
  const [yearOfManufacture, setYom] = useState(sval(det?.yearOfManufacture));
  const [isPrivate, setPrivate] = useState(det?.isPrivateVehicle === true);
  const [manufacturer, setMfg] = useState(sval(d?.manufacturer));
  const [model, setModel] = useState(sval(d?.model));
  const [vin, setVin] = useState(sval(det?.vin));
  const [fuelType, setFuel] = useState(sval(det?.fuelType));
  const [usageType, setUsage] = useState(sval(det?.usageType));
  const [registrationExpiresAt, setReg] = useState(isoToDateInput(det?.registrationExpiresAt));
  const [insuranceExpiresAt, setIns] = useState(isoToDateInput(det?.insuranceExpiresAt));
  const [firstAidExpiresAt, setFirstAid] = useState(isoToDateInput(det?.firstAidKitExpiresAt));
  const [odometerKm, setOdo] = useState(sval(det?.odometerKm));
  const [gpsProvider, setGps] = useState(sval(det?.gpsProvider) || 'nema');
  const [gpsDeviceId, setGpsId] = useState(sval(det?.gpsDeviceId));
  const [tollSerial, setTollSerial] = useState(sval(det?.tollTagSerial));
  const [tollProvider, setTollProvider] = useState(sval(det?.tollTagProvider));
  const [tollNotes, setTollNotes] = useState(sval(det?.tollTagNotes));
  const [payloadKg, setPayload] = useState(sval(det?.payloadKg));
  const [passengerSeats, setSeats] = useState(sval(det?.passengerSeats));
  const [serialNumber, setSerial] = useState(sval(d?.serialNumber));
  const [supplier, setSupplier] = useState(sval(det?.supplier ?? d?.supplier));
  const [notes, setNotes] = useState(sval(det?.notes) || sval(d?.notes));
  const [err, setErr] = useState<string | null>(null);

  const gpsDisabled = gpsProvider === 'nema';
  const legacyService = {
    due: sval(det?.serviceDueAt).slice(0, 10),
    nextKm: sval(det?.nextServiceMileageKm),
    interval: sval(det?.serviceIntervalKm),
  };
  const hasLegacyService = !!(legacyService.due || legacyService.nextKm || legacyService.interval);
  const pending = create.isPending || patchCore.isPending || upsert.isPending;

  function buildDetails(): Record<string, unknown> {
    return {
      registration_plate: registrationPlate.trim() || null,
      vin: vin.trim() || null,
      odometer_km: numOrNull(odometerKm),
      fuel_type: fuelType.trim() || null,
      registration_expires_at: registrationExpiresAt || null,
      insurance_expires_at: insuranceExpiresAt || null,
      first_aid_kit_expires_at: firstAidExpiresAt || null,
      notes: notes.trim() || null,
      year_of_manufacture: numOrNull(yearOfManufacture),
      vehicle_kind: vehicleKind || null,
      payload_kg: numOrNull(payloadKg),
      passenger_seats: numOrNull(passengerSeats),
      usage_type: usageType || null,
      gps_provider: gpsProvider || 'nema',
      gps_device_id: gpsDisabled ? null : gpsDeviceId.trim() || null,
      is_private_vehicle: isPrivate,
      owner_id: ownerId || null,
      primary_driver_id: primaryDriverId || null,
    };
  }

  function validate(): string | null {
    if (isCreate && !assetCode.trim()) return 'Šifra je obavezna.';
    if (isCreate && !name.trim()) return 'Naziv je obavezan.';
    const y = numOrNull(yearOfManufacture);
    const yMax = new Date().getFullYear() + 1;
    if (y != null && (!Number.isFinite(y) || y < 1900 || y > yMax)) return `Godina proizvodnje mora biti između 1900 i ${yMax}.`;
    const pay = numOrNull(payloadKg);
    if (pay != null && pay < 0) return 'Nosivost (kg) ne sme biti negativna.';
    const seats = numOrNull(passengerSeats);
    if (seats != null && seats < 0) return 'Broj sedišta ne sme biti negativan.';
    if (gpsDisabled && gpsDeviceId.trim()) return 'ID uređaja ostaviti prazno kada je GPS = Nema.';
    return null;
  }

  function tollPatchBody() {
    return { tollTagSerial: tollSerial.trim() || null, tollTagProvider: tollProvider.trim() || null, tollTagNotes: tollNotes.trim() || null };
  }

  function save() {
    const v = validate();
    if (v) return setErr(v);
    setErr(null);
    const details = buildDetails();

    if (isCreate) {
      const hasToll = !!(tollSerial.trim() || tollProvider.trim() || tollNotes.trim());
      create.mutate(
        {
          assetCode: assetCode.trim(),
          name: name.trim(),
          status: 'running',
          manufacturer: manufacturer.trim() || undefined,
          model: model.trim() || undefined,
          serialNumber: serialNumber.trim() || undefined,
          supplier: supplier.trim() || undefined,
          details,
        },
        {
          onSuccess: (res) => {
            const newId = (res as { data?: { assetId?: string } }).data?.assetId;
            const done = () => { toast('Vozilo dodato'); onClose(); onSaved?.(newId ?? undefined); };
            if (hasToll && newId) tollPatch.mutate({ id: newId, patch: tollPatchBody() }, { onSuccess: done, onError: done });
            else done();
          },
          onError: (e) => setErr((e as Error).message),
        },
      );
      return;
    }

    const id = vehicleId!;
    // Objedinjene napomene: unified → details.notes; legacy asset.notes se briše (null).
    patchCore.mutate(
      { id, patch: { name: name.trim(), manufacturer: manufacturer.trim() || null, model: model.trim() || null, serialNumber: serialNumber.trim() || null, supplier: supplier.trim() || null, notes: null } },
      {
        onSuccess: () => {
          upsert.mutate(
            { id, details },
            {
              onSuccess: () => {
                const done = () => { toast('Vozilo sačuvano'); onClose(); onSaved?.(id); };
                tollPatch.mutate({ id, patch: tollPatchBody() }, { onSuccess: done, onError: done });
              },
              onError: (e) => setErr((e as Error).message),
            },
          );
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  function addOwner() {
    const nm = window.prompt('Naziv novog vlasnika (firma ili osoba):');
    if (!nm || !nm.trim()) return;
    createOwner.mutate(
      { name: nm.trim(), ownerType: 'spoljni' },
      {
        onSuccess: (res) => {
          const oid = (res as { data?: { ownerId?: string } }).data?.ownerId;
          if (oid) setOwnerId(oid);
          toast('Vlasnik dodat');
        },
        onError: (e) => toast((e as Error).message),
      },
    );
  }

  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  return (
    <Dialog
      open
      onClose={onClose}
      title={isCreate ? 'Novo vozilo' : 'Detalji vozila'}
      size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={pending} onClick={save}>Sačuvaj</Button></>}
    >
      <div className="space-y-4">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}

        <Section title="Osnovno">
          {isCreate && <FormField label="Šifra" required><Input value={assetCode} onChange={(e) => setAssetCode(e.target.value)} placeholder="npr. VOZ-001 ili BG-123-AA" /></FormField>}
          <FormField label="Naziv" required={isCreate}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Caddy Crveni" /></FormField>
          <FormField label="Registracija"><Input value={registrationPlate} onChange={(e) => setPlate(e.target.value)} placeholder="BG-123-AA" /></FormField>
          <FormField label="Vrsta vozila">
            <select value={vehicleKind} onChange={(e) => setKind(e.target.value)} className={selCls}>
              <option value="">—</option>
              {KIND_KEYS.map((k) => <option key={k} value={k}>{VEHICLE_KIND_LABEL[k]}</option>)}
            </select>
          </FormField>
          <FormField label="Vlasnik">
            <div className="flex items-center gap-2">
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={selCls}>
                <option value="">—</option>
                {(owners.data?.data ?? []).map((o) => <option key={o.ownerId} value={o.ownerId}>{o.name}</option>)}
              </select>
              <Button variant="secondary" onClick={addOwner} loading={createOwner.isPending}><Plus className="h-4 w-4" aria-hidden /> Novi</Button>
            </div>
          </FormField>
          <FormField label="Primarni vozač" hint="Uredi listu u tabu Vozači">
            <select value={primaryDriverId} onChange={(e) => setDriver(e.target.value)} className={selCls}>
              <option value="">— niko —</option>
              {(drivers.data?.data ?? []).map((dr) => (
                <option key={dr.driver_id} value={dr.driver_id}>{dr.full_name}{dr.is_internal === false ? ' (spoljni)' : ''}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Godina proizvodnje"><Input value={yearOfManufacture} onChange={(e) => setYom(e.target.value)} inputMode="numeric" /></FormField>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm text-ink">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} /> Privatno vozilo
          </label>
        </Section>

        <Section title="Identifikacija i specifikacija">
          <FormField label="Proizvođač"><Input value={manufacturer} onChange={(e) => setMfg(e.target.value)} /></FormField>
          <FormField label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></FormField>
          <FormField label="VIN"><Input value={vin} onChange={(e) => setVin(e.target.value)} /></FormField>
          <FormField label="Gorivo"><Input value={fuelType} onChange={(e) => setFuel(e.target.value)} placeholder="dizel, benzin, elektro…" /></FormField>
          <FormField label="Namena">
            <select value={usageType} onChange={(e) => setUsage(e.target.value)} className={selCls}>
              <option value="">—</option>
              {USAGE_KEYS.map((k) => <option key={k} value={k}>{USAGE_LABEL[k]}</option>)}
            </select>
          </FormField>
        </Section>

        <Section title="Rokovi i stanje">
          <FormField label="Registracija važi do"><Input type="date" value={registrationExpiresAt} onChange={(e) => setReg(e.target.value)} /></FormField>
          <FormField label="Osiguranje važi do"><Input type="date" value={insuranceExpiresAt} onChange={(e) => setIns(e.target.value)} /></FormField>
          <FormField label="Prva pomoć važi do"><Input type="date" value={firstAidExpiresAt} onChange={(e) => setFirstAid(e.target.value)} /></FormField>
          <FormField label="Kilometraža (trenutno)"><Input value={odometerKm} onChange={(e) => setOdo(e.target.value)} inputMode="numeric" /></FormField>
        </Section>

        <Section title="GPS">
          <FormField label="GPS dobavljač">
            <select value={gpsProvider} onChange={(e) => { setGps(e.target.value); if (e.target.value === 'nema') setGpsId(''); }} className={selCls}>
              {GPS_KEYS.map((k) => <option key={k} value={k}>{GPS_PROVIDER_LABEL[k]}</option>)}
            </select>
          </FormField>
          <FormField label="GPS ID uređaja"><Input value={gpsDeviceId} onChange={(e) => setGpsId(e.target.value)} disabled={gpsDisabled} placeholder="Samo ako postoji uređaj" /></FormField>
        </Section>

        <Section title="TAG (putarina)">
          <FormField label="Serijski broj TAG-a"><Input value={tollSerial} onChange={(e) => setTollSerial(e.target.value)} placeholder="npr. 0001234567" /></FormField>
          <FormField label="Izdavalac / provajder">
            <Input value={tollProvider} onChange={(e) => setTollProvider(e.target.value)} list="mntTollProviders" placeholder="npr. Putevi Srbije" />
            <datalist id="mntTollProviders"><option value="Putevi Srbije" /><option value="NIS" /><option value="DKB" /></datalist>
          </FormField>
          <div className="col-span-full"><FormField label="Napomena (TAG)"><Input value={tollNotes} onChange={(e) => setTollNotes(e.target.value)} placeholder="broj naloga, status, detalji…" /></FormField></div>
        </Section>

        <details className="rounded-panel border border-line p-3" open={hasLegacyService}>
          <summary className="cursor-pointer text-sm font-medium text-ink">Dodatno (opciono)</summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Nosivost (kg)"><Input value={payloadKg} onChange={(e) => setPayload(e.target.value)} inputMode="numeric" /></FormField>
            <FormField label="Putnička sedišta"><Input value={passengerSeats} onChange={(e) => setSeats(e.target.value)} inputMode="numeric" /></FormField>
            <FormField label="Serijski broj"><Input value={serialNumber} onChange={(e) => setSerial(e.target.value)} /></FormField>
            <FormField label="Dobavljač / leasing"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></FormField>
          </div>
          <div className="mt-3 rounded-control border-l-4 border-status-warn/60 bg-status-warn-bg/40 p-3">
            <div className="text-xs font-semibold text-ink">Legacy servisna polja (samo prikaz)</div>
            <p className="mt-1 text-2xs text-ink-secondary">Primarni izvor za servise je tab „Servisni plan". Ova polja su iz starijeg sistema — koristi Plan servisa umesto njih.</p>
            <div className="mt-2 grid grid-cols-1 gap-2 text-sm text-ink-secondary sm:grid-cols-3">
              <div>Servis rok: <span className="text-ink">{legacyService.due || '—'}</span></div>
              <div>Sledeći servis km: <span className="text-ink">{legacyService.nextKm || '—'}</span></div>
              <div>Interval km: <span className="text-ink">{legacyService.interval || '—'}</span></div>
            </div>
          </div>
        </details>

        <div>
          <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Napomene</div>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Slobodan tekst — bilo šta važno o ovom vozilu" />
        </div>
      </div>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-panel border border-line p-3">
      <legend className="px-1.5 text-xs font-semibold text-ink">{title}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}
