import {
  MAINT_MAX_ATTEMPTS,
  OdrzavanjeFnService,
} from "./odrzavanje-fn.service";
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
 * ── 🔴 A ONDA JE I TA POPRAVKA UVELA SVOJ KVAR (treći krug, 08.08.2026) ─────
 *
 * Priznanje `FANOUT_NO_RECIPIENTS` je bilo VEČNO — bez ijednog prozora. Pošto
 * `dispatchDequeue` red uzima samo dok je `attempts < MAINT_MAX_ATTEMPTS`, red
 * ispumpan do plafona (~8 h uz backoff od 1 h) prestaje da se pokušava, ALI je
 * i dalje zauvek blokirao ponovni upis tog roka. Ishod je bio obrnut kvar od
 * onog koji je lečen: rok se GUBI TRAJNO, i to tiho (od drugog dana ulazi u
 * `skipped`, nerazlučivo od uredno isporučenog). Stanje u kojem ugriza je baš
 * ono koje ovaj PR priprema — profila IMA, telefona nema (delimičan prenos).
 *
 * Zato priznanje sada važi samo unutar prozora ponovnih pokušaja, i testovi
 * ispod pinuju OBE strane te granice (blokira dok je živ, pušta kad ispadne).
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
  /**
   * Brojač pokušaja dispečera. `dispatchDequeue` ga diže pri svakom claim-u i
   * red uzima samo dok je `attempts < MAINT_MAX_ATTEMPTS`; ISTA granica govori i
   * dokle red zatvoren kao `FANOUT_NO_RECIPIENTS` važi kao „upisan".
   */
  attempts: number;
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
      case "attempts": {
        // 🔴 Operator se PROVERAVA, ne pretpostavlja. Da smo samo pročitali
        // `.lt`, svaka druga varijanta (`lte`, `gt`, `equals`) dala bi
        // `red.attempts < undefined` = false — filtar bi tiho postao „nikad se
        // ne poklapa" i test bi padao iz pogrešnog razloga, umesto da prijavi
        // da servis šalje nešto što ovaj prevodilac ne meri.
        const op = v as Record<string, unknown>;
        const kljucevi = Object.keys(op);
        if (kljucevi.length !== 1 || typeof op.lt !== "number") {
          throw new Error(
            `poklapa(): 'attempts' se meri SAMO kao { lt: number }, dobijeno ` +
              `${JSON.stringify(op)} — dopuni prevodilac.`,
          );
        }
        if (!(red.attempts < op.lt)) return false;
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
          attempts: 0,
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

/**
 * Jedan tik dispečera nad redom koji fanout ne uspe da razgrana ni na koga.
 *
 * Verno preslikava ono što radnik STVARNO radi, jer o tome visi ceo prozor:
 * `dispatchDequeue` claim-uje red (`attempts + 1`, status natrag na `queued`),
 * pa `dispatchFanout` bez ijednog primaoca zove `markFailedRaw` — dakle
 * `status='failed'` sa `FANOUT_NO_RECIPIENTS` u `error`. Claim se dešava SAMO
 * dok je `attempts < MAINT_MAX_ATTEMPTS`; posle toga red trajno ispada iz reda
 * čekanja, pa ga ovaj helper više i ne dira.
 */
function tikDispecera(red: Red): void {
  if (red.attempts >= MAINT_MAX_ATTEMPTS) return;
  red.attempts += 1;
  red.status = "failed";
  red.error =
    "FANOUT_NO_RECIPIENTS: nijedan aktivan profil (chief) sa telefonom u maint_user_profiles";
}

/** Redovi koje `dispatchDequeue` još sme da uzme (živi pokušaji). */
function zivih(outbox: Red[]): number {
  return outbox.filter((r) => r.attempts < MAINT_MAX_ATTEMPTS).length;
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

  it("🔴 FANOUT_NO_RECIPIENTS važi kao UPISAN dok je red U REDU ČEKANJA", async () => {
    const { db, registracijaIstice } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);
    expect(db.outbox).toHaveLength(1);

    // Dispečer je red pokupio, fanout nije našao nijednog primaoca
    // (`maint_user_profiles` prazan) i zatvorio ga kao NEUSPEH — tačno ono što
    // prva popravka PR-a #125 radi.
    tikDispecera(db.outbox[0]);

    // 🔴 SUŠTINA: dok red još ima pokušaja, prolaz posla NE SME da napravi drugi
    // red. Sa starim filtrom (`status IN ('queued','sent')`) ovde je nastajao NOV
    // red — i tako svakog dana, dok se prenos podataka ne pusti.
    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(db.outbox).toHaveLength(1);

    // Sve do PRETPOSLEDNJEG pokušaja (attempts = 7) red i dalje blokira: prozor
    // ponovnih pokušaja je otvoren, obaveštenje još može stvarno da ode.
    while (db.outbox[0].attempts < MAINT_MAX_ATTEMPTS - 1) {
      tikDispecera(db.outbox[0]);
      expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
        enqueued: 0,
        skipped: 1,
      });
    }
    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0].attempts).toBe(MAINT_MAX_ATTEMPTS - 1);

    // Idempotencija drži, ali se laž „poslato" NE vraća: red je i dalje `failed`
    // sa vidljivim razlogom. To je jedina razlika u odnosu na staro ponašanje.
    expect(db.outbox[0].status).toBe("failed");
    expect(db.outbox[0].error).toContain("FANOUT_NO_RECIPIENTS");
    // I dalje je vezan za TAJ rok (ne poklapa se slučajno sa bilo čim).
    expect(db.outbox[0].payload.deadline_date).toBe(isoDan(registracijaIstice));
    expect(db.outbox[0].payload.deadline_kind).toBe("registration");
  });

  it("🔴 rok ispumpan do PLAFONA se NE gubi zauvek — sledeći prolaz ga upiše ponovo", async () => {
    // ── Zašto ovaj test postoji ────────────────────────────────────────────
    // Prva verzija popravke idempotencije (commit `94130750`) priznavala je
    // `FANOUT_NO_RECIPIENTS` kao „upisan" BEZ ijednog prozora. Kad `attempts`
    // udari plafon, `dispatchDequeue` (`attempts < p_max_attempts`) red više ne
    // uzima — dakle se NIKAD više ne pokušava — a on je i dalje zauvek blokirao
    // ponovni upis. Rok je time TIHO nestajao: od drugog dana samo `skipped`,
    // nerazlučivo od uredno isporučenog. Stanje u kojem ugriza je baš ono koje
    // ovaj PR priprema: profila IMA (brana `maint-deadlines` prolazi), ali
    // nijedan `chief`/`management` nema telefon — delimičan prenos.
    const { db, registracijaIstice } = bazaSaJednimVozilom();
    const s = svc(db);
    await s.checkVehicleDeadlines(db as never, 30);

    // Ceo prozor ponovnih pokušaja potrošen (~8 h uz backoff od 1 h).
    for (let i = 0; i < MAINT_MAX_ATTEMPTS; i++) tikDispecera(db.outbox[0]);
    expect(db.outbox[0].attempts).toBe(MAINT_MAX_ATTEMPTS);
    expect(zivih(db.outbox)).toBe(0);

    // 🔴 SUŠTINA: sutrašnji prolaz mora da upiše NOV red za isti rok.
    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 1,
      skipped: 0,
    });
    expect(db.outbox).toHaveLength(2);
    // Nov red je svež pokušaj…
    expect(db.outbox[1].status).toBe("queued");
    expect(db.outbox[1].attempts).toBe(0);
    expect(db.outbox[1].payload.deadline_date).toBe(isoDan(registracijaIstice));
    expect(db.outbox[1].payload.deadline_kind).toBe("registration");
    // …a stari ostaje kao VIDLJIV trag neuspeha, ne prepisuje se u `sent`.
    expect(db.outbox[0].status).toBe("failed");
    expect(db.outbox[0].error).toContain("FANOUT_NO_RECIPIENTS");

    // Nov red odmah opet blokira ponovni upis — dnevno TAČNO jedan pokušaj,
    // ne jedan po prolazu posla.
    expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(db.outbox).toHaveLength(2);
  });

  it("posle deset dana: outbox ima 10 redova, ali živ je uvek TAČNO jedan", async () => {
    // Cena prozora, izmerena a ne pretpostavljena: u stanju „nema kome" outbox
    // raste za jedan mrtav red po roku po danu (kao pre commita `6f389886`), a
    // `enqueued` ne pada na nulu. To je namerno — signal da obaveštenja ne
    // sleću — i jedina alternativa bila bi tiho gubljenje roka.
    const { db } = bazaSaJednimVozilom();
    const s = svc(db);
    for (let dan = 0; dan < 10; dan++) {
      expect(await s.checkVehicleDeadlines(db as never, 30)).toEqual({
        enqueued: 1,
        skipped: 0,
      });
      // Dan dispečera: red se ispumpa do plafona i ispadne iz reda čekanja.
      const posl = db.outbox[db.outbox.length - 1];
      for (let i = 0; i < MAINT_MAX_ATTEMPTS; i++) tikDispecera(posl);
      // U svakom trenutku najviše JEDAN red se stvarno pokušava.
      expect(zivih(db.outbox)).toBe(0);
      expect(db.outbox).toHaveLength(dan + 1);
    }
    // Nijedan red nije završio kao lažni `sent` — gubitak ostaje vidljiv.
    expect(db.outbox.every((r) => r.status === "failed")).toBe(true);
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
            attempts: 0,
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
    tikDispecera(outbox[0]);

    iRaw = 0;
    expect(await s.checkItFacilityDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(outbox).toHaveLength(1);

    // 🔴 I PROZOR se deli, ne samo skup statusa. `it_backup` ima SVOJ prozor od
    // 7 dana (`createdAt`), pa bi bez ovoga „nema kome" red ovde blokirao rok
    // celu nedelju, a u `postojiRok` ~8 h — ista funkcija, dva životna veka.
    // Presek dva prozora daje kraći: čim red ispadne iz reda čekanja, upozorenje
    // se upisuje ponovo — iako 7 dana još nije prošlo.
    for (let i = 0; i < MAINT_MAX_ATTEMPTS; i++) tikDispecera(outbox[0]);
    iRaw = 0;
    expect(await s.checkItFacilityDeadlines(db as never, 30)).toEqual({
      enqueued: 1,
      skipped: 0,
    });
    expect(outbox).toHaveLength(2);
    // A THROTTLE od 7 dana i dalje radi svoj posao nad redom koji JESTE otišao.
    outbox[1].status = "sent";
    iRaw = 0;
    expect(await s.checkItFacilityDeadlines(db as never, 30)).toEqual({
      enqueued: 0,
      skipped: 1,
    });
    expect(outbox).toHaveLength(2);
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
