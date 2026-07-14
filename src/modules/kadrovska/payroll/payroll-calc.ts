/**
 * payroll-calc.ts — 3.0 BE port `src/services/payrollCalc.js` (TALAS G, G3, doktrina §C).
 *
 * PORT 1:1 iz 1.0 — SINGLE SOURCE OF TRUTH za sve formule mesečnog obračuna.
 * Sve funkcije su pure (bez I/O). NE „modernizovati" — zlatni testovi
 * (`payroll-calc.spec.ts`) fiksiraju poznati ulaz→izlaz iz 1.0.
 *
 * Compensation modeli: fiksno / dva_dela / satnica / jednokratno / praksa.
 * Bolovanje: obično 65%, povreda/trudnoća 100%. Teren: dnevnica × dana (RSD/EUR).
 * Prava po tipu rada: 'ugovor' puna; praksa/dualno/penzioner bez plaćenih odsustava.
 */

/* ── Konstante (po Zakonu o radu RS, najmanji propisani koeficijenti) ── */
export const REGULAR_DAY_HOURS = 8;
export const BOLOVANJE_OBICNO_FACTOR = 0.65; // 65% osnovice
export const BOLOVANJE_PUNO_FACTOR = 1.0; // 100% osnovice
export const VALID_WORK_TYPES = ["ugovor", "praksa", "dualno", "penzioner"];
export const VALID_COMPENSATION_MODELS = [
  "fiksno",
  "dva_dela",
  "satnica",
  "jednokratno",
  "praksa",
];

/* ── Prozori isplate ──────────────────────────────────────────────── */

export const PAYMENT_WINDOW_LABELS: Record<string, string> = {
  "01_05": "01–05. u mesecu",
  "15_20": "15–20. u mesecu",
};

/** Podrazumevani prozori isplate za model (uz ručni izuzetak po zaposlenom). */
export function paymentWindowsForModel(
  model: string | null | undefined,
  override?: string | null,
): string[] {
  if (override === "01_05" || override === "15_20") return [override];
  switch (model) {
    case "fiksno":
      return ["01_05"];
    case "dva_dela":
    case "satnica":
      return ["01_05", "15_20"];
    case "jednokratno":
    case "praksa":
      return ["15_20"];
    default:
      return [];
  }
}

/** Ljudski čitljiv opis prozora isplate. */
export function paymentWindowLabel(
  model: string | null | undefined,
  override?: string | null,
): string {
  return paymentWindowsForModel(model, override)
    .map((w) => PAYMENT_WINDOW_LABELS[w])
    .join(" + ");
}

/** Da li YMD datum pada u prozor isplate? Bez datuma/prozora → true. */
export function isDateInPaymentWindow(
  ymd: string | null | undefined,
  windowKey: string,
): boolean {
  const d = parseInt(String(ymd || "").slice(8, 10), 10);
  if (!d) return true;
  if (windowKey === "01_05") return d >= 1 && d <= 5;
  if (windowKey === "15_20") return d >= 15 && d <= 20;
  return true;
}

const FULL_RIGHTS_WORK_TYPES = new Set(["ugovor"]);

type Numish = number | string | null | undefined;
const NUM = (v: Numish): number =>
  v == null || isNaN(Number(v)) ? 0 : Number(v);

/** Šifra odsustva iz API-ja / unosa (trim + lower). */
function normAbsCode(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  return s || null;
}

/** Plaćeni pun (8h) neradni dan koji nije godišnji/bolovanje/službeni. */
const PAID_FREE_DAY_CODES = new Set(["sl", "sv", "pl"]);

export interface Warning {
  code: string;
  message: string;
  [k: string]: unknown;
}

export interface HoursAgg {
  redovanRadSati: number;
  prekovremeniSati: number;
  praznikRadSati: number;
  praznikPlaceniSati: number;
  godisnjiSati: number;
  slobodniDaniSati: number;
  bolovanje65Sati: number;
  bolovanje100Sati: number;
  dveMasineSati: number;
  neplacenoDays?: number;
}

