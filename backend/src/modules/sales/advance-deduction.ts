import { Prisma } from "@prisma/client";

/**
 * ODBIJENI AVANS NA RAČUNU — JEDNO PRAVILO ZA CEO SISTEM.
 * =============================================================================
 * Do 02.08.2026. se „koliko je avansa odbijeno" računalo na PET mesta, i ta mesta
 * se NISU slagala:
 *
 *   `sales/advance-invoice.service.ts`  (applyAdvance)        UNIJA
 *   `pdv/advance-vat.service.ts`        (listAdvances)        UNIJA
 *   `sales/print/invoice-pdf.service.ts`(loadAdvanceDeductions) UNIJA
 *   `sales/fakturisanje.service.ts`     (getInvoice)          „ILI-ILI"
 *   `sales/sef/sef.service.ts`          (enqueue)             „ILI-ILI"
 *
 * Posledica se videla ŽIVO: račun sa zatečenom 1:1 vezom i novom N:M primenom je na
 * papiru imao „za uplatu 5.000", a na ekranu detalja i na e-fakturi 8.000. Zato ovaj
 * modul: pravilo se piše JEDNOM, a svih pet potrošača ga samo poziva.
 *
 * ── DVA IZVORA ISTE ČINJENICE ────────────────────────────────────────────────
 *
 *  1. `invoice_advance_applications` (od migracije 20260726120000) — AUTORITATIVNA,
 *     N:M veza avans↔račun. Jedan red = jedna primena, sa svojim iznosom i svojim
 *     GL nalogom zatvaranja. U zbir ulaze samo redovi `status = 'ACTIVE'`.
 *
 *  2. Kolone `invoices.advance_invoice_id` + `invoices.advance_applied_amount` —
 *     DENORMALIZACIJA, zadržane zbog SEF-a, štampe i FE-a. `advance_invoice_id`
 *     pokazuje na PRVI vezani avans, `advance_applied_amount` nosi UKUPNO odbijeno.
 *
 * ── ODAKLE „ZATEČENA 1:1 VEZA" (veza u koloni BEZ reda u spojnoj tabeli) ─────
 *
 *  (a) dokumenti knjiženi PRE migracije 20260726120000 — spojna tabela tada nije
 *      postojala, pa veza živi samo u koloni;
 *  (b) 🔴 ŽIV KANAL, ne samo istorija: pdv modul veže avans na konačni račun rutom
 *      `POST /pdv/advances/link-final` (`pdv.controller.ts`), a
 *      `AdvanceVatService.linkIncomingAdvanceToFinal` upisuje `advance_invoice_id` +
 *      `advance_applied_amount` PRAVO U KOLONE, bez reda u spojnoj tabeli. Takva veza
 *      nastaje i danas, na računima koje prodaja posle toga i dalje obrađuje.
 *
 * ── ZAŠTO UNIJA, A NE „ILI-ILI" ──────────────────────────────────────────────
 *
 * „ILI-ILI" znači: ako račun ima ijednu primenu, kolona se ne gleda. IZMEREN KVAR:
 * račun 10.000 → `A-1/26` = 3.000 povezan starim putem (`link-final`), `A-2/26` =
 * 2.000 novim (`applyAdvance`). Kolona nosi UNIJU (5.000), spojna tabela samo 2.000.
 * Po „ili-ili" ispada odbijeno 2.000 → za uplatu 8.000, a `A-1/26` nigde ne postoji:
 * kupcu se šalje VEĆI dug nego što ga ima, na poreskom dokumentu koji jedan avans
 * prećutkuje. Obrnuto (kolona ima prednost) bi na strani AVANSA dalo prekoračenje:
 * legacy deo bi se posle prve N:M primene zaboravio i avans naplaćen 5.000 bi mogao
 * da se primeni 7.000 puta preko (mereno pri drugom krugu pregleda 28.07.2026).
 *
 * Zato: Σ AKTIVNIH primena **plus** zatečena 1:1 veza KAD ONA NEMA SVOJ RED u
 * spojnoj tabeli (kad ga ima, to je isti podatak dvaput).
 *
 * ── IZNOS ZATEČENOG REDA = `kolona − Σ primena`, NE CELA KOLONA ──────────────
 *
 * Kolonu održava `applyAdvance` kao UKUPNO odbijeno (`totalApplied`), pa je deo koji
 * ne pokriva nijedna primena upravo ono što je odbijeno starim putem (u primeru:
 * 5.000 − 2.000 = 3.000 = `A-1/26`). Uzeti CELU kolonu značilo bi brojati N:M primene
 * dvaput — na strani računa bi „za uplatu" ispalo premalo, a na strani avansa bi se
 * iskorišćenost naduvala pa bi ostatak avansa nestao pre vremena.
 *
 * ⚠️ Isto važi i na strani AVANSA: `advance_applied_amount` je zbir odbitaka TOG
 * RAČUNA po SVIM avansima, a ne po posmatranom avansu — zato `computeAdvanceUsage`
 * legacy deo izvodi kroz `computeAdvanceDeductions` nad tim računom, umesto da uzme
 * kolonu kakva jeste. (To je bio tihi bag i u `applyAdvance` i u `listAdvances`:
 * račun sa legacy vezom na A-1 i N:M primenom A-2 je A-1 pripisivao zbir oba.)
 *
 * Nula ili negativna razlika znači da primene pokrivaju sve — reda tada NEMA. Kolona
 * ume da zaostane (ručna ispravka u bazi, storno primene), a papir/ekran ne smeju da
 * izmisle umanjenje od 0,00 niti da oduzmu minus (kupcu bi porastao dug).
 *
 * ── REDOSLED ─────────────────────────────────────────────────────────────────
 *
 * Zatečena veza ide PRVA: `advance_invoice_id` se upisuje samo pri PRVOM vezivanju
 * (`applyAdvance` → `isFirstApplication`, a `link-final` uz to traži
 * `advanceInvoiceId: null`), pa je taj avans hronološki stariji od svih N:M primena
 * na istom računu.
 *
 * Novac je `Prisma.Decimal` svuda (BACKEND_RULES §3 — nikad Float).
 *
 * ── ZAŠTO OVDE, A NE U `common/` ─────────────────────────────────────────────
 *
 * Pravilo čita ISKLJUČIVO tabele prodaje (`invoices`, `invoice_advance_applications`)
 * i živi uz `advance-invoice.service.ts`, koji te podatke i upisuje. `common/` u ovom
 * repou drži infrastrukturu (paginacija, datumi, soft-delete), ne poslovna pravila
 * ERP domena. Pdv modul je i pre ovoga uvozio iz prodaje baš za ovaj pojam
 * (`APPLICATION_ACTIVE`), pa smer zavisnosti pdv → prodaja nije nov.
 */

