import { OdrzavanjeFnService } from "./odrzavanje-fn.service";
import { OdrzavanjeAuthzService } from "./odrzavanje-authz.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * IDEMPOTENCIJA POSLA `maint-deadlines` — regresija koju je uvela POPRAVKA.
 *
 * 🔴 ŠTA SE OVDE ČUVA I ZAŠTO JE ISPALO IZ VIDA:
 *
 * `postojiRok` je proveravao `status IN ('queued','sent')`. Dok je fanout
 * roditelja UVEK zatvarao kao `sent`, ta lista je pokrivala sve — rok upisan
 * juče je danas nalažen i preskočen, pa je posao bio idempotentan.
 *
 * Prva popravka PR-a #125 je (s razlogom) prestala da laže „poslato" kad nema
 * primalaca: roditelj sada završava kao `failed` sa `FANOUT_NO_RECIPIENTS`, a
 * dece nema (`createMany` se preskače). Time nijedan red više ne zadovoljava
 * `postojiRok` — i posao je počeo da SVAKI DAN iznova upisuje isti rok za isto
 * vozilo. U izmerenom stanju produkcije (08.08.2026: `maint_user_profiles` = 0)
 * to nije rub nego PRAVILO: outbox bi rastao za jedan mrtav `failed` red po
 * roku po danu, a `enqueued` u `scheduled_job_runs` nikad ne bi pao na nulu —
 * čime bi baš poređenje „pre/posle preklopa" (zbog kojeg je oblik summary-ja
 * namerno očuvan) postalo neupotrebljivo.
 *
 * Testovi ispod zato NE mockuju odgovor `findFirst` nego drže MALI OUTBOX u
 * memoriji i primenjuju `where` koji servis stvarno pošalje. Mock koji vraća
 * unapred zadat red ne bi razlikovao ispravan filtar od pogrešnog.
 */

/** Red outbox-a — samo polja koja `postojiRok` gleda. */
interface Red {
  id: string;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  status: string;
  error: string | null;
  payload: Record<string, unknown>;
  /** Samo `it_backup` idempotencija ovo gleda (prozor od 7 dana). */
  createdAt: Date;
}

/**
 * Minimalni prevodilac Prisma `where`-a nad jednim redom.
 *
 * 🔴 BACA NA NEPOZNAT KLJUČ — namerno. Da tiho ignoriše ono što ne razume,
 * postao bi „uvek se poklapa" i test bi prošao i za pokvaren filtar.
 */
function poklapa(red: Red, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    switch (k) {
      case "relatedEntityType":
        if (red.relatedEntityType !== v) return false;
        break;
      case "relatedEntityId":
        if (red.relatedEntityId !== v) return false;
        break;
      case "status": {
        if (typeof v === "string") {
          if (red.status !== v) return false;
        } else {
          const lista = (v as { in: string[] }).in;
          if (!lista.includes(red.status)) return false;
        }
        break;
      }
      case "error": {
        const pref = (v as { startsWith: string }).startsWith;
        if (!red.error?.startsWith(pref)) return false;
        break;
      }
      case "payload": {
        const p = v as { path: string[]; equals: unknown };
        if (red.payload[p.path[0]] !== p.equals) return false;
        break;
      }
      case "createdAt": {
        const g = (v as { gte: Date }).gte;
        if (red.createdAt < g) return false;
        break;
      }
      case "OR": {
        const grane = v as Record<string, unknown>[];
        if (!grane.some((g) => poklapa(red, g))) return false;
        break;
      }
      case "AND": {
        const grane = v as Record<string, unknown>[];
        if (!grane.every((g) => poklapa(red, g))) return false;
        break;
      }
      default:
        throw new Error(
          `poklapa(): nepoznat ključ u where-u: '${k}' — dopuni prevodilac, ` +
            "inače test tiho prestaje da meri filtar.",
        );
    }
  }
  return true;
}