export interface SalaryTermsInput {
  compensationModel?: string | null;
  salaryType?: string | null;
  fixedAmount?: Numish;
  fixedTransportComponent?: Numish;
  fixedExtraHourRate?: Numish;
  fixedNoExtraHours?: boolean;
  firstPartAmount?: Numish;
  splitHourRate?: Numish;
  splitTransportAmount?: Numish;
  hourlyRate?: Numish;
  hourlyTransportAmount?: Numish;
  terrainDomesticRate?: Numish;
  terrainForeignRate?: Numish;
}

type HolidayOpts =
  | string
  | { workType?: string | null; hireDate?: string | null }
  | null
  | undefined;

function normHolidayOpts(opts: HolidayOpts): {
  workType?: string | null;
  hireDate?: string | null;
} {
  if (!opts) return {};
  if (typeof opts === "string") return { workType: opts };
  return { workType: opts.workType || null, hireDate: opts.hireDate || null };
}

/** Da li se ZA OVAJ DAN automatski priznaje plaćen državni praznik (8h)? */
function isAutoPaidHolidayEligible(ymd: string, opts: HolidayOpts): boolean {
  const o = normHolidayOpts(opts);
  if (o.workType && o.workType !== "ugovor") return false;
  if (o.hireDate && ymd < o.hireDate) return false;
  return true;
}

function pushWarning(
  arr: Warning[],
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  arr.push({ code, message, ...extra });
}

/** Legacy salary_type → compensation_model heuristika. */
export function deriveCompensationModel(
  terms: SalaryTermsInput | null | undefined,
): string | null {
  if (!terms) return null;
  if (
    terms.compensationModel &&
    VALID_COMPENSATION_MODELS.includes(terms.compensationModel)
  ) {
    return terms.compensationModel;
  }
  switch (terms.salaryType) {
    case "satnica":
      return "satnica";
    case "ugovor":
    case "dogovor":
      return "fiksno";
    default:
      return null;
  }
}

/** Validira ulazne sate prema tipu rada. */
export function sanitizeHoursForWorkType(
  hours: Partial<HoursAgg>,
  workType: string,
): { sanitized: Partial<HoursAgg>; warnings: Warning[] } {
  const w: Warning[] = [];
  const safe: Partial<HoursAgg> = { ...hours };

  if (!VALID_WORK_TYPES.includes(workType)) {
    pushWarning(
      w,
      "unknown_work_type",
      `Nepoznat tip rada „${workType}". Tretiram kao bez punih prava.`,
    );
  }

  const hasRights = FULL_RIGHTS_WORK_TYPES.has(workType);
  if (!hasRights) {
    if (NUM(safe.godisnjiSati) > 0) {
      pushWarning(
        w,
        "no_right_godisnji",
        `Tip rada „${workType}" nema pravo na plaćen godišnji odmor — ${NUM(safe.godisnjiSati)}h ignorisano.`,
      );
      safe.godisnjiSati = 0;
    }
    if (NUM(safe.slobodniDaniSati) > 0) {
      pushWarning(
        w,
        "no_right_slobodni",
        `Tip rada „${workType}" nema pravo na plaćene slobodne dane — ${NUM(safe.slobodniDaniSati)}h ignorisano.`,
      );
      safe.slobodniDaniSati = 0;
    }
    if (NUM(safe.praznikPlaceniSati) > 0) {
      pushWarning(
        w,
        "no_right_praznik_placeni",
        `Tip rada „${workType}" nema pravo na plaćene neradne praznike — ${NUM(safe.praznikPlaceniSati)}h ignorisano.`,
      );
      safe.praznikPlaceniSati = 0;
    }
    if (NUM(safe.bolovanje65Sati) > 0 || NUM(safe.bolovanje100Sati) > 0) {
      pushWarning(
        w,
        "no_right_bolovanje",
        `Tip rada „${workType}" nema pravo na plaćeno bolovanje — sati ignorisani.`,
      );
      safe.bolovanje65Sati = 0;
      safe.bolovanje100Sati = 0;
    }
  }

  return { sanitized: safe, warnings: w };
}