const ZERO = new Prisma.Decimal(0);

/**
 * Status primene avansa (`invoice_advance_applications.status`). Samo `ACTIVE` ulazi
 * u zbirove; storno konačnog računa prevodi primene u `REVERSED` i time OSLOBAĐA te
 * iznose za novu primenu.
 */
export const APPLICATION_ACTIVE = "ACTIVE";
export const APPLICATION_REVERSED = "REVERSED";

/** Kolone računa iz kojih se čita zatečena (denormalizovana) 1:1 veza. */
export interface AdvanceDeductionInvoice {
  /** `invoices.advance_invoice_id` — PRVI vezani avans, ili `null`. */
  advanceInvoiceId: number | null;
  /** `invoices.advance_applied_amount` — UKUPNO odbijeno na ovom računu (bruto). */
  advanceAppliedAmount: Prisma.Decimal;
}

/** Jedan AKTIVAN red spojne tabele, u obliku u kom ga pravilo troši. */
export interface AdvanceApplicationInput {
  advanceInvoiceId: number;
  /** BRUTO iznos BAŠ TE primene. */
  appliedAmount: Prisma.Decimal;
  /** Broj avansnog računa — prosleđuje ga pozivalac koji ga je učitao (štampa, SEF). */
  advanceDocumentNumber?: string | null;
}

