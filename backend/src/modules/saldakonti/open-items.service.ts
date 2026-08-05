/**
 * OPEN ITEMS SERVICE — otvorene stavke saldakonta (Faza 4 §A, jezgro).
 * =========================================================================
 * "Otvorene stavke se NE materijalizuju" (PLAN_FAZA_4 §Centralna ideja) —
 * izveden pogled nad `ledger_entries`:
 *   otvorena stavka = red gde je konto u SaldakontoAccount registru,
 *   pripadajući JournalEntry je proknjižen (status IN ('POSTED','LOCKED')),
 *   reconciled_at IS NULL.
 *
 * Grupisanje po (account_code, analytical_code, document_number); saldo =
 * Σ(debit) − Σ(credit); HAVING saldo ≠ 0. dueDate = MIN(due_date) po grupi
 * (najranije dospeće dokumenta). Aging bucket po (danas − dueDate):
 *   0-30 / 31-60 / 61-90 / 90+.
 *
 * ZAŠTO JE GRUPISANJE BEZ VRSTE DOKUMENTA BEZBEDNO: sve izlazne fakture
 * (IFR/IFGP/IFUSL + ino parnjaci) dele JEDAN niz brojeva po firmi i godini
 * (`sales/numbering.service.ts` — dokaz sa donetih BigBit papira: IFGP 650/25,
 * IFUSL 653/25, IFR 657/25, isprepleteno po datumu), a avansni račun ima
 * SOPSTVENU seriju sa prefiksom (`A-657/25`, odluka O-F6). Broj dokumenta je zato
 * jedinstven i sam za sebe. Kad bi se numeracija vratila na brojač PO VRSTI,
 * IFR `657/25` i IFUSL `657/25` bi ovde tiho pali u istu grupu i međusobno se
 * netovali — dug jednog kupca bi sakrio dug drugog, bez ijedne greške u bazi
 * (unique nad `invoices` uključuje i vrstu, pa baza to ne bi prijavila).
 *
 * ISTO VAŽI ZA AVANS (kvar 01.08.2026): dugovna strana avansnog računa ide na ISTI
 * kupčev konto (2040/2041) kao faktura. Dok je avans dobijao goli broj `7/26`, on
 * i faktura `7/26` istog kupca padali su u JEDNU otvorenu stavku od 24.000 sa
 * dospećem avansa — pa je i kamata išla na duplo veći iznos. Prefiks `A-` je jedina
 * brana; ne uklanjati ga bez zamene na ovom nivou.
 *
 * ZAŠTO VRSTA NIJE U `GROUP BY`: `ledger_entries` nema kolonu vrste dokumenta, a
 * dodavanje vrste u ključ bi raskinulo NETIRANJE — uplata sa izvoda, ručna
 * korekcija i uvezeni BigBit red nose broj ALI NE i vrstu, pa bi faktura i njena
 * uplata ostale u dve grupe i obe se prikazale kao otvorene. Razdvajanje serija je
 * zato posao NUMERACIJE, ne ovog upita.
 *
 * Raw SQL (prisma.$queryRaw) jer Prisma groupBy ne podržava HAVING nad
 * izračunatim izrazom niti join na registar; Decimal se vraća egzaktno.
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export interface OpenItem {
  accountCode: string;
  analyticalCode: number | null; // komitent (null = sintetika bez analitike)
  documentNumber: string | null;
  balance: Prisma.Decimal; // Σ debit − Σ credit (dugovni saldo pozitivan)
  totalDebit: Prisma.Decimal;
  totalCredit: Prisma.Decimal;
  dueDate: Date | null; // najranije dospeće u grupi
  daysOverdue: number | null; // asOf − dueDate (u danima; null ako nema dueDate)
  currency: string | null;
  side: string; // receivable | payable (iz registra)
  // Devizni saldo grupe (C2): Σ(fx_debit) − Σ(fx_credit) u `fxCurrency`. NULL kad
  // stavka nije devizna. `balance` iznad je i dalje DINARSKA protivvrednost —
  // postojeća polja se ne menjaju, ovo je aditivno.
  fxAmount: Prisma.Decimal | null;
  fxCurrency: string | null;
  // Svi ledger_entries.id koji čine ovaj (grupisani) red — potrebno za
  // uparivanje (reconcile) i kompenzaciju, koje rade nad pojedinačnim
  // stavkama. Izveden pogled grupiše po dokumentu; ovde izlažemo članove grupe.
  ledgerEntryIds: number[];
}

/** Aging red po komitentu — saldo raspoređen u bucket-e po dospelosti. */
export interface AgingByPartnerRow {
  analyticalCode: number | null;
  bucket0_30: Prisma.Decimal;
  bucket31_60: Prisma.Decimal;
  bucket61_90: Prisma.Decimal;
  bucket90plus: Prisma.Decimal;
  total: Prisma.Decimal;
}

