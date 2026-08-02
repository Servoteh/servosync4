/**
 * PDV SANITY — zaštita od TIHE greške u PDV evidenciji.
 * =========================================================================
 * KIF/KUF/POPDV se izvode iz glavne knjige po PDV kontima (`vat_account_map`).
 * Taj put ima tri klase tihih otkaza koje smo REPRODUKOVALI nad uvezenim
 * BigBit podacima (dev baza, 03/2026, pre ispravke):
 *
 *   1. KUF je nabrajao 625 stavki a UKUPNO je bilo 0,00 — tehnički nalog
 *      zatvaranja PDV konta ulazio je u isti zbir sa suprotnim znakom;
 *   2. KIF je imao zbir PDV −1.236.156,30 uz zbir osnovica 0,00 — pogrešno
 *      mapiran konto (potraživanje, ne PDV konto) sa stopom 0;
 *   3. PP-PDV je iz toga prijavio POVRAĆAJ 1.236.156,30 umesto 21.602.291,00.
 *
 * Nijedna od te tri nije bacila grešku — PDF se uredno štampao i mogao je biti
 * poslat mejlom. Zato ovaj modul: obračun i štampa MORAJU da jave, ne da tiho
 * izađu. Poruke su na srpskom i pišu knjigovođi šta konkretno ne valja.
 *
 * KONTROLA PREMA BIGBITU — ŠTA STVARNO DOKAZUJE. BigBit svaki mesec zatvara sva
 * PDV konta tehničkim nalogom vrste `PDV` u transitno konto 2790 („Potraživanja
 * za preplaćeni PDV") / 4790 („Obaveze za PDV"). Naš (pretporez − obaveza) IZ
 * GLAVNE KNJIGE mora da se poklopi sa saldom tog konta u granici zaokruženja
 * (BigBit zaokružuje obavezu na ceo dinar i razliku knjiži na 6799/5799 —
 * izmereno 0,20–1,11 RSD za 6 zatvorenih meseci 2026, zato prag ±2,00 RSD po
 * mesecu perioda).
 *
 * POŠTENO O DOMETU TE KONTROLE (review nalaz): taj nalog je uravnotežen do pare,
 * a skup konta u registru je definisan kao „konta koja on zatvara". Kontrola
 * zato dokazuje DA SE SKUP KONTA I NJIHOV NETO POKLAPAJU — da nijedno PDV konto
 * ne ispada iz knjiga i da ništa strano ne ulazi. NE dokazuje da su stope,
 * osnovice i razvrstavanje po POPDV poljima tačni. Zato postoje i pravila P1–P3
 * i P5, od kojih P5 (osnovica vs stopa) NIJE izvedeno iz istog naloga.
 *
 * RUČNE STAVKE (D4) NE ULAZE U KONTROLU. Ručna KIF/KUF stavka po definiciji nema
 * nalog u glavnoj knjizi, pa je nema ni u BigBit-ovom nalogu zatvaranja —
 * poređenje ide nad GK-izvedenim delom, a ručni deo se prikazuje kao imenovana
 * odstupnica (upozorenje). Bez toga je JEDNA ručna stavka trajno obarala
 * punjenje, obračun i štampu celog perioda (reprodukovano na dev bazi).
 */

import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;
const ZERO = new D(0);

/**
 * Vrsta TEHNIČKOG naloga kojim BigBit mesečno zatvara PDV konta u transitno
 * konto 2790/4790. Taj nalog NIJE poslovni promet — njegove stavke na PDV
 * kontima su ogledalo mesečnog prometa sa suprotnim znakom, pa ulaskom u KIF/KUF
 * ponište ceo mesec u nulu.
 *
 * IZUZIMA SE PRECIZNO, ne u celini (isti obrazac kao `CLOSING_ORDER_TYPE` u
 * `zavrsni/gkeval.service.ts`): iz naloga ispadaju SAMO stavke na kontima iz
 * PDV registra. Stavka transitnog konta 2790/4790 (potraživanje/obaveza prema
 * Poreskoj upravi) i stavka zaokruženja na 6799/5799 iz ISTOG naloga NAMERNO
 * ostaju u glavnoj knjizi — one su knjigovodstveni rezultat obračuna i moraju
 * se videti u bilansu (a 2790/4790 je ujedno i kontrolna tačka ispod).
 *
 * Vezano za ŠIFRU VRSTE NALOGA (`journal_entries.order_type_code`), ne za
 * `bb_nalog_id` — ponovni uvoz istog meseca dobija nov `id`, vrsta ostaje ista.
 */
