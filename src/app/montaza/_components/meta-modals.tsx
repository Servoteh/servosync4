'use client';

// Plan montaže — meta modali projekat/WP (increment 5, paritet 1.0 metaModals.js).
// Dodavanje/izmena/brisanje projekta i naloga montaže (WP). Row-odluka has_edit_role
// presuđuje sy15 (403). Napomena: projekti se obično AUTO-kreiraju iz aktivacije predmeta
// (trigger) — ručni unos je paritet 1.0 „＋ Novi".

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import {
  useUpsertProject,
  useUpdateProject,
  useDeleteProject,
  useUpsertWorkPackage,
  useUpdateWorkPackage,
  useDeleteWorkPackage,
  type MontazaProjectNode,
  type MontazaWorkPackage,
} from '@/api/plan-montaze';
import { apiDateToYmd } from '@/lib/plan-montaze/date';

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 403 ? 'Nemate dozvolu za izmenu.' : e.message;
  return 'Greška pri snimanju.';
}

const inputCls = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink';

// ------------------------------------------------------------------ Projekat

export function ProjectMetaDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** null = novi projekat. */
  project: MontazaProjectNode | null;
  onSaved?: (id: string) => void;
}) {
  const upsert = useUpsertProject();
  const update = useUpdateProject();
  const del = useDeleteProject();
  const [f, setF] = useState(() => ({
    projectCode: project?.project_code ?? '',
    projectName: project?.project_name ?? '',
    projectm: project?.projectm ?? '',
    projectDeadline: apiDateToYmd(project?.project_deadline ?? ''),
    pmEmail: project?.pm_email ?? '',
    leadpmEmail: project?.leadpm_email ?? '',
    status: project?.status ?? 'active',
  }));
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.projectCode.trim() || !f.projectName.trim()) {
      setErr('Šifra i naziv su obavezni.');
      return;
    }
    setErr('');
    try {
      const body = {
        projectCode: f.projectCode.trim(),
        projectName: f.projectName.trim(),
        projectm: f.projectm,
        projectDeadline: f.projectDeadline || null,
        pmEmail: f.pmEmail,
        leadpmEmail: f.leadpmEmail,
        status: f.status,
      };
      if (project) {
        await update.mutateAsync({ id: project.id, ...body });
        onSaved?.(project.id);
      } else {
        const res = await upsert.mutateAsync(body);
        onSaved?.(res.data.id);
      }
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function remove() {
    if (!project) return;
    if (!window.confirm(`Obrisati projekat „${project.project_name}" sa svim nalozima i fazama?`)) return;
    try {
      await del.mutateAsync(project.id);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Izmena projekta' : 'Novi projekat'}
      footer={
        <>
          {project && (
            <Button variant="danger" onClick={remove} className="mr-auto">Obriši</Button>
          )}
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={save} loading={upsert.isPending || update.isPending}>Snimi</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</div>}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Šifra" required><input className={inputCls} value={f.projectCode} onChange={(e) => set('projectCode', e.target.value)} /></FormField>
          <FormField label="Status">
            <select className={inputCls} value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Aktivan</option>
              <option value="completed">Završen</option>
              <option value="archived">Arhiviran</option>
            </select>
          </FormField>
        </div>
        <FormField label="Naziv" required><input className={inputCls} value={f.projectName} onChange={(e) => set('projectName', e.target.value)} /></FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Rukovodilac (PM)"><input className={inputCls} value={f.projectm} onChange={(e) => set('projectm', e.target.value)} /></FormField>
          <FormField label="Rok"><input type="date" className={inputCls} value={f.projectDeadline} onChange={(e) => set('projectDeadline', e.target.value)} /></FormField>
          <FormField label="PM e-mail (podsetnici)"><input className={inputCls} value={f.pmEmail} onChange={(e) => set('pmEmail', e.target.value)} /></FormField>
          <FormField label="Lead PM e-mail"><input className={inputCls} value={f.leadpmEmail} onChange={(e) => set('leadpmEmail', e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ Nalog (WP)

export function WpMetaDialog({
  open,
  onClose,
  projectId,
  wp,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** null = novi nalog. */
  wp: MontazaWorkPackage | null;
  onSaved?: (id: string) => void;
}) {
  const upsert = useUpsertWorkPackage();
  const update = useUpdateWorkPackage();
  const del = useDeleteWorkPackage();
  const [f, setF] = useState(() => ({
    name: wp?.name ?? '',
    rnCode: wp?.rnCode ?? '',
    location: wp?.location ?? '',
    deadline: apiDateToYmd(wp?.deadline ?? ''),
    responsibleEngineerDefault: wp?.responsibleEngineerDefault ?? '',
    montageLeadDefault: wp?.montageLeadDefault ?? '',
    assemblyDrawingNo: wp?.assemblyDrawingNo ?? '',
  }));
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.name.trim()) {
      setErr('Naziv naloga je obavezan.');
      return;
    }
    setErr('');
    try {
      if (wp) {
        await update.mutateAsync({
          id: wp.id,
          name: f.name.trim(),
          rnCode: f.rnCode,
          location: f.location,
          deadline: f.deadline || null,
          responsibleEngineerDefault: f.responsibleEngineerDefault,
          montageLeadDefault: f.montageLeadDefault,
          assemblyDrawingNo: f.assemblyDrawingNo,
        });
        onSaved?.(wp.id);
      } else {
        const res = await upsert.mutateAsync({
          projectId,
          name: f.name.trim(),
          rnCode: f.rnCode,
          location: f.location,
          deadline: f.deadline || null,
          responsibleEngineerDefault: f.responsibleEngineerDefault,
          montageLeadDefault: f.montageLeadDefault,
          assemblyDrawingNo: f.assemblyDrawingNo,
        });
        onSaved?.(res.data.id);
      }
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function remove() {
    if (!wp) return;
    if (!window.confirm(`Obrisati nalog „${wp.name}" sa svim fazama?`)) return;
    try {
      await del.mutateAsync(wp.id);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={wp ? 'Izmena naloga montaže' : 'Novi nalog montaže'}
      footer={
        <>
          {wp && <Button variant="danger" onClick={remove} className="mr-auto">Obriši</Button>}
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={save} loading={upsert.isPending || update.isPending}>Snimi</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</div>}
        <FormField label="Naziv pozicije" required><input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="RN kod"><input className={inputCls} value={f.rnCode} onChange={(e) => set('rnCode', e.target.value)} /></FormField>
          <FormField label="Glavni crtež sklopa"><input className={inputCls} value={f.assemblyDrawingNo} onChange={(e) => set('assemblyDrawingNo', e.target.value)} /></FormField>
          <FormField label="Lokacija"><input className={inputCls} value={f.location} onChange={(e) => set('location', e.target.value)} /></FormField>
          <FormField label="Rok"><input type="date" className={inputCls} value={f.deadline} onChange={(e) => set('deadline', e.target.value)} /></FormField>
          <FormField label="Podr. inženjer (default)"><input className={inputCls} value={f.responsibleEngineerDefault} onChange={(e) => set('responsibleEngineerDefault', e.target.value)} /></FormField>
          <FormField label="Podr. vođa (default)"><input className={inputCls} value={f.montageLeadDefault} onChange={(e) => set('montageLeadDefault', e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}