interface OpenItemRawRow {
  account_code: string;
  analytical_code: number | null;
  document_number: string | null;
  total_debit: Prisma.Decimal | null;
  total_credit: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  due_date: Date | null;
  currency: string | null;
  side: string;
  ledger_entry_ids: number[] | null; // array_agg(le.id) — članovi grupe (Int[] → number[])
  fx_balance: Prisma.Decimal | null;
  fx_currency: string | null;
}

/** Dodatni (aditivni) filteri otvorenih stavki — devizna valuta / firma (C2). */
export interface OpenItemsOptions {
  /** Samo grupe čija je devizna valuta ova (npr. "EUR") — za revalorizaciju. */
  fxCurrency?: string;
  /** Firma naloga (journal_entries.company_id); bez njega sve firme. */
  companyId?: number;
}

/**
 * Otvorena grupa koja nosi VIŠE deviznih valuta (greška podataka). Grupa je
 * (konto, komitent, broj dokumenta), a `document_number` je nullable — sve stavke
 * partnera bez broja dokumenta padaju u JEDNU grupu, pa se EUR i USD promet nađu
 * zajedno. Takva grupa nema jedinstven devizni saldo i mora se ISKLJUČITI iz
 * revalorizacije, ali i PRIJAVITI korisniku (tiho ispadanje = izgubljen bilans).
 */
export interface MixedFxCurrencyGroup {
  accountCode: string;
  analyticalCode: number | null;
  documentNumber: string | null;
  /** Sve devizne valute zatečene u grupi (sortirano, bez NULL-ova). */
  currencies: string[];
  /** Dinarski saldo grupe (Σ duguje − Σ potražuje). */
  balance: Prisma.Decimal;
  ledgerEntryIds: number[];
}

interface MixedFxRawRow {
  account_code: string;
  analytical_code: number | null;
  document_number: string | null;
  balance: Prisma.Decimal | null;
  currencies: string[] | null;
  ledger_entry_ids: number[] | null;
}

interface AgingRawRow {
  analytical_code: number | null;
  bucket_0_30: Prisma.Decimal | null;
  bucket_31_60: Prisma.Decimal | null;
  bucket_61_90: Prisma.Decimal | null;
  bucket_90_plus: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
}

