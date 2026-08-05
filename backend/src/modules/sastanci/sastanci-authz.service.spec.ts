import { SastanciAuthzService } from "./sastanci-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Paritet sy15 gejtova prava nad 3.0 `users` / `user_roles`.
 *
 * 🔴 ZAŠTO OVI TESTOVI POSTOJE: u sy15 su ova prava sprovodile RLS politike, pa
 * ih kod NIJE duplirao. Pod `3.0` RLS-a nema — ako se ovde nešto olabavi, prava
 * TIHO nestaju (svi vide/menjaju sve), a to se ne vidi ni u jednom drugom testu.
 */

function prismaStub(opts: {
  user?: { id: number; role: string } | null;
  extraRoles?: string[];
  ucesnikCount?: number;
  moverCount?: number;
  /** Broj sastanaka koji zadovoljavaju „organizator-trio" upit. */
  trioCount?: number;
}) {
  return {
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.user ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userRole: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.extraRoles ?? []).map((role) => ({ role }))),
    },
    sastanakUcesnik: {
      count: jest.fn().mockResolvedValue(opts.ucesnikCount ?? 0),
    },
    sastWeeklyMover: {
      count: jest.fn().mockResolvedValue(opts.moverCount ?? 0),
    },
    sastanak: {
      count: jest.fn().mockResolvedValue(opts.trioCount ?? 0),
    },
  } as unknown as PrismaService;
}

const svc = (p: PrismaService) => new SastanciAuthzService(p);

describe("isManagement — paritet current_user_is_management()", () => {
  it("admin i menadzment prolaze", async () => {
    for (const role of ["admin", "menadzment"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.isManagement("a@servoteh.com")).toBe(true);
    }
  });

  it("sef/tehnolog/proizvodni_radnik NE prolaze", async () => {
    for (const role of ["sef", "tehnolog", "proizvodni_radnik", "pm"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.isManagement("a@servoteh.com")).toBe(false);
    }
  });

  it("🔴 gleda I dodatne globalne role, ne samo primarnu users.role", async () => {
    // sy15 je imao JEDNU tabelu `user_roles`; 3.0 ima `users.role` + `user_roles`.
    // Bez unije bi korisnik sa menadžmentskom rolom u `user_roles` izgubio pravo
    // koje je u sy15 imao.
    const s = svc(
      prismaStub({ user: { id: 1, role: "sef" }, extraRoles: ["menadzment"] }),
    );
    expect(await s.isManagement("a@servoteh.com")).toBe(true);
  });

  it("neaktivan/nepostojeći korisnik i prazan mejl → false", async () => {
    expect(await svc(prismaStub({ user: null })).isManagement("x@y.com")).toBe(false);
    expect(await svc(prismaStub({})).isManagement("")).toBe(false);
    expect(await svc(prismaStub({})).isManagement(null)).toBe(false);
  });

  it("prazan mejl ne dira bazu (ne curi upit po praznom ključu)", async () => {
    const p = prismaStub({});
    await svc(p).isManagement("   ");
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("hasEditRole — paritet has_edit_role()", () => {
  it("skup je ŠIRI od menadžmenta: admin/hr/menadzment/pm/leadpm/poslovni_admin", async () => {
    for (const role of [
      "admin",
      "hr",
      "menadzment",
      "pm",
      "leadpm",
      "poslovni_admin",
    ]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.hasEditRole("a@servoteh.com")).toBe(true);
    }
  });

  it("sef i proizvodni_radnik nemaju edit pravo nad sastancima", async () => {
    for (const role of ["sef", "proizvodni_radnik", "magacioner", "kontrolor"]) {
      const s = svc(prismaStub({ user: { id: 1, role } }));
      expect(await s.hasEditRole("a@servoteh.com")).toBe(false);
    }
  });
});

describe("isAdmin — paritet current_user_is_admin()", () => {
  it("SAMO admin (menadzment nije admin)", async () => {
    expect(
      await svc(prismaStub({ user: { id: 1, role: "admin" } })).isAdmin("a@b.com"),
    ).toBe(true);
    expect(
      await svc(prismaStub({ user: { id: 1, role: "menadzment" } })).isAdmin("a@b.com"),
    ).toBe(false);
  });
});

describe("isUcesnik — paritet is_sastanak_ucesnik(uuid)", () => {
  it("poklapanje po lower(email) unutar jednog sastanka", async () => {
    const p = prismaStub({ ucesnikCount: 1 });
    expect(await svc(p).isUcesnik("A@Servoteh.com", "s-1")).toBe(true);
    expect(p.sastanakUcesnik.count).toHaveBeenCalledWith({
      where: {
        sastanakId: "s-1",
        email: { equals: "a@servoteh.com", mode: "insensitive" },
      },
    });
  });

  it("bez sastanka ili bez mejla → false, bez upita", async () => {
    const p = prismaStub({ ucesnikCount: 1 });
    expect(await svc(p).isUcesnik("a@b.com", null)).toBe(false);
    expect(await svc(p).isUcesnik("", "s-1")).toBe(false);
    expect(p.sastanakUcesnik.count).not.toHaveBeenCalled();
  });
});

describe("canMoveWeekly — paritet sast_user_can_move_weekly()", () => {
  it("🔴 gejt je ALLOWLIST tabela, NE rola — admin bez reda ne prolazi", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "admin" }, moverCount: 0 }));
    expect(await s.canMoveWeekly("admin@servoteh.com")).toBe(false);
  });

  it("red u sast_weekly_movers prolazi i bez ijedne role", async () => {
    const s = svc(prismaStub({ user: null, moverCount: 1 }));
    expect(await s.canMoveWeekly("bilo.ko@servoteh.com")).toBe(true);
  });
});

