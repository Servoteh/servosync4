'use client';

// Razvojna faza 2.0 — indeks-stranica WIP modula (Talasi B–G: Sastanci, Održavanje,
// Projektni biro, Praćenje proizvodnje, Plan proizvodnje, Plan montaže, Podešavanja,
// Energetika, Lokacije). Ovi moduli su BE+FE izgrađeni (R1 read + R2 write, adversarni
// review po talasu) i spojeni na main, ali NISU prošli deploy-review/hub-integraciju
// kao Reversi/Kadrovska/Tehnologija — ovaj ekran postoji da admin/menadzment/HR mogu
// da ih testiraju PRE nego što svaki dobije trajno mesto u 1.0 hub-u (odluka Nenad
// 15.07.2026). Kartice su prosto linkovi na već postojeće rute — svaka i dalje nosi
// svoj sopstveni modul-specifičan authz gate (ova stranica samo grupiše/otkriva).
//
// Kad modul „diplomira" (prođe review + hub-integraciju), izlazi odavde i dobija
// trajnu karticu u 1.0 hub-u — vidi docs/PLAN_MODULA_MES_3.0.md §4 (1.0 repo).

import Link from 'next/link';
import {
  CalendarClock,
  CalendarRange,
  Cog,
  FlaskConical,
  FolderKanban,
  Hammer,
  IdCard,
  Radar,
  SlidersHorizontal,
  Warehouse,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';

interface RazvojItem {
  label: string;
  href: string;
  icon: LucideIcon;
  requires: Permission;
  note?: string;
}

interface RazvojDomain {
  title: string;
  items: RazvojItem[];
}

// Ista domen-taksonomija kao 1.0 docs/PLAN_MODULA_MES_3.0.md §4 i app-shell.tsx
// NAV_SECTIONS — ČISTO navigaciono grupisanje, permisije netaknute.
const RAZVOJ_DOMAINS: RazvojDomain[] = [
  {
    title: '🏭 Proizvodnja',
    items: [
      { label: 'Planiranje (Plan proizvodnje)', href: '/plan-proizvodnje', icon: CalendarRange, requires: PERMISSIONS.PLAN_PROIZVODNJE_READ },
      { label: 'Praćenje proizvodnje', href: '/pracenje-proizvodnje', icon: Radar, requires: PERMISSIONS.PRACENJE_READ },
    ],
  },
  {
    title: '🔧 Montaža i servis',
    items: [
      { label: 'Plan montaže', href: '/montaza', icon: Hammer, requires: PERMISSIONS.MONTAZA_READ },
    ],
  },
  {
    title: '📐 Projektovanje',
    items: [
      { label: 'Projektni biro', href: '/pb', icon: FolderKanban, requires: PERMISSIONS.PB_READ },
    ],
  },
  {
    title: '📦 Logistika',
    items: [
      { label: 'Lokacije delova', href: '/lokacije', icon: Warehouse, requires: PERMISSIONS.LOKACIJE_READ, note: 'poznat paritet-deficit — v. MERGE_PLAN' },
    ],
  },
  {
    title: '🛠️ Oprema i energija',
    items: [
      { label: 'Održavanje (CMMS)', href: '/odrzavanje', icon: Cog, requires: PERMISSIONS.ODRZAVANJE_READ },
      { label: 'Energetika / SCADA', href: '/energetika', icon: Zap, requires: PERMISSIONS.ENERGETIKA_READ },
    ],
  },
  {
    title: '🤝 Saradnja',
    items: [
      { label: 'Sastanci', href: '/sastanci', icon: CalendarClock, requires: PERMISSIONS.SASTANCI_READ },
    ],
  },
  {
    title: '⚙️ Sistem',
    items: [
      { label: 'Podešavanja', href: '/podesavanja', icon: SlidersHorizontal, requires: PERMISSIONS.SETTINGS_ORG_PROFILE },
    ],
  },
];

// Konteksta radi — moduli koji su VEĆ prošli ovaj isti proces i imaju trajno mesto
// u 1.0 hub-u (nisu deo testa, samo referenca da se vidi napredak).
const VEC_ZIVO: RazvojItem[] = [
  { label: 'Reversi', href: '/reversi', icon: Wrench, requires: PERMISSIONS.REVERSI_READ },
  { label: 'Kadrovska', href: '/kadrovska', icon: IdCard, requires: PERMISSIONS.KADROVSKA_READ },
];

function ModuleCard({ item }: { item: RazvojItem }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="flex items-start gap-3 rounded-panel border border-line bg-surface p-4 hover:border-accent hover:bg-surface-2"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-secondary" aria-hidden />
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{item.label}</div>
        {item.note && <div className="mt-0.5 text-xs text-ink-secondary">{item.note}</div>}
      </div>
    </Link>
  );
}

export default function RazvojnaFazaPage() {
  const { can } = useAuth();
  const readOk = can(PERMISSIONS.RAZVOJ_READ);

  if (!readOk) {
    return (
      <AppShell>
        <PageHeader title="Razvojna faza 2.0" />
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-md rounded-panel border border-line bg-surface p-6 text-center">
            <div className="text-3xl">🔒</div>
            <h2 className="mt-2 text-md font-semibold text-ink">Pristup ograničen</h2>
            <p className="mt-1 text-sm text-ink-secondary">
              Razvojna faza je dostupna samo administratorima, menadžmentu i kadrovskoj administraciji.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const visibleDomains = RAZVOJ_DOMAINS.map((d) => ({
    ...d,
    items: d.items.filter((i) => can(i.requires)),
  })).filter((d) => d.items.length > 0);
  const visibleZivo = VEC_ZIVO.filter((i) => can(i.requires));

  return (
    <AppShell>
      <PageHeader title="Razvojna faza 2.0" count="testni prikaz — Talasi B–G" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 flex items-start gap-3 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-status-warn" aria-hidden />
          <div className="text-sm text-status-warn">
            <p className="font-semibold">Moduli u razvoju — funkcionalnost se testira.</p>
            <p className="mt-0.5 text-status-warn/90">
              Ovi ekrani mogu biti nedovršeni ili nestabilni. Mutacije pišu u ISTU produkcionu
              bazu koju koristi i 1.0 — testiraj pažljivo. Kad modul prođe review, dobija
              trajno mesto u glavnom hub-u i nestaje odavde.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {visibleDomains.map((domain) => (
            <section key={domain.title}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-secondary">
                {domain.title}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {domain.items.map((item) => (
                  <ModuleCard key={item.href} item={item} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {visibleZivo.length > 0 && (
          <div className="mt-8 border-t border-line pt-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-secondary">
              ✅ Već živo (za kontekst — nisu deo testa)
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleZivo.map((item) => (
                <ModuleCard key={item.href} item={item} />
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
