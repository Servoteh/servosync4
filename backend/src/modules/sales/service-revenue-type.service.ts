import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { TAX_TREATMENTS } from "./service-revenue-type";

/**
 * ŠIFARNIK VRSTA USLUGE — čitanje za račun + UREĐIVANJE za knjigovođu.
 *
 * Do 05.08.2026. je ovaj servis samo ČITAO, a šifarnik se menjao isključivo SQL-om nad
 * produkcijom (nalaz P10, `docs/OTVORENI_POSLOVI.md`). Sada uređivanje ide kroz ekran u
 * Podešavanjima, iza prava `settings.accounting_rules`.
 *
 * Zašto zaseban servis, a ne metod na `SalesService`: `SalesService` je o IZMENI jednog
 * nacrta (brave, CAS, preračun zbirova), a ovo je šifarnik koji čitaju i račun i
 * Podešavanja.
 *
 * ── ZAŠTO JE OVO KNJIGOVODSTVENI, A NE KOMERCIJALNI EKRAN ────────────────────
 * Jedan red ovog šifarnika nosi DVE poreske tvrdnje: konto prihoda i to KO obračunava
 * PDV. Izmena `OTPAD` sa `REVERSE_CHARGE` na `TAXED` bi od sledeće fakture obračunavala
 * porez koji po zakonu obračunava kupac (čl. 10 st. 2 t. 1 ZPDV), na dokumentu koji
 * uredno balansira i koji nijedna kontrola ne bi prijavila. Zato čitanje ostaje pod
 * `sales.read` (komercijala bira ŠTA PRODAJE), a upis je zaseban, uži ključ.
 *
 * ── DVE BRANE KOJE EKRAN NE SME DA ZAOBIĐE ───────────────────────────────────
 *  1. PORESKI TRETMAN je izbor sa liste, ne slobodan tekst. Vrednost van
 *     `TAX_TREATMENTS` se odbija ovde, u DTO-u i u DB CHECK-u
 *     (`chk_service_revenue_types_vat_treatment`) — tri sloja, jer je posledica
 *     greške u kucanju („REVERSE-CHARGE") tiho pogrešan porez.
 *  2. KONTO PRIHODA mora da postoji u `accounts`. Kolona je meki ref (namerno — kontni
 *     plan sme da se pregrupiše), pa je strani ključ ne čuva; bez ove provere bi konto
 *     sa greškom u kucanju („6104" umesto „6140") prošao, a otkrio bi se tek kad
 *     knjiženje padne — na proknjiženju fakture, dakle kod komercijale, a ne kod onoga
 *     ko je grešku napravio.
 */