// ============================================================================
// READ-SCOPE (blokada 4) — paritet SELECT RLS politika
// ============================================================================
//
// 🔴 ZAŠTO SE TESTIRA VIDLJIVOST A NE OBLIK OBJEKTA: tvrdnja tipa
// `expect(where).toEqual({...})` prolazi i kad je uslov logički pogrešan. Zato
// se generisani Prisma `where` OVDE IZVRŠAVA nad fiksnim skupom redova (mali
// evaluator ispod), pa svaki test kaže tačno ono što politika kaže:
// „vidi svoje" i „NE vidi tuđe".
//
// Politike su prepisane sa ŽIVE sy15 (`pg_policies`, 06.08.2026), ne iz docs-a.

/** Izvršava podskup Prisma `where` oblika koje generiše `SastanciAuthzService`. */
function matches(row: Record<string, unknown>, where: unknown): boolean {
  if (where == null || typeof where !== "object") return true;
  const w = where as Record<string, unknown>;
  return Object.entries(w).every(([k, v]) => {
    if (k === "OR") return (v as unknown[]).some((c) => matches(row, c));
    if (k === "AND") return (v as unknown[]).every((c) => matches(row, c));
    const cell = row[k];
    if (v === null) return cell == null;
    if (typeof v !== "object") return cell === v;
    const cond = v as Record<string, unknown>;
    if ("in" in cond) return (cond.in as unknown[]).includes(cell);
    if ("equals" in cond) {
      const a = cond.equals as string;
      const b = cell as string | null;
      return cond.mode === "insensitive"
        ? (b ?? "").toLowerCase() === a.toLowerCase()
        : b === a;
    }
    // relacija: { sastanak: { is: { ucesnici: { some: { … } } } } }
    if ("is" in cond)
      return cell != null && matches(cell as Record<string, unknown>, cond.is);
    if ("some" in cond)
      return ((cell as unknown[]) ?? []).some((r) =>
        matches(r as Record<string, unknown>, cond.some),
      );
    throw new Error(`evaluator ne zna uslov: ${JSON.stringify(v)}`);
  });
}

const JA = "ja@servoteh.com";
const TUDJE = "tudje@servoteh.com";

/** s1 = sastanak na kom JESAM učesnik, s2 = sastanak na kom NISAM. */
const ucesniciS1 = { ucesnici: [{ email: JA }, { email: TUDJE }] };
const ucesniciS2 = { ucesnici: [{ email: TUDJE }] };

const TEME = [
  {
    k: "moja",
    predlozioEmail: JA,
    sastanakId: null,
    status: "predlog",
    sastanak: null,
  },
  {
    k: "tudja-moj-sastanak",
    predlozioEmail: TUDJE,
    sastanakId: "s1",
    status: "predlog",
    sastanak: ucesniciS1,
  },
  {
    k: "tudja-tudj-sastanak",
    predlozioEmail: TUDJE,
    sastanakId: "s2",
    status: "predlog",
    sastanak: ucesniciS2,
  },
  {
    k: "tudj-draft-bez-sastanka",
    predlozioEmail: TUDJE,
    sastanakId: null,
    status: "draft",
    sastanak: null,
  },
  {
    k: "tudj-draft-na-tudjem",
    predlozioEmail: TUDJE,
    sastanakId: "s2",
    status: "draft",
    sastanak: ucesniciS2,
  },
];

