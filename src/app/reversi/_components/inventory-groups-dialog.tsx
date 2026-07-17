'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { toast } from '@/lib/toast';
import {
  useAddSubgroup,
  useAddSubsubgroup,
  useDeleteSubgroup,
  useDeleteSubsubgroup,
  useInventoryClassificationUsage,
  useInventoryTree,
  useRenameClassification,
  type ClassificationKind,
} from '@/api/reversi';

/**
 * Modal „Grupe" — stablo klasifikacije (grupa → podgrupa → podpodgrupa) + CRUD
 * (RA-25 stablo/brojači/🔒, RA-26 dodavanje, RA-27 preimenovanje svih nivoa,
 * RA-28 brisanje korisničkih sa upozorenjem). Paritet 1.0 `inventoryGroupsModal.js`.
 * Sistemski nivoi (is_seeded) se ne brišu, ali se svi mogu preimenovati.
 */

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';
const ICON_BTN =
  'rounded-control p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink';

type AddForm =
  | { kind: 'subgroup'; groupCode: string; groupLabel: string }
  | { kind: 'subsubgroup'; subgroupId: string; subgroupLabel: string }
  | null;
type RenameForm = { kind: ClassificationKind; id: string; current: string } | null;

export function InventoryGroupsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tree = useInventoryTree();
  const usage = useInventoryClassificationUsage();
  const addSub = useAddSubgroup();
  const addSubsub = useAddSubsubgroup();
  const rename = useRenameClassification();
  const delSub = useDeleteSubgroup();
  const delSubsub = useDeleteSubsubgroup();

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());
  const [addForm, setAddForm] = useState<AddForm>(null);
  const [renameForm, setRenameForm] = useState<RenameForm>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const groups = tree.data?.data.groups ?? [];
  const subgroups = tree.data?.data.subgroups ?? [];
  const subsubgroups = tree.data?.data.subsubgroups ?? [];
  const u = usage.data?.data ?? { tools: {}, cutting: {}, subsubs: {} };

  // Podrazumevano otvori sve grupe pri prvom učitavanju.
  useEffect(() => {
    if (open && groups.length && expandedGroups.size === 0) {
      setExpandedGroups(new Set(groups.map((g) => g.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groups.length]);

  useEffect(() => {
    if (!open) {
      setAddForm(null);
      setRenameForm(null);
      setDraft('');
    }
  }, [open]);

  const subsByGroup = useMemo(() => {
    const m = new Map<string, typeof subgroups>();
    for (const s of subgroups) {
      const arr = m.get(s.groupId) ?? [];
      arr.push(s);
      m.set(s.groupId, arr);
    }
    return m;
  }, [subgroups]);

  const subsubsBySub = useMemo(() => {
    const m = new Map<string, typeof subsubgroups>();
    for (const ss of subsubgroups) {
      const arr = m.get(ss.subgroupId) ?? [];
      arr.push(ss);
      m.set(ss.subgroupId, arr);
    }
    return m;
  }, [subsubgroups]);

  function subgroupUsed(sgId: string): number {
    return (u.tools[sgId] ?? 0) + (u.cutting[sgId] ?? 0);
  }

  function toggle(set: Set<string>, id: string, apply: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  }

  function openAdd(f: AddForm) {
    setAddForm(f);
    setRenameForm(null);
    setDraft('');
  }
  function openRename(f: RenameForm) {
    setRenameForm(f);
    setAddForm(null);
    setDraft(f?.current ?? '');
  }

  async function saveAdd() {
    const label = draft.trim();
    if (!label) {
      toast('Unesite naziv');
      return;
    }
    if (!addForm) return;
    setBusy(true);
    try {
      if (addForm.kind === 'subgroup') {
        await addSub.mutateAsync({ groupCode: addForm.groupCode, label });
        toast('Podgrupa dodata');
      } else {
        await addSubsub.mutateAsync({ subgroupId: addForm.subgroupId, label });
        toast('Podpodgrupa dodata');
      }
      setAddForm(null);
      setDraft('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Dodavanje nije uspelo');
    } finally {
      setBusy(false);
    }
  }

  async function saveRename() {
    const label = draft.trim();
    if (!renameForm) return;
    if (!label) {
      toast('Unesite naziv');
      return;
    }
    if (label === renameForm.current) {
      setRenameForm(null);
      return;
    }
    setBusy(true);
    try {
      await rename.mutateAsync({ kind: renameForm.kind, id: renameForm.id, label });
      toast(`Preimenovano u „${label}"`);
      setRenameForm(null);
      setDraft('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Preimenovanje nije uspelo');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSubgroup(sgId: string, label: string) {
    const used = subgroupUsed(sgId);
    const childSs = (subsubsBySub.get(sgId) ?? []).filter((x) => !x.isSeeded);
    let msg = `Obrisati podgrupu „${label}"?`;
    if (used) msg += `\n\n${used} artikala će postati nesvrstano.`;
    if (childSs.length) msg += `\n\nPrvo će biti obrisano ${childSs.length} podpodgrupa.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      // FK RESTRICT na podpodgrupe — prvo briši korisničke podpodgrupe (paritet 1.0).
      for (const ss of childSs) await delSubsub.mutateAsync(ss.id);
      await delSub.mutateAsync(sgId);
      toast('Podgrupa obrisana');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Brisanje nije uspelo');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSubsubgroup(ssId: string, label: string) {
    const used = u.subsubs[ssId] ?? 0;
    let msg = `Obrisati podpodgrupu „${label}"?`;
    if (used) msg += `\n\n${used} artikala će ostati bez podpodgrupe.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await delSubsub.mutateAsync(ssId);
      toast('Podpodgrupa obrisana');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Brisanje nije uspelo');
    } finally {
      setBusy(false);
    }
  }

  function RenameInline() {
    return (
      <div className="my-1 flex flex-wrap items-center gap-2 rounded-control border border-accent/30 bg-accent-subtle px-2 py-1.5">
        <span className="text-xs text-ink-secondary">Novi naziv:</span>
        <input
          className={`${INPUT} w-56`}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void saveRename()}
        />
        <Button variant="primary" loading={busy} onClick={() => void saveRename()}>
          Preimenuj
        </Button>
        <Button variant="secondary" onClick={() => setRenameForm(null)}>
          Otkaži
        </Button>
      </div>
    );
  }

  function AddInline({ label }: { label: string }) {
    return (
      <div className="my-1 flex flex-wrap items-center gap-2 rounded-control border border-accent/30 bg-accent-subtle px-2 py-1.5">
        <span className="text-xs text-ink-secondary">{label}</span>
        <input
          className={`${INPUT} w-56`}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void saveAdd()}
        />
        <Button variant="primary" loading={busy} onClick={() => void saveAdd()}>
          Dodaj
        </Button>
        <Button variant="secondary" onClick={() => setAddForm(null)}>
          Otkaži
        </Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Grupe, podgrupe i podpodgrupe" size="lg">
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-ink-secondary">
          Sistemski nivoi (<Lock className="inline h-3 w-3" aria-hidden />) ne mogu se brisati, ali
          se svi nivoi mogu preimenovati. Korisničke podgrupe i podpodgrupe možete dodavati i
          uklanjati. Brisanje podgrupe ostavlja artikle nesvrstane.
        </p>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setExpandedGroups(new Set(groups.map((g) => g.id)))}>
            Otvori sve
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setExpandedGroups(new Set());
              setExpandedSubs(new Set());
            }}
          >
            Zatvori sve
          </Button>
        </div>

        {tree.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje klasifikacije…</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema klasifikacije.</p>
        ) : (
          <div className="space-y-1">
            {groups.map((g) => {
              const gOpen = expandedGroups.has(g.id);
              const subs = subsByGroup.get(g.id) ?? [];
              return (
                <div key={g.id} className="rounded-control border border-line">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <button
                      type="button"
                      className={ICON_BTN}
                      aria-expanded={gOpen}
                      onClick={() => toggle(expandedGroups, g.id, setExpandedGroups)}
                    >
                      {gOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <strong className="text-sm">{g.label}</strong>
                    <span className="text-2xs text-ink-disabled">{g.code}</span>
                    <span className="text-2xs text-ink-secondary">{subs.length} podgr.</span>
                    <button
                      type="button"
                      className={`${ICON_BTN} ml-auto`}
                      title="Preimenuj"
                      onClick={() => openRename({ kind: 'group', id: g.id, current: g.label })}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <Lock className="h-4 w-4 text-ink-disabled" aria-label="Sistemska grupa" />
                  </div>

                  {renameForm?.kind === 'group' && renameForm.id === g.id && (
                    <div className="px-2 pb-1">
                      <RenameInline />
                    </div>
                  )}

                  {gOpen && (
                    <div className="space-y-1 border-t border-line px-2 py-1.5">
                      {subs.length === 0 && (
                        <p className="px-1 text-2xs text-ink-disabled">Nema podgrupa</p>
                      )}
                      {subs.map((sg) => {
                        const sgOpen = expandedSubs.has(sg.id);
                        const ssList = subsubsBySub.get(sg.id) ?? [];
                        const used = subgroupUsed(sg.id);
                        return (
                          <div key={sg.id} className="rounded-control bg-surface-2/50">
                            <div className="flex items-center gap-2 px-2 py-1">
                              <button
                                type="button"
                                className={ICON_BTN}
                                aria-expanded={sgOpen}
                                onClick={() => toggle(expandedSubs, sg.id, setExpandedSubs)}
                              >
                                {sgOpen ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                              <span className="text-sm">{sg.label}</span>
                              <span className="text-2xs text-ink-disabled">{sg.code}</span>
                              {used > 0 && (
                                <span className="text-2xs text-ink-secondary">{used} st.</span>
                              )}
                              <button
                                type="button"
                                className={`${ICON_BTN} ml-auto`}
                                title="Preimenuj"
                                onClick={() => openRename({ kind: 'subgroup', id: sg.id, current: sg.label })}
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              {sg.isSeeded ? (
                                <Lock className="h-4 w-4 text-ink-disabled" aria-label="Sistemska podgrupa" />
                              ) : (
                                <button
                                  type="button"
                                  className={`${ICON_BTN} text-status-danger`}
                                  title="Obriši podgrupu"
                                  disabled={busy}
                                  onClick={() => void deleteSubgroup(sg.id, sg.label)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </div>

                            {renameForm?.kind === 'subgroup' && renameForm.id === sg.id && (
                              <div className="px-2 pb-1">
                                <RenameInline />
                              </div>
                            )}

                            {sgOpen && (
                              <div className="space-y-0.5 px-2 pb-1.5 pl-8">
                                {ssList.length === 0 && (
                                  <p className="text-2xs text-ink-disabled">Nema podpodgrupa</p>
                                )}
                                {ssList.map((ss) => {
                                  const ssUsed = u.subsubs[ss.id] ?? 0;
                                  return (
                                    <div key={ss.id}>
                                      <div className="flex items-center gap-2 py-0.5">
                                        <span className="text-sm">{ss.label}</span>
                                        <span className="text-2xs text-ink-disabled">{ss.code}</span>
                                        {ssUsed > 0 && (
                                          <span className="text-2xs text-ink-secondary">
                                            {ssUsed} st.
                                          </span>
                                        )}
                                        <button
                                          type="button"
                                          className={`${ICON_BTN} ml-auto`}
                                          title="Preimenuj"
                                          onClick={() =>
                                            openRename({ kind: 'subsubgroup', id: ss.id, current: ss.label })
                                          }
                                        >
                                          <Pencil className="h-4 w-4" />
                                        </button>
                                        {ss.isSeeded ? (
                                          <Lock
                                            className="h-4 w-4 text-ink-disabled"
                                            aria-label="Sistemska podpodgrupa"
                                          />
                                        ) : (
                                          <button
                                            type="button"
                                            className={`${ICON_BTN} text-status-danger`}
                                            title="Obriši podpodgrupu"
                                            disabled={busy}
                                            onClick={() => void deleteSubsubgroup(ss.id, ss.label)}
                                          >
                                            <Trash2 className="h-4 w-4" />
                                          </button>
                                        )}
                                      </div>
                                      {renameForm?.kind === 'subsubgroup' && renameForm.id === ss.id && (
                                        <RenameInline />
                                      )}
                                    </div>
                                  );
                                })}

                                {addForm?.kind === 'subsubgroup' && addForm.subgroupId === sg.id ? (
                                  <AddInline label={`Nova podpodgrupa u „${sg.label}":`} />
                                ) : (
                                  <button
                                    type="button"
                                    className="mt-1 inline-flex items-center gap-1 text-2xs text-accent hover:underline"
                                    onClick={() =>
                                      openAdd({ kind: 'subsubgroup', subgroupId: sg.id, subgroupLabel: sg.label })
                                    }
                                  >
                                    <Plus className="h-3 w-3" /> Podpodgrupa
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {addForm?.kind === 'subgroup' && addForm.groupCode === g.code ? (
                        <AddInline label={`Nova podgrupa u „${g.label}":`} />
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                          onClick={() => openAdd({ kind: 'subgroup', groupCode: g.code, groupLabel: g.label })}
                        >
                          <Plus className="h-3.5 w-3.5" /> Podgrupa
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
