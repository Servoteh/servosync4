import {
  SecurityAuditService,
  SECURITY_AUDIT_JOB_KEY,
} from "./security-audit.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { MailService } from "../../common/mail/mail.service";

/*
 * Nedeljna bezbednosna provera sy15. Pinuje ono što lako tiho pukne:
 *  • MEJL SAMO NA NALAZ (čisto stanje = tišina, inače izveštaj postane šum),
 *  • dva namerna izuzetka NISU nalaz, ali DODAT POTPIS pod istim imenom JESTE,
 *  • trigger-funkcije ne smeju da uđu u upit (14/18 lažnih na živoj bazi 31.07),
 *  • ugašena/nepostojeća brana je nalaz najvišeg prioriteta,
 *  • pad slanja mejla NE obara posao,
 *  • nekonfigurisan sy15 = greška, nikad tiho „ok".
 */

/** Redosled upita u `audit()`: anon-postoji, pa Promise.all [tabele, pogledi, fn, brana, defaultAcl]. */
interface FakeRows {
  anonExists?: boolean;
  tables?: unknown[];
  views?: unknown[];
  functions?: unknown[];
  guard?: unknown[];
  defaultAcl?: unknown[];
}

const GUARD_OK = [
  {
    evtname: "sec_guard_revoke_anon",
    evtevent: "ddl_command_end",
    evtenabled: "O",
  },
];

/**
 * Mok sy15: `$queryRaw` je tagovan šablon, pa raspoznajemo upit po SQL tekstu
 * (fragmenti su stabilni delovi svakog upita — ne po redosledu poziva, jer
 * `Promise.all` ne garantuje redosled).
 */
function fakeSy15(rows: FakeRows = {}) {
  const sql: string[] = [];
  const $queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const text = strings.join(" ");
    sql.push(text);
    if (text.includes("rolname = 'anon'") && text.includes("EXISTS"))
      return Promise.resolve([{ present: rows.anonExists ?? true }]);
    if (text.includes("relrowsecurity"))
      return Promise.resolve(rows.tables ?? []);
    if (text.includes("security_invoker"))
      return Promise.resolve(rows.views ?? []);
    if (text.includes("prosecdef"))
      return Promise.resolve(rows.functions ?? []);
    if (text.includes("pg_event_trigger"))
      return Promise.resolve(rows.guard ?? GUARD_OK);
    if (text.includes("pg_default_acl"))
      return Promise.resolve(rows.defaultAcl ?? []);
    throw new Error(`Nepokriven upit u moku: ${text.slice(0, 120)}`);
  });
  return {
    sy15: { isConfigured: true, db: { $queryRaw } } as unknown as Sy15Service,
    sql,
  };
}

/** Ono što `MailService.send` stvarno primi — tipizovano da mok ne bude `any`. */
interface SendArgs {
  to: string[];
  subject: string;
  html: string;
}

function fakeMail(sent = true) {
  const send = jest.fn<Promise<boolean>, [SendArgs]>().mockResolvedValue(sent);
  return { mail: { send } as unknown as MailService, send };
}

const fn = (name: string, args = "") => ({
  name,
  args,
  body_unreadable: false,
});

