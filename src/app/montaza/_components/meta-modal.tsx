'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import {
  useUpsertProject,
  useUpdateProject,
  useDeleteProject,
  useUpsertWorkPackage,
  useUpdateWorkPackage,
  useDeleteWorkPackage,
  type PmProjectRow,
  type PmWorkPackage,
} from '@/api/plan-montaze';
import { DEFAULT_LOCATIONS } from './phase-util';

/** Meta modal projekta (rok, PM/leadPM mejlovi). */
export function ProjectModal({
  open,
  onClose,
  project,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  project: PmProjectRow | null;
  canEdit: boolean;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [deadline, setDeadline] = useState('');
  const [pm, setPm] = useState('');
  const [leadpm, setLeadpm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const upsert = useUpsertProject();
  const update = useUpdateProject();
  const remove = useDeleteProject();

  useEffect(() => {
    if (!open) return;
    setCode(project?.project_code ?? '');
    setName(project?.project_name ?? '');
    setDeadline(project?.project_deadline?.slice(0, 10) ?? '');
    setPm(project?.pm_email ?? '');
    setLeadpm(project?.leadpm_email ?? '');
    setErr(null);
  }, [open, project]);

  async function save() {
    setErr(null);
    if (!code.trim() || !name.trim()) {
      setErr('Šifra i naziv projekta su obavezni.');
      return;
    }
    try {
      if (project) {
        await update.mutateAsync({
          id: project.id,
          patch: { projectCode: code.trim(), projectName: name.trim(), projectDeadline: deadline || null, pmEmail: pm, leadpmEmail: leadpm },
        });
      } else {
        await upsert.mutateAsync({ projectCode: code.trim(), projectName: name.trim(), projectDeadline: deadline || null, pmEmail: pm, leadpmEmail: leadpm });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri čuvanju.');
    }
  }
  async function del() {
    if (!project || !confirm('Obrisati projekat i sve naloge/faze?')) return;
    try {
      await remove.mutateAsync({ id: project.id });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri brisanju.');
    }
  }
  const busy = upsert.isPending || update.isPending || remove.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Izmena projekta' : 'Novi projekat'}
      footer={
        canEdit ? (
          <>
            {project && (
              <Button variant="danger" onClick={del} loading={remove.isPending} className="mr-auto">
                Obriši
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Otkaži</Button>
            <Button onClick={save} loading={busy}>Sačuvaj</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
        )
      }
    >
      <fieldset disabled={!canEdit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} />
          </FormField>
          <FormField label="Rok">
            <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Naziv" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="PM (mejl)">
            <Input value={pm} onChange={(e) => setPm(e.target.value)} />
          </FormField>
          <FormField label="Lead PM (mejl)">
            <Input value={leadpm} onChange={(e) => setLeadpm(e.target.value)} />
          </FormField>
        </div>
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </fieldset>
    </Dialog>
  );
}

/** Meta modal naloga montaže (WP): rn_code/rn_order, lokacija, default inženjer/vođa, glavni crtež sklopa. */
export function WorkPackageModal({
  open,
  onClose,
  projectId,
  wp,
  canEdit,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  wp: PmWorkPackage | null;
  canEdit: boolean;
}) {
  const [name, setName] = useState('');
  const [rnCode, setRnCode] = useState('');
  const [rnOrder, setRnOrder] = useState('');
  const [location, setLocation] = useState('');
  const [eng, setEng] = useState('');
  const [lead, setLead] = useState('');
  const [assembly, setAssembly] = useState('');
  const [deadline, setDeadline] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const upsert = useUpsertWorkPackage();
  const update = useUpdateWorkPackage();
  const remove = useDeleteWorkPackage();

  useEffect(() => {
    if (!open) return;
    setName(wp?.name ?? '');
    setRnCode(wp?.rnCode ?? '');
    setRnOrder(wp?.rnOrder != null ? String(wp.rnOrder) : '');
    setLocation(wp?.location ?? DEFAULT_LOCATIONS[0]);
    setEng(wp?.responsibleEngineerDefault ?? '');
    setLead(wp?.montageLeadDefault ?? '');
    setAssembly(wp?.assemblyDrawingNo ?? '');
    setDeadline(wp?.deadline?.slice(0, 10) ?? '');
    setErr(null);
  }, [open, wp]);

  async function save() {
    setErr(null);
    if (!name.trim()) {
      setErr('Naziv naloga je obavezan.');
      return;
    }
    const patch = {
      rnCode,
      rnOrder: rnOrder ? Number(rnOrder) : undefined,
      name: name.trim(),
      location,
      responsibleEngineerDefault: eng,
      montageLeadDefault: lead,
      assemblyDrawingNo: assembly,
      deadline: deadline || null,
    };
    try {
      if (wp) await update.mutateAsync({ id: wp.id, patch });
      else await upsert.mutateAsync({ projectId, ...patch });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri čuvanju.');
    }
  }
  async function del() {
    if (!wp || !confirm('Obrisati nalog i sve faze?')) return;
    try {
      await remove.mutateAsync({ id: wp.id });
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Greška pri brisanju.');
    }
  }
  const busy = upsert.isPending || update.isPending || remove.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={wp ? 'Izmena naloga montaže' : 'Novi nalog montaže'}
      footer={
        canEdit ? (
          <>
            {wp && (
              <Button variant="danger" onClick={del} loading={remove.isPending} className="mr-auto">
                Obriši
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>Otkaži</Button>
            <Button onClick={save} loading={busy}>Sačuvaj</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>Zatvori</Button>
        )
      }
    >
      <fieldset disabled={!canEdit} className="space-y-3">
        <FormField label="Naziv" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="RN kod">
            <Input value={rnCode} onChange={(e) => setRnCode(e.target.value)} />
          </FormField>
          <FormField label="Redosled (RN)">
            <Input type="number" value={rnOrder} onChange={(e) => setRnOrder(e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Lokacija">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} />
          </FormField>
          <FormField label="Rok">
            <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Inženjer (default)">
            <Input value={eng} onChange={(e) => setEng(e.target.value)} />
          </FormField>
          <FormField label="Vođa montaže (default)">
            <Input value={lead} onChange={(e) => setLead(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Glavni crtež sklopa">
          <Input value={assembly} onChange={(e) => setAssembly(e.target.value)} />
        </FormField>
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </fieldset>
    </Dialog>
  );
}
