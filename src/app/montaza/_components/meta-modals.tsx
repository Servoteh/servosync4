'use client';

// Plan montaže — meta modali projekat/WP (increment 5, paritet 1.0 metaModals.js).
// Dodavanje/izmena/brisanje projekta i naloga montaže (WP). Row-odluka has_edit_role
// presuđuje sy15 (403). Napomena: projekti se obično AUTO-kreiraju iz aktivacije predmeta
// (trigger) — ručni unos je paritet 1.0 „＋ Novi".
// Paritet 1.0 dopune: WP „Primeni na prazne / Primeni na sve" (default inženjer/vođa na
// faze) + projekat „Preimenuj lokaciju" (renameLocationEverywhere) — logika živi u
// plan-tab-u (callback props), modal samo prosleđuje trenutne vrednosti polja.

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { useAuth } from '@/lib/auth-context';
import { toast } from '@/lib/toast';
import {
  useUpsertProject,
  useUpdateProject,
  useDeleteProject,
  useUpsertWorkPackage,
  useUpdateWorkPackage,
  useDeleteWorkPackage,
  useUpsertPhase,
  newClientEventId,
  type MontazaProjectNode,
  type MontazaWorkPackage,
} from '@/api/plan-montaze';
import { apiDateToYmd } from '@/lib/plan-montaze/date';
import { DEFAULT_PHASES } from '@/lib/plan-montaze/constants';
import { locationColor } from '@/lib/plan-montaze/phase';

function errText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 403 ? 'Nemate dozvolu za izmenu.' : e.message;
  return 'Greška pri snimanju.';
}

/** MP-05: brisanje projekta je dozvoljeno samo LeadPM-u (1.0 isLeadPM), admin kao superuser. */
function canDeleteProject(role: string | undefined): boolean {
  return role === 'leadpm' || role === 'admin';
}

const inputCls = 'h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink';

// ------------------------------------------------------------------ Projekat

