'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Tabs, type TabItem } from './tabs';
import { OdmoriUiProvider } from './odmori/ui';
import { SaldoTab } from './odmori/saldo-tab';
import { ZahteviTab } from './odmori/zahtevi-tab';
import { OdobravanjeTab } from './odmori/odobravanje-tab';

// Kadrovska → Odmori (P5 GODIŠNJI ODMORI, pun paritet 1.0). Tri pod-taba:
//   • Stanje — saldo (akrual/avans/istorija/gantt/excel/rešenje)
//   • Zahtevi — inbox zahteva za GO (odobri/odbij/izmeni termin/rešenje/🔔 dispatch)
//   • Za odobravanje — objedinjeni inbox 4 tipa (GO/nadoknada/plaćeno/neplaćeno)
// Vidljivost pod-tabova: read = svi; Zahtevi/Za odobravanje = vacreq_manage/admin.

type SubTab = 'stanje' | 'zahtevi' | 'odobravanje';

export function OdmoriTab() {
  const { can } = useAuth();
  const canVacreq =
    can(PERMISSIONS.KADROVSKA_VACREQ_MANAGE) || can(PERMISSIONS.KADROVSKA_VACREQ_ADMIN);

  const [sub, setSub] = useState<SubTab>('stanje');
  const [openReq, setOpenReq] = useState(0);
  const [openAppr, setOpenAppr] = useState(0);

  const tabs: TabItem<SubTab>[] = [
    { key: 'stanje', label: 'Stanje (saldo)' },
    ...(canVacreq
      ? ([
          { key: 'zahtevi', label: openReq > 0 ? `Zahtevi (${openReq})` : 'Zahtevi' },
          { key: 'odobravanje', label: openAppr > 0 ? `Za odobravanje (${openAppr})` : 'Za odobravanje' },
        ] as TabItem<SubTab>[])
      : []),
  ];

  return (
    <OdmoriUiProvider>
      <div className="space-y-4">
        <Tabs tabs={tabs} value={sub} onChange={setSub} ariaLabel="Godišnji odmori" />

        {/* Saldo se uvek montira; ostali tabovi drže count-badž preko skrivenog mount-a. */}
        <div className={sub === 'stanje' ? '' : 'hidden'}>
          <SaldoTab />
        </div>
        {canVacreq && (
          <>
            <div className={sub === 'zahtevi' ? '' : 'hidden'}>
              <ZahteviTab onOpenCount={setOpenReq} />
            </div>
            <div className={sub === 'odobravanje' ? '' : 'hidden'}>
              <OdobravanjeTab onCount={setOpenAppr} />
            </div>
          </>
        )}
      </div>
    </OdmoriUiProvider>
  );
}
