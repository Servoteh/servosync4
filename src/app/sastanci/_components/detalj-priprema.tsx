'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { DictateButton } from '@/components/voice-controls';
import {
  useAddUcesnik,
  useRemindUnprepared,
  useRemoveUcesnik,
  useUpdateUcesnik,
  type SastanakFull,
  type Ucesnik,
} from '@/api/sastanci';
import { DirectoryPicker } from './directory-picker';
import { INPUT_CLS } from './common';

/** Priprema tab — učesnici, RSVP pregled, pripremljen + tekst, podsetnik (paritet 1.0). */
export function DetaljPriprema({ sast, canEdit }: { sast: SastanakFull; canEdit: boolean }) {
  const add = useAddUcesnik();
  const remind = useRemindUnprepared();
  const [newU, setNewU] = useState<{ email: string; label?: string } | null>(null);

  const ucesnici = sast.ucesnici;
  const locked = sast.status === 'zakljucan' || sast.status === 'otkazan';
  const editable = canEdit && !locked;

  const dolazi = ucesnici.filter((u) => u.rsvpStatus === 'dolazim').length;
  const neDolazi = ucesnici.filter((u) => u.rsvpStatus === 'ne_dolazim').length;
  const bezOdgovora = ucesnici.length - dolazi - neDolazi;
  const pripremljeno = ucesnici.filter((u) => u.pripremljen).length;

  return (
    <div className="space-y-4">
      {/* RSVP pregled */}
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-control bg-status-success-bg px-2 py-1 text-status-success">Dolazi: {dolazi}</span>
        <span className="rounded-control bg-status-danger-bg px-2 py-1 text-status-danger">Ne dolazi: {neDolazi}</span>
        <span className="rounded-control bg-surface-2 px-2 py-1 text-ink-secondary">Bez odgovora: {bezOdgovora}</span>
        <span className="ml-auto self-center text-ink-secondary">Pripremljeno: {pripremljeno}/{ucesnici.length}</span>
      </div>

      {editable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <DirectoryPicker value={newU} onChange={setNewU} placeholder="Dodaj učesnika…" />
          </div>
          <Button
            variant="secondary"
            disabled={!newU}
            loading={add.isPending}
            onClick={() => {
              if (newU) {
                add.mutate({ id: sast.id, email: newU.email, label: newU.label });
                setNewU(null);
              }
            }}
          >
            Dodaj
          </Button>
          <Can permission={PERMISSIONS.SASTANCI_MANAGE}>
            <Button variant="ghost" loading={remind.isPending} onClick={() => remind.mutate({ id: sast.id })}>
              Podseti nepripremljene
            </Button>
          </Can>
        </div>
      )}

      <div className="space-y-2">
        {ucesnici.map((u) => (
          <UcesnikRow key={u.email} sastanakId={sast.id} u={u} editable={editable} />
        ))}
        {ucesnici.length === 0 && <p className="text-sm text-ink-secondary">Nema učesnika.</p>}
      </div>
    </div>
  );
}

function UcesnikRow({ sastanakId, u, editable }: { sastanakId: string; u: Ucesnik; editable: boolean }) {
  const update = useUpdateUcesnik();
  const remove = useRemoveUcesnik();
  const [priprema, setPriprema] = useState(u.priprema ?? '');

  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-sm font-medium text-ink">{u.label || u.email}</span>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={u.pozvan} disabled={!editable} onChange={(e) => update.mutate({ id: sastanakId, email: u.email, patch: { pozvan: e.target.checked } })} /> Pozvan
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={u.prisutan} disabled={!editable} onChange={(e) => update.mutate({ id: sastanakId, email: u.email, patch: { prisutan: e.target.checked } })} /> Prisutan
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={u.pripremljen} disabled={!editable} onChange={(e) => update.mutate({ id: sastanakId, email: u.email, patch: { pripremljen: e.target.checked } })} /> Pripremljen
        </label>
        {u.rsvpStatus && (
          <span className={`text-xs ${u.rsvpStatus === 'dolazim' ? 'text-status-success' : 'text-status-danger'}`}>
            {u.rsvpStatus === 'dolazim' ? '✅ dolazi' : '❌ ne dolazi'}
          </span>
        )}
        {editable && (
          <button title="Ukloni" className="rounded-control border border-line p-1 text-status-danger hover:bg-surface-2" onClick={() => { if (confirm('Ukloniti učesnika?')) remove.mutate({ id: sastanakId, email: u.email }); }}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {editable && (
        <div className="mt-2 flex items-start gap-1">
          <textarea
            className={`${INPUT_CLS} min-h-12 flex-1`}
            value={priprema}
            onChange={(e) => setPriprema(e.target.value)}
            onBlur={() => { if (priprema !== (u.priprema ?? '')) update.mutate({ id: sastanakId, email: u.email, patch: { priprema } }); }}
            placeholder="Priprema / zaduženje za ovaj sastanak…"
          />
          <DictateButton context="zapisnik" onText={(txt) => setPriprema((v) => (v ? `${v} ${txt}` : txt))} />
        </div>
      )}
    </div>
  );
}