/** Jedno umanjenje na računu: KOJI avans i KOLIKO baš on. Nikad zbir svih. */
export interface AdvanceDeductionLine {
  advanceInvoiceId: number;
  /** `null` kad AVR više ne postoji (meki ref) ili kad ga pozivalac nije učitao. */
  advanceDocumentNumber: string | null;
  amount: Prisma.Decimal;
  /**
   * `true` = red je REKONSTRUISAN iz kolona, jer ta veza nema svoj red u spojnoj
   * tabeli. Potrošači koji prikazuju „tehnički" spisak primena (id primene, nalog
   * zatvaranja) po ovome znaju da tih podataka nema.
   */
  fromLegacyLink: boolean;
}

/** Odbijeni avansi JEDNOG računa. `total` je uvek zbir `lines`. */
export interface AdvanceDeductions {
  total: Prisma.Decimal;
  lines: AdvanceDeductionLine[];
}

/**
 * ✅ PRAVILO — jedina tačka istine. Iz računa i njegovih AKTIVNIH primena daje
 * ukupno odbijeno + listu (broj avansa, iznos).
 *
 * Čista funkcija: ne dira bazu, pa je isto pozivaju i servisi u transakciji i oni
 * koji podatke već imaju u ruci. Obrazloženje pravila je u zaglavlju fajla.
 */