/** Računa „payable_hours" (težinski sat-koeficijent) zavisno od modela. */
export function computePayableHours(
  hours: Partial<HoursAgg>,
  model: string | null,
): { payableHours: number; breakdown: Record<string, unknown> } {
  const h = {
    redovanRadSati: NUM(hours.redovanRadSati),
    prekovremeniSati: NUM(hours.prekovremeniSati),
    praznikRadSati: NUM(hours.praznikRadSati),
    dveMasineSati: NUM(hours.dveMasineSati),
    praznikPlaceniSati: NUM(hours.praznikPlaceniSati),
    godisnjiSati: NUM(hours.godisnjiSati),
    slobodniDaniSati: NUM(hours.slobodniDaniSati),
    bolovanje100Sati: NUM(hours.bolovanje100Sati),
    bolovanje65Sati: NUM(hours.bolovanje65Sati),
  };

  let payable = 0;
  const breakdown: Record<string, unknown> = {
    ...h,
    factor65: BOLOVANJE_OBICNO_FACTOR,
  };

  if (model === "fiksno" || model === "jednokratno") {
    payable = h.prekovremeniSati + h.praznikRadSati + h.dveMasineSati;
    breakdown.mode = "fiksno_extra_only";
  } else {
    payable =
      h.redovanRadSati +
      h.prekovremeniSati +
      h.praznikRadSati +
      h.dveMasineSati +
      h.praznikPlaceniSati +
      h.godisnjiSati +
      h.slobodniDaniSati +
      h.bolovanje100Sati * BOLOVANJE_PUNO_FACTOR +
      h.bolovanje65Sati * BOLOVANJE_OBICNO_FACTOR;
    breakdown.mode = "weighted_full";
  }

  return { payableHours: round2(payable), breakdown };
}

export interface ComputeEarningsInput {
  workType?: string;
  terms?: SalaryTermsInput;
  hours?: Partial<HoursAgg>;
  terrain?: { domestic?: Numish; foreign?: Numish };
  advanceAmount?: Numish;
  neplacenoDays?: Numish;
  fondSati?: Numish;
}

export interface ComputeEarningsResult {
  compensationModel: string | null;
  workType: string;
  sanitizedHours: Partial<HoursAgg>;
  payableHours: number;
  ukupnaZarada: number;
  prviDeo: number;
  preostaloZaIsplatu: number;
  terrainRsd: number;
  terrainEur: number;
  breakdown: Record<string, unknown>;
  warnings: Warning[];
}