export const VAT_SETTLEMENT_ORDER_TYPE = "PDV";

/**
 * Transitna PDV konta (prema Poreskoj upravi). NAMERNO nisu u `vat_account_map`
 * — nisu ni pretporez ni obaveza nego rezultat obračuna; ovde služe kao
 * kontrolna tačka prema BigBitu.
 */
export const VAT_TRANSIT_ACCOUNTS = ["2790", "4790"] as const;

/**
 * Dozvoljeno odstupanje našeg obračuna od BigBit-ovog salda 2790/4790 — PO
 * MESECU PERIODA. Izmereno na 6 zatvorenih meseci 2026: 0,20 / 0,33 / 0,42 /
 * 0,66 / 0,80 / 1,11 RSD — sve je zaokruženje obaveze na ceo dinar (razlika
 * knjižena na 6799/5799). Uži prag bi počeo da obara ISPRAVAN obračun i guard bi
 * bio isključen posle druge lažne uzbune.
 *
 * MNOŽI SE BROJEM MESECI: kvartalni obveznik ima tri nezavisna zaokruženja, pa
 * bi fiksnih 2,00 obaralo ispravan kvartal u kojem sva tri padnu na istu stranu
 * (3 × 1,11 = 3,33 > 2,00).
 */
export const VAT_RECON_TOLERANCE = new D("2.00");

/**
 * Marker ručne KUF stavke bez prava na odbitak („van PDV") — isti string kao
 * `VAT_RATE_CODE_NO_DEDUCTION` u `dto/manual-vat-entry.dto.ts`. Ovde se drži
 * lokalno da `vat-sanity` ostane list bez zavisnosti na DTO sloj; obe konstante
 * su zaključane testom.
 */
export const VAT_RATE_CODE_NO_DEDUCTION_SANITY = "VP";

/**
 * Dozvoljeno odstupanje Σ PDV od Σ osnovica × stopa unutar jedne stope (P5):
 * 1,00 RSD + 0,1% iznosa. Zaokruživanje po dokumentu i BigBit-ove korekcije od
 * po nekoliko para staju u to; greška tipa „konto skida PDV a ne skida osnovicu"
 * (izmereno 60.101.996,50 RSD na KUF 03/2026) je red veličine iznad.
 */
const RATE_CONSISTENCY_FIXED = new D("1.00");
const RATE_CONSISTENCY_PCT = new D("0.001");

/** Zbir jedne knjige (KIF ili KUF) iz `vat_ledger_entries`. */
export interface VatBookSums {
  count: number;
  base: Prisma.Decimal;
  vat: Prisma.Decimal;
}

/** Σ osnovice/PDV jedne stope unutar jedne knjige (za pravilo P5). */
export interface VatRateGroup {
  direction: string; // input | output
  /** Šifra stope iz `vat_ledger_entries` („20", „10", „VP", null = bez stope). */
  rateCode: string | null;
  count: number;
  base: Prisma.Decimal;
  vat: Prisma.Decimal;
}

/**
 * Σ RUČNIH stavki perioda (`sourceJournalEntryId IS NULL`). Postoje DVA zbira
 * jer se dva pozivaoca razlikuju: obračun (POPDV/VatReturn) iz pretporeza
 * izbacuje „van PDV" stavke, a zbir knjige ih sadrži. Kontrola prema BigBitu
 * mora da oduzme TAČNO onaj deo koji je u njen ulaz i ušao.
 */
