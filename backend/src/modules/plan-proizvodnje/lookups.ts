/**
 * Plan proizvodnje — LOOKUP servisi (C2-P7, GAP-PM-26; MODULE_SPEC §3 „dele se s
 * Lokacijama"). Port 1.0 `src/services/planProizvodnje.js`:
 *   - fetchBigtehnOpSnapshotByRnAndTp (~505–720): 9400 dash/slash kanonizacija
 *     kandidata + pickBestBigtehnWoRow + komada_done iz routing keša + kupac
 *     (best-effort);
 *   - fetchTpOptionsForPredmetOrder (~793): distinct TP opcije;
 *   - resolveDrawingNoForPredmetTp (~535): autofill crteža (sanitizacija
 *     placeholder tačaka);
 *   - fetchBigtehnWorkOrdersByIds (~867).
 *
 * Sve nad sy15 `bigtehn_*` kešom kroz `withUserRls` (poziva servis). Ovaj modul
 * drži ČISTU (bez-DB) logiku kanonizacije/izbora da bi bila unit-testabilna;
 * DB pozivi se injektuju kao callback-ovi (`Fetcher`).
 */

import { sanitizeDrawingNo } from "../../common/drawings";

export interface BigtehnWoRow {
  id?: number | bigint | null;
  ident_broj?: string | null;
  broj_crteza?: string | null;
  komada?: number | bigint | null;
  naziv_dela?: string | null;
  materijal?: string | null;
  dimenzija_materijala?: string | null;
  customer_id?: number | bigint | null;
  rok_izrade?: unknown;
  status_rn?: boolean | null;
  revizija?: string | null;
}

/** Parsiraj TP ref u varijante relevantne za lookup (paritet 1.0 ~598–614). */
export function parseOpRef(rnIdentBroj: string, operacija: string | null): {
  ident: string;
  opForIdent: string;
  opNumRoute: number | null;
  opHy: RegExpMatchArray | null;
  opPairNoLead: RegExpMatchArray | null;
} {
  const ident = String(rnIdentBroj ?? "").trim();
  const opRaw = operacija == null || operacija === "" ? "" : String(operacija).trim();
  const opNum = opRaw === "" ? null : /^\d+$/.test(opRaw) ? parseInt(opRaw, 10) : null;
  const opFinite = opNum != null && Number.isFinite(opNum);
  const opForIdent = opRaw === "" ? "" : opFinite ? String(opNum) : opRaw;
  const opHy = opRaw.match(/^-(\d+)\/(\d+)$/);
  const opPairNoLead =
    opRaw && !opRaw.startsWith("-") && /^(\d+)\/(\d+)$/.test(opRaw)
      ? opRaw.match(/^(\d+)\/(\d+)$/)
      : null;
  let opNumRoute = opFinite ? opNum : null;
  if (opHy) {
    const n = parseInt(opHy[2], 10);
    if (Number.isFinite(n)) opNumRoute = n;
  } else if (ident === "9400" && opPairNoLead) {
    const n = parseInt(opPairNoLead[2], 10);
    if (Number.isFinite(n)) opNumRoute = n;
  }
  return { ident, opForIdent, opNumRoute, opHy, opPairNoLead };
}

/**
 * Kandidati ident_broj-a za lookup (paritet 1.0 ~664–690). KANONSKA kosa crta
 * (`9400/2/334`) PRVA; legacy dash forma (`9400-2/334`, samo predmet 9400) je
 * FALLBACK — nosi STARIJI crtež pa sme da pobedi tek ako kosa crta ne postoji.
 */
export function buildIdentCandidates(
  ident: string,
  opForIdent: string,
  opHy: RegExpMatchArray | null,
  opPairNoLead: RegExpMatchArray | null,
): string[] {
  const candidates: string[] = [];
  if (opForIdent) {
    const skipGenericHyphenTp = ident === "9400" && !!opHy;
    if (!skipGenericHyphenTp) {
      candidates.push(`${ident}/${opForIdent}`);
      if (/^\d+$/.test(ident)) {
        const normalized = String(parseInt(ident, 10));
        if (normalized !== ident) candidates.push(`${normalized}/${opForIdent}`);
      }
    }
    if (ident === "9400" && opHy) {
      candidates.push(`9400-${opHy[1]}/${opHy[2]}`);
    }
    if (ident === "9400" && opPairNoLead) {
      candidates.push(`9400-${opPairNoLead[1]}/${opPairNoLead[2]}`);
    }
  }
  // Bez TP ref-a dozvoljen fallback na sam nalog (sa TP ref-om NE).
  if (!opForIdent) {
    candidates.push(ident);
    if (/^\d+$/.test(ident)) {
      const normalized = String(parseInt(ident, 10));
      if (normalized !== ident) candidates.push(normalized);
    }
  }
  return candidates.filter(Boolean);
}

/**
 * Izaberi najbolji RN red kad ima više varijanti istog ident_broj (port 1.0
 * pickBestBigtehnWoRow ~505). PostgREST/upit ne garantuje redosled.
 */
export function pickBestBigtehnWoRow(
  rows: BigtehnWoRow[],
  ident: string,
  opForIdent: string,
): BigtehnWoRow | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length === 1) return rows[0];
  const o = String(ident ?? "").trim();
  const t = String(opForIdent ?? "").trim();
  if (t) {
    const want = `${o}/${t}`;
    const exact = rows.find((r) => String(r?.ident_broj ?? "").trim() === want);
    if (exact) return exact;
    const tail = rows.find((r) => {
      const ib = String(r?.ident_broj ?? "").trim();
      const parts = ib.split("/");
      return parts.length >= 2 && parts[0] === o && parts[1] === t;
    });
    if (tail) return tail;
  } else if (o) {
    const exact = rows.find((r) => String(r?.ident_broj ?? "").trim() === o);
    if (exact) return exact;
  }
  return rows[0];
}

/** Numeričko-svesni sort TP opcija (paritet 1.0 ~852). */
export function sortTpOptions<T extends { tp: string }>(out: T[]): T[] {
  return out.sort((a, b) => {
    const na = parseInt(a.tp, 10);
    const nb = parseInt(b.tp, 10);
    if (
      Number.isFinite(na) &&
      Number.isFinite(nb) &&
      String(na) === a.tp &&
      String(nb) === b.tp
    ) {
      return na - nb;
    }
    return String(a.tp).localeCompare(String(b.tp), "sr", { numeric: true });
  });
}

export { sanitizeDrawingNo };