const ASSET = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Datum unutar lookahead prozora (rok koji posao MORA da primeti). */
function zaDana(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(12, 0, 0, 0);
  return d;
}

/** `isoDan` iz servisa — lokalni dan, ne UTC (payload mora da se poklopi). */
function isoDan(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Lažna 3.0 baza: JEDNO vozilo sa isteklom registracijom + outbox u memoriji.
 * Vozača i dokumenata nema — merimo tačno jedan rok.
 */
function bazaSaJednimVozilom(outbox: Red[] = []) {
  const registracijaIstice = zaDana(5);
  const db = {
    outbox,
    maintVehicleDetails: {
      findMany: () =>
        Promise.resolve([
          {
            assetId: ASSET,
            registrationPlate: "BG 2884 XA",
            registrationExpiresAt: registracijaIstice,
            insuranceExpiresAt: null,
            firstAidKitExpiresAt: null,
            asset: { assetCode: "V-001", name: "Kombi" },
          },
        ]),
    },
    maintDriver: { findMany: () => Promise.resolve([]) },
    maintDocument: { findMany: () => Promise.resolve([]) },
    maintNotificationLog: {
      findFirst: (args: { where: Record<string, unknown> }) =>
        Promise.resolve(outbox.find((r) => poklapa(r, args.where)) ?? null),
      create: (args: { data: Record<string, unknown> }) => {
        const d = args.data;
        outbox.push({
          id: `N${outbox.length + 1}`,
          relatedEntityType: d.relatedEntityType as string,
          relatedEntityId: d.relatedEntityId as string,
          status: d.status as string,
          error: null,
          payload: d.payload as Record<string, unknown>,
          createdAt: new Date(),
        });
        return Promise.resolve({ id: `N${outbox.length}` });
      },
    },
  };
  return { db, registracijaIstice };
}

function svc(db: unknown) {
  const prisma = db as PrismaService;
  return new OdrzavanjeFnService(prisma, new OdrzavanjeAuthzService(prisma));
}

describe("maint-deadlines — rok upisan JUČE se DANAS ne upisuje ponovo", () => {
  it("prvi prolaz upisuje rok (enqueued=1), drugi ga preskače (skipped=1)", async () => {
    const { db } = bazaSaJednimVozilom();
    const s = svc(db);

    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 1,
      skipped: 0,
    });
    // Red je i dalje `queued` (dispečer ga još nije uzeo) — klasičan slučaj.
    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(db.outbox).toHaveLength(1);
  });

  it("🔴 red zatvoren kao FANOUT_NO_RECIPIENTS i dalje važi kao UPISAN", async () => {
    const { db, registracijaIstice } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);
    expect(db.outbox).toHaveLength(1);

    // Dispečer je red pokupio, fanout nije našao nijednog primaoca
    // (`maint_user_profiles` prazan) i zatvorio ga kao NEUSPEH — tačno ono što
    // prva popravka PR-a #125 radi.
    db.outbox[0].status = "failed";
    db.outbox[0].error =
      "FANOUT_NO_RECIPIENTS: nijedan aktivan profil (chief) sa telefonom u maint_user_profiles";

    // 🔴 SUŠTINA: sutrašnji prolaz posla NE SME da napravi drugi red. Sa starim
    // filtrom (`status IN ('queued','sent')`) ovde je nastajao NOV red — i tako
    // svakog dana, dok se prenos podataka ne pusti.
    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(db.outbox).toHaveLength(1);
    // I posle deset dana stoji TAČNO jedan red — outbox ne raste.
    for (let i = 0; i < 10; i++) await s.checkVehicleDeadlines(db as never, 30);
    expect(db.outbox).toHaveLength(1);

    // Idempotencija drži, ali se laž „poslato" NE vraća: red je i dalje `failed`
    // sa vidljivim razlogom. To je jedina razlika u odnosu na staro ponašanje.
    expect(db.outbox[0].status).toBe("failed");
    expect(db.outbox[0].error).toContain("FANOUT_NO_RECIPIENTS");
    // I dalje je vezan za TAJ rok (ne poklapa se slučajno sa bilo čim).
    expect(db.outbox[0].payload.deadline_date).toBe(isoDan(registracijaIstice));
    expect(db.outbox[0].payload.deadline_kind).toBe("registration");
  });

  it("STVARAN neuspeh isporuke i dalje pušta ponovni upis (paritet sa sy15)", async () => {
    const { db } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);

    // Ovo NIJE „nema kome" nego pad isporuke ka postojećem primaocu. Izvor takav
    // red ne računa kao upisan — sutrašnji prolaz sme da pokuša ponovo, i to
    // ponašanje se NE dira (inače bi propali rok tiho nestao).
    db.outbox[0].status = "failed";
    db.outbox[0].error = "WA 500: Internal Server Error";

    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 1,
      skipped: 0,
    });
    expect(db.outbox).toHaveLength(2);
  });

  it("poslat rok (`sent`) se ne ponavlja — netaknuto ponašanje izvora", async () => {
    const { db } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);
    db.outbox[0].status = "sent";
    db.outbox[0].error = "FANOUT_DONE: 2 recipients";

    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
  });

  it("🔴 DRUGA kopija iste idempotencije (`it_backup`) drži isto pravilo", async () => {
    // `it_backup` ima svoj ključ (`backup_status` + poslednjih 7 dana, jer backup
    // nema rok) i SVOJ upit — dok su bila dva mesta, popravka jednog je drugo
    // ostavljala na starom pravilu i backup-upozorenje bi se ponavljalo dnevno.
    const outbox: Red[] = [];
    let iRaw = 0;
    const db = {
      outbox,
      $queryRaw: () => {
        // 1. poziv = `v_maint_it_overview`, 2. = `v_maint_facility_overview`.
        iRaw += 1;
        return Promise.resolve(
          iRaw === 1
            ? [
                {
                  asset_id: ASSET,
                  asset_code: "IT-1",
                  name: "Server",
                  license_expires_at: null,
                  warranty_expires_at: null,
                  backup_status: "stale",
                },
              ]
            : [],
        );
      },
      maintNotificationLog: {
        findFirst: (args: { where: Record<string, unknown> }) =>
          Promise.resolve(outbox.find((r) => poklapa(r, args.where)) ?? null),
        create: (args: { data: Record<string, unknown> }) => {
          const d = args.data;
          outbox.push({
            id: `N${outbox.length + 1}`,
            relatedEntityType: d.relatedEntityType as string,
            relatedEntityId: d.relatedEntityId as string,
            status: d.status as string,
            error: null,
            payload: d.payload as Record<string, unknown>,
            createdAt: new Date(),
          });
          return Promise.resolve({ id: `N${outbox.length}` });
        },
      },
    };
    const s = svc(db);

    expect(await s.checkItFacilityDeadlines(db as never, 30)).toEqual({
      enqueued: 1,
      skipped: 0,
    });
    outbox[0].status = "failed";
    outbox[0].error = "FANOUT_NO_RECIPIENTS: nijedan aktivan profil (chief)";

    iRaw = 0;
    expect(await s.checkItFacilityDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(outbox).toHaveLength(1);
  });

  it("DRUGI rok istog vozila nije blokiran prvim (filtar je po vrsti i datumu)", async () => {
    const { db } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);
    db.outbox[0].status = "failed";
    db.outbox[0].error = "FANOUT_NO_RECIPIENTS: …";
    // Ručno ubačen rok DRUGE vrste za isto sredstvo ne sme da se poklopi sa
    // registracijom — inače bi jedan „nema kome" ućutkao ceo entitet.
    expect(
      poklapa(db.outbox[0], {
        relatedEntityType: "asset",
        relatedEntityId: ASSET,
        AND: [{ payload: { path: ["deadline_kind"], equals: "insurance" } }],
      }),
    ).toBe(false);
  });
});