export interface VatManualSums {
  count: number;
  /** Σ ručnih po smeru PO PRAVILU OBRAČUNA (input bez „van PDV" stavki). */
  output: Prisma.Decimal;
  input: Prisma.Decimal;
  /** Σ ručnih po smeru PO PRAVILU KNJIGE (sve, uključujući „van PDV"). */
  outputAll: Prisma.Decimal;
  inputAll: Prisma.Decimal;
  /** Σ ulaznog PDV-a bez prava na odbitak (marker „VP") — informativno. */
  noDeduction: Prisma.Decimal;
}

/** Sirovi ulaz provere — sve što se čita iz baze (odvojeno radi testabilnosti). */
export interface VatSanityInput {
  year: number;
  months: number[];
  /** KIF (direction = 'output') iz `vat_ledger_entries`. */
  kif: VatBookSums;
  /** KUF (direction = 'input') iz `vat_ledger_entries`. */
  kuf: VatBookSums;
  /** Σ po (smer, stopa) — ulaz pravila P5 (osnovica mora odgovarati stopi). */
  rateGroups: VatRateGroup[];
  /** Σ ručnih stavki — izuzimaju se iz kontrole prema BigBitu. */
  manual: VatManualSums;
  /**
   * Autoritativan obračun perioda (POPDV/VatReturn). Kad je zadat, kontrola
   * prema BigBitu se radi nad njim; inače nad zbirovima knjiga.
   */
  computed?: { outputVat: Prisma.Decimal; inputVat: Prisma.Decimal };
  /**
   * Saldo transitnih konta (2790/4790) iz naloga vrste PDV za period, kao
   * Σ(duguje − potražuje). Pozitivno = povraćaj (potraživanje od PU).
   * `null` = period nema nalog zatvaranja (otvoren period) → kontrola nije moguća.
   */
  bigbitControl: Prisma.Decimal | null;
  /**
   * 27x/47x konta sa prometom u periodu koja NISU ni u `vat_account_map` ni u
   * `popdv_account_map` (ni transitna) — kandidati za tiho ispadanje iz knjiga.
   */
  unmappedAccounts: { account: string; net: Prisma.Decimal }[];
}

/** Rezultat provere: problemi (blokiraju) + upozorenja (ne blokiraju). */
export interface VatSanityReport {
  year: number;
  months: number[];
  periodLabel: string;
  kif: VatBookSums;
  kuf: VatBookSums;
  /** (pretporez − obaveza): pozitivno = povraćaj, negativno = obaveza za uplatu. */
  computedRefund: Prisma.Decimal;
  /** Deo `computedRefund`-a koji potiče IZ GLAVNE KNJIGE (bez ručnih stavki). */
  gkRefund: Prisma.Decimal;
  manual: VatManualSums;
  bigbitControl: Prisma.Decimal | null;
  /** gkRefund − bigbitControl (null kad kontrola nije moguća). */
  controlDiff: Prisma.Decimal | null;
  /** Primenjeni prag kontrole (2,00 RSD × broj meseci perioda). */
  controlTolerance: Prisma.Decimal;
  problems: string[];
  warnings: string[];
  ok: boolean;
}

/** „03/2026" ili „Q1/2026" oblik za poruke. */
function labelFor(year: number, months: number[]): string {
  if (months.length === 1) return `${String(months[0]).padStart(2, "0")}/${year}`;
  if (months.length === 0) return String(year);
  return `${String(months[0]).padStart(2, "0")}–${String(months[months.length - 1]).padStart(2, "0")}/${year}`;
}

/** Novčani zapis za poruku greške (srpski: tačka=hiljade, zarez=decimala). */
export function fmtRsd(v: Prisma.Decimal): string {
  const fixed = new D(v).toFixed(2);
  const neg = fixed.startsWith("-");
  const [i, d] = (neg ? fixed.slice(1) : fixed).split(".");
  return `${neg ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${d}`;
}