const vidljive = (where: unknown) =>
  TEME.filter((t) => matches(t, where)).map((t) => t.k);

describe("scopeTemeWhere — paritet pmt_select", () => {
  it("običan korisnik (bez edit role) vidi SVOJU temu i temu sa SVOG sastanka", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vidljive(await s.scopeTemeWhere(JA))).toEqual([
      "moja",
      "tudja-moj-sastanak",
    ]);
  });

  it("🔴 običan korisnik NE VIDI tuđu temu sa tuđeg sastanka ni tuđi draft", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    const v = vidljive(await s.scopeTemeWhere(JA));
    expect(v).not.toContain("tudja-tudj-sastanak");
    expect(v).not.toContain("tudj-draft-bez-sastanka");
    expect(v).not.toContain("tudj-draft-na-tudjem");
  });

  it("edit rola dodaje SAMO draft BEZ sastanka (ne i draft na tuđem sastanku)", async () => {
    // `pm` je u EDIT_ROLES a NIJE u MANAGEMENT_ROLES — tačno četvrta grana.
    const s = svc(prismaStub({ user: { id: 1, role: "pm" } }));
    const v = vidljive(await s.scopeTemeWhere(JA));
    expect(v).toContain("tudj-draft-bez-sastanka");
    expect(v).not.toContain("tudj-draft-na-tudjem");
    expect(v).not.toContain("tudja-tudj-sastanak");
  });

  it("rukovodstvo vidi sve (where = {}, bez sužavanja)", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "menadzment" } }));
    const where = await s.scopeTemeWhere(JA);
    expect(where).toEqual({});
    expect(vidljive(where)).toHaveLength(TEME.length);
  });

  it("poređenje predlagača je neosetljivo na veličinu slova (kao lower() u sy15)", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vidljive(await s.scopeTemeWhere("JA@Servoteh.COM"))).toContain("moja");
  });

  it("🔴 prazan mejl → NIJEDAN red (nikad `{}`)", async () => {
    const s = svc(prismaStub({ user: null }));
    for (const prazan of ["", "   ", null, undefined]) {
      expect(vidljive(await s.scopeTemeWhere(prazan))).toEqual([]);
    }
  });
});

describe("scopeTemeSql — isti scope za čitanja preko view-a", () => {
  it("rukovodstvo → TRUE, prazan mejl → FALSE", async () => {
    const mgmt = svc(prismaStub({ user: { id: 1, role: "admin" } }));
    expect((await mgmt.scopeTemeSql(JA, "v")).sql).toBe("TRUE");
    const niko = svc(prismaStub({ user: null }));
    expect((await niko.scopeTemeSql("", "v")).sql).toBe("FALSE");
  });

  it("🔴 kolone su kvalifikovane aliasom — inače EXISTS zasenči spoljnu sastanak_id", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    const frag = (await s.scopeTemeSql(JA, "v")).sql;
    expect(frag).toContain('"v".predlozio_email');
    expect(frag).toContain('su.sastanak_id = "v".sastanak_id');
    expect(frag).toContain('"v".sastanak_id IS NOT NULL');
  });

  it("draft grana postoji SAMO uz edit rolu", async () => {
    const bez = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect((await bez.scopeTemeSql(JA, "v")).sql).not.toContain("'draft'");
    const sa = svc(prismaStub({ user: { id: 1, role: "pm" } }));
    expect((await sa.scopeTemeSql(JA, "v")).sql).toContain("'draft'");
  });

  it("mejl ide kao parametar, ne ulepljen u tekst (nema SQL injekcije)", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    const frag = await s.scopeTemeSql("a'; DROP TABLE pm_teme; --", "v");
    expect(frag.sql).not.toContain("DROP TABLE");
    expect(frag.values).toContain("a'; drop table pm_teme; --");
  });
});

