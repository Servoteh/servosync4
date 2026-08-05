import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Prepis sy15 gejtova prava koje je domen sastanaka koristio kroz RLS i kroz
 * `SECURITY DEFINER` funkcije — sada nad 3.0 `users` / `user_roles`.
 *
 * ZAŠTO POSTOJI: u sy15 su sva prava reda išla kroz tri funkcije koje čitaju
 * `auth.jwt() ->> 'email'` i sy15 tabelu `user_roles`:
 *
 *   sy15                              ->  ovde
 *   ---------------------------------------------------------------
 *   current_user_is_management()      ->  isManagement(email)
 *   current_user_is_admin()           ->  isAdmin(email)
 *   has_edit_role()                   ->  hasEditRole(email)
 *   is_sastanak_ucesnik(sastanak_id)  ->  isUcesnik(email, sastanakId)
 *   sast_user_can_move_weekly()       ->  canMoveWeekly(email)
 *
 * PARITET KOJI SE MORA ZADRŽATI (izmereno `pg_get_functiondef` na živoj sy15,
 * 06.08.2026):
 *   - poređenje mejla je `lower(...)` sa OBE strane; prazan mejl = false
 *     (nikad „true jer nije nađen red"),
 *   - `current_user_is_management` traži rolu `admin` ILI `menadzment` i
 *     `project_id IS NULL` (globalni domet) i `is_active = TRUE`,
 *   - `has_edit_role` je ŠIRI skup: `admin, hr, menadzment, pm, leadpm,
 *     poslovni_admin` (takođe globalni domet),
 *   - `sast_user_can_move_weekly` NE gleda rolu nego ISKLJUČIVO allowlist
 *     tabelu `sast_weekly_movers` (koja putuje sa domenom).
 *
 * RAZLIKA sy15 -> 3.0 KOJU TREBA ZNATI: sy15 je imao JEDNU tabelu `user_roles`
 * (mejl + rola + project_id). 3.0 ima DVA mesta: `users.role` (primarna rola) i
 * `user_roles` (dodatne, sa `scope_type`). Zato se gleda unija oba — inače bi
 * korisnik čija je jedina rola primarna (`users.role='menadzment'`, bez reda u
 * `user_roles`) izgubio pravo koje je u sy15 imao. `scope_type='global'` je
 * parnjak sy15 uslovu `project_id IS NULL`.
 */

/** `current_user_is_management()` — role sa punim pravom nad sastancima. */
const MANAGEMENT_ROLES = new Set(["admin", "menadzment"]);

/** `has_edit_role()` — role kojima je dozvoljen upis (bez project-scoped grane). */
const EDIT_ROLES = new Set([
  "admin",
  "hr",
  "menadzment",
  "pm",
  "leadpm",
  "poslovni_admin",
]);

@Injectable()
export class SastanciAuthzService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sve aktivne role korisnika (primarna + globalne dodatne), lowercase. */
  private async roles(email: string | null | undefined): Promise<Set<string>> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "") return new Set();
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: key, mode: "insensitive" }, active: true },
      select: { id: true, role: true },
    });
    if (!user) return new Set();
    const extra = await this.prisma.userRole.findMany({
      where: { userId: user.id, isActive: true, scopeType: "global" },
      select: { role: true },
    });
    const out = new Set<string>([user.role.toLowerCase()]);
    for (const r of extra) out.add(r.role.toLowerCase());
    return out;
  }

  /** Paritet `current_user_is_management()`. */
  async isManagement(email: string | null | undefined): Promise<boolean> {
    const rs = await this.roles(email);
    for (const r of rs) if (MANAGEMENT_ROLES.has(r)) return true;
    return false;
  }

  /** Paritet `current_user_is_admin()` (gejt `set_sastanci_ai_model`). */
  async isAdmin(email: string | null | undefined): Promise<boolean> {
    return (await this.roles(email)).has("admin");
  }

  /** Paritet `has_edit_role()` bez project-scoped grane (domen je ne koristi:
   *  sve politike sastanaka zovu `has_edit_role()` BEZ argumenta). */
  async hasEditRole(email: string | null | undefined): Promise<boolean> {
    const rs = await this.roles(email);
    for (const r of rs) if (EDIT_ROLES.has(r)) return true;
    return false;
  }

  /** Paritet `is_sastanak_ucesnik(uuid)` — poklapanje po `lower(email)`. */
  async isUcesnik(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "" || !sastanakId) return false;
    const n = await this.prisma.sastanakUcesnik.count({
      where: { sastanakId, email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }

  /**
   * Paritet `sast_user_can_move_weekly()` — ALLOWLIST tabela, ne rola.
   * (Namerno: pomeranje kolegijuma je poimenično pravo, ne posledica role.)
   */
  async canMoveWeekly(email: string | null | undefined): Promise<boolean> {
    const key = (email ?? "").trim().toLowerCase();
    if (key === "") return false;
    const n = await this.prisma.sastWeeklyMover.count({
      where: { email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }

  // ==========================================================================
  // READ-SCOPE (prepis SELECT RLS politika) — blokada 4 iz runbook-a
  // ==========================================================================
  //
  // 🔴 ZAŠTO OVAJ ODELJAK POSTOJI: u sy15 su SVE tabele domena imale
  // `relrowsecurity = TRUE` (izmereno: 27/27), a čitanje je sužavala SELECT
  // politika. 3.0 nema RLS (ODLUKE.md) — bez ovog prepisa bi svaki port
  // čitanja tiho vratio TUĐE redove, i nijedan postojeći test to ne bi video.
  //
  // IZMERENO nad ŽIVOM sy15 (`pg_policies`, 06.08.2026) — ne iz dokumentacije:
  //
  //   tabela                        | SELECT qual
  //   ------------------------------+---------------------------------------
  //   pm_teme (pmt_select)          | predlagač ∨ mgmt ∨ učesnik ∨ draft+edit
  //   sastanci_notification_log     | primalac ∨ mgmt
  //     (snl_select)                |
  //   sastanci_notification_prefs   | svoj red ∨ mgmt
  //     (snp_select_own)            |
  //   ostalih 13 tabela sastanaka   | `true` (javno za `authenticated`)
  //
  // 🔴 NALAZ: runbook §7c blokada 4 nabraja SAMO `pm_teme` i
  // `sastanci_notification_log` („ostale SELECT politike su `true`"). Merenje
  // je našlo i TREĆU: `sastanci_notification_prefs.snp_select_own`. Bez nje bi
  // lista podešavanja obaveštenja pokazala tuđe adrese i tuđe opt-out izbore.
  //
  // Politike PROJEKTNOG BIROA se OVDE NE prepisuju — PB pod `3.0` u celini pada
  // sa 503 (zavisi od `employees`, korak 4), a četiri njegove read-politike
  // (`pb_eng_tips`, `pb_eng_tip_files`, `pb_work_reports`, `pb_notification_log`)
  // traže `pb_current_employee_id()` koji u 3.0 ne postoji. Popisane su u
  // runbook-u §7e da ne bi bile promašene kad PB dođe na red.
  //
  // ⚠️ SVESNO ODSTUPANJE (jedno, mereno): sy15 `snl_select`/`snp_select_own`
  // porede KOLONU doslovno sa `lower(jwt.email)` — dakle mejl sa velikim slovom
  // U KOLONI vlasnik NE BI video. `pmt_select` pak spušta obe strane. Ovde su
  // sve tri poređenja neosetljiva na veličinu slova (kao i ostatak ovog servisa
  // i `is_sastanak_ucesnik`). Provereno da je razlika NULTA na živim podacima:
  // `sastanci_notification_log` 0/134 i `sastanci_notification_prefs` 0/6 redova
  // ima veliko slovo u mejlu. Odstupanje ne može da pokaže tuđi red — samo tvoj
  // sopstveni sanduče-zapis koji bi sy15 sakrio zbog razlike u veličini slova.
  //
  // UGOVOR: svaki `where` je bezbedan za direktno prosleđivanje Prismi.
  //   - rukovodstvo -> `{}` (bez sužavanja, kao `current_user_is_management()`),
  //   - prazan mejl -> nemoguć uslov (0 redova), NIKAD `{}`.

  /** Prazan/nedostajući mejl → 0 redova. Nikad „sve" (bezbedan smer). */
  private key(email: string | null | undefined): string {
    return (email ?? "").trim().toLowerCase();
  }

  /**
   * Read-scope `pm_teme` (politika `pmt_select`) kao Prisma `where`.
   *
   * sy15:
   *   lower(coalesce(predlozio_email,'')) = lower(coalesce(jwt.email,''))
   *   OR current_user_is_management()
   *   OR (sastanak_id IS NOT NULL AND is_sastanak_ucesnik(sastanak_id))
   *   OR (status = 'draft' AND sastanak_id IS NULL AND has_edit_role())
   *
   * Četvrta grana je NAMERNO uža nego što izgleda: draft BEZ sastanka je
   * „predlog u pripremi" koji vide svi sa edit pravom; draft VEZAN za sastanak
   * vide samo predlagač, rukovodstvo i učesnici tog sastanka.
   */
  async scopeTemeWhere(
    email: string | null | undefined,
  ): Promise<Prisma.PmTemaWhereInput> {
    const key = this.key(email);
    // Prazan mejl: `lower(coalesce(predlozio_email,'')) = ''` bi u sy15 pokazao
    // teme bez predlagača. Ovde je 0 redova — sužavanje je bezbedan smer.
    if (key === "") return { id: { in: [] } };
    if (await this.isManagement(key)) return {};
    const or: Prisma.PmTemaWhereInput[] = [
      { predlozioEmail: { equals: key, mode: "insensitive" } },
      // `sastanak: { is: … }` nosi i `sastanak_id IS NOT NULL` (relacija je
      // nullable), tj. tačno prvi konjunkt sy15 grane.
      {
        sastanak: {
          is: { ucesnici: { some: { email: { equals: key, mode: "insensitive" } } } },
        },
      },
    ];
    if (await this.hasEditRole(key)) {
      or.push({ status: "draft", sastanakId: null });
    }
    return { OR: or };
  }

  /**
   * Isti scope kao `scopeTemeWhere`, ali kao SQL uslov — za čitanja koja idu
   * preko view-a `v_pm_teme_pregled` (Prisma view ne modeluje). Vraća BOOLEAN
   * izraz, bez `WHERE`, pa se spaja sa ostalim filterima.
   *
   * `alias` je obavezan: `EXISTS` podupit džoinuje `sastanak_ucesnici` čija
   * kolona se takođe zove `sastanak_id`, pa bi bez kvalifikacije spoljna kolona
   * bila zasenčena i uslov bi tiho postao „učesnik bilo čega".
   */
  async scopeTemeSql(
    email: string | null | undefined,
    alias: string,
  ): Promise<Prisma.Sql> {
    const key = this.key(email);
    if (key === "") return Prisma.sql`FALSE`;
    if (await this.isManagement(key)) return Prisma.sql`TRUE`;
    const a = Prisma.raw(`"${alias.replace(/"/g, "")}"`);
    const grane: Prisma.Sql[] = [
      Prisma.sql`lower(coalesce(${a}.predlozio_email, '')) = ${key}`,
      Prisma.sql`(${a}.sastanak_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM sastanak_ucesnici su
        WHERE su.sastanak_id = ${a}.sastanak_id AND lower(su.email) = ${key}))`,
    ];
    if (await this.hasEditRole(key)) {
      grane.push(Prisma.sql`(${a}.status = 'draft' AND ${a}.sastanak_id IS NULL)`);
    }
    return Prisma.sql`(${Prisma.join(grane, " OR ")})`;
  }

  /**
   * Read-scope `sastanci_notification_log` (politika `snl_select`):
   * `recipient_email = lower(jwt.email) OR current_user_is_management()`.
   *
   * Ovo je OUTBOX mejlova — sadrži `subject`, `body_html` i `payload` svakog
   * poslatog obaveštenja. Bez ovog scope-a lista „Obaveštenja" pokazuje tuđu
   * poštu.
   */
  async scopeNotifLogWhere(
    email: string | null | undefined,
  ): Promise<Prisma.SastanciNotificationLogWhereInput> {
    const key = this.key(email);
    if (key === "") return { id: { in: [] } };
    if (await this.isManagement(key)) return {};
    return { recipientEmail: { equals: key, mode: "insensitive" } };
  }

  /**
   * Read-scope `sastanci_notification_prefs` (politika `snp_select_own`):
   * `email = lower(jwt.email) OR current_user_is_management()`.
   *
   * 🔴 Ova politika NIJE u runbook §7c — nađena je merenjem `pg_policies`.
   * Ključ tabele JESTE mejl, pa je „svoj red" = red sa svojim mejlom.
   */
  async scopeNotifPrefsWhere(
    email: string | null | undefined,
  ): Promise<Prisma.SastanciNotificationPrefsWhereInput> {
    const key = this.key(email);
    if (key === "") return { email: { in: [] } };
    if (await this.isManagement(key)) return {};
    return { email: { equals: key, mode: "insensitive" } };
  }

  // ==========================================================================
  // WRITE-SCOPE (prepis INSERT/UPDATE/DELETE politika) — deo blokade 3
  // ==========================================================================
  //
  // Prepisuje se SAMO ono što traže rute skinute sa 503 u ovom koraku
  // (create-sastanak, bulk-ucesnici, prenos, instantiate). Ostatak blokade 3
  // ide zajedno sa tabelarnim CRUD-om (blokada 2) i ne sme da kasni za njim.
  //
  // IZMERENO (`pg_policies`, živa sy15, 05.08.2026):
  //   sastanci_insert                       WITH CHECK: has_edit_role()
  //   su_insert / su_update / su_delete      has_edit_role() ∧ (učesnik ∨ mgmt ∨ trio)
  //   ap_insert / ap_update / ap_delete      has_edit_role() ∧ ((sastanak_id IS NULL
  //                                          ∧ mgmt) ∨ učesnik ∨ mgmt ∨ trio)
  //
  // „trio" = `lower(vodio_email | zapisnicar_email | created_by_email)` roditeljskog
  // sastanka poklapa se sa mejlom iz sesije.
  //
  // Grana `(sastanak_id IS NULL ∧ mgmt)` kod `ap_*` je LOGIČKI SUVIŠNA — u istoj
  // disjunkciji stoji i goli `mgmt`, koji je apsorbuje. Zato je jedan te isti gejt
  // dovoljan i za `su_*` i za `ap_*`, i zato se ovde NE prepisuje doslovno (prepis
  // suvišne grane bi sugerisao pravilo koje ne postoji).

  /** `sastanci_insert` — pravo da se NAPRAVI sastanak je samo edit rola. */
  async canCreateSastanak(email: string | null | undefined): Promise<boolean> {
    return this.hasEditRole(email);
  }

  /**
   * Zajednički gejt za DECU sastanka (`sastanak_ucesnici`, `akcioni_plan`):
   * `has_edit_role() ∧ (mgmt ∨ učesnik ∨ organizator-trio)`.
   *
   * ⚠️ Pri kreiranju NOVOG sastanka učesnika još nema, pa grana „učesnik" ne može
   * da prođe — prolazi „trio" preko `created_by_email`, koji upis postavlja na
   * mejl pozivaoca. Tako radi i sy15: ista politika, isti redosled upisa.
   */
  async canWriteSastanakChild(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    const key = this.key(email);
    if (key === "") return false;
    if (!(await this.hasEditRole(key))) return false;
    if (await this.isManagement(key)) return true;
    if (await this.isUcesnik(key, sastanakId)) return true;
    return this.isOrganizatorTrio(key, sastanakId);
  }

  /** `vodio_email ∨ zapisnicar_email ∨ created_by_email` sastanka = moj mejl. */
  async isOrganizatorTrio(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    const key = this.key(email);
    if (key === "" || !sastanakId) return false;
    const n = await this.prisma.sastanak.count({
      where: {
        id: sastanakId,
        OR: [
          { vodioEmail: { equals: key, mode: "insensitive" } },
          { zapisnicarEmail: { equals: key, mode: "insensitive" } },
          { createdByEmail: { equals: key, mode: "insensitive" } },
        ],
      },
    });
    return n > 0;
  }

  /**
   * `canWriteSastanakChild` + 403. sy15 je odbijeni upis vraćao kao `42501`, koji
   * `rethrowSy15` mapira na 403 — ovde se isti HTTP kod diže direktno.
   */
  async assertCanWriteSastanakChild(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<void> {
    if (await this.canWriteSastanakChild(email, sastanakId)) return;
    throw new ForbiddenException(
      "Nemate pravo da menjate podatke ovog sastanka.",
    );
  }

  // ==========================================================================
  // WRITE-SCOPE, ostatak blokade 3 (tabelarni CRUD)
  // ==========================================================================
  //
  // IZMERENO nad ŽIVOM sy15 (`pg_policies`, 06.08.2026) — ne iz runbook-a.
  // Runbook §7c blokadu 3 opisuje kao „politike `pa_*`, `ps_*`, `sa_*`, `pmt_*`
  // = has_edit_role ∧ (učesnik ∨ mgmt ∨ organizator-trio)". Merenje je to
  // POTVRDILO za tri od četiri, a za četvrtu (`pmt_*`) OBORILO — v. dole.
  //
  //   tabela             | politike             | pravilo
  //   -------------------+----------------------+--------------------------------
  //   presek_aktivnosti  | pa_insert/update/del | edit ∧ (učesnik ∨ mgmt ∨ trio)
  //   presek_slike       | ps_insert/update/del | ISTO, znak za znak
  //   sastanak_arhiva    | sa_insert/update/del | ISTO, znak za znak
  //   sastanak_odluke    | sast_odluke_write    | 🔴 SAMO has_edit_role()
  //   sastanci_templates | sast_tpl_write       | 🔴 SAMO has_edit_role()
  //   ..._template_ucesnici | sast_tu_write     | 🔴 SAMO has_edit_role()
  //   pm_teme            | pmt_insert/update/del| 🔴 DRUGAČIJE (v. `canWriteTema`)
  //   pm_teme            | pm_teme_draft_insert | draft ∧ bez sastanka ∧ edit
  //   pm_teme            | pm_teme_draft_review | USING ≠ WITH CHECK (!)
  //   ..._notification_prefs | snp_update_own   | svoj red ∨ mgmt
  //   ..._notification_log   | snl_insert       | edit ; snl_update/delete = mgmt
  //
  // 🟢 `pa_*`, `ps_*` i `sa_*` su DOSLOVNO isti izraz kao `su_*` (upoređena tela
  // politika, ne opisi) — zato NE dobijaju svoj metod nego koriste postojeći
  // `canWriteSastanakChild`. Pisanje trećeg identičnog gejta bi samo napravilo
  // tri mesta koja mogu da se raziđu.

  /**
   * `pmt_insert` / `pmt_update` / `pmt_delete` — 🔴 NIJE isto što i `ap_*`.
   *
   * sy15 (oba, i USING i WITH CHECK):
   * ```
   * has_edit_role() AND (
   *      (sastanak_id IS NULL     AND current_user_is_management())
   *   OR (sastanak_id IS NOT NULL AND (is_sastanak_ucesnik(sastanak_id)
   *                                    OR current_user_is_management()
   *                                    OR organizator-trio))
   * )
   * ```
   *
   * 🔴 RAZLIKA KOJU JE LAKO PROMAŠITI: kod `ap_*` u istoj disjunkciji stoji i
   * GOLI `current_user_is_management()`, pa on apsorbuje granu
   * `(sastanak_id IS NULL ∧ mgmt)` i sve se svodi na `canWriteSastanakChild`
   * (tako i piše u odeljku iznad). Kod `pmt_*` golog `mgmt` NEMA — obe grane su
   * uslovljene stanjem `sastanak_id`. Posledica je STVARNO pravilo, ne stilska
   * razlika: **temu BEZ sastanka sme da piše samo rukovodstvo**, dok je kod
   * akcija bez sastanka dovoljna edit rola. Prepis kao `canWriteSastanakChild`
   * bi tiho proširio prava.
   */
  async canWriteTema(
    email: string | null | undefined,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    const key = this.key(email);
    if (key === "") return false;
    if (!(await this.hasEditRole(key))) return false;
    if (!sastanakId) return this.isManagement(key);
    if (await this.isManagement(key)) return true;
    if (await this.isUcesnik(key, sastanakId)) return true;
    return this.isOrganizatorTrio(key, sastanakId);
  }

  /**
   * `pm_teme_draft_insert` (PERMISSIVE, dakle OR uz `pmt_insert`):
   * `status='draft' ∧ sastanak_id IS NULL ∧ has_edit_role()`.
   *
   * Zbog nje „predloži temu" (draft bez sastanka) radi svakom sa edit rolom,
   * iako bi ga `pmt_insert` sam odbio (grana `sastanak_id IS NULL ∧ mgmt`).
   * Dve politike na istoj tabeli se SABIRAJU — ako se prepiše samo stroža,
   * predlaganje tema bi prestalo da radi svima osim rukovodstvu.
   */
  async canInsertDraftTema(
    email: string | null | undefined,
    status: string,
    sastanakId: string | null | undefined,
  ): Promise<boolean> {
    if (status !== "draft" || sastanakId) return false;
    return this.hasEditRole(email);
  }

  /** Zbir `pmt_insert` ∨ `pm_teme_draft_insert` — pravi gejt za INSERT teme. */
  async assertCanInsertTema(
    email: string | null | undefined,
    status: string,
    sastanakId: string | null | undefined,
  ): Promise<void> {
    if (await this.canInsertDraftTema(email, status, sastanakId)) return;
    if (await this.canWriteTema(email, sastanakId)) return;
    throw new ForbiddenException("Nemate pravo da upišete ovu temu.");
  }

  /**
   * `pm_teme_draft_review` (PERMISSIVE UPDATE, OR uz `pmt_update`):
   *
   * ```
   * USING      : status = 'draft'                          AND (edit ∨ mgmt)
   * WITH CHECK : status IN ('usvojeno','odbijeno')          AND (edit ∨ mgmt)
   * ```
   *
   * 🔴 USING I WITH CHECK SE RAZLIKUJU — USING gleda STARI red (mora biti
   * draft), WITH CHECK NOVI (mora biti usvojeno/odbijeno). Isti obrazac koji je
   * `prenos` već pokazao kod `ap_update`. Prepis koji bi proverio samo jednu
   * stranu bio bi ili preširok (pustio bi draft -> bilo šta) ili preuzak
   * (odbio bi legitiman pregled drafta).
   */
  async canDraftReview(
    email: string | null | undefined,
    stariStatus: string,
    noviStatus: string,
  ): Promise<boolean> {
    if (stariStatus !== "draft") return false;
    if (noviStatus !== "usvojeno" && noviStatus !== "odbijeno") return false;
    const key = this.key(email);
    if (key === "") return false;
    return (await this.hasEditRole(key)) || (await this.isManagement(key));
  }

  /** Zbir `pmt_update` ∨ `pm_teme_draft_review` — pravi gejt za UPDATE teme. */
  async assertCanUpdateTema(
    email: string | null | undefined,
    stari: { status: string; sastanakId: string | null },
    novi: { status: string; sastanakId: string | null },
  ): Promise<void> {
    if (await this.canDraftReview(email, stari.status, novi.status)) return;
    // `pmt_update` traži pravo i nad STARIM redom (USING) i nad NOVIM (CHECK) —
    // premeštanje teme sa sastanka A na B mora proći oba.
    if (
      (await this.canWriteTema(email, stari.sastanakId)) &&
      (await this.canWriteTema(email, novi.sastanakId))
    ) {
      return;
    }
    throw new ForbiddenException("Nemate pravo da menjate ovu temu.");
  }

  /** `pmt_delete` — samo USING strana (DELETE nema WITH CHECK). */
  async assertCanDeleteTema(
    email: string | null | undefined,
    sastanakId: string | null,
  ): Promise<void> {
    if (await this.canWriteTema(email, sastanakId)) return;
    throw new ForbiddenException("Nemate pravo da obrišete ovu temu.");
  }

  /**
   * `sast_odluke_write` (ALL na `sastanak_odluke`) = **samo `has_edit_role()`**.
   *
   * 🔴 Namerno ŠIRE od dece sastanka: odluka se ne sužava ni na učesnike ni na
   * organizatora. Tako je u sy15 (izmereno) — ne „popravljamo" to usput, jer bi
   * sužavanje bilo regresija prava koju niko nije tražio. Guard zaključanog
   * sastanka i dalje važi (triger `sast_trg_locked_guard_sastanak_odluke`).
   */
  async assertCanWriteOdluka(email: string | null | undefined): Promise<void> {
    if (await this.hasEditRole(email)) return;
    throw new ForbiddenException("Nemate pravo da menjate odluke sastanka.");
  }

  /** `sast_tpl_write` / `sast_tu_write` (ALL) = `has_edit_role()`. */
  async assertCanWriteTemplate(email: string | null | undefined): Promise<void> {
    if (await this.hasEditRole(email)) return;
    throw new ForbiddenException("Nemate pravo da menjate šablone sastanaka.");
  }

  /**
   * `snp_update_own` — `email = lower(jwt.email) ∨ mgmt` na OBE strane
   * (USING i WITH CHECK su isti izraz).
   */
  async assertCanWritePrefs(
    email: string | null | undefined,
    redEmail: string,
  ): Promise<void> {
    const key = this.key(email);
    if (key !== "" && key === redEmail.trim().toLowerCase()) return;
    if (await this.isManagement(key)) return;
    throw new ForbiddenException("Nemate pravo nad tuđim podešavanjima.");
  }
}
