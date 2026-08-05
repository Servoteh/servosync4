/**
 * Lokacije — dočitavanje BROJA CRTEŽA za par (nalog, TP ref).
 *
 * ZAŠTO POSTOJI: RNZ barkod naloga (`RNZ:{projectId}:{nalog}/{tp}:{var}:{rev}`)
 * broj crteža NE NOSI — nosi ga jedino legacy „short" nalepnica `{nalog}/{crtez}`.
 * 1.0 zato posle skena (i posle ručne izmene naloga/TP-a) dočitava crtež iz
 * BigTehn keša i predpopunjava polje „Broj crteža" (editabilno). Ovaj fajl je
 * VERAN port čistih delova te logike:
 *   • `sanitizeDrawingNo`            — 1.0 `src/services/drawings.js`
 *   • `buildDrawingIdentCandidates`  — kandidat-lista `ident_broj` vrednosti iz
 *     1.0 `fetchBigtehnOpSnapshotByRnAndTp` (redosled je BITAN: kanonska kosa
 *     crta `9400/2/334` PRE legacy dash forme `9400-2/334` — dash redovi u kešu
 *     predmeta 9400 nose ZASTARELI crtež; komentar u 1.0 na ~655. redu)
 *   • `pickBestDrawingRow`           — 1.0 `pickBestBigtehnWoRow`
 *
 * DB pristup (glavna baza `work_orders` + sy15 `bigtehn_work_orders_cache`) je u
 * `LocationsService.lookupDrawing` — ovde su samo čisti, unit-testabilni delovi
 * (isti obrazac kao `barcode.ts`).
 */

/**
 * Ukupan broj komada na nalogu (`komada` / `piece_count`) → number | null.
 *
 * Paritet 1.0 `fetchBigtehnOpSnapshotByRnAndTp`: `komada_total =
 * Number.isFinite(Number(wo.komada)) ? total : null` — nevalidno/odsutno je
 * `null` (FE tada NE nudi „Uloži preostalo sa naloga (K kom)" jer ukupno nije
 * pouzdano; 1.0 tada prikazuje generičku INITIAL opciju bez broja). Negativne
 * vrednosti se ovde propuštaju kao u 1.0 — odbija ih tek FE računica preostatka
 * (`computeLocInitialRemainder` vraća null za total < 0).
 */
export function sanitizePieceCount(
  raw: string | number | bigint | null | undefined,
): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Očisti BigTehn `broj_crteza`: skini vodeće/prateće tačke i razmake
 * (`..1133219.` → `1133219`), a placeholder vrednosti (`.`, `..`, `   `) svedi
 * na PRAZNO — 1500+ RN-ova u kešu ima samo-tačku umesto crteža, pa bi autofill
 * bez ovoga upisao „tačku" u polje. Paritet 1.0 `sanitizeDrawingNo` (jedina
 * adaptacija: vraća `""` umesto `null` — pozivaoci ovde rade sa stringom).
 */
export function sanitizeDrawingNo(
  raw: string | number | null | undefined,
): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (!s || /^[.\s]*$/.test(s)) return "";
  return s;
}

/**
 * Kandidat-lista `ident_broj` vrednosti za lookup crteža + `opForIdent` (TP ref
 * normalizovan za poklapanje, potreban i `pickBestDrawingRow`).
 *
 * Ulaz MORA već biti kanonizovan kroz `normalizeLocMovementKeys` (kao u 1.0
 * `resolveDrawingNoForPredmetTp`) — dash/slash/9400 preklapanja rešava ona;
 * grane za `-N/M` i 9400 par ovde ostaju kao odbrana (paritet 1.0, koji ih
 * takođe drži iza normalizacije).
 */
export function buildDrawingIdentCandidates(
  orderNo: string,
  tpRef: string,
): { candidates: string[]; opForIdent: string } {
  const ident = String(orderNo ?? "").trim();
  const opRaw = String(tpRef ?? "").trim();
  if (!ident) return { candidates: [], opForIdent: "" };

  const opNum =
    opRaw !== "" && /^\d+$/.test(opRaw) ? parseInt(opRaw, 10) : null;
  const opFinite = Number.isFinite(opNum);
  const opForIdent = opRaw === "" ? "" : opFinite ? String(opNum) : opRaw;
  const opHy = opRaw.match(/^-(\d+)\/(\d+)$/);
  const opPairNoLead =
    opRaw && !opRaw.startsWith("-") && /^(\d+)\/(\d+)$/.test(opRaw)
      ? opRaw.match(/^(\d+)\/(\d+)$/)
      : null;

  const candidates: string[] = [];
  if (opForIdent) {
    const skipGenericHyphenTp = ident === "9400" && !!opHy;
    if (!skipGenericHyphenTp) {
      candidates.push(`${ident}/${opForIdent}`);
      if (/^\d+$/.test(ident)) {
        const normalized = String(parseInt(ident, 10));
        if (normalized !== ident)
          candidates.push(`${normalized}/${opForIdent}`);
      }
    }
    // Legacy dash forma (samo predmet 9400) — tek POSLE kanonske kose crte.
    if (ident === "9400" && opHy) candidates.push(`9400-${opHy[1]}/${opHy[2]}`);
    if (ident === "9400" && opPairNoLead)
      candidates.push(`9400-${opPairNoLead[1]}/${opPairNoLead[2]}`);
  } else {
    // Bez TP ref-a dozvoljen fallback na sam nalog; SA TP ref-om NE — inače
    // `ident_broj=9000` vrati pogrešan crtež umesto tačnog `9000/488` (1.0).
    candidates.push(ident);
    if (/^\d+$/.test(ident)) {
      const normalized = String(parseInt(ident, 10));
      if (normalized !== ident) candidates.push(normalized);
    }
  }
  return { candidates, opForIdent };
}

/** Minimalni oblik WO reda potreban izboru najboljeg poklapanja. */
export interface DrawingCandidateRow {
  identBroj: string | null;
}

/**
 * Više WO redova za isti upit → izaberi najbolje poklapanje (tačan
 * `ident_broj = nalog/tp`, pa „rep" poklapanje po segmentima, pa prvi red).
 * Paritet 1.0 `pickBestBigtehnWoRow`.
 */
export function pickBestDrawingRow<T extends DrawingCandidateRow>(
  rows: T[],
  orderNo: string,
  opForIdent: string,
): T | null {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (rows.length === 1) return rows[0];
  const o = String(orderNo ?? "").trim();
  const t = String(opForIdent ?? "").trim();
  if (t) {
    const want = `${o}/${t}`;
    const exact = rows.find((r) => String(r?.identBroj ?? "").trim() === want);
    if (exact) return exact;
    const tail = rows.find((r) => {
      const ib = String(r?.identBroj ?? "").trim();
      const parts = ib.split("/");
      return parts.length >= 2 && parts[0] === o && parts[1] === t;
    });
    if (tail) return tail;
  } else if (o) {
    const exact = rows.find((r) => String(r?.identBroj ?? "").trim() === o);
    if (exact) return exact;
  }
  return rows[0];
}
