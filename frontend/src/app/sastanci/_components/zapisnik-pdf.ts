'use client';

import {
  newClientEventId,
  usePredmetPrioritet,
  useSastanakFull,
  useSastanakWeeklyDiff,
  useUploadArhivaPdf,
  type SastanakFull,
  type WeeklyDiff,
} from '@/api/sastanci';
import { generateSastanakPdf, type SastanakPdfInput } from '@/lib/sastanci-pdf';
import { groupAkcijeByRn } from './common';

/**
 * Datum koji nosi ZAPISNIK (PDF, mejl, naziv priloga) — zahtev 014/26 + presuda
 * vlasnika 25.07.2026: to je datum ODRŽAVANJA, čija je podrazumevana vrednost dan
 * zaključavanja. `zapisnikDatum` je NULL na svim zatečenim sastancima → pada na
 * `datum` (zakazani termin), tj. ponašanje kao pre paketa. Ista `COALESCE` logika
 * živi i u sy15 (mejl payload) — v. SQL_sastanci_zapisnik_datum_2026-07-25.sql.
 */
export function zapisnikDatumOf(sast: {
  datum: string;
  zapisnikDatum?: string | null;
}): string {
  return sast.zapisnikDatum ?? sast.datum;
}

/**
 * Sklopi SastanakFull → ulaz za jsPDF generator. Akcioni plan grupisan po RN-u
 * (paritet 1.0 sastanciArhiva/getSastanakFullSaAkcijama): ⭐ prioritetni predmeti
 * prvi (`prioritet` = usePredmetPrioritet lista), pa šifra sr-numeric; „Bez RN /
 * projekta" poslednja; redovi po rb — naslov PDF sekcije „Akcioni plan po
 * projektima" time je istinit. `diff` (weekly diff sa sidrom = prethodni zaključani
 * sastanak) daje red „Od prošlog sastanka"; null = red se ne crta (1.0 paritet).
 *
 * `datumOverride` je datum zapisnika koji JOŠ NIJE u bazi — tok zaključavanja i tok
 * ispravke PDF grade iz datuma izabranog u modalu, pre/tokom upisa. Bez njega se
 * uzima `zapisnikDatum ?? datum` sa reda.
 */
export function buildPdfInput(
  sast: SastanakFull,
  diff?: WeeklyDiff | null,
  prioritet?: string[] | null,
  datumOverride?: string | null,
): SastanakPdfInput {
  return {
    diffSummary: diff ?? null,
    naslov: sast.naslov,
    datum: datumOverride ?? zapisnikDatumOf(sast),
    vreme: sast.vreme,
    mesto: sast.mesto,
    tip: sast.tip,
    vodioLabel: sast.vodioLabel,
    vodioEmail: sast.vodioEmail,
    zakljucanByEmail: sast.zakljucanByEmail,
    ucesnici: sast.ucesnici.map((u) => ({ email: u.email, label: u.label, prisutan: u.prisutan, pozvan: u.pozvan })),
    aktivnosti: sast.aktivnosti.map((a) => ({
      naslov: a.naslov,
      sadrzajText: a.sadrzajText,
      napomena: a.napomena,
      odgovoranLabel: a.odgovoranLabel,
      odgovoranText: a.odgovoranText,
      odgovoranEmail: a.odgovoranEmail,
      rok: a.rok,
      rokText: a.rokText,
      status: a.status,
    })),
    akcioniPlanGrouped: sast.akcije.length
      ? groupAkcijeByRn(sast.akcije, prioritet, { rowSort: 'rb' }).map((g) => ({
          code: g.code || undefined,
          naziv: g.naziv,
          rows: g.rows.map((a) => ({
            naslov: a.naslov,
            // Opis zadatka u PDF akcionom planu (zahtev 014/26 t.6).
            opis: a.opis,
            effectiveStatus: a.effective_status,
            status: a.status,
            odgovoranLabel: a.odgovoran_label,
            odgovoranText: a.odgovoran_text,
            odgovoranEmail: a.odgovoran_email,
            rok: a.rok,
            rokText: a.rok_text,
          })),
        }))
      : [],
  };
}

/**
 * Re-generiši zvanični PDF zapisnika iz SVEŽIH podataka i zameni ga u arhivi
 * (1.0 regenerateSastanakPdf paritet). Jedan izvor za dva pozivaoca:
 *  • arhiva tab — dugme „Re-generiši PDF";
 *  • detalj — „Ispravi datum zapisnika" (prosleđuje `datumOverride`).
 * Hook-ovi dele query-key sa SastanakDetalj, pa refetch osvežava zajednički keš.
 *
 * Baca `Error` sa porukom za korisnika (pozivalac je hvata i prikazuje) — namerno
 * NE guta greške: zapisnik koji nije zamenjen mora biti vidljiv kvar, a ne tih 200.
 */
export function useZapisnikPdfRegen(sastanakId: string) {
  const fullQ = useSastanakFull(sastanakId);
  const diffQ = useSastanakWeeklyDiff(sastanakId);
  const prioQ = usePredmetPrioritet();
  const uploadM = useUploadArhivaPdf();

  async function regenerisi(datumOverride?: string | null): Promise<void> {
    // PDF ne sme na stale/failed hook snapshotove — sveže dohvati full + weekly-diff
    // + ⭐ prioritet; pad bilo kog = prekid (bez tihog izostavljanja sekcija).
    const [fullRes, diffRes, prioRes] = await Promise.all([
      fullQ.refetch(),
      diffQ.refetch(),
      prioQ.refetch(),
    ]);
    const fresh = fullRes.data?.data;
    if (fullRes.isError || diffRes.isError || prioRes.isError || !fresh) {
      throw new Error('Ne mogu da učitam sveže podatke za PDF — pokušaj ponovo.');
    }
    const dd = diffRes.data?.data;
    const freshDiff: WeeklyDiff | null = dd
      ? { novo: dd.novo, zavrsenoOveNedelje: dd.zavrsenoOveNedelje, kasni: dd.kasni, aktivnih: dd.aktivnih }
      : null;
    const blob = await generateSastanakPdf(buildPdfInput(fresh, freshDiff, prioRes.data?.data, datumOverride));
    // requireArhiva: arhiva red MORA biti pogođen — BE vrati 403 umesto tihog 200
    // kad RLS odbije upis (toast bi inače lagao dok arhiva drži STARI PDF).
    await uploadM.mutateAsync({
      id: sastanakId,
      blob,
      clientEventId: newClientEventId(),
      requireArhiva: true,
    });
  }

  return { regenerisi };
}