@Injectable()
export class OpenItemsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista otvorenih stavki (izveden pogled nad ledger_entries). Filteri su
   * opcioni; bez filtera vraća sve otvorene stavke svih saldakonto konta.
   * @param accountCode — tačan konto (opciono)
   * @param partnerId   — analitička = komitent (opciono)
   * @param asOf        — presek na dan za daysOverdue (default danas)
   * @param opts        — aditivni filteri (devizna valuta / firma) — C2
   */
  async listOpenItems(
    accountCode?: string,
    partnerId?: number,
    asOf?: Date,
    opts?: OpenItemsOptions,
  ): Promise<OpenItem[]> {
    const cutoff = asOf ?? new Date();
    const accountFilter = accountCode
      ? Prisma.sql`AND le.account_code = ${accountCode}`
      : Prisma.empty;
    const partnerFilter =
      partnerId != null
        ? Prisma.sql`AND le.analytical_code = ${partnerId}`
        : Prisma.empty;
    const companyFilter =
      opts?.companyId != null
        ? Prisma.sql`AND je.company_id = ${opts.companyId}`
        : Prisma.empty;
    // Devizni filter ide u HAVING, NE u WHERE (namerno): dinarske stavke iste grupe
    // (uplata u RSD, prethodna kursna razlika) nemaju fx_currency, a MORAJU ući u
    // zbir da bi knjigovodstvena protivvrednost grupe bila tačna. WHERE bi ih izbacio
    // pa bi sledeća revalorizacija dvaput obračunala istu razliku.
    //
    // USLOV JE „grupa sadrži traženu valutu I nijednu drugu" (review C2 §3), NE
    // `MAX(fx_currency) = valuta`: `document_number` je nullable, pa sve stavke partnera
    // bez broja dokumenta padaju u JEDNU grupu; MAX bi tada leksikografski izabrao jednu
    // valutu — EUR grupa bi tiho nestala iz bilansa, a USD bi pokupio i EUR devizni saldo
    // i knjižio lažan rashod. Mešane grupe se isključuju ovde i prijavljuju kroz
    // {@link listMixedFxCurrencyGroups}.
    const fxCurrency = opts?.fxCurrency;
    const fxHaving = fxCurrency
      ? Prisma.sql`AND bool_or(le.fx_currency = ${fxCurrency})
          AND NOT bool_or(le.fx_currency IS NOT NULL AND le.fx_currency <> ${fxCurrency})`
      : Prisma.empty;
    // Devizni saldo se sa aktivnim filterom sabira SAMO preko redova te valute; bez
    // filtera izraz ostaje doslovno isti kao pre (postojeći čitaoci — aging, kartica —
    // moraju da vrate identičan rezultat).
    const fxBalanceExpr = fxCurrency
      ? Prisma.sql`COALESCE(SUM(CASE WHEN le.fx_currency = ${fxCurrency} THEN le.fx_debit END), 0)
                 - COALESCE(SUM(CASE WHEN le.fx_currency = ${fxCurrency} THEN le.fx_credit END), 0)`
      : Prisma.sql`COALESCE(SUM(le.fx_debit), 0) - COALESCE(SUM(le.fx_credit), 0)`;
    const fxCurrencyExpr = fxCurrency
      ? Prisma.sql`MAX(CASE WHEN le.fx_currency = ${fxCurrency} THEN le.fx_currency END)`
      : Prisma.sql`MAX(le.fx_currency)`;

    const rows = await this.prisma.$queryRaw<OpenItemRawRow[]>(
      Prisma.sql`
        SELECT
          le.account_code AS account_code,
          le.analytical_code AS analytical_code,
          le.document_number AS document_number,
          COALESCE(SUM(le.debit), 0) AS total_debit,
          COALESCE(SUM(le.credit), 0) AS total_credit,
          COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance,
          MIN(le.due_date) AS due_date,
          MAX(le.currency) AS currency,
          array_agg(le.id ORDER BY le.id) AS ledger_entry_ids,
          -- Devizni saldo grupe (C2). COALESCE po SUMI, ne po razlici: kad su svi
          -- fx_credit NULL, SUM(a) - SUM(b) bi dalo NULL pa bi ceo devizni saldo pao na 0.
          ${fxBalanceExpr} AS fx_balance,
          ${fxCurrencyExpr} AS fx_currency,
          sa.side AS side
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        -- 'LOCKED' MORA biti uključen (review Batch A VISOK): lock perioda (POST
        -- /gl/journal/lock-older) ne sme da OBRIŠE otvoreni dug — zaključan nalog je i
        -- dalje proknjižen. Konzistentno sa partner-card / assertCreditLimit /
        -- payment-preparation čitaocima koji već koriste IN ('POSTED','LOCKED').
        WHERE je.status IN ('POSTED', 'LOCKED')
          -- Presek NA DAN (review 1E): stavka je „otvorena na dan" ako je proknjižena
          -- do preseka I nije bila uparena do preseka (uparivanje POSLE preseka je
          -- nevidljivo za istorijski IOS — godišnje usaglašavanje 31.12).
          AND je.posting_date <= ${cutoff}
          AND (le.reconciled_at IS NULL OR le.reconciled_at > ${cutoff})
          AND sa.tracks_open_items = TRUE
          ${accountFilter}
          ${partnerFilter}
          ${companyFilter}
        GROUP BY le.account_code, le.analytical_code, le.document_number, sa.side
        HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
          ${fxHaving}
        ORDER BY le.account_code, le.analytical_code, le.document_number
      `,
    );

    return rows.map((r) => this.mapRow(r, cutoff));
  }

  /**
   * Otvorene grupe sa VIŠE deviznih valuta na dan preseka — greška podataka, ne
   * poslovni slučaj. `listOpenItems` sa `fxCurrency` filterom ih namerno preskače
   * (nemaju jedinstven devizni saldo), pa se ovde vraćaju da bi revalorizacija mogla
   * da ih prijavi korisniku umesto da tiho ispadnu iz bilansa.
   *
   * `opts.fxCurrency` sužava na grupe koje SADRŽE tu valutu (tj. na one koje su
   * isključene iz obračuna baš te valute); bez njega vraća sve mešane grupe.
   *
   * Isti WHERE (presek, posted+locked, neuparen do preseka) kao `listOpenItems` —
   * inače bi se prijavljivale grupe koje uopšte nisu u obračunu.
   */
  async listMixedFxCurrencyGroups(
    asOf?: Date,
    opts?: OpenItemsOptions,
  ): Promise<MixedFxCurrencyGroup[]> {
    const cutoff = asOf ?? new Date();
    const companyFilter =
      opts?.companyId != null
        ? Prisma.sql`AND je.company_id = ${opts.companyId}`
        : Prisma.empty;
    const currencyFilter = opts?.fxCurrency
      ? Prisma.sql`AND bool_or(le.fx_currency = ${opts.fxCurrency})`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<MixedFxRawRow[]>(
      Prisma.sql`
        SELECT
          le.account_code AS account_code,
          le.analytical_code AS analytical_code,
          le.document_number AS document_number,
          COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance,
          array_agg(DISTINCT le.fx_currency) FILTER (WHERE le.fx_currency IS NOT NULL) AS currencies,
          array_agg(le.id ORDER BY le.id) AS ledger_entry_ids
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN saldakonto_accounts sa ON sa.account = le.account_code
        WHERE je.status IN ('POSTED', 'LOCKED')
          AND je.posting_date <= ${cutoff}
          AND (le.reconciled_at IS NULL OR le.reconciled_at > ${cutoff})
          AND sa.tracks_open_items = TRUE
          ${companyFilter}
        GROUP BY le.account_code, le.analytical_code, le.document_number
        HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
          AND COUNT(DISTINCT le.fx_currency) > 1
          ${currencyFilter}
        ORDER BY le.account_code, le.analytical_code, le.document_number
      `,
    );

    return rows.map((r) => ({
      accountCode: r.account_code,
      analyticalCode: r.analytical_code,
      documentNumber: r.document_number,
      currencies: [...(r.currencies ?? [])].sort(),
      balance: new Prisma.Decimal(r.balance ?? 0),
      ledgerEntryIds: r.ledger_entry_ids ?? [],
    }));
  }

  /**
   * Aging po komitentu za dati konto (default svi saldakonto konti). Za svaku
   * analitiku (komitent) raspoređuje saldo dokumenta u bucket po dospelosti
   * (asOf − dueDate): 0-30 / 31-60 / 61-90 / 90+. Bez dueDate → bucket 0-30
   * (nedospelo / nepoznato dospeće se tretira kao tekuće).
   *
   * 🔴 PRESEK MORA BITI ISTI KAO U `listOpenItems` (nalaz N2, 03.08.2026).
   * ─────────────────────────────────────────────────────────────────────────
   * IZMERENO (hvatanje `Prisma.Sql`, `asOf = 2026-06-30`): `listOpenItems` je gradio
   * `je.posting_date <= $1` **i** `(le.reconciled_at IS NULL OR le.reconciled_at > $2)`
   * — dva parametra; `agingByPartner` je imao SAMO `le.reconciled_at IS NULL`, bez
   * ijednog uslova nad `posting_date`, i `cutoff` je koristio jedino za `days_overdue`.
   *
   * Posledica je bila da ISTI kupac na ISTI dan ima DVA različita duga u dva izveštaja
   * koji stoje jedan pored drugog (kartica/IOS/opomena čitaju `listOpenItems`, starosna
   * struktura i tabla naplate čitaju ovaj upit), i to u oba smera:
   *   • faktura proknjižena POSLE preseka ulazila je u aging, a u otvorene stavke nije
   *     (aging veći od IOS-a — istorijski presek 31.12 pokazuje dug koji tada nije ni
   *     postojao);
   *   • faktura zatvorena POSLE preseka ispadala je iz aging-a, a u otvorenim stavkama
   *     je pravilno ostajala otvorena na dan preseka (aging manji od IOS-a).
   * Za godišnje usaglašavanje su oba izveštaja dokazni materijal, pa razlika nije
   * kozmetička — potpisuje se saldo koji se ne slaže sa sopstvenom specifikacijom.
   *
   * Uslovi su namerno DOSLOVNO isti kao u `listOpenItems` (uključujući `LOCKED`) — ovo
   * su dva pogleda na isti skup, ne dva izveštaja.
   */
  async agingByPartner(
    accountCode?: string,
    asOf?: Date,
  ): Promise<AgingByPartnerRow[]> {
    const cutoff = asOf ?? new Date();
    // Bez izabranog konta aging je IZVEŠTAJ NAPLATE → samo kupčeva konta. Inače bi se
    // potraživanje (2040, pozitivno) i naša obaveza (4350, negativno) prema ISTOM
    // partneru netirali u jedan iznos i bucket, pa bi dug koji se goni bio prikazan
    // umanjen za našu obavezu prema njemu (revizija). Sa izabranim kontom filter se ne
    // primenjuje — korisnik je svesno tražio taj konto (npr. starenje obaveza 4350).
    const accountFilter = accountCode
      ? Prisma.sql`AND le.account_code = ${accountCode}`
      : Prisma.sql`AND sa.partner_scope = 'customer'`;

    // Dvostepeno: prvo saldo + daysOverdue po (konto, komitent, dokument);
    // zatim raspoređivanje u bucket-e i Σ po komitentu. `cutoff` ulazi kao
    // parametar da je aging deterministički za dati presek.
    const rows = await this.prisma.$queryRaw<AgingRawRow[]>(
      Prisma.sql`
        WITH doc_saldo AS (
          SELECT
            le.analytical_code AS analytical_code,
            COALESCE(SUM(le.debit) - SUM(le.credit), 0) AS balance,
            (${cutoff}::date - MIN(le.due_date)::date) AS days_overdue
          FROM ledger_entries le
          JOIN journal_entries je ON je.id = le.journal_entry_id
          JOIN saldakonto_accounts sa ON sa.account = le.account_code
          -- 'LOCKED' MORA biti uključen (review Batch A VISOK): lock perioda ne sme da
          -- obriše dospeli dug iz aging-a — zaključan nalog je i dalje proknjižen.
          -- Konzistentno sa partner-card / limit / priprema (IN ('POSTED','LOCKED')).
          WHERE je.status IN ('POSTED', 'LOCKED')
            -- Presek NA DAN — isti par uslova kao u listOpenItems (nalaz N2): stavka je
            -- „otvorena na dan" ako je proknjižena DO preseka i nije bila uparena DO
            -- preseka. Uparivanje posle preseka je za istorijski presek nevidljivo.
            AND je.posting_date <= ${cutoff}
            AND (le.reconciled_at IS NULL OR le.reconciled_at > ${cutoff})
            AND sa.tracks_open_items = TRUE
            ${accountFilter}
          GROUP BY le.account_code, le.analytical_code, le.document_number
          HAVING COALESCE(SUM(le.debit) - SUM(le.credit), 0) <> 0
        )
        SELECT
          analytical_code,
          COALESCE(SUM(CASE WHEN days_overdue IS NULL OR days_overdue <= 30 THEN balance ELSE 0 END), 0) AS bucket_0_30,
          COALESCE(SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN balance ELSE 0 END), 0) AS bucket_31_60,
          COALESCE(SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN balance ELSE 0 END), 0) AS bucket_61_90,
          COALESCE(SUM(CASE WHEN days_overdue > 90 THEN balance ELSE 0 END), 0) AS bucket_90_plus,
          COALESCE(SUM(balance), 0) AS total
        FROM doc_saldo
        GROUP BY analytical_code
        ORDER BY analytical_code
      `,
    );

    return rows.map((r) => ({
      analyticalCode: r.analytical_code,
      bucket0_30: new Prisma.Decimal(r.bucket_0_30 ?? 0),
      bucket31_60: new Prisma.Decimal(r.bucket_31_60 ?? 0),
      bucket61_90: new Prisma.Decimal(r.bucket_61_90 ?? 0),
      bucket90plus: new Prisma.Decimal(r.bucket_90_plus ?? 0),
      total: new Prisma.Decimal(r.total ?? 0),
    }));
  }

  private mapRow(r: OpenItemRawRow, cutoff: Date): OpenItem {
    const dueDate = r.due_date ?? null;
    const daysOverdue =
      dueDate != null
        ? Math.floor(
            (cutoff.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24),
          )
        : null;
    return {
      accountCode: r.account_code,
      analyticalCode: r.analytical_code,
      documentNumber: r.document_number,
      balance: new Prisma.Decimal(r.balance ?? 0),
      totalDebit: new Prisma.Decimal(r.total_debit ?? 0),
      totalCredit: new Prisma.Decimal(r.total_credit ?? 0),
      dueDate,
      daysOverdue,
      currency: r.currency,
      side: r.side,
      ledgerEntryIds: r.ledger_entry_ids ?? [],
      // Devizni saldo ima smisla samo kad grupa NOSI valutu — bez fx_currency je
      // stavka čisto dinarska (fxAmount ostaje null, ne 0).
      fxAmount: r.fx_currency ? new Prisma.Decimal(r.fx_balance ?? 0) : null,
      fxCurrency: r.fx_currency,
    };
  }
}
