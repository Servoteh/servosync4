'use client';

import type { QueryClient } from '@tanstack/react-query';
import {
  fetchSastanakFull,
  fetchSlikaUrl,
  sastanakFullQueryKey,
  type SastanakFull,
} from '@/api/sastanci';
import { printZapisnik } from '@/lib/sastanci-print';
import { toast } from '@/lib/toast';

// Deljeni helper za štampu zapisnika (S1). Isti tok koristi arhiva tab („Štampaj"
// po redu) i novo dugme „Prethodni zapisnik" u headeru detalja. Logika je 1:1
// izvučena iz arhiva-tab.tsx da ponašanje ostane identično:
//   • pun (1.0) snapshot → printZapisnik direktno;
//   • okrnjen (2.0 lock) snapshot → dohvati ŽIVE podatke (deli query keš sa
//     detaljem) + potpisane slike → sagradi print iz njih;
//   • ako su i živi prazni → toast umesto skoro prazne štampe.

/** Snapshot je upotrebljiv za štampu samo ako nosi tačke zapisnika — 2.0 lock
 *  snapshot (schemaVersion 2, DB RPC) ima aktivnosti/akcije/pmTeme = [] pa bi
 *  štampa iz njega bila skoro prazna (samo meta zaglavlje). */
export function snapshotImaAktivnosti(snap: Record<string, unknown> | null | undefined): boolean {
  if (!snap) return false;
  const akt = snap['aktivnosti'];
  return Array.isArray(akt) && akt.length > 0;
}

/** SastanakFull → oblik `sastanak_arhiva.snapshot` koji printZapisnik čita
 *  (camelCase ključevi — `pick(camel, snake)` u sastanci-print ih razume).
 *  pmTeme nisu deo full odgovora → sekcija „Dnevni red" se izostavlja. */
function liveSnapshotZaPrint(
  full: SastanakFull,
  slike: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    sastanak: full,
    ucesnici: full.ucesnici,
    aktivnosti: full.aktivnosti,
    akcije: full.akcije,
    pmTeme: [],
    slike,
  };
}

/**
 * Odštampaj zapisnik sastanka. Ako je `snapshot` prosleđen i pun (ima aktivnosti),
 * štampa se direktno iz njega (bez fetch-a). Inače (nema snapshot-a ili je okrnjen)
 * dohvataju se živi podaci + potpisane slike. Vraća `true` ako je štampa pokrenuta.
 *
 * @param qc          QueryClient (deli keš sa detaljem/arhivom)
 * @param sastanakId  id sastanka čiji se zapisnik štampa
 * @param snapshot    opcioni arhiva snapshot (1.0 pun → brzi put)
 */
export async function stampajZapisnik(
  qc: QueryClient,
  sastanakId: string,
  snapshot?: Record<string, unknown> | null,
): Promise<boolean> {
  if (snapshotImaAktivnosti(snapshot)) {
    printZapisnik(snapshot as Record<string, unknown>);
    return true;
  }
  try {
    const res = await qc.fetchQuery({
      queryKey: sastanakFullQueryKey(sastanakId),
      queryFn: () => fetchSastanakFull(sastanakId),
    });
    const full = res.data;
    if (!full || (full.aktivnosti.length === 0 && full.akcije.length === 0)) {
      toast('Nema podataka za štampu — snapshot i živi zapisnik su prazni.');
      return false;
    }
    // Signed URL po slici za sekciju „Foto dokumentacija"; slika kojoj
    // potpisivanje padne se preskače (štampa ne sme da padne zbog priloga).
    const slike = (
      await Promise.all(
        full.slike.map(async (s) => {
          try {
            const u = await fetchSlikaUrl(s.id);
            return { ...s, signedUrl: u.data.url } as Record<string, unknown>;
          } catch {
            return null;
          }
        }),
      )
    ).filter((s): s is Record<string, unknown> => s !== null);
    printZapisnik(liveSnapshotZaPrint(full, slike));
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Ne mogu da učitam podatke za štampu.');
    return false;
  }
}