/**
 * ČISTA evaluacija (bez baze — zato je testabilna). Vraća izveštaj; ne baca.
 *
 * PRAVILA — svako je vezano za konkretan reprodukovan otkaz:
 *   P1  knjiga ima stavke a Σ PDV je tačno 0,00
 *       → tehnički nalog / suprotan znak poništio mesec (KUF 03/2026: 625 → 0,00).
 *       Uslov MORA da nosi i „ima stavki": mesec bez prometa je legitimna nula.
 *   P2  knjiga ima stavke i Σ PDV ≠ 0 a Σ osnovica je 0,00
 *       → stopa/registar ne daju osnovicu (KIF 03/2026: PDV −1,23 mil, osnovica 0).
 *   P3  |Σ osnovica| < |Σ PDV| uz osnovicu ≠ 0
 *       → matematički nemoguće za stope ≤ 20% (inverzija osnovice i poreza).
 *   P4  |GK deo (pretporez − obaveza) − BigBit saldo 2790/4790| > 2,00 × meseci
 *       → skup konta se poklapa sa BigBitom; za 03/2026 stari kod pada sa
 *       20.366.134,70. Ručne stavke se PRE poređenja oduzimaju (nemaju nalog u GK).
 *   P5  unutar jedne stope: |Σ PDV − Σ osnovica × stopa| > 1,00 + 0,1%
 *       → osnovica ne odgovara stopi. Jedino pravilo koje NIJE izvedeno iz
 *       BigBit-ovog naloga zatvaranja, pa hvata i grešku koju kontrola P4 ne vidi
 *       (KIF 02/2026 je imao implicitnu stopu 6,99% uz P4 razliku od 0,80 RSD).
 *   U1  period nema nalog vrste PDV (otvoren mesec) → SAMO upozorenje, ne blokada.
 *   U2  27x/47x konto sa prometom van oba registra → tiho ispada iz knjiga.
 *   U3  period ima ručne stavke → imenovana odstupnica prema BigBit kontroli.
 *   U4  stavke bez upisane stope nose PDV → osnovica im je 0 (proveri registar).
 */