@Injectable()
export class ServiceRevenueTypeService {
  private readonly logger = new Logger(ServiceRevenueTypeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vrste za padajuću listu na uslužnom računu.
   *
   * ⚠️ SAMO AKTIVNE, i to namerno: ugašena vrsta se ne sme ponuditi jer je knjigovođa
   * povukao njeno konto iz upotrebe (`SalesService.assertServiceRevenueTypeAllowed` je
   * i odbija). Račun koji je ugašenu vrstu već poneo je i dalje čita preko relacije, pa
   * mu papir i knjiženje ostaju tačni — gašenje deluje unapred, ne unazad.
   *
   * Redosled je `sortOrder` pa `code`: knjigovođa određuje šta je na vrhu liste
   * (podrazumevano `USL`, izmereno 45 od 57 stavki), a `code` je samo stabilna rezerva
   * da se dve vrste sa istim `sortOrder` ne premeštaju od poziva do poziva.
   */
  async listActive() {
    return this.prisma.serviceRevenueType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        revenueAccountCode: true,
        vatTreatment: true,
        paperNote: true,
        sortOrder: true,
      },
    });
  }

  /**
   * SVE vrste — i ugašene — za ekran u Podešavanjima.
   *
   * Ugašene se moraju videti: gašenje je jedini način da vrsta izađe iz upotrebe (red se
   * ne briše, strani ključ to i ne da), pa bi ekran bez njih tvrdio da vrsta ne postoji,
   * a pokušaj da se doda ponovo bi pao na jedinstvenoj šifri — greška bez objašnjenja.
   *
   * Uz svaku vrstu ide i naziv konta iz `accounts` (ako konto postoji) i broj računa koji
   * je već koriste: to je jedina informacija koja knjigovođi kaže koliko je izmena skupa.
   */
  async listAll() {
    const [rows, accounts, usage] = await Promise.all([
      this.prisma.serviceRevenueType.findMany({
        orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
        select: {
          id: true,
          code: true,
          name: true,
          revenueAccountCode: true,
          vatTreatment: true,
          paperNote: true,
          isActive: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.account.findMany({ select: { code: true, name: true } }),
      this.prisma.invoice.groupBy({
        by: ["serviceRevenueTypeId"],
        where: { serviceRevenueTypeId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const accountName = new Map(accounts.map((a) => [a.code, a.name]));
    const usedBy = new Map(
      usage.map((u) => [u.serviceRevenueTypeId, u._count._all]),
    );

    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      /** `null` = konto ne postoji u kontnom planu (zatečen red, unet SQL-om). */
      revenueAccountName: accountName.get(r.revenueAccountCode) ?? null,
      /** Koliko dokumenata već nosi ovu vrstu — cena izmene konta/tretmana. */
      usedByInvoices: usedBy.get(r.id) ?? 0,
    }));
  }

  /** Dozvoljeni poreski tretmani — ekran ih nudi kao listu, ne kao polje za kucanje. */
  taxTreatments(): string[] {
    return [...TAX_TREATMENTS];
  }

  /**
   * Nova vrsta usluge. `code` je jedinstven — duplikat je 409, ne tiha izmena
   * zatečenog reda (upsert bi ovde prepisao tuđe konto bez ijednog traga).
   */
  async create(actor: Actor, dto: WriteServiceRevenueTypeInput) {
    const data = await this.validate(dto, { requireAll: true });

    const created = await this.prisma
      .$transaction(async (tx) => {
        const row = await tx.serviceRevenueType.create({
          data: {
            code: data.code!,
            name: data.name!,
            revenueAccountCode: data.revenueAccountCode!,
            vatTreatment: data.vatTreatment!,
            paperNote: data.paperNote ?? null,
            isActive: data.isActive ?? true,
            sortOrder: data.sortOrder ?? 0,
          },
        });
        await writeAudit(tx, actor, "CREATE", row.id, null, row);
        return row;
      })
      .catch((e: unknown) => {
        throw translateUniqueViolation(e, data.code ?? "");
      });

    this.logger.log(
      `Nova vrsta usluge „${created.code}" → konto ${created.revenueAccountCode}, ` +
        `tretman ${created.vatTreatment} (${actor.email ?? "nepoznat korisnik"}).`,
    );
    return created;
  }

  /**
   * Izmena zatečene vrste. Polje koje nije poslato se NE dira.
   *
   * ⚠️ `code` se NE menja, i to je svesno: šifra je ono što kod poznaje po imenu
   * (`DEFAULT_SERVICE_REVENUE_TYPE_CODE = "USL"` bira podrazumevanu stavku pri unosu),
   * a i knjigovođa je koristi kao stabilnu oznaku u svojim beleškama. Preimenovanje bi
   * tiho oborilo predlog podrazumevane vrste — ekran bi radio, a komercijala bi počela
   * da bira ručno i grešila. Pogrešno unetu šifru zameniti novom vrstom + gašenjem stare.
   */
  async update(actor: Actor, id: number, dto: WriteServiceRevenueTypeInput) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new UnprocessableEntityException(
        "Neispravan identifikator vrste usluge.",
      );
    }

    const before = await this.prisma.serviceRevenueType.findUnique({
      where: { id },
    });
    if (!before) {
      throw new NotFoundException(
        `Vrsta usluge ${id} ne postoji u šifarniku vrsta usluge.`,
      );
    }

    if (dto.code !== undefined && normaliseCode(dto.code) !== before.code) {
      throw new UnprocessableEntityException(
        `Šifra vrste usluge se ne menja („${before.code}" → „${normaliseCode(dto.code)}"). ` +
          `Šifru poznaje i sam program (podrazumevana vrsta pri unosu je „USL"), pa bi je ` +
          `preimenovanje tiho oborilo. Ako je šifra pogrešna: napravite novu vrstu sa tačnom ` +
          `šifrom i ugasite ovu — zatečeni računi ostaju vezani za staru i njihov papir se ne menja.`,
      );
    }

    const data = await this.validate(dto, { requireAll: false });
    // `code` je jedino polje koje sme da stigne a da ne pravi izmenu (poslato je isto).
    delete data.code;
    if (Object.keys(data).length === 0) {
      throw new UnprocessableEntityException("Nijedno polje nije prosleđeno.");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.serviceRevenueType.update({
        where: { id },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.revenueAccountCode !== undefined
            ? { revenueAccountCode: data.revenueAccountCode }
            : {}),
          ...(data.vatTreatment !== undefined
            ? { vatTreatment: data.vatTreatment }
            : {}),
          ...(data.paperNote !== undefined
            ? { paperNote: data.paperNote }
            : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          ...(data.sortOrder !== undefined
            ? { sortOrder: data.sortOrder }
            : {}),
        },
      });
      await writeAudit(tx, actor, "UPDATE", id, before, row);
      return row;
    });

    this.logger.log(
      `Izmenjena vrsta usluge „${updated.code}" (${Object.keys(data).join(", ")}) ` +
        `— ${actor.email ?? "nepoznat korisnik"}.`,
    );
    return updated;
  }

  /** Trag izmene šifarnika (ko, kad, sa čega na šta) — za prikaz ispod tabele. */
  async trail(limit = 50) {
    const rows = await this.prisma.auditLog.findMany({
      where: { entityType: SERVICE_REVENUE_TYPE_AUDIT_ENTITY },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        actorUserId: true,
        actorUsername: true,
        action: true,
        entityId: true,
        beforeData: true,
        afterData: true,
        metadata: true,
        createdAt: true,
      },
    });
    return rows.map((r) => {
      const meta = asRecord(r.metadata);
      return {
        at: r.createdAt.toISOString(),
        action: r.action,
        byEmail: r.actorUsername,
        byUserId: r.actorUserId,
        id: r.entityId,
        code: typeof meta?.code === "string" ? meta.code : null,
        /** Samo polja koja su se STVARNO promenila — trag mora da se čita u jednom pogledu. */
        changes: meta?.changes ?? null,
        before: r.beforeData,
        after: r.afterData,
      };
    });
  }

  /**
   * Provera i normalizacija ulaza. `requireAll` = kreiranje (sva obavezna polja moraju
   * biti tu); inače izmena (samo poslata polja).
   */
  private async validate(
    dto: WriteServiceRevenueTypeInput,
    opts: { requireAll: boolean },
  ): Promise<Partial<NormalisedInput>> {
    const out: Partial<NormalisedInput> = {};

    if (opts.requireAll || dto.code !== undefined) {
      const code = normaliseCode(dto.code);
      if (!code) {
        throw new UnprocessableEntityException(
          "Šifra vrste usluge je obavezna.",
        );
      }
      if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(code)) {
        throw new UnprocessableEntityException(
          `Šifra „${code}" nije ispravna: dozvoljena su velika slova, cifre i crtica, ` +
            `najviše 20 znakova, i ne sme počinjati crticom (npr. USL, USL-INO, OTPAD).`,
        );
      }
      out.code = code;
    }

    if (opts.requireAll || dto.name !== undefined) {
      const name = (dto.name ?? "").trim();
      if (!name) {
        throw new UnprocessableEntityException(
          "Naziv vrste usluge je obavezan — to je tekst koji komercijala vidi na listi.",
        );
      }
      if (name.length > 100) {
        throw new UnprocessableEntityException(
          `Naziv sme imati najviše 100 znakova (uneto ${name.length}).`,
        );
      }
      out.name = name;
    }

    if (opts.requireAll || dto.revenueAccountCode !== undefined) {
      const code = (dto.revenueAccountCode ?? "").trim();
      if (!code) {
        throw new UnprocessableEntityException("Konto prihoda je obavezan.");
      }
      if (code.length > 10) {
        throw new UnprocessableEntityException(
          `Konto prihoda sme imati najviše 10 znakova (uneto ${code.length}).`,
        );
      }
      // 🔴 BRANA: konto mora POSTOJATI. Meki ref znači da baza ovo ne čuva.
      const account = await this.prisma.account.findUnique({
        where: { code },
        select: { code: true, name: true },
      });
      if (!account) {
        throw new UnprocessableEntityException(
          `Konto „${code}" ne postoji u kontnom planu, pa se ne sme upisati kao konto prihoda. ` +
            `Proverite šifru (potvrđena konta su 6140 domaća usluga, 6151 usluga stranom kupcu, ` +
            `6796 prodaja otpada, 6501 zakup) ili ga prvo otvorite u kontnom planu. ` +
            `Da je upisan nepostojeći konto, greška bi izašla tek pri knjiženju fakture — kod ` +
            `komercijale, a ne ovde.`,
        );
      }
      out.revenueAccountCode = account.code;
    }

    if (opts.requireAll || dto.vatTreatment !== undefined) {
      const raw = (dto.vatTreatment ?? "").trim().toUpperCase();
      // 🔴 BRANA: tretman je izbor sa liste. Ista provera kao `taxTreatmentOfValue`, ali
      // sa 422 umesto golog `Error` — ovo je korisnički unos, ne greška u podacima.
      if (!TAX_TREATMENTS.has(raw)) {
        throw new UnprocessableEntityException(
          `Poreski tretman „${dto.vatTreatment}" nije dozvoljen. Bira se sa liste: ` +
            `TAXED (mi obračunavamo PDV), REVERSE_CHARGE (obračunava KUPAC — poreski dužnik ` +
            `je primalac, čl. 10 st. 2 t. 1), OUTSIDE_SCOPE (niko — mesto prometa je van ` +
            `Republike Srbije, čl. 12 st. 3).`,
        );
      }
      out.vatTreatment = raw;
    }

    if (dto.paperNote !== undefined) {
      // Prazan tekst se svodi na `null`: papir tada pada na rezervni tekst iz
      // `vat-exemption.ts`, a ne štampa prazan red na poreskom dokumentu.
      out.paperNote =
        dto.paperNote == null ? null : String(dto.paperNote).trim() || null;
    }

    if (dto.isActive !== undefined) {
      if (typeof dto.isActive !== "boolean") {
        throw new UnprocessableEntityException(
          `Polje „aktivno" mora biti da/ne.`,
        );
      }
      out.isActive = dto.isActive;
    }

    if (dto.sortOrder !== undefined) {
      if (!Number.isInteger(dto.sortOrder)) {
        throw new UnprocessableEntityException("Redosled mora biti ceo broj.");
      }
      out.sortOrder = dto.sortOrder;
    }

    return out;
  }
}

