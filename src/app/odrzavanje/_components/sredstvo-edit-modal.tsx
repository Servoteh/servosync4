'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useAssignableUsers,
  useCreateFacility,
  useCreateItAsset,
  useFacility,
  useFacilityTypes,
  useItAsset,
  useLocations,
  usePatchFacilityCore,
  usePatchItAssetCore,
  useUpsertFacilityDetails,
  useUpsertItDetails,
  type AssetCardDetail,
} from '@/api/odrzavanje';
import {
  CRITICALITY_LABEL,
  DEVICE_TYPE_SUGGESTIONS,
  FACILITY_TYPE_SUGGESTIONS,
  FACILITY_TYPES_HIDE_TECH,
  f,
  isoToDateInput,
} from './common';

type Kind = 'it' | 'facility';

const sval = (v: unknown): string => (v == null ? '' : String(v));
/** ISO/ts → vrednost za <input type=datetime-local> (YYYY-MM-DDTHH:mm). */
function isoToDtLocal(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v).slice(0, 16);
}

/**
 * Pun create+edit modal IT opreme / objekta (H12 — paritet 1.0 openItAssetModal
 * maintItAssetsPanel.js:140-396 i openFacilityModal maintFacilitiesPanel.js:207-475).
 * `assetId` prazan = create; inače edit. Žica: create RPC (details jsonb) → guarded
 * location patch; edit = patch core (name/mfr/model/serial/supplier + location + objedinjene
 * napomene) + PUT details. Objedinjene napomene: details.notes primarno, legacy asset.notes
 * čuva se samo dok je objedinjeno prazno (skriveno pravilo). Facility: service_contract i
 * last_inspection_at se preserv-uju (PUT je pun replace). „Odgovoran" (responsible_user_id)
 * je editabilan preko useAssignableUsers → core patch (PatchAssetCoreDto.responsibleUserId);
 * „Zadužen" (assigned_to, samo IT) ostaje uz tooltip koji objašnjava razliku.
 */
export function SredstvoEditModal({
  kind,
  assetId,
  onClose,
  onSaved,
}: {
  kind: Kind;
  assetId?: string | null;
  onClose: () => void;
  onSaved?: (id?: string) => void;
}) {
  const isCreate = !assetId;
  const itQ = useItAsset(kind === 'it' && assetId ? assetId : null);
  const facQ = useFacility(kind === 'facility' && assetId ? assetId : null);
  const q = kind === 'it' ? itQ : facQ;
  const d = q.data?.data;

  if (!isCreate && (q.isLoading || !d)) {
    return (
      <Dialog open onClose={onClose} title={kind === 'it' ? 'Detalji IT opreme' : 'Detalji objekta'}>
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      </Dialog>
    );
  }
  return <Form kind={kind} isCreate={isCreate} assetId={assetId ?? null} d={d ?? null} onClose={onClose} onSaved={onSaved} />;
}