export function ProjectMetaDialog({
  open,
  onClose,
  project,
  onSaved,
  locations,
  onRenameLocation,
  allProjects,
  onDeleteLocation,
}: {
  open: boolean;
  onClose: () => void;
  /** null = novi projekat. */
  project: MontazaProjectNode | null;
  onSaved?: (id: string) => void;
  /** Postojeće lokacije projekta (za listu + „Preimenuj lokaciju" select). */
  locations?: string[];
  /**
   * Preimenuj lokaciju na SVIM fazama projekta (paritet 1.0 renameLocationEverywhere).
   * Confirm + PATCH-evi žive u plan-tab-u; vraća broj izmenjenih faza.
   */
  onRenameLocation?: (oldLoc: string, newLoc: string) => Promise<number>;
  /** Svi projekti (MP-06: provera case-insensitive duplikata koda). */
  allProjects?: MontazaProjectNode[];
  /**
   * MP-16: obriši lokaciju iz projekta. Vraća broj faza koje je koriste (>0 = u upotrebi);
   * plan-tab traži potvrdu i (ako je zadnja lokacija) vraća DEFAULT fallback. undefined = ok.
   */
  onDeleteLocation?: (loc: string) => Promise<void>;
}) {
  const { user } = useAuth();
  const upsert = useUpsertProject();
  const update = useUpdateProject();
  const del = useDeleteProject();
  const [renOld, setRenOld] = useState('');
  const [renNew, setRenNew] = useState('');
  const [renBusy, setRenBusy] = useState(false);
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
    const code = f.projectCode.trim();
    if (!code || !f.projectName.trim()) {
      setErr('Šifra i naziv su obavezni.');
      return;
    }
    // MP-06: šifra ulazi u rnCode naloga (`code/order`) — kosa crta bi razbila derivaciju.
    if (code.includes('/')) {
      setErr('Šifra ne sme da sadrži znak „/".');
      return;
    }
    // MP-06: case-insensitive provera duplikata (BE nema unique na project_code).
    const dup = (allProjects ?? []).some(
      (p) => p.id !== project?.id && String(p.project_code ?? '').trim().toLowerCase() === code.toLowerCase(),
    );
    if (dup) {
      setErr(`Projekat sa šifrom „${code}" već postoji.`);
      return;
    }
    setErr('');
    try {
      const body = {
        projectCode: code,
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
        // MP-06 (D-2): novi projekat NEMA vezan aktivan predmet → posle refetch-a nestaje
        // iz liste (pb_list_projects INNER JOIN na aktivaciju predmeta). Ne menjamo taj
        // filter (live-data bezbednost) — jasno upozoravamo umesto tihog gubitka.
        window.setTimeout(() => {
          window.alert(
            `Projekat „${code} — ${body.projectName}" je kreiran, ali NEĆE biti vidljiv u ` +
              `listi posle osvežavanja dok se odgovarajući predmet ne aktivira za ` +
              `projektovanje/montažu (modul Praćenje / Podešavanja predmeta).`,
          );
        }, 0);
      }
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function remove() {
    if (!project) return;
    // MP-05: gate + dvostepena potvrda kucanjem tačnog koda projekta (1.0 deleteActiveProject).
    if (!canDeleteProject(user?.role)) {
      setErr('Brisanje projekta može samo LeadPM.');
      return;
    }
    const typed = window.prompt(
      `OPASNA AKCIJA: brišeš projekat „${project.project_code} — ${project.project_name}" i SVE ` +
        `njegove naloge i faze. Ovo je nepovratno.\n\n` +
        `Za potvrdu upiši tačnu šifru projekta (${project.project_code}):`,
      '',
    );
    if (typed == null) return;
    if (String(typed).trim() !== String(project.project_code).trim()) {
      setErr('Šifra se ne poklapa — brisanje otkazano.');
      return;
    }
    if (!window.confirm(`Poslednja potvrda: obrisati projekat „${project.project_name}" zauvek?`)) return;
    try {
      await del.mutateAsync(project.id);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function deleteLocation(loc: string) {
    if (!onDeleteLocation) return;
    setErr('');
    try {
      await onDeleteLocation(loc);
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function renameLocation() {
    if (!onRenameLocation) return;
    const from = renOld.trim();
    const to = renNew.trim();
    if (!from || !to || from === to) return;
    setErr('');
    setRenBusy(true);
    try {
      await onRenameLocation(from, to);
      setRenOld('');
      setRenNew('');
    } catch (e) {
      setErr(errText(e));
    } finally {
      setRenBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? 'Izmena projekta' : 'Novi projekat'}
      footer={
        <>
          {/* MP-05: „Obriši projekat" vidi SAMO LeadPM (1.0 isLeadPM gate); BE presuđuje 403. */}
          {project && canDeleteProject(user?.role) && (
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

        {/* MP-16: lokacije projekta — lista sa color-dot + obriši (uz in-use proveru u plan-tab-u),
            + preimenuj kaskadno (1.0 metaModals _projectFormHtml + renameLocationEverywhere). */}
        {project && onRenameLocation && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-sm font-medium text-ink">Lokacije (na fazama)</p>
            <p className="text-xs text-ink-secondary">
              Boja lokacije prati je u tabeli i na Gantt trakama. Preimenovanje/brisanje menja sve
              faze ovog projekta koje je koriste.
            </p>
            {(locations ?? []).length > 0 ? (
              <ul className="divide-y divide-line-soft rounded-control border border-line">
                {(locations ?? []).map((l) => (
                  <li key={l} className="flex items-center gap-2 px-3 py-1.5 text-sm text-ink">
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ background: locationColor(l) }}
                      aria-hidden
                    />
                    <span className="flex-1 truncate">{l}</span>
                    {onDeleteLocation && (
                      <button
                        type="button"
                        onClick={() => deleteLocation(l)}
                        title={`Obriši lokaciju „${l}"`}
                        aria-label={`Obriši lokaciju ${l}`}
                        className="rounded-control p-1 text-status-danger hover:bg-status-danger-bg"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-disabled">Nema definisanih lokacija.</p>
            )}

            {/* Preimenuj (kaskadno na sve faze) — nove lokacije se u 2.0 dobijaju dodelom fazi
                (nema zasebne persist liste lokacija projekta; v. BE-follow-up). */}
            <div className="grid gap-3 pt-1 sm:grid-cols-2">
              <FormField label="Preimenuj lokaciju">
                <select className={inputCls} value={renOld} onChange={(e) => setRenOld(e.target.value)}>
                  <option value="">—</option>
                  {(locations ?? []).map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Novo ime">
                <input className={inputCls} value={renNew} onChange={(e) => setRenNew(e.target.value)} placeholder="npr. Dobanovci — hala 2" />
              </FormField>
            </div>
            <Button
              variant="secondary"
              onClick={renameLocation}
              loading={renBusy}
              disabled={!renOld.trim() || !renNew.trim() || renOld.trim() === renNew.trim()}
            >
              Preimenuj
            </Button>
          </div>
        )}
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
  onApplyDefaults,
  projectCode,
  nextRnOrder,
  isLastWp,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** null = novi nalog. */
  wp: MontazaWorkPackage | null;
  onSaved?: (id: string) => void;
  /**
   * „Primeni na prazne / Primeni na sve" (paritet 1.0 metaModals wpApplyEmpty/wpApplyAll):
   * prosleđuje TRENUTNE vrednosti default polja; primenu na faze radi plan-tab.
   */
  onApplyDefaults?: (mode: 'empty' | 'all', engineer: string, lead: string) => void;
  /** MP-07: šifra projekta za auto-derivaciju rnCode-a novog naloga (`code/order`). */
  projectCode?: string | null;
  /** MP-07: redni broj novog naloga (postojeći broj naloga + 1). */
  nextRnOrder?: number;
  /** MP-08: true ako je ovo poslednji nalog projekta — brisanje se zabranjuje. */
  isLastWp?: boolean;
}) {
  const upsert = useUpsertWorkPackage();
  const update = useUpdateWorkPackage();
  const del = useDeleteWorkPackage();
  const seedPhase = useUpsertPhase();
  const [seeding, setSeeding] = useState(false);
  // MP-07: novi nalog → rnCode = `code/order` (1.0 addWorkPackage). Postojeći: zadrži.
  const derivedRn =
    !wp && projectCode ? `${projectCode}/${nextRnOrder ?? 1}` : '';
  const [f, setF] = useState(() => ({
    name: wp?.name ?? '',
    rnCode: wp?.rnCode ?? derivedRn,
    location: wp?.location ?? '',
    deadline: apiDateToYmd(wp?.deadline ?? ''),
    responsibleEngineerDefault: wp?.responsibleEngineerDefault ?? '',
    montageLeadDefault: wp?.montageLeadDefault ?? '',
    assemblyDrawingNo: wp?.assemblyDrawingNo ?? '',
  }));
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  // MP-07: posle kreiranja novog naloga upiši 15 standardnih faza (1.0 createBlankWP →
  // DEFAULT_PHASES + queueCurrentWpSync). Sekvencijalno, sortOrder = index; tip iz naziva.
  async function seedDefaultPhases(newWpId: string) {
    setSeeding(true);
    try {
      for (let i = 0; i < DEFAULT_PHASES.length; i++) {
        const name = DEFAULT_PHASES[i];
        await seedPhase.mutateAsync({
          id: newClientEventId(),
          projectId,
          workPackageId: newWpId,
          phaseName: name,
          location: f.location || undefined,
          responsibleEngineer: f.responsibleEngineerDefault || undefined,
          montageLead: f.montageLeadDefault || undefined,
          sortOrder: i,
          phaseType: name.toLowerCase().includes('elektro') ? 'electrical' : 'mechanical',
        });
      }
    } finally {
      setSeeding(false);
    }
  }

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
          rnOrder: nextRnOrder,
          location: f.location,
          deadline: f.deadline || null,
          responsibleEngineerDefault: f.responsibleEngineerDefault,
          montageLeadDefault: f.montageLeadDefault,
          assemblyDrawingNo: f.assemblyDrawingNo,
        });
        // Seed default faza pre zatvaranja — best-effort: ako neka faza padne, nalog
        // ostaje (delimično seedovan), a korisnik dobija poruku.
        try {
          await seedDefaultPhases(res.data.id);
        } catch {
          toast('Nalog kreiran, ali standardne faze nisu sve upisane.');
        }
        onSaved?.(res.data.id);
      }
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function remove() {
    if (!wp) return;
    // MP-08: ne dozvoli brisanje poslednjeg naloga — projekat bez naloga razbija ostatak UI-ja
    // (1.0 deleteActiveWorkPackage: „Poslednja pozicija — ne može se obrisati").
    if (isLastWp) {
      toast('Poslednji nalog projekta — ne može se obrisati.');
      return;
    }
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
          {/* MP-08: brisanje se ne nudi za poslednji nalog projekta. */}
          {wp && !isLastWp && <Button variant="danger" onClick={remove} className="mr-auto">Obriši</Button>}
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={save} loading={upsert.isPending || update.isPending || seeding}>Snimi</Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && <div className="rounded-control border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</div>}
        {seeding && (
          <div className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink-secondary">
            Upisujem standardne faze naloga…
          </div>
        )}
        <FormField label="Naziv pozicije" required><input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} /></FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="RN kod"><input className={inputCls} value={f.rnCode} onChange={(e) => set('rnCode', e.target.value)} /></FormField>
          <FormField label="Glavni crtež sklopa"><input className={inputCls} value={f.assemblyDrawingNo} onChange={(e) => set('assemblyDrawingNo', e.target.value)} /></FormField>
          <FormField label="Lokacija"><input className={inputCls} value={f.location} onChange={(e) => set('location', e.target.value)} /></FormField>
          <FormField label="Rok"><input type="date" className={inputCls} value={f.deadline} onChange={(e) => set('deadline', e.target.value)} /></FormField>
          <FormField label="Podr. inženjer (default)"><input className={inputCls} value={f.responsibleEngineerDefault} onChange={(e) => set('responsibleEngineerDefault', e.target.value)} /></FormField>
          <FormField label="Podr. vođa (default)"><input className={inputCls} value={f.montageLeadDefault} onChange={(e) => set('montageLeadDefault', e.target.value)} /></FormField>
        </div>
        {!wp && (
          <p className="text-xs text-ink-secondary">
            Novi nalog dobija RN kod „{f.rnCode || '—'}" i {DEFAULT_PHASES.length} standardnih faza montaže
            (lokacija i podrazumevani inženjer/vođa se prepisuju na sve).
          </p>
        )}

        {/* Primena defaulta na postojeće faze (samo izmena postojećeg naloga) */}
        {wp && onApplyDefaults && (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-xs text-ink-secondary">
              Primeni podrazumevanog inženjera i vođu na faze ovog naloga.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => onApplyDefaults('empty', f.responsibleEngineerDefault, f.montageLeadDefault)}
              >
                Primeni na prazne
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!window.confirm('Primeniti podrazumevanog inženjera i vođu na SVE faze ovog naloga? Postojeće vrednosti će biti pregažene.')) return;
                  onApplyDefaults('all', f.responsibleEngineerDefault, f.montageLeadDefault);
                }}
              >
                Primeni na sve
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