// -------------------------------------------------------------------- pomoćno

/** `audit_log.entity_type` za izmene šifarnika — po njemu se čita trag na ekranu. */
export const SERVICE_REVENUE_TYPE_AUDIT_ENTITY = "service_revenue_types";

interface Actor {
  userId?: number | null;
  email?: string | null;
}

/** Ono što ekran šalje; sva polja opciona (izmena dira samo poslata). */
export interface WriteServiceRevenueTypeInput {
  code?: string;
  name?: string;
  revenueAccountCode?: string;
  vatTreatment?: string;
  paperNote?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

interface NormalisedInput {
  code: string;
  name: string;
  revenueAccountCode: string;
  vatTreatment: string;
  paperNote: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** Šifra je uvek velikim slovima — „usl" i „USL" ne smeju biti dve vrste. */
function normaliseCode(code?: string): string {
  return (code ?? "").trim().toUpperCase();
}

/** Polja koja ulaze u trag (bez `createdAt`/`updatedAt` — oni nisu odluka knjigovođe). */
const AUDITED_FIELDS = [
  "code",
  "name",
  "revenueAccountCode",
  "vatTreatment",
  "paperNote",
  "isActive",
  "sortOrder",
] as const;

type AuditedRow = Record<string, unknown>;

/**
 * Trag izmene U ISTOJ TRANSAKCIJI sa izmenom.
 *
 * ZAŠTO NE globalni `AuditInterceptor`: on je fire-and-forget (pad upisa se samo loguje),
 * upisuje SAMO telo zahteva i ne zna prethodnu vrednost — pa na „sa čega na šta" odgovara
 * pola. Ovde se pamte obe strane i, odvojeno, spisak polja koja su se stvarno promenila.
 */
async function writeAudit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: "CREATE" | "UPDATE",
  id: number,
  before: AuditedRow | null,
  after: AuditedRow,
): Promise<void> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of AUDITED_FIELDS) {
    const from = before ? before[f] : null;
    const to = after[f];
    if (before && from === to) continue;
    changes[f] = { from: from ?? null, to: to ?? null };
  }

  await tx.auditLog.create({
    data: {
      actorUserId: actor.userId ?? null,
      actorUsername: actor.email ?? null,
      action,
      entityType: SERVICE_REVENUE_TYPE_AUDIT_ENTITY,
      entityId: String(id),
      // `as Prisma.InputJsonValue`: Prisma tipizuje JSON kolone vrlo usko, a ovde su
      // vrednosti izvedene iz reda šifarnika (string/broj/bool/null) — sve validan JSON.
      beforeData: before
        ? (pick(before) as Prisma.InputJsonValue)
        : Prisma.DbNull,
      afterData: pick(after) as Prisma.InputJsonValue,
      metadata: {
        // `after` je red iz baze, pa je `code` uvek string; provera tipa je tu da audit
        // NIKAD ne padne na oblik podatka — trag ne sme da obori samu izmenu.
        code: typeof after.code === "string" ? after.code : "",
        changes,
      } as Prisma.InputJsonValue,
    },
  });
}

function pick(row: AuditedRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of AUDITED_FIELDS) out[f] = row[f] ?? null;
  return out;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * P2002 (jedinstvena šifra) → 409 sa objašnjenjem umesto sirove Prisma poruke.
 * Ugašena vrsta i dalje zauzima šifru (red se ne briše), pa je najčešći uzrok baš to —
 * i poruka mora da kaže gde da se pogleda, inače korisnik proba još tri puta.
 */
function translateUniqueViolation(e: unknown, code: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return new ConflictException(
      `Vrsta usluge sa šifrom „${code}" već postoji. Ako je ne vidite na listi, verovatno je ` +
        `UGAŠENA — ugašen red i dalje zauzima šifru (ne briše se, jer su za njega vezani ` +
        `zatečeni računi). Uključite prikaz ugašenih i vratite je u upotrebu umesto da pravite novu.`,
    );
  }
  return e;
}
