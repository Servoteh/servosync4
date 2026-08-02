'use client';

/**
 * Mobilno „Za mene" (/mob/za-mene) — PLAN_MOB_3.0 Faza 2, talas B
 * (paritet 1.0 mobilnog `/m/za-mene` = myWork). TANAK omotač nad postojećim
 * `sastanci` hook-ovima; semantika je 1:1 sa desktop „Moj rad" tabom
 * (`app/sastanci/_components/moj-rad-tab.tsx`): akcije se filtriraju po
 * `effective_status ∈ {otvoren, u_toku, kasni}`, RSVP je zaključan kad je sastanak
 * `zakljucan`/`otkazan`. Nula nove poslovne logike — server ostaje autoritet.
 *
 * Gate: `sastanci.read`. SVA tri izvora (`GET /sastanci/my`, `/sastanci/akcije`,
 * `/sastanci/teme`) su iza class-level `@RequirePermission(SASTANCI_READ)` na BE-u,
 * pa ekran (i hub kartica) moraju nositi isti gate — bez njega bi korisnik dobio
 * tri 403 i prazan ekran.
 *
 * PERMISIJE (odluka Nenada 26.07): status SOPSTVENE akcije menja svako pod
 * read-nivoom kroz `POST /sastanci/akcije/:id/moj-status` (server presuđuje
 * vlasništvo po odgovoran_email) — lista ovde je ionako filtrirana na moje.
 * RSVP (`POST /sastanci/:id/rsvp`) je read-level kao i ranije.
 *
 * Static export: čista statička ruta, bez `[id]` i bez `useSearchParams`.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, ChevronRight, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { toast } from '@/lib/toast';
import { ApiError } from '@/api/client';
import {
  useAkcije,
  useMyMeetings,
  useSetMyAkcijaStatus,
  useSetMyRsvp,
  useTeme,
  type AkcijaRow,
  type Sastanak,
} from '@/api/sastanci';
import {
  AkcijaStatusBadge,
  formatDatum,
  formatVreme,
  SastanakStatusBadge,
  TemaStatusBadge,
} from '@/app/sastanci/_components/common';
import { MobShell } from '../_components/mob-shell';
import { MobPermissionsError } from '../_components/mob-refresh';

/** Vidljiv fokus na svakoj kontroli (DS §11) — nikad `outline:none` bez zamene. */
const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]';

/** Statusi koje mobilni sme da postavi na akciji (paritet desktop status sheet-a;
 *  `kasni` je IZVEDEN iz roka — nikad se ne postavlja ručno). */
const SETTABLE: { v: string; l: string }[] = [
  { v: 'otvoren', l: 'Otvoren' },
  { v: 'u_toku', l: 'U toku' },
  { v: 'zavrsen', l: 'Završen' },
];

type RsvpStatus = 'dolazim' | 'ne_dolazim';

export default function MobZaMenePage() {
  const { user, isLoading, can, permissionsPending, permissionsError } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user || permissionsPending) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }
  if (permissionsError) {
    return <MobPermissionsError />;
  }
  if (!can(PERMISSIONS.SASTANCI_READ)) {
    return (
      <main className="grid min-h-dvh place-items-center bg-app p-6 text-center text-sm text-ink-secondary">
        Moje akcije i sastanci su deo modula Sastanci — tvoja uloga nema pristup
        (potrebno `sastanci.read`).
      </main>
    );
  }

  // Podaci se montiraju TEK posle gejta — inače bi upiti krenuli sa praznim
  // `odgovoranEmail`/`predlozioEmail` (nescopovan `/akcije`) dok /auth/me stiže.
  return <ZaMene myEmail={user.email} />;
}