/** Glavni obračun — vraća kompletan rezultat za jedan red salary_payroll. */
export function computeEarnings(
  input: ComputeEarningsInput,
): ComputeEarningsResult {
  const warnings: Warning[] = [];
  const workType = input.workType || "ugovor";
  const terms = input.terms || {};
  const model = deriveCompensationModel(terms);
  const neplacenoDays = Math.max(0, NUM(input.neplacenoDays));

  if (!model) {
    pushWarning(
      warnings,
      "no_compensation_model",
      "Aktivni uslovi zarade nemaju definisan tip zarade (compensation_model).",
    );
  }

  const { sanitized, warnings: hoursWarn } = sanitizeHoursForWorkType(
    input.hours || {},
    workType,
  );
  warnings.push(...hoursWarn);

  const { payableHours, breakdown } = computePayableHours(sanitized, model);

  let baseEarnings = 0;
  let extraEarnings = 0;
  let transportEarnings = 0;
  let prviDeo = 0;

  if (model === "fiksno" || model === "jednokratno") {
    let proporcija = 1;
    const fondSati = NUM(input.fondSati);
    if (neplacenoDays > 0 && fondSati > 0) {
      const radnih = fondSati / REGULAR_DAY_HOURS;
      const efektivnih = Math.max(0, radnih - neplacenoDays);
      proporcija = Math.min(1, efektivnih / radnih);
      pushWarning(
        warnings,
        "neplaceno_fiksno",
        `Fiksna plata umanjena za ${neplacenoDays} neplaćenih dana (proporcija ${Math.round(proporcija * 100)}%).`,
        { neplacenoDays, proporcija: round2(proporcija) },
      );
    } else if (neplacenoDays > 0) {
      pushWarning(
        warnings,
        "neplaceno_fiksno",
        `Neplaćeno odsustvo: ${neplacenoDays} dana. Proporcija nije izračunata — dostavi fondSati u ulazu.`,
      );
    }
    baseEarnings = round2(NUM(terms.fixedAmount) * proporcija);
    if (terms.fixedNoExtraHours) {
      if (payableHours > 0) {
        pushWarning(
          warnings,
          "fiksno_bez_dodatnih",
          `Ugovoreno fiksno bez dodatnih sati — ${payableHours}h (prekovremeni/praznik rad/2 mašine) evidentirano ali se NE plaća.`,
          { payableHours },
        );
      }
      extraEarnings = 0;
    } else {
      extraEarnings = payableHours * NUM(terms.fixedExtraHourRate);
    }
    transportEarnings = 0;
    prviDeo = NUM(input.advanceAmount);
  } else if (model === "dva_dela") {
    if (neplacenoDays > 0) {
      pushWarning(
        warnings,
        "neplaceno_fond",
        `${neplacenoDays} neplaćenih dana smanjuje fond sati za ${neplacenoDays * REGULAR_DAY_HOURS}h.`,
        { neplacenoDays },
      );
    }
    baseEarnings =
      NUM(terms.firstPartAmount) + payableHours * NUM(terms.splitHourRate);
    transportEarnings = NUM(terms.splitTransportAmount);
    prviDeo = NUM(terms.firstPartAmount);
  } else if (model === "satnica" || model === "praksa") {
    if (neplacenoDays > 0) {
      pushWarning(
        warnings,
        "neplaceno_fond",
        `${neplacenoDays} neplaćenih dana smanjuje fond sati za ${neplacenoDays * REGULAR_DAY_HOURS}h.`,
        { neplacenoDays },
      );
    }
    baseEarnings = payableHours * NUM(terms.hourlyRate);
    transportEarnings = NUM(terms.hourlyTransportAmount);
    prviDeo =
      model === "satnica"
        ? NUM(input.advanceAmount) > 0
          ? NUM(input.advanceAmount)
          : NUM(terms.firstPartAmount)
        : NUM(input.advanceAmount);
  } else {
    /* model nepoznat → sve 0, već je upozoreno */
  }

  const terrainDomCount = NUM(input.terrain?.domestic);
  const terrainForCount = NUM(input.terrain?.foreign);
  const terrainRsd = terrainDomCount * NUM(terms.terrainDomesticRate);
  const terrainEur = terrainForCount * NUM(terms.terrainForeignRate);

  const ukupnaZarada = round2(
    baseEarnings + extraEarnings + transportEarnings + terrainRsd,
  );
  const preostaloZaIsplatu = round2(ukupnaZarada - prviDeo);

  if (preostaloZaIsplatu < 0) {
    pushWarning(
      warnings,
      "negative_remainder",
      `Preostalo za isplatu je negativno (${preostaloZaIsplatu.toFixed(2)} RSD) — prvi deo veći od ukupne zarade.`,
      { value: preostaloZaIsplatu },
    );
  }

  return {
    compensationModel: model || null,
    workType,
    sanitizedHours: sanitized,
    payableHours,
    ukupnaZarada,
    prviDeo: round2(prviDeo),
    preostaloZaIsplatu,
    terrainRsd: round2(terrainRsd),
    terrainEur: round2(terrainEur),
    breakdown: {
      ...breakdown,
      baseEarnings: round2(baseEarnings),
      extraEarnings: round2(extraEarnings),
      transportEarnings: round2(transportEarnings),
    },
    warnings,
  };
}