export function computeAdvanceDeductions(input: {
  invoice: AdvanceDeductionInvoice;
  /** SAMO `status = 'ACTIVE'` redovi, redom nastanka (`id asc`). */
  applications: readonly AdvanceApplicationInput[];
  /** Broj AVR-a na koji pokazuje kolona — potreban samo ako zatečeni red postoji. */
  legacyAdvanceDocumentNumber?: string | null;
}): AdvanceDeductions {
  const { invoice, applications } = input;

  const fromApplications: AdvanceDeductionLine[] = applications.map((a) => ({
    advanceInvoiceId: a.advanceInvoiceId,
    advanceDocumentNumber: a.advanceDocumentNumber ?? null,
    amount: a.appliedAmount,
    fromLegacyLink: false,
  }));
  const appliedSum = applications.reduce(
    (sum, a) => sum.add(a.appliedAmount),
    ZERO,
  );

  const legacyId = invoice.advanceInvoiceId;
  // Veza iz kolone koja IMA svoj red u spojnoj tabeli je isti podatak dvaput.
  if (
    legacyId == null ||
    applications.some((a) => a.advanceInvoiceId === legacyId)
  ) {
    return { total: appliedSum, lines: fromApplications };
  }

  // Deo kolone koji ne pokriva nijedna primena = ono što je odbijeno starim putem.
  const legacyAmount = invoice.advanceAppliedAmount.sub(appliedSum);
  if (!legacyAmount.greaterThan(ZERO)) {
    return { total: appliedSum, lines: fromApplications };
  }

  return {
    total: appliedSum.add(legacyAmount),
    lines: [
      {
        advanceInvoiceId: legacyId,
        advanceDocumentNumber: input.legacyAdvanceDocumentNumber ?? null,
        amount: legacyAmount,
        fromLegacyLink: true,
      },
      ...fromApplications,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STRANA AVANSA — ista činjenica, gledana iz AVR-a umesto iz računa
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Račun čija kolona `advance_invoice_id` pokazuje na posmatrani avans, zajedno sa
 * SVOJIM aktivnim primenama.
 *
 * ⚠️ `advanceApplications` mora da nosi SVE aktivne primene tog računa, i one koje
 * pripadaju DRUGIM avansima — bez njih se `kolona − Σ primena` ne može izračunati,
 * a upravo je ta razlika iznos zatečene veze.
 */
export interface AdvanceLinkedInvoice extends AdvanceDeductionInvoice {
  id: number;
  documentNumber?: string | null;
  advanceApplications: readonly AdvanceApplicationInput[];
}

/** Jedan račun na kome je posmatrani avans iskorišćen. */
export interface AdvanceUsageLine {
  invoiceId: number;
  invoiceDocumentNumber: string | null;
  amount: Prisma.Decimal;
  fromLegacyLink: boolean;
}

/** Iskorišćenost JEDNOG avansa. `total` je uvek zbir `lines`. */
export interface AdvanceUsage {
  total: Prisma.Decimal;
  lines: AdvanceUsageLine[];
}

/** Primena posmatranog avansa, viđena sa strane AVR-a. */
export interface AdvanceUsageApplicationInput {
  invoiceId: number;
  appliedAmount: Prisma.Decimal;
  /** Broj KONAČNOG računa (ne avansa) — ekran liste avansa prikazuje njega. */
  invoiceDocumentNumber?: string | null;
}

/**
 * Koliko je JEDNOG avansa iskorišćeno = ISTO PRAVILO, samo grupisano po avansu.
 *
 * Legacy deo se NE uzima iz kolone `advance_applied_amount` kakva jeste (ona je zbir
 * po SVIM avansima tog računa), nego se izvodi kroz `computeAdvanceDeductions` nad
 * tim računom — tako avans dobije tačno svoj deo. Redosled: prvo N:M primene, pa
 * zatečene veze (ekran liste avansa po prvom elementu prikazuje kolonu „Vezan za").
 */
export function computeAdvanceUsage(input: {
  advanceInvoiceId: number;
  /** AKTIVNE primene BAŠ TOG avansa, kroz sve račune. */
  applicationsOfAdvance: readonly AdvanceUsageApplicationInput[];
  /** Računi sa zatečenom 1:1 vezom na taj avans (kolona), sa svojim primenama. */
  linkedInvoices: readonly AdvanceLinkedInvoice[];
}): AdvanceUsage {
  const lines: AdvanceUsageLine[] = input.applicationsOfAdvance.map((a) => ({
    invoiceId: a.invoiceId,
    invoiceDocumentNumber: a.invoiceDocumentNumber ?? null,
    amount: a.appliedAmount,
    fromLegacyLink: false,
  }));

  for (const linked of input.linkedInvoices) {
    if (linked.advanceInvoiceId !== input.advanceInvoiceId) continue;
    // Po definiciji kolone ima NAJVIŠE jedan zatečeni red po računu.
    const legacy = computeAdvanceDeductions({
      invoice: linked,
      applications: linked.advanceApplications,
    }).lines.find((l) => l.fromLegacyLink);
    if (!legacy) continue;
    lines.push({
      invoiceId: linked.id,
      invoiceDocumentNumber: linked.documentNumber ?? null,
      amount: legacy.amount,
      fromLegacyLink: true,
    });
  }

  return {
    total: lines.reduce((sum, l) => sum.add(l.amount), ZERO),
    lines,
  };
}

/** Batch varijanta za listu avansa (jedna stranica ekrana = više AVR-ova). */
export function computeAdvanceUsageByAdvance(input: {
  advanceInvoiceIds: readonly number[];
  applicationsOfAdvances: readonly (AdvanceUsageApplicationInput & {
    advanceInvoiceId: number;
  })[];
  linkedInvoices: readonly AdvanceLinkedInvoice[];
}): Map<number, AdvanceUsage> {
  const byAdvance = new Map<number, AdvanceUsageApplicationInput[]>();
  for (const a of input.applicationsOfAdvances) {
    const list = byAdvance.get(a.advanceInvoiceId) ?? [];
    list.push(a);
    byAdvance.set(a.advanceInvoiceId, list);
  }

  const result = new Map<number, AdvanceUsage>();
  for (const advanceInvoiceId of input.advanceInvoiceIds) {
    result.set(
      advanceInvoiceId,
      computeAdvanceUsage({
        advanceInvoiceId,
        applicationsOfAdvance: byAdvance.get(advanceInvoiceId) ?? [],
        linkedInvoices: input.linkedInvoices,
      }),
    );
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// UČITAVANJE — za potrošače koji podatke još nemaju u ruci
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum Prisma klijenta koji pravilu treba. `Pick` nad `TransactionClient` znači da
 * isti poziv radi i sa `PrismaService` i sa `tx` unutar transakcije.
 */
export type AdvanceDeductionDb = Pick<
  Prisma.TransactionClient,
  "invoice" | "invoiceAdvanceApplication"
>;

/**
 * Odbijeni avansi JEDNOG računa, sa učitavanjem. Koriste je potrošači koji o avansima
 * ništa drugo ne traže (štampa, SEF).
 *
 * Broj zatečenog AVR-a se čita SAMO kad taj red stvarno postoji — račun bez zatečene
 * veze (ubedljivo najčešći slučaj) prolazi sa jednim upitom.
 */
export async function loadInvoiceAdvanceDeductions(
  db: AdvanceDeductionDb,
  invoice: { id: number } & AdvanceDeductionInvoice,
): Promise<AdvanceDeductions> {
  const applications = await db.invoiceAdvanceApplication.findMany({
    where: { invoiceId: invoice.id, status: APPLICATION_ACTIVE },
    orderBy: { id: "asc" },
    select: {
      advanceInvoiceId: true,
      appliedAmount: true,
      advance: { select: { documentNumber: true } },
    },
  });
  const rows: AdvanceApplicationInput[] = applications.map((a) => ({
    advanceInvoiceId: a.advanceInvoiceId,
    appliedAmount: a.appliedAmount,
    advanceDocumentNumber: a.advance?.documentNumber ?? null,
  }));

  const legacyId = invoice.advanceInvoiceId;
  const needsLegacyNumber =
    legacyId != null && !rows.some((r) => r.advanceInvoiceId === legacyId);
  const legacy = needsLegacyNumber
    ? await db.invoice.findUnique({
        where: { id: legacyId },
        select: { documentNumber: true },
      })
    : null;

  return computeAdvanceDeductions({
    invoice,
    applications: rows,
    legacyAdvanceDocumentNumber: legacy?.documentNumber ?? null,
  });
}

/**
 * Računi sa zatečenom 1:1 vezom na zadate avanse, sa SVOJIM aktivnim primenama —
 * ulaz za `computeAdvanceUsage` / `computeAdvanceUsageByAdvance`.
 *
 * Filter `status ≠ CANCELLED`: storniran račun ne troši avans (storno usput i čisti
 * kolone, ali dokumenti knjiženi pre N:M migracije to nisu prošli).
 */
export async function loadAdvanceLinkedInvoices(
  db: AdvanceDeductionDb,
  advanceInvoiceIds: readonly number[],
): Promise<AdvanceLinkedInvoice[]> {
  if (advanceInvoiceIds.length === 0) return [];
  const rows = await db.invoice.findMany({
    where: {
      advanceInvoiceId: { in: [...advanceInvoiceIds] },
      status: { not: "CANCELLED" },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      documentNumber: true,
      advanceInvoiceId: true,
      advanceAppliedAmount: true,
      // SVE aktivne primene tog računa — i tuđe; bez njih `kolona − Σ primena` laže.
      advanceApplications: {
        where: { status: APPLICATION_ACTIVE },
        orderBy: { id: "asc" },
        select: { advanceInvoiceId: true, appliedAmount: true },
      },
    },
  });
  // Bez `?? []`: primene se NE podrazumevaju prazne. Kad bi izvor (ili lažni klijent u
  // testu) izostavio relaciju, tiho bi ispalo da kolonu ne pokriva nijedna primena i
  // ceo iznos bi se pripisao zatečenoj vezi — dakle dvostruko brojanje. Glasan pad je
  // ovde jeftiniji od tihog pogrešnog iznosa.
  return rows.map((r) => ({
    id: r.id,
    documentNumber: r.documentNumber,
    advanceInvoiceId: r.advanceInvoiceId,
    advanceAppliedAmount: r.advanceAppliedAmount,
    advanceApplications: r.advanceApplications,
  }));
}
