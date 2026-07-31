import { Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../common/mail/mail.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import type { ScheduledJob } from "./scheduler.types";

/*
 * NEDELJNA BEZBEDNOSNA PROVERA sy15 BAZE — „da li je išta otvoreno anonimcima?"
 *
 * POVOD (incident 31.07.2026): sy15 PostgREST je javno dostupan i odgovara BEZ
 * ijednog zaglavlja kao rola `anon`. Zbog Supabase podrazumevanih prava
 * (ALTER DEFAULT PRIVILEGES … GRANT ALL TO anon) svaki NOV objekat u šemi
 * `public` je automatski dobijao anon pristup. Na produkciji je tako bilo javno:
 *   • 24 pogleda (uklj. `v_kadr_medical_exam_status` — imena zaposlenih i status
 *     lekarskih pregleda — i `v_kadr_audit_log`),
 *   • 2 tabele bez RLS-a,
 *   • 67 funkcija koje MENJAJU podatke (npr. `kadr_grid_set_go` — upis godišnjeg
 *     odmora bilo kom zaposlenom, sa interneta, bez prijave).
 * Sve je zatvoreno istog dana i postavljena je brana: event trigger
 * `sec_guard_revoke_anon` (ddl_command_end) koji svakom novom objektu u `public`
 * odmah skida `anon`/`PUBLIC`.
 *
 * ZAŠTO OVAJ POSAO: brana pokriva SAMO ono što prođe kroz DDL na toj bazi. Ne
 * pokriva ručni `GRANT` posle kreiranja, vraćanje podrazumevanih prava
 * (`ALTER DEFAULT PRIVILEGES`), ni gašenje same brane (`ALTER EVENT TRIGGER …
 * DISABLE`). Zato jednom nedeljno nezavisno merimo ISHOD (šta anon stvarno može),
 * a ne nameru.
 *
 * DOKTRINA: posao SAMO ČITA sistemske kataloge (`pg_class`, `pg_proc`,
 * `pg_event_trigger`, `pg_default_acl`). Nikad ne menja prava — nalaz se prijavljuje
 * čoveku, popravku radi čovek. Nivo autonomije 1 (detekcija + izveštaj).
 *
 * ROLA: konekcija ide kao `servosync2_app`. Svi upiti su čitanje sistemskih
 * kataloga (javno čitljivi) + `has_*_privilege()` (dozvoljeno svakome) — VERIFIKOVANO
 * uživo na sy15-db (PostgreSQL 17.6, `SET ROLE servosync2_app`, 31.07.2026). Nikakve
 * dodatne privilegije se NE traže.
 *
 * ŠUM: ako je sve čisto — samo log, BEZ mejla. Nedeljni „sve je u redu" mejl se
 * posle mesec dana ignoriše, pa bi i pravi nalaz prošao neopaženo.
 */

/** Ključ posla u `scheduled_job_runs.job_key` — ne menjati posle uvođenja. */
export const SECURITY_AUDIT_JOB_KEY = "sy15-anon-security-audit";

/** Primalac izveštaja; zarezom razdvojeno. Prazno → `DEFAULT_MAIL_TO`. */
const MAIL_TO_ENV = "SECURITY_AUDIT_MAIL_TO";
const DEFAULT_MAIL_TO = "nenad.jarakovic@servoteh.com";

/** Ime brane (event trigger) postavljene 31.07.2026. */
const GUARD_TRIGGER = "sec_guard_revoke_anon";

/**
 * NAMERNI izuzeci — javni RPC-jevi koji MORAJU da rade bez prijave:
 *  • `kiosk_record_punch` — kiosk terminal u pogonu kuca prijavu/odjavu tokenom
 *    uređaja (radnik nema nalog na terminalu),
 *  • `assessment_submit_by_token` — 360° procena se predaje preko jednokratnog
 *    linka iz pozivnice (ocenjivač je često van sistema).
 * Oba se štite TOKENOM u telu funkcije, ne rolom — zato ih heuristika „nema
 * proveru pozivaoca" ne prepoznaje i moraju stajati ovde.
 *
 * Poređenje ide po IMENU (ne po punom potpisu) da preimenovan parametar ne digne
 * lažnu uzbunu. Rupu koju to otvara — DODAT overload istog imena — pokriva
 * kontrola broja: više redova nego imena u listi = nalaz („dozvoljeno ime, novi
 * potpis"), vidi `classifyFunctions`.
 */
const ALLOWED_ANON_FUNCTIONS = new Set([
  "kiosk_record_punch",
  "assessment_submit_by_token",
]);

/**
 * Telo funkcije koje MENJA podatke. `\m`/`\M` su granice reči u PG regexu —
 * bez njih bi „updated_at" ili „deleted_by" lažno okidali na svakoj čitajućoj fn.
 */
const MUTATING_BODY_RE = String.raw`\m(insert|update|delete|truncate)\M`;

/**
 * Znak da funkcija SAMA proverava ko je zove (pa DEFINER prava nisu blanko ček).
 * Namerno široko — cilj je da propusti sve što ima ikakvu proveru, jer je svaki
 * lažan nalaz mesečno-ponavljajući šum koji ubija poverenje u izveštaj.
 */
const CALLER_CHECK_RE = String.raw`(auth\.uid|auth\.jwt|current_user_is_|request\.jwt|can_edit_|can_manage_|is_admin)`;

/** Viseći sy15 upit ne sme da zakuca tik pogona (obrazac iz sy15-cron-jobs.ts). */
const QUERY_TIMEOUT_MS = 60_000;

export interface SecurityAuditItem {
  /** Ime objekta (tabela/pogled/funkcija) ili oznaka nalaza. */
  name: string;
  /** Šta je tačno izloženo (privilegije, potpis, status). */
  detail: string;
}

export interface SecurityAuditCategory {
  key: string;
  title: string;
  count: number;
  items: SecurityAuditItem[];
}

export interface SecurityAuditResult {
  checkedAt: string;
  /** true = nijedan nalaz (nema mejla). */
  ok: boolean;
  findingCount: number;
  categories: SecurityAuditCategory[];
  /** Namerni izuzeci zatečeni na bazi — informativno, NE ulaze u findingCount. */
  allowedExceptions: SecurityAuditItem[];
  /** Jedan red za dnevnik `scheduled_job_runs.summary`. */
  summary: string;
}

interface TableRow {
  name: string;
  privs: string;
}
interface ViewRow {
  name: string;
  kind: string;
  privs: string;
}
interface FunctionRow {
  name: string;
  args: string;
  body_unreadable: boolean;
}
interface GuardRow {
  evtname: string;
  evtevent: string;
  evtenabled: string;
}
interface DefaultAclRow {
  schema_name: string;
  for_role: string;
  objtype: string;
  privs: string;
}

@Injectable()
export class SecurityAuditService {
  private readonly logger = new Logger(SecurityAuditService.name);

  constructor(
    private readonly sy15: Sy15Service,
    private readonly mail: MailService,
  ) {}

  /** Primaoci izveštaja (lowercase, bez duplikata i praznih). */
  recipients(): string[] {
    const raw = (process.env[MAIL_TO_ENV] ?? "").trim() || DEFAULT_MAIL_TO;
    const seen = new Set<string>();
    for (const part of raw.split(",")) {
      const e = part.trim().toLowerCase();
      if (e.includes("@")) seen.add(e);
    }
    return [...seen];
  }

  buildJobs(): ScheduledJob[] {
    return [
      {
        key: SECURITY_AUDIT_JOB_KEY,
        description:
          "Bezbednosna provera sy15: da li je ijedan objekat (tabela/pogled/funkcija) otvoren roli anon + je li brana sec_guard_revoke_anon živa",
        // Ponedeljak 07:15 lokalno — pre početka radnog dana, a razmaknuto od
        // ostalih ponedeljničkih poslova (06:30 attendance digest, 09:00 HR rizik),
        // da spor sy15 upit ne gura njih u isti tik.
        schedule: { kind: "weekly", isoDow: 1, at: "07:15" },
        // 240 min: restart/deploy ponedeljkom ujutru još nadoknadi propušten
        // termin; posle 11h nedeljni izveštaj i dalje ima smisla, ali se ne čeka
        // dalje — sledeći ponedeljak svejedno meri isto stanje.
        catchUpMinutes: 240,
        run: async () => {
          const res = await this.run();
          return res.summary;
        },
      },
    ];
  }

  /**
   * Odradi proveru i (samo ako ima nalaza) pošalji mejl. Vraća strukturiran
   * rezultat — isti objekat koji vidi admin ruta.
   */
  async run(): Promise<SecurityAuditResult> {
    const result = await this.audit();

    if (result.ok) {
      this.logger.log(`Bezbednosna provera sy15: ${result.summary}`);
      return result;
    }

    this.logger.error(`Bezbednosna provera sy15: ${result.summary}`);
    for (const c of result.categories) {
      if (c.count === 0) continue;
      this.logger.error(
        `  ${c.title} (${c.count}): ${c.items.map((i) => `${i.name} [${i.detail}]`).join("; ")}`,
      );
    }

    // Mejl je best-effort — pad slanja NE sme da obori posao, inače bi scheduler
    // retry-jem ponovo skenirao bazu zbog problema koji nema veze sa bezbednošću.
    try {
      const to = this.recipients();
      const sent = await this.mail.send({
        to,
        subject: `⚠️ ServoSync bezbednost — anonimni pristup sy15 bazi (${result.findingCount} ${result.findingCount === 1 ? "nalaz" : "nalaza"})`,
        html: this.buildHtml(result),
      });
      if (!sent) {
        this.logger.warn(
          `Izveštaj o ${result.findingCount} nalaza NIJE poslat (DRY-RUN ili greška Resend-a) — nalazi su gore u logu.`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Slanje izveštaja palo: ${e instanceof Error ? e.message : String(e)} — nalazi su gore u logu.`,
      );
    }

    return result;
  }

  /** ČISTO ČITANJE — nikad ne šalje mejl (koristi je i `run()` i admin ruta). */
  async audit(): Promise<SecurityAuditResult> {
    const checkedAt = new Date().toISOString();

    if (!this.sy15.isConfigured) {
      // Namerno greška, ne tiho „ok": provera koja se ne izvrši ne sme da izgleda
      // kao provera koja je prošla.
      throw new Error(
        "sy15 baza nije konfigurisana (SY15_DATABASE_URL) — bezbednosna provera nije mogla da se izvrši.",
      );
    }

    // Bez role `anon` nema anonimnog pristupa — nema ni šta da se meri, a
    // `has_*_privilege('anon', …)` bi pukao na nepostojećoj roli.
    const anonExists = await this.q<{ present: boolean }>(
      this.sy15.db.$queryRaw`
        SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS present`,
    );
    if (!anonExists[0]?.present) {
      const summary =
        "rola `anon` ne postoji na sy15 — anonimni pristup nije moguć, provera preskočena.";
      return {
        checkedAt,
        ok: true,
        findingCount: 0,
        categories: [],
        allowedExceptions: [],
        summary,
      };
    }

    const [tables, views, functions, guard, defaultAcl] = await Promise.all([
      this.checkTables(),
      this.checkViews(),
      this.checkFunctions(),
      this.checkGuard(),
      this.checkDefaultAcl(),
    ]);

    const { findings: fnFindings, allowed } = this.classifyFunctions(functions);

    const categories: SecurityAuditCategory[] = [
      cat(
        "guard",
        `Brana \`${GUARD_TRIGGER}\` (event trigger)`,
        this.guardFindings(guard),
      ),
      cat(
        "tables",
        "Tabele bez RLS-a dostupne roli `anon`",
        tables.map((t) => ({ name: t.name, detail: t.privs })),
      ),
      cat(
        "views",
        "Pogledi bez `security_invoker` dostupni roli `anon`",
        views.map((v) => ({
          name: v.name,
          detail: `${v.kind === "m" ? "materijalizovan pogled" : "pogled"} · ${v.privs}`,
        })),
      ),
      cat(
        "functions",
        "Funkcije SECURITY DEFINER koje MENJAJU podatke, izvršive od `anon`, bez provere pozivaoca",
        fnFindings,
      ),
      cat(
        "defaultAcl",
        "Podrazumevana prava (`ALTER DEFAULT PRIVILEGES`) koja opet daju `anon`",
        defaultAcl.map((d) => ({
          name: `${d.schema_name} · ${objTypeLabel(d.objtype)}`,
          detail: `vlasnik ${d.for_role} → ${d.privs}`,
        })),
      ),
    ];

    const findingCount = categories.reduce((n, c) => n + c.count, 0);
    const ok = findingCount === 0;
    const summary = ok
      ? `čisto — nijedan objekat nije otvoren roli anon (dozvoljenih izuzetaka: ${allowed.length}).`
      : `${findingCount} NALAZA — ` +
        categories
          .filter((c) => c.count > 0)
          .map((c) => `${c.key}=${c.count}`)
          .join(", ");

    return {
      checkedAt,
      ok,
      findingCount,
      categories,
      allowedExceptions: allowed,
      summary,
    };
  }

  // ── Pojedinačne provere (SVE su SELECT nad sistemskim katalozima) ──────────

  /**
   * (1) Tabele u `public` BEZ RLS-a a dostupne roli `anon`. Bez RLS-a grant znači
   * pun sadržaj tabele — sa RLS-om politika i dalje presuđuje red po red, pa
   * tabela sa RLS-om nije automatski nalaz.
   *
   * `has_table_privilege` (a ne `aclexplode(relacl)`) namerno: hvata i grant kroz
   * `PUBLIC` i grant kroz članstvo u drugoj roli — dakle ISHOD, ne zapis u ACL-u.
   */
  private async checkTables(): Promise<TableRow[]> {
    return this.q<TableRow>(this.sy15.db.$queryRaw`
      SELECT c.relname AS name,
             array_to_string(ARRAY(
               SELECT pr FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) pr
                WHERE has_table_privilege('anon', c.oid, pr)
             ), ',') AS privs
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('r', 'p')
         AND c.relrowsecurity = false
         AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('anon', c.oid, 'INSERT')
           OR has_table_privilege('anon', c.oid, 'UPDATE')
           OR has_table_privilege('anon', c.oid, 'DELETE')
           OR has_table_privilege('anon', c.oid, 'TRUNCATE'))
       ORDER BY 1`);
  }

  /**
   * (2) Pogledi dostupni `anon`-u koji NEMAJU `security_invoker=true`. Takav pogled
   * se izvršava sa pravima VLASNIKA, pa probija RLS tabela ispod sebe — tako je
   * `v_kadr_medical_exam_status` (imena + lekarski pregledi) i bio javan. Pogled SA
   * `security_invoker=true` čita kao sam pozivalac i nije nalaz.
   *
   * Materijalizovani pogledi (`relkind='m'`) NEMAJU `security_invoker` — oni su
   * snimak podataka i grant `anon`-u je uvek pun sadržaj, pa se uvek prijavljuju.
   */
  private async checkViews(): Promise<ViewRow[]> {
    return this.q<ViewRow>(this.sy15.db.$queryRaw`
      SELECT c.relname AS name,
             c.relkind::text AS kind,
             array_to_string(ARRAY(
               SELECT pr FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) pr
                WHERE has_table_privilege('anon', c.oid, pr)
             ), ',') AS privs
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind IN ('v', 'm')
         AND NOT COALESCE((
               SELECT bool_or(lower(split_part(o, '=', 2)) IN ('true','on','1','yes'))
                 FROM unnest(COALESCE(c.reloptions, '{}'::text[])) o
                WHERE lower(split_part(o, '=', 1)) = 'security_invoker'), false)
         AND (has_table_privilege('anon', c.oid, 'SELECT')
           OR has_table_privilege('anon', c.oid, 'INSERT')
           OR has_table_privilege('anon', c.oid, 'UPDATE')
           OR has_table_privilege('anon', c.oid, 'DELETE'))
       ORDER BY 1`);
  }

  /**
   * (3) Najopasnija kategorija: SECURITY DEFINER funkcija koju `anon` sme da
   * izvrši, koja MENJA podatke i nema unutrašnju proveru pozivaoca = upis u bazu
   * sa interneta bez prijave (npr. `kadr_grid_set_go` pre 31.07).
   *
   * SVESNA SUŽENJA (bez njih je izveštaj šum koji niko ne čita):
   *  • `prorettype` trigger/event_trigger se ODBACUJE — PostgreSQL odbija direktan
   *    poziv trigger funkcije („trigger functions can only be called as triggers"),
   *    pa grant na njima nije put ka izvršenju. Uživo je to 14 od 18 pogodaka
   *    (31.07) — sve lažne.
   *  • `prokind` samo 'f'/'p' (funkcije i procedure); agregati/prozorske funkcije
   *    nemaju telo koje ovde ima smisla čitati.
   *
   * `prosrc IS NULL` (funkcija sa SQL-standard telom, `BEGIN ATOMIC`) se prijavljuje
   * kao nalaz NAMERNO — telo ne možemo pročitati, pa se pada na sigurnu stranu i
   * traži se ručna procena, umesto da nešto tiho prođe.
   */
  private async checkFunctions(): Promise<FunctionRow[]> {
    return this.q<FunctionRow>(this.sy15.db.$queryRaw`
      SELECT p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS args,
             (p.prosrc IS NULL) AS body_unreadable
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prosecdef
         AND p.prokind IN ('f', 'p')
         AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
         AND has_function_privilege('anon', p.oid, 'EXECUTE')
         AND (p.prosrc IS NULL
              OR (p.prosrc ~* ${MUTATING_BODY_RE}::text
              AND p.prosrc !~* ${CALLER_CHECK_RE}::text))
       ORDER BY 1, 2`);
  }

  /**
   * (4) Sama brana. Nema je ili je isključena = nalaz NAJVIŠEG prioriteta: od tog
   * trenutka svaki nov objekat opet tiho dobija `anon`, a ostale četiri provere to
   * vide tek sledećeg ponedeljka (do nedelju dana izloženosti).
   */
  private async checkGuard(): Promise<GuardRow[]> {
    return this.q<GuardRow>(this.sy15.db.$queryRaw`
      SELECT evtname, evtevent, evtenabled::text AS evtenabled
        FROM pg_event_trigger
       WHERE evtname = ${GUARD_TRIGGER}`);
  }

  /**
   * (5) Podrazumevana prava. Ovo je IZVOR celog incidenta: Supabase-ov
   * `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL … TO anon` je svakom novom
   * objektu unapred davao anon. Ako se vrati, brana i dalje radi (skida posle DDL-a),
   * ali svaki objekat kreiran mimo DDL putanje ostaje otvoren — zato se prijavljuje.
   *
   * `defaclnamespace = 0` = podrazumevana prava za SVE šeme; važe i za `public`, pa
   * ulaze u proveru.
   */
  private async checkDefaultAcl(): Promise<DefaultAclRow[]> {
    return this.q<DefaultAclRow>(this.sy15.db.$queryRaw`
      SELECT COALESCE(n.nspname, '(sve šeme)') AS schema_name,
             pg_get_userbyid(d.defaclrole) AS for_role,
             d.defaclobjtype::text AS objtype,
             string_agg(DISTINCT a.privilege_type, ',') AS privs
        FROM pg_default_acl d
        LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       WHERE (n.nspname = 'public' OR d.defaclnamespace = 0)
         AND (a.grantee = 0
           OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'anon'))
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`);
  }

  // ── Obrada ────────────────────────────────────────────────────────────────

  private guardFindings(rows: GuardRow[]): SecurityAuditItem[] {
    if (rows.length === 0) {
      return [
        {
          name: GUARD_TRIGGER,
          detail:
            "NE POSTOJI — svaki nov objekat u šemi public opet dobija anon pristup",
        },
      ];
    }
    const g = rows[0];
    // 'O' = uključen (origin), 'A' = uključen i na replici. 'D' = isključen,
    // 'R' = radi samo na replici (dakle na primaru ne radi ništa).
    if (g.evtenabled !== "O" && g.evtenabled !== "A") {
      return [
        {
          name: GUARD_TRIGGER,
          detail: `ISKLJUČENA (evtenabled='${g.evtenabled}') — brana ne radi`,
        },
      ];
    }
    if (g.evtevent !== "ddl_command_end") {
      return [
        {
          name: GUARD_TRIGGER,
          detail: `okida se na '${g.evtevent}' umesto 'ddl_command_end' — ne pokriva kreiranje objekata`,
        },
      ];
    }
    return [];
  }

  /**
   * Razdvoji namerne izuzetke od pravih nalaza. Kontrola broja: ako pod dozvoljenim
   * IMENOM postoji više potpisa nego što lista dozvoljava, višak je nalaz — tako
   * dodat overload (`kiosk_record_punch(...)` sa drugim parametrima) ne može da se
   * provuče kroz poređenje po imenu.
   */
  classifyFunctions(rows: FunctionRow[]): {
    findings: SecurityAuditItem[];
    allowed: SecurityAuditItem[];
  } {
    const findings: SecurityAuditItem[] = [];
    const allowed: SecurityAuditItem[] = [];
    const seenAllowedNames = new Set<string>();

    for (const r of rows) {
      const item: SecurityAuditItem = {
        name: `${r.name}(${r.args})`,
        detail: r.body_unreadable
          ? "telo nije čitljivo (SQL-standard telo) — traži ručnu procenu"
          : "SECURITY DEFINER · anon EXECUTE · menja podatke · bez provere pozivaoca",
      };
      if (!ALLOWED_ANON_FUNCTIONS.has(r.name)) {
        findings.push(item);
        continue;
      }
      if (seenAllowedNames.has(r.name)) {
        findings.push({
          name: item.name,
          detail: `DODAT POTPIS pod dozvoljenim imenom '${r.name}' — izuzetak pokriva samo jedan potpis, ovaj nije odobren`,
        });
        continue;
      }
      seenAllowedNames.add(r.name);
      allowed.push({
        name: item.name,
        detail: "namerno javan (štiti se tokenom u telu funkcije)",
      });
    }
    return { findings, allowed };
  }

  // ── Pomoćno ───────────────────────────────────────────────────────────────

  /** Upit sa rokom — mrtva sy15 veza ne sme da zakuca tik pogona. */
  private async q<T>(query: PromiseLike<unknown>): Promise<T[]> {
    return Promise.race([
      query as Promise<T[]>,
      new Promise<never>((_, rej) =>
        setTimeout(
          () =>
            rej(
              new Error(
                `sy15 upit nije odgovorio za ${QUERY_TIMEOUT_MS / 1000}s`,
              ),
            ),
          QUERY_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  }

  private esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private buildHtml(r: SecurityAuditResult): string {
    const tables = r.categories
      .filter((c) => c.count > 0)
      .map(
        (c) => `
        <p style="margin:18px 0 6px"><strong>${this.esc(c.title)} — ${c.count}</strong></p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <thead><tr>
            <th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">Objekat</th>
            <th style="text-align:left;padding:4px 8px;border-bottom:1px solid #ccc">Šta je izloženo</th>
          </tr></thead>
          <tbody>${c.items
            .map(
              (i) =>
                `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee"><code>${this.esc(i.name)}</code></td>` +
                `<td style="padding:4px 8px;border-bottom:1px solid #eee;color:#444">${this.esc(i.detail)}</td></tr>`,
            )
            .join("")}</tbody>
        </table>`,
      )
      .join("");

    const allowed = r.allowedExceptions.length
      ? `<p style="margin:18px 0 6px;color:#666"><strong>Namerni izuzeci (nisu nalaz):</strong> ${r.allowedExceptions
          .map((a) => `<code>${this.esc(a.name)}</code>`)
          .join(", ")}</p>`
      : "";

    return `
      <p>Nedeljna provera sy15 baze našla je <strong>${r.findingCount}</strong>
      ${r.findingCount === 1 ? "objekat otvoren" : "objekata otvorenih"} anonimnom pristupu
      (rola <code>anon</code> = svako sa interneta, bez prijave, preko PostgREST-a).</p>
      ${tables}
      ${allowed}
      <p style="margin:18px 0;color:#444">Provera je <strong>samo čitala</strong> sistemske kataloge —
      ništa nije promenjeno. Popravka se radi ručno na sy15 bazi
      (<code>REVOKE … FROM anon, PUBLIC</code>, odnosno uključivanje brane
      <code>${GUARD_TRIGGER}</code>).</p>
      <p style="color:#666;font-size:13px;margin-top:16px">Automatska poruka sistema ServoSync
      (posao <code>${SECURITY_AUDIT_JOB_KEY}</code>, ponedeljak 07:15).
      Provereno: ${this.esc(r.checkedAt)}.</p>`;
  }
}

function cat(
  key: string,
  title: string,
  items: SecurityAuditItem[],
): SecurityAuditCategory {
  return { key, title, count: items.length, items };
}

/** `pg_default_acl.defaclobjtype` → ljudski čitljivo. */
function objTypeLabel(t: string): string {
  switch (t) {
    case "r":
      return "tabele";
    case "S":
      return "sekvence";
    case "f":
      return "funkcije";
    case "T":
      return "tipovi";
    case "n":
      return "šeme";
    default:
      return t;
  }
}