describe("scopeNotifLogWhere — paritet snl_select (outbox mejlova)", () => {
  const REDOVI = [
    { k: "moj", recipientEmail: JA },
    { k: "moj-drugo-slovo", recipientEmail: "JA@Servoteh.com" },
    { k: "tudji", recipientEmail: TUDJE },
  ];
  const vid = (w: unknown) =>
    REDOVI.filter((r) => matches(r, w)).map((r) => r.k);

  it("vidim SVOJE mejlove", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vid(await s.scopeNotifLogWhere(JA))).toContain("moj");
  });

  it("🔴 NE VIDIM tuđe (red nosi subject/body_html/payload cele poruke)", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vid(await s.scopeNotifLogWhere(JA))).not.toContain("tudji");
  });

  it("rukovodstvo vidi sve", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "menadzment" } }));
    expect(await s.scopeNotifLogWhere(JA)).toEqual({});
  });

  it("SVESNO ODSTUPANJE: poređenje je case-insensitive (sy15 je poredio kolonu doslovno)", async () => {
    // Izmereno: 0/134 redova u živoj sy15 ima veliko slovo, pa je razlika nulta.
    // Odstupanje može pokazati SAMO sopstveni red, nikad tuđi.
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vid(await s.scopeNotifLogWhere(JA))).toContain("moj-drugo-slovo");
  });

  it("🔴 prazan mejl → nijedan red", async () => {
    const s = svc(prismaStub({ user: null }));
    expect(vid(await s.scopeNotifLogWhere(""))).toEqual([]);
  });
});

describe("scopeNotifPrefsWhere — paritet snp_select_own", () => {
  // 🔴 Ova politika NIJE bila u runbook-u §7c — nađena merenjem `pg_policies`.
  const REDOVI = [
    { k: "moja", email: JA },
    { k: "tudja", email: TUDJE },
  ];
  const vid = (w: unknown) =>
    REDOVI.filter((r) => matches(r, w)).map((r) => r.k);

  it("vidim svoja podešavanja, NE i tuđa", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    expect(vid(await s.scopeNotifPrefsWhere(JA))).toEqual(["moja"]);
  });

  it("rukovodstvo vidi sve", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "admin" } }));
    expect(vid(await s.scopeNotifPrefsWhere(JA))).toEqual(["moja", "tudja"]);
  });

  it("🔴 prazan mejl → nijedan red", async () => {
    const s = svc(prismaStub({ user: null }));
    expect(vid(await s.scopeNotifPrefsWhere(null))).toEqual([]);
  });
});

// ============================================================================
// WRITE-SCOPE — gejtovi koje traže rute skinute sa 503 (blokada 1)
// ============================================================================
//
// Izmereno (`pg_policies`, živa sy15):
//   sastanci_insert            has_edit_role()
//   su_* / ap_*                has_edit_role() ∧ (mgmt ∨ učesnik ∨ trio)

describe("canCreateSastanak — paritet sastanci_insert", () => {
  it("edit rola sme, ostali ne", async () => {
    expect(
      await svc(prismaStub({ user: { id: 1, role: "pm" } })).canCreateSastanak(JA),
    ).toBe(true);
    expect(
      await svc(prismaStub({ user: { id: 1, role: "sef" } })).canCreateSastanak(JA),
    ).toBe(false);
  });
});