describe("SecurityAuditService", () => {
  it("čisto stanje: nema nalaza i NE šalje mejl", async () => {
    const { sy15 } = fakeSy15();
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.ok).toBe(true);
    expect(res.findingCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(res.summary).toContain("čisto");
  });

  it("dva namerna izuzetka su i dalje čisto stanje (bez mejla)", async () => {
    const { sy15 } = fakeSy15({
      functions: [
        fn("kiosk_record_punch", "p_token text, p_direction text"),
        fn("assessment_submit_by_token", "p_token text, p_scores jsonb"),
      ],
    });
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.ok).toBe(true);
    expect(res.findingCount).toBe(0);
    expect(res.allowedExceptions).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  it("otvorena tabela: nalaz + mejl na podrazumevanog primaoca", async () => {
    const { sy15 } = fakeSy15({
      tables: [{ name: "kadr_employees", privs: "SELECT,UPDATE" }],
    });
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.ok).toBe(false);
    expect(res.findingCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.to).toEqual(["nenad.jarakovic@servoteh.com"]);
    expect(arg.subject).toContain("anonimni pristup");
    expect(arg.html).toContain("kadr_employees");
    expect(arg.html).toContain("SELECT,UPDATE");
  });

  it("funkcija koja menja podatke van liste izuzetaka je nalaz", async () => {
    const { sy15 } = fakeSy15({
      functions: [
        fn("kiosk_record_punch", "p_token text, p_direction text"),
        fn("_loc_purge_synced_events_cron", "p_retention_days integer"),
      ],
    });
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    expect(res.allowedExceptions).toHaveLength(1);
    const cat = res.categories.find((c) => c.key === "functions");
    expect(cat?.items[0].name).toBe(
      "_loc_purge_synced_events_cron(p_retention_days integer)",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("DODAT potpis pod dozvoljenim imenom je nalaz (overload ne prolazi)", async () => {
    const { sy15 } = fakeSy15({
      functions: [
        fn("kiosk_record_punch", "p_token text, p_direction text"),
        fn("kiosk_record_punch", "p_token text"),
      ],
    });
    const { mail } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    expect(res.allowedExceptions).toHaveLength(1);
    expect(
      res.categories.find((c) => c.key === "functions")?.items[0].detail,
    ).toContain("DODAT POTPIS");
  });

  it("nečitljivo telo (SQL-standard) se prijavljuje umesto da tiho prođe", async () => {
    const { sy15 } = fakeSy15({
      functions: [{ name: "nesto_novo", args: "", body_unreadable: true }],
    });
    const { mail } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    expect(
      res.categories.find((c) => c.key === "functions")?.items[0].detail,
    ).toContain("ručnu procenu");
  });

  it("brana koja ne postoji je nalaz", async () => {
    const { sy15 } = fakeSy15({ guard: [] });
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    expect(
      res.categories.find((c) => c.key === "guard")?.items[0].detail,
    ).toContain("NE POSTOJI");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ISKLJUČENA brana (evtenabled='D') je nalaz", async () => {
    const { sy15 } = fakeSy15({
      guard: [
        {
          evtname: "sec_guard_revoke_anon",
          evtevent: "ddl_command_end",
          evtenabled: "D",
        },
      ],
    });
    const { mail } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    expect(
      res.categories.find((c) => c.key === "guard")?.items[0].detail,
    ).toContain("ISKLJUČENA");
  });

  it("vraćena podrazumevana prava za anon su nalaz", async () => {
    const { sy15 } = fakeSy15({
      defaultAcl: [
        {
          schema_name: "public",
          for_role: "supabase_admin",
          objtype: "r",
          privs: "SELECT,INSERT",
        },
      ],
    });
    const { mail } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.findingCount).toBe(1);
    const item = res.categories.find((c) => c.key === "defaultAcl")?.items[0];
    expect(item?.name).toBe("public · tabele");
  });

  it("pad slanja mejla NE obara posao (best-effort)", async () => {
    const { sy15 } = fakeSy15({ tables: [{ name: "t", privs: "SELECT" }] });
    const mail = {
      send: jest.fn().mockRejectedValue(new Error("Resend 500")),
    } as unknown as MailService;

    const res = await new SecurityAuditService(sy15, mail).run();
    expect(res.findingCount).toBe(1);
    expect(res.ok).toBe(false);
  });

  it("nekonfigurisan sy15 BACA (provera koja se ne izvrši nije 'ok')", async () => {
    const sy15 = { isConfigured: false } as unknown as Sy15Service;
    const { mail, send } = fakeMail();
    await expect(new SecurityAuditService(sy15, mail).run()).rejects.toThrow(
      /SY15_DATABASE_URL/,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("bez role `anon` provera je bez nalaza i bez mejla", async () => {
    const { sy15 } = fakeSy15({ anonExists: false });
    const { mail, send } = fakeMail();
    const res = await new SecurityAuditService(sy15, mail).run();

    expect(res.ok).toBe(true);
    expect(res.categories).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("upit o funkcijama odbacuje trigger funkcije i traži anon EXECUTE", async () => {
    const { sy15, sql } = fakeSy15();
    await new SecurityAuditService(sy15, {
      send: jest.fn(),
    } as unknown as MailService).audit();

    const fnSql = sql.find((s) => s.includes("prosecdef")) ?? "";
    expect(fnSql).toContain("'trigger'::regtype");
    expect(fnSql).toContain("'event_trigger'::regtype");
    expect(fnSql).toContain("has_function_privilege('anon'");
    // Nijedan upit ne sme da menja bazu. Ne može se tražiti odsustvo reči
    // INSERT/UPDATE/DELETE — one legitimno stoje kao IMENA PRIVILEGIJA u
    // `has_table_privilege(…, 'INSERT')`. Zato se proverava OBLIK naredbe:
    // jedna jedina naredba (bez `;`) koja počinje sa SELECT.
    for (const s of sql) {
      expect(s.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(s).not.toContain(";");
    }
  });

  it("primaoci se čitaju iz SECURITY_AUDIT_MAIL_TO (bez duplikata i praznih)", () => {
    const prev = process.env.SECURITY_AUDIT_MAIL_TO;
    process.env.SECURITY_AUDIT_MAIL_TO =
      " A@x.com , a@x.com ,,b@x.com , bezmajmuna";
    try {
      const { sy15 } = fakeSy15();
      const svc = new SecurityAuditService(sy15, {} as unknown as MailService);
      expect(svc.recipients()).toEqual(["a@x.com", "b@x.com"]);
    } finally {
      if (prev === undefined) delete process.env.SECURITY_AUDIT_MAIL_TO;
      else process.env.SECURITY_AUDIT_MAIL_TO = prev;
    }
  });

  it("posao je nedeljni (ponedeljak) i registruje se BEZ prekidača", () => {
    const { sy15 } = fakeSy15();
    const jobs = new SecurityAuditService(
      sy15,
      {} as unknown as MailService,
    ).buildJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe(SECURITY_AUDIT_JOB_KEY);
    expect(jobs[0].schedule).toEqual({
      kind: "weekly",
      isoDow: 1,
      at: "07:15",
    });
  });
});
