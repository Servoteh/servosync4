'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { toast } from '@/lib/toast';
import { formatDecimal } from '@/lib/format';
import {
  usePayoutReport,
  useCloseMonth,
  useTariffs,
  usePutTariffs,
  type PayoutUserRow,
} from '@/api/zahtevi';

/** Tekući mesec „YYYY-MM". */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Tab „Nagrade" (admin, MODULE_SPEC §12.2 / §11 F4): (a) mesečni obračun — picker
 * meseca, tabela po korisniku (expand stavke), ukupno, „Zaključi mesec"; (b) tarifa —
 * 5 iznosa sa izmenom (PUT; nov red od danas). V1 = izveštaj za ručnu isplatu (§13.10).
 */
export function NagradeTab() {
  return (
    <div className="space-y-6">
      <MonthlyPayout />
      <TariffEditor />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── mesečni obračun */

function MonthlyPayout() {
  const [month, setMonth] = useState(currentMonth());
  const report = usePayoutReport(month);
  const closeMonth = useCloseMonth();
  const [confirmClose, setConfirmClose] = useState(false);

  const data = report.data?.data;
  const closed = data?.closed ?? false;
  const empty = (data?.itemCount ?? 0) === 0;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Mesec
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-9 rounded-control border border-line bg-surface px-3 text-sm text-ink focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>
          {data && (
            <div className="flex flex-col">
              <span className="text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                Ukupno {closed ? '(zaključen)' : ''}
              </span>
              <span className="tnums text-xl font-semibold text-ink">
                {formatDecimal(data.total)} <span className="text-sm text-ink-secondary">RSD</span>
              </span>
            </div>
          )}
        </div>
        <Button
          variant="primary"
          disabled={closed || empty || report.isLoading}
          loading={closeMonth.isPending}
          onClick={() => setConfirmClose(true)}
          title={
            closed
              ? 'Mesec je već zaključen.'
              : empty
                ? 'Nema potvrđenih nagrada za ovaj mesec.'
                : 'Sve potvrđene nagrade prelaze u „Isplaćeno".'
          }
        >
          {closed ? 'Zaključen' : 'Zaključi mesec'}
        </Button>
      </div>

      {report.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(report.error as Error).message}
        </div>
      )}

      {closed && (
        <p className="rounded-control bg-surface-2 px-3 py-2 text-2xs text-ink-secondary">
          Mesec je zaključen — stavke su prebačene u „Isplaćeno" i više se ne menjaju. Nove
          potvrde ocena idu u naredni otvoreni mesec.
        </p>
      )}

      {data && data.users.length > 0 ? (
        <div className="overflow-hidden rounded-panel border border-line">
          {data.users.map((u) => (
            <PayoutUserBlock key={u.userId} user={u} />
          ))}
        </div>
      ) : (
        !report.isLoading && (
          <EmptyState
            title="Nema potvrđenih nagrada"
            hint="Za izabrani mesec nema potvrđenih ocena. Potvrdite ocene u Inbox-u ili detalju zahteva."
          />
        )
      )}

      <ConfirmDialog
        open={confirmClose}
        title={`Zaključivanje meseca ${month}`}
        message={'Sve potvrđene nagrade ovog meseca prelaze u „Isplaćeno" i postaju nepromenjive. Ova radnja se ne može poništiti. Nastaviti?'}
        confirmLabel="Zaključi mesec"
        loading={closeMonth.isPending}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() =>
          closeMonth.mutate(month, {
            onSuccess: (res) => {
              setConfirmClose(false);
              toast(`Mesec zaključen — ${res.data.paidCount} nagrada.`);
            },
            onError: (e) => toast((e as Error).message),
          })
        }
      />
    </section>
  );
}