describe("canWriteSastanakChild — paritet su_*/ap_* politika", () => {
  const S = "sast-1";

  it("🔴 edit rola SAMA po sebi NIJE dovoljna (mora i veza sa sastankom)", async () => {
    // Ovo je grana koju je najlakše izgubiti: `has_edit_role()` je konjunkt, ne
    // alternativa. Bez nje bi svaki `pm` menjao učesnike SVAKOG sastanka.
    const s = svc(
      prismaStub({ user: { id: 1, role: "pm" }, ucesnikCount: 0, trioCount: 0 }),
    );
    expect(await s.canWriteSastanakChild(JA, S)).toBe(false);
  });

  it("edit rola + učesnik → sme", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "pm" }, ucesnikCount: 1 }));
    expect(await s.canWriteSastanakChild(JA, S)).toBe(true);
  });

  it("edit rola + organizator-trio (vodio/zapisničar/created_by) → sme", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "pm" }, trioCount: 1 }));
    expect(await s.canWriteSastanakChild(JA, S)).toBe(true);
  });

  it("rukovodstvo sme i bez ikakve veze sa sastankom", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "menadzment" } }));
    expect(await s.canWriteSastanakChild(JA, S)).toBe(true);
  });

  it("🔴 BEZ edit role ni učesnik ni trio ne pomažu", async () => {
    const s = svc(
      prismaStub({ user: { id: 1, role: "sef" }, ucesnikCount: 1, trioCount: 1 }),
    );
    expect(await s.canWriteSastanakChild(JA, S)).toBe(false);
  });

  it("prazan mejl → false, bez ijednog upita", async () => {
    const p = prismaStub({ ucesnikCount: 1, trioCount: 1 });
    expect(await svc(p).canWriteSastanakChild("", S)).toBe(false);
    expect(p.sastanak.count).not.toHaveBeenCalled();
  });

  it("assert varijanta baca 403 (sy15 je vraćao 42501 → 403)", async () => {
    const s = svc(prismaStub({ user: { id: 1, role: "sef" } }));
    await expect(s.assertCanWriteSastanakChild(JA, S)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("isOrganizatorTrio", () => {
  it("gleda sve tri kolone, neosetljivo na veličinu slova", async () => {
    const p = prismaStub({ trioCount: 1 });
    expect(await svc(p).isOrganizatorTrio("JA@Servoteh.com", "sast-1")).toBe(true);
    const where = (p.sastanak.count as jest.Mock).mock.calls[0][0].where;
    expect(where.OR.map((o: Record<string, unknown>) => Object.keys(o)[0])).toEqual([
      "vodioEmail",
      "zapisnicarEmail",
      "createdByEmail",
    ]);
    for (const o of where.OR) {
      expect(Object.values(o)[0]).toEqual({
        equals: "ja@servoteh.com",
        mode: "insensitive",
      });
    }
  });

  it("bez sastanka → false bez upita", async () => {
    const p = prismaStub({ trioCount: 1 });
    expect(await svc(p).isOrganizatorTrio(JA, null)).toBe(false);
    expect(p.sastanak.count).not.toHaveBeenCalled();
  });
});

// ============================================================================
// WRITE-SCOPE, ostatak blokade 3 — svaka politika dobija par „sme svoje" /
// „NE sme tuđe". Ovi testovi su jedina brana: pod `3.0` RLS-a nema, pa bi
// olabavljen gejt tiho dao pravo nad tuđim redom.
// ============================================================================

const EDIT = { id: 1, role: "pm" }; // edit rola, NIJE menadžment
const MGMT = { id: 2, role: "menadzment" };
const NIKO = { id: 3, role: "sef" }; // bez edit role

describe("pmt_* (pm_teme write) — canWriteTema", () => {
  it("🔴 tema BEZ sastanka: rukovodstvo SME, obična edit rola NE SME", async () => {
    // Ovo je razlika prema `ap_*`, gde goli `mgmt` apsorbuje granu i edit rola
    // sme i bez sastanka. Prepis po analogiji bi tiho proširio prava.
    expect(await svc(prismaStub({ user: MGMT })).canWriteTema(JA, null)).toBe(true);
    expect(await svc(prismaStub({ user: EDIT })).canWriteTema(JA, null)).toBe(false);
  });

  it("tema NA sastanku: učesnik sa edit rolom sme", async () => {
    const p = prismaStub({ user: EDIT, ucesnikCount: 1 });
    expect(await svc(p).canWriteTema(JA, "sast-1")).toBe(true);
  });

  it("tema NA sastanku: organizator-trio sa edit rolom sme", async () => {
    const p = prismaStub({ user: EDIT, ucesnikCount: 0, trioCount: 1 });
    expect(await svc(p).canWriteTema(JA, "sast-1")).toBe(true);
  });

  it("🔴 NE SME TUĐE: edit rola koja nije ni učesnik ni organizator", async () => {
    const p = prismaStub({ user: EDIT, ucesnikCount: 0, trioCount: 0 });
    expect(await svc(p).canWriteTema(JA, "sast-tudji")).toBe(false);
  });

  it("bez edit role ne pomaže ni učešće ni menadžment-grana", async () => {
    const p = prismaStub({ user: NIKO, ucesnikCount: 1, trioCount: 1 });
    expect(await svc(p).canWriteTema(JA, "sast-1")).toBe(false);
  });

  it("prazan mejl → false", async () => {
    expect(await svc(prismaStub({ user: MGMT })).canWriteTema("", null)).toBe(false);
  });
});

describe("pm_teme_draft_insert — predlaganje drafta", () => {
  it("draft BEZ sastanka sme svaka edit rola (politika se SABIRA sa pmt_insert)", async () => {
    const p = prismaStub({ user: EDIT });
    await expect(
      svc(p).assertCanInsertTema(JA, "draft", null),
    ).resolves.toBeUndefined();
  });

  it("🔴 NE-draft bez sastanka i dalje traži rukovodstvo", async () => {
    const p = prismaStub({ user: EDIT });
    await expect(
      svc(p).assertCanInsertTema(JA, "predlog", null),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("draft VEZAN za sastanak ne prolazi kroz draft granu (pada na pmt_insert)", async () => {
    const p = prismaStub({ user: EDIT, ucesnikCount: 0, trioCount: 0 });
    expect(await svc(p).canInsertDraftTema(JA, "draft", "sast-1")).toBe(false);
    await expect(
      svc(p).assertCanInsertTema(JA, "draft", "sast-1"),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("pm_teme_draft_review — USING ≠ WITH CHECK", () => {
  it("draft → usvojeno/odbijeno prolazi za edit rolu", async () => {
    const p = prismaStub({ user: EDIT });
    expect(await svc(p).canDraftReview(JA, "draft", "usvojeno")).toBe(true);
    expect(await svc(p).canDraftReview(JA, "draft", "odbijeno")).toBe(true);
  });

  it("🔴 USING strana: red koji NIJE draft ne ulazi u ovu politiku", async () => {
    const p = prismaStub({ user: EDIT });
    expect(await svc(p).canDraftReview(JA, "predlog", "usvojeno")).toBe(false);
  });

  it("🔴 WITH CHECK strana: draft → bilo šta drugo (npr. odlozeno) ne prolazi", async () => {
    const p = prismaStub({ user: EDIT });
    expect(await svc(p).canDraftReview(JA, "draft", "odlozeno")).toBe(false);
    expect(await svc(p).canDraftReview(JA, "draft", "zatvoreno")).toBe(false);
  });

  it("bez edit role i bez menadžmenta → false", async () => {
    const p = prismaStub({ user: NIKO });
    expect(await svc(p).canDraftReview(JA, "draft", "usvojeno")).toBe(false);
  });
});

describe("assertCanUpdateTema — obe strane pmt_update", () => {
  it("🔴 premeštanje teme traži pravo i nad STARIM i nad NOVIM sastankom", async () => {
    // Učesnik je samo na jednom sastanku (ucesnikCount 1 za oba poziva bi bio
    // lažno permisivan) — ovde simuliramo „na starom da, na novom ne".
    const p = prismaStub({ user: EDIT, trioCount: 0 });
    (p.sastanakUcesnik.count as jest.Mock)
      .mockResolvedValueOnce(1) // stari sastanak — jesam učesnik
      .mockResolvedValue(0); // novi sastanak — nisam
    await expect(
      svc(p).assertCanUpdateTema(
        JA,
        { status: "predlog", sastanakId: "stari" },
        { status: "predlog", sastanakId: "novi" },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("draft-review grana prolazi i kad pmt_update ne bi", async () => {
    const p = prismaStub({ user: EDIT, ucesnikCount: 0, trioCount: 0 });
    await expect(
      svc(p).assertCanUpdateTema(
        JA,
        { status: "draft", sastanakId: null },
        { status: "usvojeno", sastanakId: null },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("sast_odluke_write / sast_tpl_write — SAMO has_edit_role()", () => {
  it("edit rola sme odluke i šablone i kad nije učesnik ni organizator", async () => {
    // Namerno šire od dece sastanka — tako je izmereno u sy15; sužavanje bi
    // bilo regresija prava.
    const p = prismaStub({ user: EDIT, ucesnikCount: 0, trioCount: 0 });
    await expect(svc(p).assertCanWriteOdluka(JA)).resolves.toBeUndefined();
    await expect(svc(p).assertCanWriteTemplate(JA)).resolves.toBeUndefined();
  });

  it("🔴 bez edit role → 403", async () => {
    const p = prismaStub({ user: NIKO, ucesnikCount: 1, trioCount: 1 });
    await expect(svc(p).assertCanWriteOdluka(JA)).rejects.toMatchObject({
      status: 403,
    });
    await expect(svc(p).assertCanWriteTemplate(JA)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("snp_update_own — podešavanja obaveštenja", () => {
  it("svoj red sme (neosetljivo na veličinu slova), bez ijednog upita", async () => {
    const p = prismaStub({ user: NIKO });
    await expect(
      svc(p).assertCanWritePrefs("JA@Servoteh.com", "ja@servoteh.com"),
    ).resolves.toBeUndefined();
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });

  it("🔴 NE SME TUĐE — obična rola nad tuđim redom je 403", async () => {
    const p = prismaStub({ user: EDIT });
    await expect(
      svc(p).assertCanWritePrefs(JA, "neko.drugi@servoteh.com"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rukovodstvo sme i tuđe (politika ima `∨ mgmt`)", async () => {
    const p = prismaStub({ user: MGMT });
    await expect(
      svc(p).assertCanWritePrefs(JA, "neko.drugi@servoteh.com"),
    ).resolves.toBeUndefined();
  });
});