function Form({
  kind,
  isCreate,
  assetId,
  d,
  onClose,
  onSaved,
}: {
  kind: Kind;
  isCreate: boolean;
  assetId: string | null;
  d: AssetCardDetail | null;
  onClose: () => void;
  onSaved?: (id?: string) => void;
}) {
  const isIt = kind === 'it';
  const det = (d?.details ?? {}) as Record<string, unknown>;
  const locations = useLocations();
  const facilityTypes = useFacilityTypes();
  const assignable = useAssignableUsers(true);
  const users = assignable.data?.data ?? [];

  const createIt = useCreateItAsset();
  const createFac = useCreateFacility();
  const patchItCore = usePatchItAssetCore();
  const patchFacCore = usePatchFacilityCore();
  const upsertItDetails = useUpsertItDetails();
  const upsertFacDetails = useUpsertFacilityDetails();

  const create = isIt ? createIt : createFac;
  const patchCore = isIt ? patchItCore : patchFacCore;
  const upsert = isIt ? upsertItDetails : upsertFacDetails;

  // ── Osnovno ──
  const [assetCode, setAssetCode] = useState('');
  const [name, setName] = useState(sval(d?.name));
  const [locationId, setLocationId] = useState(sval(d?.locationId));
  const [manufacturer, setMfg] = useState(sval(d?.manufacturer));
  const [model, setModel] = useState(sval(d?.model));
  const [serialNumber, setSerial] = useState(sval(d?.serialNumber));
  const [supplier, setSupplier] = useState(sval(d?.supplier));
  const [responsibleUserId, setResp] = useState(sval(d?.responsibleUserId));
  const [notes, setNotes] = useState(sval(det.notes) || sval(d?.notes));

  // ── IT-specific ──
  const [deviceType, setDeviceType] = useState(sval(det.deviceType));
  const [assignedTo, setAssignedTo] = useState(sval(det.assignedTo));
  const [hostname, setHostname] = useState(sval(det.hostname));
  const [ipAddress, setIp] = useState(sval(det.ipAddress));
  const [macAddress, setMac] = useState(sval(det.macAddress));
  const [operatingSystem, setOs] = useState(sval(det.operatingSystem));
  const [licenseKey, setLicenseKey] = useState(sval(det.licenseKey));
  const [licenseExpiresAt, setLicense] = useState(isoToDateInput(det.licenseExpiresAt));
  const [warrantyExpiresAt, setWarranty] = useState(isoToDateInput(det.warrantyExpiresAt));
  const [backupRequired, setBackupReq] = useState(det.backupRequired === true);
  const [lastBackupAt, setLastBackup] = useState(isoToDtLocal(det.lastBackupAt));

  // ── Facility-specific ──
  const [facilityType, setFacilityType] = useState(sval(det.facilityType));
  const [floorOrZone, setZone] = useState(sval(det.floorOrZone));
  const [floorAreaM2, setArea] = useState(sval(det.floorAreaM2));
  const [criticality, setCriticality] = useState(sval(det.criticality));
  const [cadastralParcels, setCadastral] = useState(sval(det.cadastralParcels));
  const [inspectionDueAt, setInspection] = useState(isoToDateInput(det.inspectionDueAt));
  const [fireSafetyDueAt, setFireSafety] = useState(isoToDateInput(det.fireSafetyDueAt));
  const [serviceProvider, setProvider] = useState(sval(det.serviceProvider));

  const [err, setErr] = useState<string | null>(null);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';
  const pending = create.isPending || patchCore.isPending || upsert.isPending;

  const hideTech = FACILITY_TYPES_HIDE_TECH.has(facilityType);
  const hasTech = !!(manufacturer || model || serialNumber || supplier);

  // Fallback lista tipova objekata (lookup je prazan na živoj bazi — F5 migracija).
  const facilityTypeOptions = useMemo(() => {
    const rows = (facilityTypes.data?.data ?? []) as Array<Record<string, unknown>>;
    if (rows.length > 0) {
      return rows.map((r) => ({ value: String(f(r, 'code') ?? ''), label: String(f(r, 'label') ?? f(r, 'code') ?? '') })).filter((o) => o.value);
    }
    const opts = FACILITY_TYPE_SUGGESTIONS.map((t) => ({ value: t, label: t }));
    if (facilityType && !FACILITY_TYPE_SUGGESTIONS.includes(facilityType)) opts.push({ value: facilityType, label: `${facilityType} (legacy)` });
    return opts;
  }, [facilityTypes.data, facilityType]);

  function buildDetails(): Record<string, unknown> {
    // Objedinjene napomene: kad korisnik unese tekst → details.notes; kad je prazno,
    // legacy ostaje na core.notes (details.notes null). (skriveno pravilo)
    const unified = notes.trim() || null;
    if (isIt) {
      return {
        device_type: deviceType.trim() || null,
        hostname: hostname.trim() || null,
        ip_address: ipAddress.trim() || null,
        mac_address: macAddress.trim() || null,
        operating_system: operatingSystem.trim() || null,
        assigned_to: assignedTo.trim() || null,
        license_key: licenseKey.trim() || null,
        license_expires_at: licenseExpiresAt || null,
        warranty_expires_at: warrantyExpiresAt || null,
        backup_required: backupRequired,
        last_backup_at: lastBackupAt ? `${lastBackupAt}:00` : null,
        notes: unified,
      };
    }
    return {
      facility_type: facilityType.trim() || null,
      floor_area_m2: floorAreaM2.trim() === '' ? null : Number(floorAreaM2),
      floor_or_zone: floorOrZone.trim() || null,
      criticality: criticality || null,
      inspection_due_at: inspectionDueAt || null,
      fire_safety_due_at: fireSafetyDueAt || null,
      service_provider: serviceProvider.trim() || null,
      cadastral_parcels: cadastralParcels.trim() || null,
      // Preserve (PUT je pun replace): last_inspection_at je READ-ONLY (postavlja ga WO
      // „Inspekcija"), service_contract se ne unosi u ovoj formi.
      last_inspection_at: isoToDateInput(det.lastInspectionAt) || null,
      service_contract: sval(det.serviceContract) || null,
      notes: unified,
    };
  }

  function validate(): string | null {
    if (isCreate && !assetCode.trim()) return 'Šifra je obavezna.';
    if (!name.trim()) return 'Naziv je obavezan.';
    if (isIt && !deviceType.trim()) return 'Tip uređaja je obavezan.';
    if (!isIt && !facilityType.trim()) return 'Tip objekta je obavezan.';
    if (!isIt && floorAreaM2.trim() !== '') {
      const a = Number(floorAreaM2);
      if (!Number.isFinite(a) || a < 0) return 'Površina (m²) mora biti nenegativan broj.';
    }
    return null;
  }

  function save() {
    const v = validate();
    if (v) return setErr(v);
    setErr(null);
    const details = buildDetails();

    if (isCreate) {
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
            const done = () => { toast(isIt ? 'IT oprema dodata' : 'Objekat dodat'); onClose(); onSaved?.(newId ?? undefined); };
            // Lokacija i Odgovoran idu kroz core patch (create RPC ih ne prima) — paritet 1.0.
            const corePatch: Record<string, unknown> = {};
            if (locationId) corePatch.locationId = locationId;
            if (responsibleUserId) corePatch.responsibleUserId = responsibleUserId;
            if (Object.keys(corePatch).length > 0 && newId) patchCore.mutate({ id: newId, patch: corePatch }, { onSuccess: done, onError: done });
            else done();
          },
          onError: (e) => setErr((e as Error).message),
        },
      );
      return;
    }

    const id = assetId!;
    // Objedinjene napomene: legacy core.notes se čuva SAMO ako je objedinjeno polje prazno.
    const legacyCoreNotes = sval(d?.notes);
    const preserveLegacy = notes.trim() === '' && !!legacyCoreNotes;
    patchCore.mutate(
      {
        id,
        patch: {
          name: name.trim(),
          manufacturer: manufacturer.trim() || null,
          model: model.trim() || null,
          serialNumber: serialNumber.trim() || null,
          supplier: supplier.trim() || null,
          locationId: locationId || null,
          responsibleUserId: responsibleUserId || null,
          notes: preserveLegacy ? legacyCoreNotes : null,
        },
      },
      {
        onSuccess: () => {
          upsert.mutate(
            { id, details },
            {
              onSuccess: () => { toast(isIt ? 'IT oprema sačuvana' : 'Objekat sačuvan'); onClose(); onSaved?.(id); },
              onError: (e) => setErr((e as Error).message),
            },
          );
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  const title = isCreate ? (isIt ? 'Nova IT oprema' : 'Novi objekat') : (isIt ? 'Detalji IT opreme' : 'Detalji objekta');

  return (
    <Dialog open onClose={onClose} title={title} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={pending} onClick={save}>Sačuvaj</Button></>}>
      <div className="space-y-4">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}

        <Section title="Osnovno">
          {isCreate && <FormField label="Šifra" required><Input value={assetCode} onChange={(e) => setAssetCode(e.target.value)} placeholder={isIt ? 'npr. IT-LPT-042' : 'npr. HALA-2 ili HVAC-H2'} /></FormField>}
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          {isIt ? (
            <FormField label="Tip uređaja" required>
              <Input value={deviceType} onChange={(e) => setDeviceType(e.target.value)} list="mntDeviceTypes" placeholder="laptop, server, printer…" />
              <datalist id="mntDeviceTypes">{DEVICE_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}</datalist>
            </FormField>
          ) : (
            <FormField label="Tip objekta" required>
              <select value={facilityType} onChange={(e) => setFacilityType(e.target.value)} className={selCls}>
                <option value="">—</option>
                {facilityTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FormField>
          )}
          <FormField label="Lokacija (CMMS)">
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={selCls}>
              <option value="">—</option>
              {(locations.data?.data ?? []).map((l) => <option key={l.locationId} value={l.locationId}>{l.name}</option>)}
            </select>
          </FormField>
          <FormField label="Odgovoran" hint={'Interni CMMS korisnik odgovoran za sredstvo (održavanje/administracija) — razlikuje se od „Zadužen" (krajnji korisnik opreme).'}>
            <select value={responsibleUserId} onChange={(e) => setResp(e.target.value)} className={selCls}>
              <option value="">— bez odgovornog —</option>
              {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>)}
            </select>
          </FormField>
          {isIt ? (
            <FormField label="Zadužen (krajnji korisnik)" hint={'Krajnji korisnik / lokacija — razlikuje se od „Odgovorni" (IT admin koji upravlja sredstvom).'}>
              <Input value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} placeholder="npr. Marko Petrović — kancelarija 12" />
            </FormField>
          ) : (
            <>
              <FormField label="Zona / sprat"><Input value={floorOrZone} onChange={(e) => setZone(e.target.value)} placeholder="npr. prizemlje, sever" /></FormField>
              <FormField label="Površina m²"><Input value={floorAreaM2} onChange={(e) => setArea(e.target.value)} inputMode="decimal" /></FormField>
              <FormField label="Kritičnost">
                <select value={criticality} onChange={(e) => setCriticality(e.target.value)} className={selCls}>
                  <option value="">—</option>
                  {Object.entries(CRITICALITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </FormField>
              <div className="col-span-full">
                <FormField label="Katastarske parcele" hint="Ako objekat stoji na više parcela, odvoji zarezima.">
                  <Input value={cadastralParcels} onChange={(e) => setCadastral(e.target.value)} placeholder="npr. 421, 422/1, 423" />
                </FormField>
              </div>
            </>
          )}
        </Section>

        {isIt ? (
          <>
            <Section title="Mreža (opciono)">
              <FormField label="Hostname"><Input value={hostname} onChange={(e) => setHostname(e.target.value)} /></FormField>
              <FormField label="IP adresa"><Input value={ipAddress} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.42" /></FormField>
              <FormField label="MAC adresa"><Input value={macAddress} onChange={(e) => setMac(e.target.value)} /></FormField>
              <FormField label="Operativni sistem"><Input value={operatingSystem} onChange={(e) => setOs(e.target.value)} placeholder="Windows 11, Ubuntu 22.04…" /></FormField>
            </Section>

            <Section title="Licenca i garancija">
              <FormField label="Licenca / ključ"><Input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} /></FormField>
              <FormField label="Licenca važi do"><Input type="date" value={licenseExpiresAt} onChange={(e) => setLicense(e.target.value)} /></FormField>
              <FormField label="Garancija važi do"><Input type="date" value={warrantyExpiresAt} onChange={(e) => setWarranty(e.target.value)} /></FormField>
            </Section>

            <Section title="Backup i monitoring">
              <label className="col-span-full flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={backupRequired} onChange={(e) => setBackupReq(e.target.checked)} /> Backup je obavezan za ovo sredstvo</label>
              <FormField label="Poslednji backup" hint={'Za automatske backup-e (Veeam, rsync) ostavi prazno — biće „nema backup" dok ne uneseš datum.'}><Input type="datetime-local" value={lastBackupAt} onChange={(e) => setLastBackup(e.target.value)} /></FormField>
            </Section>
          </>
        ) : (
          <Section title="Rokovi i serviser">
            <FormField label="Inspekcija rok"><Input type="date" value={inspectionDueAt} onChange={(e) => setInspection(e.target.value)} /></FormField>
            <FormField label="PP zaštita rok"><Input type="date" value={fireSafetyDueAt} onChange={(e) => setFireSafety(e.target.value)} /></FormField>
            <FormField label="Poslednja inspekcija (auto)" hint={'Postavlja se automatski kad se zatvori WO „Inspekcija" za ovaj objekat.'}>
              <div className="flex h-9 items-center rounded-control border border-line bg-surface-2/60 px-2 text-sm text-ink-secondary">{isoToDateInput(det.lastInspectionAt) || '— još nije zabeleženo'}</div>
            </FormField>
            <FormField label="Serviser / ugovarač"><Input value={serviceProvider} onChange={(e) => setProvider(e.target.value)} placeholder="naziv firme" /></FormField>
          </Section>
        )}

        <details className="rounded-panel border border-line p-3" open={!hideTech && hasTech}>
          <summary className="cursor-pointer text-sm font-medium text-ink">{isIt ? 'Hardver (opciono)' : 'Tehnički podaci (opciono)'}</summary>
          {!isIt && hideTech && <p className="mt-2 text-2xs text-ink-secondary">Za hale/zgrade/magacine ova polja obično nisu potrebna — preskoči ako nije primenljivo.</p>}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label={isIt ? 'Proizvođač' : 'Proizvođač / sistem'}><Input value={manufacturer} onChange={(e) => setMfg(e.target.value)} /></FormField>
            <FormField label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></FormField>
            <FormField label={isIt ? 'Serijski broj' : 'Serijski / inventarski broj'}><Input value={serialNumber} onChange={(e) => setSerial(e.target.value)} /></FormField>
            <FormField label="Dobavljač"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></FormField>
          </div>
        </details>

        <div>
          <div className="mb-1 text-2xs uppercase tracking-wider text-ink-secondary">Napomene</div>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={isIt ? 'Slobodan tekst — istorija servisa, konfiguracije, link na dokumentaciju…' : 'Slobodan tekst — bilo šta važno o ovom objektu'} />
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
