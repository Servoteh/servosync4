'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate } from '@/lib/format';
import {
  useKadrMe,
  useAttendanceDaily,
  useAttendanceCorrections,
  useSubmitCorrection,
  newClientEventId,
} from '@/api/kadrovska';

type ViewRow = Record<string, unknown>;
function pick(row: ViewRow, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

/**
 * Mobilno prisustvo (/m/prisustvo) — G6 self-service. Zaposleni vidi svoje dnevne
 * prolaze i podnosi korekciju (ulaz/izlaz + razlog) za svoj dan. Guard = profile.self;
 * RPC (own ∨ manager) presuđuje. Van AppShell-a (full-screen mobilni panel).
 */
export default function MobilePrisustvoPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const meQ = useKadrMe();
  const employeeId = meQ.data?.data.employeeId ?? undefined;

  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const dailyQ = useAttendanceDaily({ employeeId, from, to });
  const corrQ = useAttendanceCorrections({ employeeId, from, to });
  const submit = useSubmitCorrection();

  const [day, setDay] = useState(to);
  const [inT, setInT] = useState('');
  const [outT, setOutT] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  async function sendCorrection() {
    if (!employeeId) return;
    setMsg(null);
    try {
      await submit.mutateAsync({
        employeeId,
        day,
        in: inT || undefined,
        out: outT || undefined,
        reason: reason || undefined,
        clientEventId: newClientEventId(),
      });
      setMsg('Korekcija je poslata na odobravanje.');
      setInT('');
      setOutT('');
      setReason('');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Greška pri slanju korekcije.');
    }
  }

  const daily = dailyQ.data?.data ?? [];
  const corrections = corrQ.data?.data ?? [];

  return (
    <div className="min-h-screen bg-app pb-10">
      <header className="sticky top-0 z-10 border-b border-line bg-surface px-4 py-3">
        <h1 className="text-base font-semibold text-ink">Moje prisustvo</h1>
        <p className="text-xs text-ink-secondary">{user.email}</p>
      </header>

      <div className="space-y-6 p-4">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Poslednjih 30 dana</h2>
          {dailyQ.isLoading ? (
            <p className="text-sm text-ink-secondary">Učitavanje…</p>
          ) : daily.length === 0 ? (
            <p className="text-sm text-ink-secondary">Nema evidentiranih prolaza.</p>
          ) : (
            <ul className="divide-y divide-line-soft rounded-panel border border-line bg-surface">
              {daily.slice(0, 40).map((r, i) => (
                <li key={i} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{pick(r, ['day', 'datum']) ? formatDate(pick(r, ['day', 'datum'])) : '—'}</span>
                  <span className="tnums text-ink-secondary">
                    {pick(r, ['first_in', 'prvi_ulaz', 'in']) || '—'} – {pick(r, ['last_out', 'poslednji_izlaz', 'out']) || '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-ink">Prijavi korekciju</h2>
          <FormField label="Dan">
            <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Ulaz (HH:MM)">
              <Input type="time" value={inT} onChange={(e) => setInT(e.target.value)} />
            </FormField>
            <FormField label="Izlaz (HH:MM)">
              <Input type="time" value={outT} onChange={(e) => setOutT(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Razlog">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="npr. zaboravljeno kucanje" />
          </FormField>
          <Button onClick={sendCorrection} loading={submit.isPending} disabled={!employeeId} className="w-full">
            <Check className="h-4 w-4" aria-hidden /> Pošalji korekciju
          </Button>
          {!employeeId && <p className="text-xs text-status-warn">Vaš nalog nije povezan sa zaposlenim — korekcija nije moguća.</p>}
          {msg && <p className="text-sm text-ink-secondary">{msg}</p>}
        </section>

        {corrections.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-ink">Moje korekcije</h2>
            <ul className="divide-y divide-line-soft rounded-panel border border-line bg-surface">
              {corrections.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{formatDate(c.day)}</span>
                  <span className="text-ink-secondary">
                    {c.correctedIn || '—'} – {c.correctedOut || '—'} · {c.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