function round2(v: Numish): number {
  if (v == null || isNaN(Number(v))) return 0;
  return Math.round(Number(v) * 100) / 100;
}

/** Ponedeljak–petak (lokalni kalendar). NB: port `parseDateLocal` → new Date(y, m-1, d). */
function parseDateLocal(ymd: string): Date | null {
  if (!ymd || typeof ymd !== "string") return null;
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** Fond sati za mesec (radni dani − praznici na radne × 8h; minus neplaćeni). */
export function computeMonthlyFond(
  year: number,
  month: number,
  holidayDates: Set<string> | string[],
  neplacenoDays = 0,
): { fondSati: number; radniDani: number; prazniciNaRadnim: number } {
  const set =
    holidayDates instanceof Set
      ? holidayDates
      : new Set(Array.isArray(holidayDates) ? holidayDates : []);
  const daysInMonth = new Date(year, month, 0).getDate();
  let radniDani = 0;
  let prazniciNaRadnim = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const dow = dt.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    radniDani += 1;
    const ymd = ymdLocal(dt);
    if (set.has(ymd)) prazniciNaRadnim += 1;
  }
  const nop = Math.max(0, Math.round(neplacenoDays));
  return {
    fondSati:
      (radniDani - prazniciNaRadnim) * REGULAR_DAY_HOURS -
      nop * REGULAR_DAY_HOURS,
    radniDani,
    prazniciNaRadnim,
  };
}

/** Ponedeljak–petak (lokalni kalendar). */
export function isWeekdayYmd(ymd: string): boolean {
  if (!ymd || typeof ymd !== "string") return false;
  const [y, m, d] = ymd.split("-").map((n) => parseInt(n, 10));
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay();
  return dow >= 1 && dow <= 5;
}

interface WorkHoursRow {
  hours?: Numish;
  overtimeHours?: Numish;
  overtime_hours?: Numish;
  twoMachineHours?: Numish;
  two_machine_hours?: Numish;
  absenceCode?: unknown;
  absence_code?: unknown;
  absenceSubtype?: unknown;
  absence_subtype?: unknown;
}