export function evaluateVatSanity(input: VatSanityInput): VatSanityReport {
  const {
    year,
    months,
    kif,
    kuf,
    rateGroups,
    manual,
    computed,
    bigbitControl,
    unmappedAccounts,
  } = input;
  const periodLabel = labelFor(year, months);
  const problems: string[] = [];
  const warnings: string[] = [];

  const book = (name: "KIF" | "KUF", s: VatBookSums, what: string) => {
    if (s.count <= 0) return; // period bez prometa je legitiman
    if (new D(s.vat).isZero()) {
      problems.push(
        `${name} za ${periodLabel} ima ${s.count} ${stavki(s.count)} ${what}, a ukupan PDV je 0,00. ` +
          `To znači da se stavke međusobno poništavaju — najčešće je u zbir ušao tehnički ` +
          `nalog zatvaranja PDV konta.`,
      );
      return;
    }
    if (new D(s.base).isZero()) {
      problems.push(
        `${name} za ${periodLabel} ima ${s.count} ${stavki(s.count)} i ukupan PDV ` +
          `${fmtRsd(s.vat)}, a ukupna osnovica je 0,00. Proveri stope i uloge konta u ` +
          `registru PDV konta (konto bez stope ne može nositi PDV).`,
      );
      return;
    }
    if (new D(s.base).abs().lt(new D(s.vat).abs())) {
      problems.push(
        `${name} za ${periodLabel}: ukupna osnovica ${fmtRsd(s.base)} je manja od ukupnog ` +
          `PDV ${fmtRsd(s.vat)}. Pri stopama do 20% to nije moguće — osnovica i porez su ` +
          `zamenjeni ili je konto pogrešno mapiran.`,
      );
    }
  };

  book("KIF", kif, "izlaznih dokumenata");
  book("KUF", kuf, "ulaznih dokumenata");

  // ── P5: osnovica mora odgovarati stopi, unutar SVAKE stope zasebno ─────────
  // Poređenje po grupi (a ne po celoj knjizi) jer knjiga meša 20% i 10%, pa bi
  // zbirna „implicitna stopa" bila mutna. Šifre koje nisu broj (marker „VP") i
  // stopa 0 se preskaču — one po definiciji ne nose izvedenu osnovicu.
  for (const g of rateGroups) {
    if (g.count <= 0) continue;
    const code = (g.rateCode ?? "").trim();
    const bookName = g.direction === "output" ? "KIF" : "KUF";
    if (code === "" || code === VAT_RATE_CODE_NO_DEDUCTION_SANITY) {
      // U4: stavke bez stope. Nisu greška po sebi (ručna stavka sme biti bez
      // stope), ali osnovica im se ne izvodi — knjigovođa to mora da vidi.
      if (!new D(g.vat).isZero()) {
        warnings.push(
          `${bookName} za ${periodLabel}: ${g.count} ${stavki(g.count)} ` +
            (code === VAT_RATE_CODE_NO_DEDUCTION_SANITY
              ? `sa oznakom „bez prava na odbitak" nosi PDV ${fmtRsd(g.vat)} — taj iznos ` +
                `NE ulazi u pretporez (pozicija 008/108) i namerno je van provere stope.`
              : `bez upisane stope nosi PDV ${fmtRsd(g.vat)}, a osnovica im se ne može ` +
                `izvesti. Ako su izvedene iz glavne knjige, kontu fali stopa u registru PDV konta.`),
        );
      }
      continue;
    }
    const rate = Number(code);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const expected = new D(g.base).mul(rate).div(100);
    const diff = new D(g.vat).sub(expected);
    const tol = RATE_CONSISTENCY_FIXED.add(new D(g.vat).abs().mul(RATE_CONSISTENCY_PCT));
    if (diff.abs().gt(tol)) {
      problems.push(
        `${bookName} za ${periodLabel}, stopa ${code}%: osnovica ${fmtRsd(g.base)} pri toj ` +
          `stopi daje PDV ${fmtRsd(expected)}, a u knjizi stoji ${fmtRsd(g.vat)} ` +
          `(razlika ${fmtRsd(diff)} RSD na ${g.count} ${stavki(g.count)}). Osnovica i porez ` +
          `se ne slažu — proveri stope u registru PDV konta i ručno unete stavke.`,
      );
    }
  }

  const outputVat = new D(computed?.outputVat ?? kif.vat);
  const inputVat = new D(computed?.inputVat ?? kuf.vat);
  const computedRefund = inputVat.sub(outputVat);

  // ── P4: kontrola prema BigBitu — SAMO nad GK-izvedenim delom ──────────────
  // `computed` (POPDV/VatReturn) sadrži ručne stavke po pravilu obračuna (input
  // bez „van PDV"); zbir knjige ih sadrži sve. Oduzima se tačno onaj deo koji je
  // u ulaz i ušao, inače kontrola poredi jabuke sa kruškama i JEDNA ručna stavka
  // trajno obara period (reprodukovano na dev bazi: razlika = iznos stavke).
  const manualOutputIn = computed ? new D(manual.output) : new D(manual.outputAll);
  const manualInputIn = computed ? new D(manual.input) : new D(manual.inputAll);
  const gkRefund = inputVat
    .sub(manualInputIn)
    .sub(outputVat.sub(manualOutputIn));
  const controlTolerance = VAT_RECON_TOLERANCE.mul(Math.max(1, months.length));

  let controlDiff: Prisma.Decimal | null = null;
  if (bigbitControl == null) {
    warnings.push(
      `Za ${periodLabel} ne postoji nalog zatvaranja PDV konta (vrsta ${VAT_SETTLEMENT_ORDER_TYPE}), ` +
        `pa poređenje sa BigBitom nije moguće. Period je verovatno još otvoren — ` +
        `obračun je izračunat, ali NIJE upoređen sa BigBit-ovim rezultatom.`,
    );
  } else {
    controlDiff = gkRefund.sub(new D(bigbitControl));
    if (controlDiff.abs().gt(controlTolerance)) {
      problems.push(
        `Obračun za ${periodLabel} se NE slaže sa BigBitom: iz glavne knjige nam izlazi ` +
          `${fmtRsd(gkRefund)}, a BigBit-ov nalog zatvaranja daje ` +
          `${fmtRsd(new D(bigbitControl))} na kontima ${VAT_TRANSIT_ACCOUNTS.join("/")}. ` +
          `Razlika ${fmtRsd(controlDiff)} RSD (dozvoljeno je najviše ` +
          `${fmtRsd(controlTolerance)} zbog zaokruživanja).`,
      );
    }
  }

  // U3: ručne stavke su legitimne, ali stoje VAN poređenja sa BigBitom — to mora
  // da se vidi, da knjigovođa zna zašto se brojevi razlikuju od BigBit naloga.
  if (manual.count > 0) {
    const manualNet = manualInputIn.sub(manualOutputIn);
    warnings.push(
      `${periodLabel} sadrži ${manual.count} ručno unetu/e KIF/KUF ${stavki(manual.count)} ` +
        `(neto ${fmtRsd(manualNet)} RSD). Njih nema u glavnoj knjizi, pa ne ulaze u poređenje ` +
        `sa BigBit-ovim nalogom zatvaranja — u prijavi jesu, u kontroli nisu.` +
        (new D(manual.noDeduction).isZero()
          ? ""
          : ` Od toga ${fmtRsd(manual.noDeduction)} RSD nosi oznaku „bez prava na odbitak" ` +
            `i ne ulazi u pretporez.`),
    );
  }

  for (const a of unmappedAccounts) {
    warnings.push(
      `Konto ${a.account} ima promet ${fmtRsd(a.net)} u ${periodLabel}, a nije ni u registru ` +
        `PDV konta ni u POPDV mapi — tiho ispada iz KIF/KUF i PDV prijave.`,
    );
  }

  return {
    year,
    months,
    periodLabel,
    kif,
    kuf,
    computedRefund,
    gkRefund,
    manual,
    bigbitControl: bigbitControl == null ? null : new D(bigbitControl),
    controlDiff,
    controlTolerance,
    problems,
    warnings,
    ok: problems.length === 0,
  };
}