function PayoutUserBlock({ user }: { user: PayoutUserRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const scoreSummary = useMemo(
    () =>
      Object.entries(user.countByScore)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([score, n]) => `${score}★×${n}`)
        .join('  '),
    [user.countByScore],
  );

  return (
    <div className="border-b border-line last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-ink-secondary" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 text-ink-secondary" aria-hidden />
        )}
        <span className="flex-1 font-medium text-ink">{user.userName}</span>
        <span className="hidden text-2xs text-ink-secondary sm:inline">{scoreSummary}</span>
        <span className="text-2xs text-ink-secondary">{user.count} predl.</span>
        <span className="tnums w-32 text-right font-semibold text-ink">
          {formatDecimal(user.total)} RSD
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto bg-surface-2/50 px-4 pb-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                <th className="py-1 text-left font-semibold">Broj</th>
                <th className="py-1 text-left font-semibold">Naslov</th>
                <th className="py-1 text-right font-semibold">Ocena</th>
                <th className="py-1 text-right font-semibold">Iznos</th>
                <th className="py-1 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {user.items.map((it) => (
                <tr
                  key={it.id}
                  className="cursor-pointer border-t border-line/60 hover:bg-surface"
                  onClick={() => router.push(`/zahtevi/${it.id}`)}
                >
                  <td className="tnums py-1.5 text-ink-secondary">{it.reqNo}</td>
                  <td className="py-1.5 text-ink">{it.title}</td>
                  <td className="tnums py-1.5 text-right text-ink">{it.score ?? '—'}★</td>
                  <td className="tnums py-1.5 text-right text-ink">
                    {it.amount ? `${formatDecimal(it.amount)} RSD` : '—'}
                  </td>
                  <td className="py-1.5 text-right text-2xs text-ink-secondary">
                    {it.rewardStatus === 'PAID' ? 'Isplaćeno' : 'Potvrđeno'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── tarifa */

const SCORES = [1, 2, 3, 4, 5] as const;

function TariffEditor() {
  const tariffs = useTariffs();
  const put = usePutTariffs();
  const [editing, setEditing] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const current = tariffs.data?.data.current ?? [];

  function startEdit() {
    const seed: Record<string, string> = {};
    for (const s of SCORES) {
      const row = current.find((c) => c.score === s);
      seed[String(s)] = row ? String(Math.round(Number(row.amount))) : '';
    }
    setAmounts(seed);
    setErr(null);
    setEditing(true);
  }

  function save() {
    setErr(null);
    const payload: Record<string, number> = {};
    for (const s of SCORES) {
      const raw = amounts[String(s)];
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < 0) {
        setErr(`Unesite ispravan iznos za ocenu ${s}.`);
        return;
      }
      payload[String(s)] = n;
    }
    put.mutate(payload, {
      onSuccess: () => {
        toast('Tarifa sačuvana (važi od danas).');
        setEditing(false);
      },
      onError: (e) => setErr((e as Error).message),
    });
  }

  return (
    <section className="space-y-3 rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-md font-semibold text-ink">Tarifa nagrada</h3>
        {!editing && (
          <Button variant="secondary" onClick={startEdit}>
            Izmeni tarifu
          </Button>
        )}
      </div>
      <p className="text-2xs text-ink-secondary">
        Iznos po oceni (RSD). Izmena kreira nov red koji važi od danas — raniji obračuni
        ostaju po staroj tarifi.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {SCORES.map((s) => {
          const row = current.find((c) => c.score === s);
          return (
            <div key={s} className="rounded-control border border-line bg-surface-2 px-3 py-2">
              <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                {s}★
              </p>
              <p className="mt-1 tnums text-lg font-semibold text-ink">
                {row ? formatDecimal(row.amount) : '—'}
              </p>
              {row?.validFrom && (
                <p className="text-2xs text-ink-secondary">od {row.validFrom}</p>
              )}
            </div>
          );
        })}
      </div>

      {editing && (
        <Dialog
          open
          onClose={() => setEditing(false)}
          dismissable={false}
          title="Izmena tarife nagrada"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Otkaži
              </Button>
              <Button onClick={save} loading={put.isPending}>
                Sačuvaj (od danas)
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            {err && (
              <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
                {err}
              </p>
            )}
            <p className="text-2xs text-ink-secondary">
              Novi iznosi važe od danas; postojeći potvrđeni obračuni se ne menjaju.
            </p>
            {SCORES.map((s) => (
              <FormField key={s} label={`Ocena ${s}★`}>
                <Input
                  value={amounts[String(s)] ?? ''}
                  onChange={(e) =>
                    setAmounts((a) => ({
                      ...a,
                      [String(s)]: e.target.value.replace(/[^0-9]/g, ''),
                    }))
                  }
                  inputMode="numeric"
                  placeholder="0"
                />
              </FormField>
            ))}
          </div>
        </Dialog>
      )}
    </section>
  );
}

/* ───────────────────────────────────────────────────────────────────── shared */

function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  loading,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Otkaži
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink">{message}</p>
    </Dialog>
  );
}
