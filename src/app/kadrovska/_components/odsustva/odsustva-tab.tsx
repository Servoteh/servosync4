'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Tabs, type TabItem } from '../tabs';
import { SS_KEYS, ssGet, ssSet } from './shared';
import { PregledTab } from './pregled-tab';
import { ListingTab } from './listing-tab';
import { KalendarTab } from './kalendar-tab';

type SubtabKey = 'pregled' | 'listing' | 'kalendar';

const SUBTABS: TabItem<SubtabKey>[] = [
  { key: 'pregled', label: 'Pregled' },
  { key: 'listing', label: 'Listing' },
  { key: 'kalendar', label: 'Kalendar' },
];

/**
 * Kadrovska — tab „Odsustva" (P8): host sa podtabovima (paritet 1.0 absencesTab
 * host + zasebni 1.0 tabovi Kalendar/Nadoknada/Plaćeno/Odsutni koji se ovde
 * slivaju kao podtabovi). Izbor podtaba se pamti u session storage.
 */
export function OdsustvaTab({ onNavigateGrid }: { onNavigateGrid?: (empName: string, yyyymm: string) => void }) {
  const { can } = useAuth();
  void can(PERMISSIONS.KADROVSKA_READ); // modul je već iza kadrovska.read; podtabovi gate-uju svoje mutacije
  const [subtab, setSubtab] = useState<SubtabKey>(() => {
    const saved = ssGet(SS_KEYS.subtab, 'pregled') as SubtabKey;
    return SUBTABS.some((t) => t.key === saved) ? saved : 'pregled';
  });

  function change(key: SubtabKey) {
    ssSet(SS_KEYS.subtab, key);
    setSubtab(key);
  }

  return (
    <div className="space-y-4">
      <Tabs tabs={SUBTABS} value={subtab} onChange={change} ariaLabel="Odsustva — pogled" />
      {subtab === 'pregled' && <PregledTab onNavigateGrid={onNavigateGrid} />}
      {subtab === 'listing' && <ListingTab />}
      {subtab === 'kalendar' && <KalendarTab onNavigateGrid={onNavigateGrid} />}
    </div>
  );
}