/** Srpska množina uz broj stavki (1 stavku / 2–4 stavke / 5+ stavki). */
function stavki(n: number): string {
  const abs = Math.abs(n);
  const last2 = abs % 100;
  const last = abs % 10;
  if (last === 1 && last2 !== 11) return "stavku";
  if (last >= 2 && last <= 4 && (last2 < 12 || last2 > 14)) return "stavke";
  return "stavki";
}

/** Minimalna Prisma površina koju provera koristi (radi i sa `tx` klijentom). */
export interface VatSanityDb {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * Učitaj ulaz provere iz baze. Radi i unutar transakcije (`tx`) — u
 * `buildKifKuf` se poziva POSLE upisa, pa vidi tek napunjene knjige i pad
 * provere povlači ROLLBACK celog punjenja.
 */
export async function loadVatSanityInput(
  db: VatSanityDb,
  year: number,
  months: number[],
  computed?: { outputVat: Prisma.Decimal; inputVat: Prisma.Decimal },
): Promise<VatSanityInput> {
  const emptyManual = (): VatManualSums => ({
    count: 0,
    output: ZERO,
    input: ZERO,
    outputAll: ZERO,
    inputAll: ZERO,
    noDeduction: ZERO,
  });

  if (months.length === 0) {
    return {
      year,
      months,
      kif: { count: 0, base: ZERO, vat: ZERO },
      kuf: { count: 0, base: ZERO, vat: ZERO },
      rateGroups: [],
      manual: emptyManual(),
      computed,
      bigbitControl: null,
      unmappedAccounts: [],
    };
  }

  const monthList = Prisma.join(months);

  // Jedan prolaz kroz knjige: Σ po (smer, stopa, ručno/GK). Iz njega se izvode i
  // zbirovi knjiga (P1–P3), i grupe po stopi (P5), i ručna odstupnica (P4).
  const bookRows = await db.$queryRaw<
    {
      direction: string;
      rate_code: string | null;
      is_manual: boolean;
      n: bigint | number;
      base: Prisma.Decimal | null;
      vat: Prisma.Decimal | null;
    }[]
  >(Prisma.sql`
    SELECT direction,
           vat_rate_code                          AS rate_code,
           (source_journal_entry_id IS NULL)      AS is_manual,
           COUNT(*)                               AS n,
           COALESCE(SUM(vat_base), 0)             AS base,
           COALESCE(SUM(vat_amount), 0)           AS vat
    FROM vat_ledger_entries
    WHERE tax_period_year = ${year} AND tax_period_month IN (${monthList})
    GROUP BY direction, vat_rate_code, (source_journal_entry_id IS NULL)
  `);

  const emptyBook = (): VatBookSums => ({ count: 0, base: ZERO, vat: ZERO });
  const kif = emptyBook();
  const kuf = emptyBook();
  const manual = emptyManual();
  const rateKey = new Map<string, VatRateGroup>();

  for (const r of bookRows) {
    const isOutput = r.direction === "output";
    const n = Number(r.n ?? 0);
    const base = new D(r.base ?? ZERO);
    const vat = new D(r.vat ?? ZERO);

    const target = isOutput ? kif : kuf;
    target.count += n;
    target.base = target.base.add(base);
    target.vat = target.vat.add(vat);

    // Grupe po stopi zbrajaju ručne i GK stavke — P5 važi za obe (i ručna stavka
    // sa stopom 20% mora imati osnovicu koja odgovara svom porezu).
    const key = `${r.direction}|${r.rate_code ?? ""}`;
    const g = rateKey.get(key);
    if (g) {
      g.count += n;
      g.base = g.base.add(base);
      g.vat = g.vat.add(vat);
    } else {
      rateKey.set(key, {
        direction: r.direction,
        rateCode: r.rate_code,
        count: n,
        base,
        vat,
      });
    }

    if (r.is_manual) {
      manual.count += n;
      const noDed =
        !isOutput && (r.rate_code ?? "") === VAT_RATE_CODE_NO_DEDUCTION_SANITY;
      if (isOutput) {
        manual.outputAll = manual.outputAll.add(vat);
        manual.output = manual.output.add(vat);
      } else {
        manual.inputAll = manual.inputAll.add(vat);
        if (noDed) manual.noDeduction = manual.noDeduction.add(vat);
        // Pravilo obračuna: „van PDV" ulazna stavka NE ulazi u pretporez
        // (isto kao `sumManualVatEntries` u popdv.service.ts).
        else manual.input = manual.input.add(vat);
      }
    }
  }

  const rateGroups = [...rateKey.values()];

  // Kontrolna tačka: saldo transitnih konta u nalogu vrste PDV za period.
  // Σ(duguje − potražuje): 2790 duguje = povraćaj, 4790/2790 potražuje = obaveza.
  const ctrl = await db.$queryRaw<{ n: bigint | number; net: Prisma.Decimal | null }[]>(Prisma.sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS net
    FROM ledger_entries le
    JOIN journal_entries je ON je.id = le.journal_entry_id
    WHERE je.status IN ('POSTED', 'LOCKED')
      AND COALESCE(je.order_type_code, '') = ${VAT_SETTLEMENT_ORDER_TYPE}
      AND le.account_code IN (${Prisma.join([...VAT_TRANSIT_ACCOUNTS])})
      AND EXTRACT(YEAR FROM je.posting_date) = ${year}
      AND EXTRACT(MONTH FROM je.posting_date) IN (${monthList})
  `);
  const ctrlCount = Number(ctrl[0]?.n ?? 0);
  const bigbitControl = ctrlCount > 0 ? new D(ctrl[0]?.net ?? ZERO) : null;

  // 27x/47x konta sa prometom van OBA registra (vat_account_map + popdv_account_map)
  // i van transitnih — kandidat za tiho ispadanje. Prefiks se koristi SAMO kao
  // alarm, nikad kao osnov obračuna (mapiranje ostaje eksplicitno po kontu).
  const unmapped = await db.$queryRaw<{ account_code: string; net: Prisma.Decimal | null }[]>(Prisma.sql`
    SELECT le.account_code, COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS net
    FROM ledger_entries le
    JOIN journal_entries je ON je.id = le.journal_entry_id
    WHERE je.status IN ('POSTED', 'LOCKED')
      AND EXTRACT(YEAR FROM je.posting_date) = ${year}
      AND EXTRACT(MONTH FROM je.posting_date) IN (${monthList})
      AND (le.account_code LIKE '27%' OR le.account_code LIKE '47%')
      AND le.account_code NOT IN (${Prisma.join([...VAT_TRANSIT_ACCOUNTS])})
      AND NOT EXISTS (SELECT 1 FROM vat_account_map v WHERE v.account = le.account_code)
      AND NOT EXISTS (SELECT 1 FROM popdv_account_map p WHERE p.account = le.account_code)
    GROUP BY le.account_code
    HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
    ORDER BY le.account_code
  `);

  return {
    year,
    months,
    kif,
    kuf,
    rateGroups,
    manual,
    computed,
    bigbitControl,
    unmappedAccounts: unmapped.map((u) => ({
      account: u.account_code,
      net: new D(u.net ?? ZERO),
    })),
  };
}

/** Učitaj + evaluiraj. Ne baca — pozivalac odlučuje (assert ili prikaz). */
export async function checkVatPeriodSanity(
  db: VatSanityDb,
  year: number,
  months: number[],
  computed?: { outputVat: Prisma.Decimal; inputVat: Prisma.Decimal },
): Promise<VatSanityReport> {
  return evaluateVatSanity(await loadVatSanityInput(db, year, months, computed));
}

/**
 * Baci `ConflictException` (409) ako izveštaj ima problem. Poruka je na srpskom
 * i navodi ŠTA je zaustavljeno, ŠTA konkretno ne valja i ŠTA da se uradi.
 * `what` = radnja koja se zaustavlja („Štampa KUF specifikacije", „Obračun…").
 */
export function assertVatPeriodSane(report: VatSanityReport, what: string): void {
  if (report.ok) return;
  throw new VatSanityException(report, what);
}

/**
 * Uputstvo „šta sad" — SME da pominje samo ono što u aplikaciji STVARNO postoji.
 * Ekran registra PDV konta ne postoji (registar se menja migracijom), pa se za
 * njega upućuje na administratora, a ne na nepostojeći tab u Podešavanjima.
 */
const WHAT_NEXT =
  'Šta dalje: proveri stavke perioda u karticama KIF i KUF i, ako je nalog u ' +
  'glavnoj knjizi menjan, ponovo pokreni „Napuni iz GK". Ako problem ostane, ' +
  'javi administratoru šifru PDV_OBRACUN_NEISPRAVAN i period — registar PDV ' +
  'konta se menja migracijom baze, ne kroz aplikaciju. Kad ti izlaz treba samo ' +
  'za proveru, uključi „Ipak prikaži": dokument izlazi sa crvenom oznakom ' +
  '„NEISPRAVAN OBRAČUN — NIJE ZA PREDAJU" i ne sme se predati ni poslati mejlom.';

/** 409 sa punim izveštajem u `details` (front može da prikaže listu). */
export class VatSanityException extends ConflictException {
  readonly code = "PDV_OBRACUN_NEISPRAVAN";
  constructor(
    public readonly report: VatSanityReport,
    what: string,
  ) {
    super({
      // Rodno neutralan oblik: `what` je čas muški („Obračun"), čas ženski
      // („Štampa"), pa se pridev uz njega ne sme slagati („je zaustavljena").
      message:
        `Zaustavljeno: ${what} — PDV evidencija za ${report.periodLabel} nije ispravna:\n` +
        report.problems.map((p) => `• ${p}`).join("\n") +
        `\n${WHAT_NEXT}`,
      code: "PDV_OBRACUN_NEISPRAVAN",
      details: {
        period: report.periodLabel,
        problems: report.problems,
        warnings: report.warnings,
      },
    });
  }
}