/** Jedan mesec work_hours mapiran u agregat za obračun (port 1.0). */
export function aggregateWorkHoursForMonth(
  year: number,
  month: number,
  rowsByYmd:
    | Map<string, WorkHoursRow>
    | Record<string, WorkHoursRow>
    | null
    | undefined,
  holidayYmdSet: Set<string> | string[],
  opts?: HolidayOpts,
): Required<HoursAgg> {
  const hol =
    holidayYmdSet instanceof Set
      ? holidayYmdSet
      : new Set(Array.isArray(holidayYmdSet) ? holidayYmdSet : []);
  const last = new Date(year, month, 0).getDate();
  const out: Required<HoursAgg> = {
    redovanRadSati: 0,
    prekovremeniSati: 0,
    praznikRadSati: 0,
    praznikPlaceniSati: 0,
    godisnjiSati: 0,
    slobodniDaniSati: 0,
    bolovanje65Sati: 0,
    bolovanje100Sati: 0,
    dveMasineSati: 0,
    neplacenoDays: 0,
  };

  const getRow = (ymd: string): WorkHoursRow | null => {
    if (!rowsByYmd) return null;
    if (rowsByYmd instanceof Map) return rowsByYmd.get(ymd) || null;
    return (rowsByYmd as Record<string, WorkHoursRow>)[ymd] || null;
  };

  for (let day = 1; day <= last; day++) {
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    const ymd = `${year}-${mm}-${dd}`;
    const r = getRow(ymd);
    const h = r ? NUM(r.hours) : 0;
    const ot = r ? NUM(r.overtimeHours ?? r.overtime_hours) : 0;
    const tm = r ? NUM(r.twoMachineHours ?? r.two_machine_hours) : 0;
    const abs = normAbsCode(r?.absenceCode ?? r?.absence_code);
    const sub = normAbsCode(r?.absenceSubtype ?? r?.absence_subtype);

    out.prekovremeniSati += ot;
    out.dveMasineSati += tm;

    const dt = parseDateLocal(ymd);
    const dow = dt ? dt.getDay() : new Date(year, month - 1, day).getDay();
    const weekend = dow === 0 || dow === 6;
    const isHol = hol.has(ymd);

    if (weekend) {
      if (!abs && h > 0) {
        out.redovanRadSati += h;
        continue;
      }
      if (isHol && h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (isHol) {
        if (abs === "go") out.godisnjiSati += REGULAR_DAY_HOURS;
        else if (abs === "bo") {
          if (sub === "povreda_na_radu" || sub === "odrzavanje_trudnoce")
            out.bolovanje100Sati += REGULAR_DAY_HOURS;
          else out.bolovanje65Sati += REGULAR_DAY_HOURS;
        } else if (abs === "sp") out.praznikPlaceniSati += REGULAR_DAY_HOURS;
        else if (abs && PAID_FREE_DAY_CODES.has(abs))
          out.slobodniDaniSati += REGULAR_DAY_HOURS;
        continue;
      }
      if (abs === "go") out.godisnjiSati += REGULAR_DAY_HOURS;
      else if (abs === "bo") {
        if (sub === "povreda_na_radu" || sub === "odrzavanje_trudnoce")
          out.bolovanje100Sati += REGULAR_DAY_HOURS;
        else out.bolovanje65Sati += REGULAR_DAY_HOURS;
      } else if (abs === "sp") out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      else if (abs && PAID_FREE_DAY_CODES.has(abs))
        out.slobodniDaniSati += REGULAR_DAY_HOURS;
      continue;
    }

    /* Radni dan kalendarski (pon–pet) */
    if (isHol) {
      if (h > 0) {
        out.praznikRadSati += h;
        continue;
      }
      if (abs === "go") out.godisnjiSati += REGULAR_DAY_HOURS;
      else if (abs === "bo") {
        if (sub === "povreda_na_radu" || sub === "odrzavanje_trudnoce")
          out.bolovanje100Sati += REGULAR_DAY_HOURS;
        else out.bolovanje65Sati += REGULAR_DAY_HOURS;
      } else if (abs === "sp") out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      else if (abs && PAID_FREE_DAY_CODES.has(abs))
        out.slobodniDaniSati += REGULAR_DAY_HOURS;
      else if (abs === "np" || abs === "pr" || abs === "nop") {
        /* ne plaća se */
      } else if (isAutoPaidHolidayEligible(ymd, opts)) {
        out.praznikPlaceniSati += REGULAR_DAY_HOURS;
      }
      continue;
    }

    /* Običan radni dan */
    if (abs === "go") out.godisnjiSati += REGULAR_DAY_HOURS;
    else if (abs === "bo") {
      if (sub === "povreda_na_radu" || sub === "odrzavanje_trudnoce")
        out.bolovanje100Sati += REGULAR_DAY_HOURS;
      else out.bolovanje65Sati += REGULAR_DAY_HOURS;
    } else if (abs === "sp") out.praznikPlaceniSati += REGULAR_DAY_HOURS;
    else if (abs && PAID_FREE_DAY_CODES.has(abs))
      out.slobodniDaniSati += REGULAR_DAY_HOURS;
    else if (abs === "np" || abs === "pr" || abs === "nop") {
      out.neplacenoDays += 1;
    } else {
      out.redovanRadSati += h;
    }
  }

  return out;
}

/** Zbir za „Redovni" red mesečnog grida (prikazni Σ). */
export function gridRedovniSumUnitsForMonth(
  year: number,
  month: number,
  rowsByYmd:
    | Map<string, WorkHoursRow>
    | Record<string, WorkHoursRow>
    | null
    | undefined,
  holidayYmdSet: Set<string> | string[],
  opts?: HolidayOpts,
): number {
  const agg = aggregateWorkHoursForMonth(
    year,
    month,
    rowsByYmd,
    holidayYmdSet,
    opts,
  );
  return (
    agg.redovanRadSati +
    agg.praznikPlaceniSati +
    agg.godisnjiSati +
    agg.slobodniDaniSati +
    agg.bolovanje65Sati +
    agg.bolovanje100Sati +
    agg.praznikRadSati
  );
}

/** Doprinos jednog dana zbiru „Redovni" reda u mesečnom gridu (prikazni Σ). */
export function gridRedovniUnitsOneDay(
  ymd: string,
  row: {
    hours?: Numish;
    absence_code?: unknown;
    absenceCode?: unknown;
    absence_subtype?: unknown;
    absenceSubtype?: unknown;
  } | null,
  holidayYmdSet: Set<string> | string[],
  opts?: HolidayOpts,
): number {
  const hol =
    holidayYmdSet instanceof Set
      ? holidayYmdSet
      : new Set(Array.isArray(holidayYmdSet) ? holidayYmdSet : []);
  const eff = row || {};
  const h = NUM(eff.hours);
  const abs = normAbsCode(eff.absence_code ?? eff.absenceCode);

  const [yStr, mStr, dStr] = (ymd || "").split("-");
  const y = parseInt(yStr, 10);
  const mo = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (!y || !mo || !d) return 0;
  const dt = parseDateLocal(ymd);
  const dow = dt ? dt.getDay() : new Date(y, mo - 1, d).getDay();
  const weekend = dow === 0 || dow === 6;
  const isHol = hol.has(ymd);

  if (weekend) {
    if (!abs && h > 0) return h;
    if (isHol && h > 0) return h;
    if (isHol) {
      if (abs === "go") return REGULAR_DAY_HOURS;
      if (abs === "bo") return REGULAR_DAY_HOURS;
      if (abs === "sp") return REGULAR_DAY_HOURS;
      if (abs && PAID_FREE_DAY_CODES.has(abs)) return REGULAR_DAY_HOURS;
      if (abs === "np" || abs === "pr" || abs === "nop") return 0;
      return 0;
    }
    if (
      abs === "go" ||
      abs === "sp" ||
      abs === "bo" ||
      (abs && PAID_FREE_DAY_CODES.has(abs))
    ) {
      return REGULAR_DAY_HOURS;
    }
    if (abs === "np" || abs === "pr" || abs === "nop") return 0;
    return 0;
  }
  if (isHol) {
    if (h > 0) return h;
    if (abs === "go") return REGULAR_DAY_HOURS;
    if (abs === "bo") return REGULAR_DAY_HOURS;
    if (abs === "sp") return REGULAR_DAY_HOURS;
    if (abs && PAID_FREE_DAY_CODES.has(abs)) return REGULAR_DAY_HOURS;
    if (abs === "np" || abs === "pr" || abs === "nop") return 0;
    return isAutoPaidHolidayEligible(ymd, opts) ? REGULAR_DAY_HOURS : 0;
  }
  if (
    abs === "go" ||
    abs === "sp" ||
    abs === "bo" ||
    (abs && PAID_FREE_DAY_CODES.has(abs))
  ) {
    return REGULAR_DAY_HOURS;
  }
  if (abs === "np" || abs === "pr" || abs === "nop") return 0;
  return h;
}

export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