function ZaMene({ myEmail }: { myEmail: string }) {
  const meetingsQ = useMyMeetings();
  const akcijeQ = useAkcije({ odgovoranEmail: myEmail });
  const temeQ = useTeme({ predlozioEmail: myEmail });

  const rsvpM = useSetMyRsvp();
  const statusM = useSetMyAkcijaStatus();
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Lokalni odjek RSVP izbora: `GET /sastanci/my` vraća sirov `sastanci` red BEZ
   *  `rsvpStatus` (učesnici stižu tek u detalju), pa bi dugme posle klika ostalo
   *  bez potvrde. Ovo NIJE keš stanja sa servera — samo izbor iz tekuće sesije. */
  const [rsvpEcho, setRsvpEcho] = useState<Record<string, RsvpStatus>>({});

  // Otvorena zaduženja — identičan filter kao desktop MojRadTab.
  const akcije = useMemo(
    () =>
      (akcijeQ.data?.data ?? []).filter((a) =>
        ['otvoren', 'u_toku', 'kasni'].includes(a.effective_status),
      ),
    [akcijeQ.data],
  );

  // Predstojeći sastanci (datum >= danas, nije zaključan/otkazan) — hronološki.
  const predstojeci = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return (meetingsQ.data?.data ?? [])
      .filter((s) => {
        const d = String(s.datum).slice(0, 10);
        return d >= today && s.status !== 'zakljucan' && s.status !== 'otkazan';
      })
      .sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
  }, [meetingsQ.data]);

  const predlozi = temeQ.data?.data ?? [];

  async function setStatus(a: AkcijaRow, status: string) {
    setBusyId(a.id);
    try {
      await statusM.mutateAsync({
        id: a.id,
        status: status as 'otvoren' | 'u_toku' | 'zavrsen',
      });
      toast('Status akcije izmenjen.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Izmena statusa nije uspela.');
    } finally {
      setBusyId(null);
    }
  }

  async function setRsvp(s: Sastanak, status: RsvpStatus) {
    setBusyId(s.id);
    try {
      await rsvpM.mutateAsync({ id: s.id, status });
      setRsvpEcho((p) => ({ ...p, [s.id]: status }));
      toast(status === 'dolazim' ? 'Zabeleženo: dolaziš.' : 'Zabeleženo: ne dolaziš.');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Slanje odgovora nije uspelo.');
    } finally {
      setBusyId(null);
    }
  }

  // Zaglavlje i donja tab-traka su u `MobShell` (F1); povratak na početnu je tab
  // „Početna", pa ekran više ne crta svoje dugme nazad. Podnaslov = 1.0 tekst.
  return (
    <MobShell title="Za mene" subtitle="Moji zadaci i obaveze" active="zaMene">
      <div className="space-y-5">
        {/* ── Moje akcije (otvorene / u toku / kasne) ── */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Moje akcije{akcije.length > 0 ? ` · ${akcije.length}` : ''}
          </h2>

          {akcijeQ.isLoading ? (
            <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
          ) : akcijeQ.isError ? (
            <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
              Akcije nisu učitane. Proveri vezu pa dodirni „Osveži" gore desno.
            </p>
          ) : akcije.length === 0 ? (
            <EmptyState title="Nemaš otvorenih zaduženja 🎉" hint="Sve akcije sa tvojim imenom su zatvorene." />
          ) : (
            <ul className="space-y-2">
              {akcije.map((a) => (
                <li key={a.id} className="rounded-panel border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 text-sm font-medium text-ink">{a.naslov}</span>
                    <span className="shrink-0">
                      <AkcijaStatusBadge status={a.effective_status} />
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-ink-secondary">
                    {(a.projekatCode || a.projekatNaziv) && (
                      <span>{a.projekatCode || a.projekatNaziv} · </span>
                    )}
                    <span
                      className={`tnums ${a.effective_status === 'kasni' ? 'text-status-danger' : ''}`}
                    >
                      rok: {a.rok_text || (a.rok ? formatDatum(a.rok) : '—')}
                    </span>
                  </p>

                  <div className="mt-2 flex gap-2">
                    {SETTABLE.map((s) => (
                        <button
                          key={s.v}
                          disabled={busyId === a.id}
                          onClick={() => void setStatus(a, s.v)}
                          className={`h-11 flex-1 rounded-control border text-sm ${
                            a.status === s.v
                              ? 'border-accent bg-accent-subtle text-accent'
                              : 'border-line text-ink-secondary active:bg-surface-2'
                          } disabled:opacity-40 ${FOCUS}`}
                        >
                          {s.l}
                        </button>
                      ))}
                  </div>

                  {a.sastanak_id && (
                    <Link
                      href={`/mob/sastanci?open=${a.sastanak_id}`}
                      className={`mt-2 inline-flex min-h-11 items-center gap-1 text-sm text-accent ${FOCUS}`}
                    >
                      Otvori sastanak
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Moji sastanci (predstojeći + RSVP) ── */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Moji sastanci
          </h2>
          {meetingsQ.isLoading ? (
            <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
          ) : meetingsQ.isError ? (
            <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
              Sastanci nisu učitani. Proveri vezu pa dodirni „Osveži" gore desno.
            </p>
          ) : predstojeci.length === 0 ? (
            <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
              Nemaš predstojećih sastanaka.{' '}
              <Link href="/mob/sastanci" className={`text-accent ${FOCUS}`}>
                Svi sastanci
              </Link>
            </p>
          ) : (
            <ul className="space-y-2">
              {predstojeci.map((s) => {
                const echo = rsvpEcho[s.id];
                return (
                  <li key={s.id} className="rounded-panel border border-line bg-surface p-3">
                    <Link
                      href={`/mob/sastanci?open=${s.id}`}
                      className={`flex items-start gap-2 ${FOCUS}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{s.naslov}</span>
                        <span className="tnums block text-xs text-ink-secondary">
                          {formatDatum(s.datum)} · {formatVreme(s.vreme)}
                          {s.mesto ? ` · ${s.mesto}` : ''}
                        </span>
                      </span>
                      <SastanakStatusBadge status={s.status} />
                      <ChevronRight className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
                    </Link>

                    <div className="mt-2 flex gap-2">
                      <button
                        disabled={busyId === s.id}
                        onClick={() => void setRsvp(s, 'dolazim')}
                        className={`inline-flex h-11 flex-1 items-center justify-center gap-1 rounded-control border text-sm ${
                          echo === 'dolazim'
                            ? 'border-status-success bg-status-success-bg text-status-success'
                            : 'border-line text-ink active:bg-surface-2'
                        } disabled:opacity-40 ${FOCUS}`}
                      >
                        <Check className="h-4 w-4" aria-hidden /> Dolazim
                      </button>
                      <button
                        disabled={busyId === s.id}
                        onClick={() => void setRsvp(s, 'ne_dolazim')}
                        className={`inline-flex h-11 flex-1 items-center justify-center gap-1 rounded-control border text-sm ${
                          echo === 'ne_dolazim'
                            ? 'border-status-danger bg-status-danger-bg text-status-danger'
                            : 'border-line text-ink active:bg-surface-2'
                        } disabled:opacity-40 ${FOCUS}`}
                      >
                        <X className="h-4 w-4" aria-hidden /> Ne dolazim
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── Moji predlozi (PM teme koje sam predložio) — read-only ── */}
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            Moji predlozi
          </h2>
          {temeQ.isLoading ? (
            <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
          ) : temeQ.isError ? (
            <p className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-6 text-center text-sm text-status-danger">
              Predlozi nisu učitani. Proveri vezu pa dodirni „Osveži" gore desno.
            </p>
          ) : predlozi.length === 0 ? (
            <p className="rounded-panel border border-line bg-surface px-4 py-6 text-center text-sm text-ink-secondary">
              Nisi predložio nijednu temu.
            </p>
          ) : (
            <ul className="space-y-2">
              {predlozi.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start gap-2 rounded-panel border border-line bg-surface p-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{t.naslov}</span>
                    <span className="block text-xs text-ink-secondary">
                      {t.oblast}
                      {t.hitno ? ' · hitno' : ''}
                    </span>
                  </span>
                  <TemaStatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MobShell>
  );
}
