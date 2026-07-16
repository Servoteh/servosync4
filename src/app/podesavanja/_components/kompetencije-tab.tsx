'use client';

import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { useCompetenceFramework } from '@/api/podesavanja';
import { CompetenceEditor } from './competence-editor';

// ============================================================================
// Okvir kompetencija — pregled + „Uredi okvir" (P10). Pregled je paritet Drop 2
// read taba (fiksiran na Prisma camelCase: nameSr/groupId — stari read je čitao
// snake_case pa je prikazivao prazna imena). „Uredi okvir" (samo admin) otvara
// CompetenceEditor; posle svake izmene TanStack invalidira KEYS.competence →
// pregled se sam osveži. Gating taba je na page-nivou (settings.org_profile).
// ============================================================================

type Raw = Record<string, unknown>;
const rs = (o: Raw, k: string): string => (o[k] == null ? '' : String(o[k]));
const rn = (o: Raw, k: string): number => Number(o[k]);

export function KompetencijeTab() {
  const { user } = useAuth();
  const isAdmin = (user?.role ?? '').trim().toLowerCase() === 'admin';

  const q = useCompetenceFramework();
  const f = q.data?.data;

  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2 text-xs text-ink-secondary">
          {f && (
            <>
              <span className="rounded bg-surface-2 px-2 py-1">{f.profiles.length} profila</span>
              <span className="rounded bg-surface-2 px-2 py-1">{f.groups.length} grupa</span>
              <span className="rounded bg-surface-2 px-2 py-1">{f.competences.length} kompetencija</span>
              <span className="rounded bg-surface-2 px-2 py-1">{f.levels.length} opisa nivoa</span>
            </>
          )}
        </div>
        {isAdmin && (
          <Button variant="secondary" onClick={() => setEditorOpen(true)}>
            <Pencil className="h-4 w-4" aria-hidden /> Uredi okvir
          </Button>
        )}
      </div>

      {!f ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Učitavanje…</p>
      ) : (
        <div className="space-y-2">
          {f.groups.map((g) => {
            const gid = rn(g, 'id');
            const comps = f.competences.filter((c) => rn(c, 'groupId') === gid);
            return (
              <div key={gid} className="rounded-panel border border-line bg-surface p-3">
                <div className="font-semibold text-ink">{rs(g, 'nameSr') || rs(g, 'code')}</div>
                <ul className="mt-1 space-y-0.5 pl-3">
                  {comps.map((c) => (
                    <li key={rn(c, 'id')} className="text-sm text-ink-secondary">
                      • {rs(c, 'nameSr')}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {editorOpen && <CompetenceEditor onClose={() => setEditorOpen(false)} />}
    </div>
  );
}
