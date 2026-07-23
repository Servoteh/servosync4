import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type ScoreDto,
  validateScore,
  type ExcludeDto,
  validateExclude,
} from "./dto/score.dto";
import {
  type TariffPutDto,
  validateTariffPut,
  TARIFF_SCORES,
} from "./dto/tariff.dto";

/** "YYYY-MM" iz Date (lokalno vreme servera; obračun je poslovno-mesečni). */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Nagrađivanje predloga (MODULE_SPEC §12) — poseban servis u modulu.
 * Ocena/potvrda (score), isključivanje (exclude), tarifa (CRUD, nov red po važenju),
 * mesečni obračun i zaključivanje. DOKTRINA §10.1: novac nastaje SAMO admin potvrdom;
 * AI ga nikad ne dodeljuje. Zaključen mesec je immutable — nova potvrda ide u naredni.
 */
@Injectable()
export class ZahteviRewardsService {
  private readonly logger = new Logger(ZahteviRewardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private assertAdmin(actor: AuthUser): void {
    if (!roleHasPermission(actor.role, PERMISSIONS.ZAHTEVI_ADMIN))
      throw new ForbiddenException("Nagrade uređuje administrator.");
  }

  private async writeEvent(
    tx: Prisma.TransactionClient,
    requestId: number,
    type: string,
    actorUserId: number | null,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.changeRequestEvent.create({
      data: {
        requestId,
        type,
        actorUserId,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  // ── OCENA / POTVRDA (§12.2) ─────────────────────────────────────────────────

  /**
   * Da li je dati mesec zaključen: postoji BAR jedan PAID red sa tim rewardMonth
   * (deterministička provera — zaključivanje meseca prevodi CONFIRMED→PAID).
   *
   * ⚠️ UPOZORENJE (V1): zaključenje je OVDE DERIVED iz postojanja PAID reda — nema
   * eksplicitne month-closure tabele. Buduća payroll ruta (kad novac zaista izlazi)
   * MORA uvesti eksplicitno zaključavanje meseca (npr. red u posebnoj tabeli + lock),
   * jer se na derived signal ne može osloniti kad zaključenje postane pravni događaj.
   */
  private async isMonthClosed(month: string): Promise<boolean> {
    const paid = await this.prisma.changeRequest.count({
      where: { rewardMonth: month, rewardStatus: "PAID" },
    });
    return paid > 0;
  }

  /**
   * Prvi neзаključen mesec počev od `start` (traži napred dok ne nađe otvoren).
   *
   * NAPOMENA: rezultujući rewardMonth + rewardAmount su SNAPSHOT iz trenutka potvrde ocene
   * (namerno — v. currentAmountFor). Ako se tarifa promeni kasnije ili potvrda „preskoči"
   * preko granice godine, iznos i mesec ostaju onakvi kakvi su bili u trenutku potvrde;
   * granica-godina tarife se NE reevaluira. To je svesna V1 odluka (isplata = ono što je
   * potvrđeno), ne bug.
   */
  private async nextOpenMonth(start: string): Promise<string> {
    let [y, m] = start.split("-").map(Number);
    // Zaštita od beskonačne petlje (praktično nikad — max nekoliko iteracija).
    for (let i = 0; i < 60; i++) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      if (!(await this.isMonthClosed(key))) return key;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return start; // fallback (neće se desiti)
  }

  /** Iznos iz VAŽEĆE tarife za datu ocenu (najnoviji red po score sa validFrom<=danas). */
  private async currentAmountFor(
    score: number,
    on: Date,
  ): Promise<Prisma.Decimal | null> {
    if (score < 1) return null;
    const row = await this.prisma.changeRequestRewardTariff.findFirst({
      where: { score, validFrom: { lte: on } },
      orderBy: { validFrom: "desc" },
    });
    return row ? row.amount : null;
  }

  /**
   * POST /zahtevi/:id/score — admin potvrdi/koriguj ocenu (0–5).
   *  - score 0 → status REJECTED (ako prelaz dozvoljen) + rewardStatus=NONE, event SCORE_CONFIRMED.
   *  - score ≥1 → finalScore + snapshot iznosa iz važeće tarife → rewardAmount,
   *    rewardStatus=CONFIRMED, rewardMonth = tekući (ili prvi otvoreni ako je tekući zaključen).
   * Ponovljena potvrda pre zaključenja: korekcija (novi snapshot + event). Radi bez AI ocene.
   */
  async score(id: number, dto: ScoreDto, actor: AuthUser) {
    this.assertAdmin(actor);
    validateScore(dto);
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);

    // Zaključen mesec je immutable — potvrda posle zaključenja ide u naredni otvoreni.
    if (req.rewardStatus === "PAID")
      throw new UnprocessableEntityException(
        "Nagrada je već isplaćena (mesec zaključen) — ne može se menjati.",
      );
    // F4: IZMENA postojeće nagrade koja PRIPADA zaključenom mesecu je zabranjena (422).
    // Nova potvrda (rewardMonth još null) NIJE pogođena — ta i dalje ide u tekući/naredni
    // otvoreni mesec kroz nextOpenMonth. Ovim se štiti već zaključen/prijavljen obračun od
    // naknadne korekcije ocene (koja bi promenila njegov ukupan iznos).
    if (req.rewardMonth && (await this.isMonthClosed(req.rewardMonth)))
      throw new UnprocessableEntityException(
        `Nagrada pripada zaključenom mesecu (${req.rewardMonth}) — ocena se više ne menja.`,
      );

    const now = new Date();

    if (dto.score === 0) {
      // Ocena 0: bez novca. REJECTED ako je status u fazi odlučivanja (SUBMITTED/ANALYZED),
      // inače status ostaje (npr. već DONE) — samo se skida nagrada.
      const canReject = ["SUBMITTED", "ANALYZED"].includes(req.status);
      const updated = await this.prisma.$transaction(async (tx) => {
        const data: Prisma.ChangeRequestUpdateInput = {
          finalScore: 0,
          rewardAmount: null,
          rewardStatus: "NONE",
          rewardMonth: null,
        };
        if (canReject) {
          data.status = "REJECTED";
          data.decidedAt = now;
          data.decidedByUserId = actor.userId;
        }
        const u = await tx.changeRequest.update({ where: { id }, data });
        await this.writeEvent(tx, id, "SCORE_CONFIRMED", actor.userId, {
          score: 0,
        });
        if (canReject)
          await this.writeEvent(tx, id, "REJECTED", actor.userId, {
            from: req.status,
            to: "REJECTED",
            reason: "ocena 0",
          });
        return u;
      });
      return { data: updated };
    }

    // score ≥ 1: snapshot iznosa iz važeće tarife + CONFIRMED.
    const amount = await this.currentAmountFor(dto.score, now);
    if (amount === null)
      throw new UnprocessableEntityException(
        `Nema važeće tarife za ocenu ${dto.score}. Podesite tarifu u tabu Nagrade.`,
      );

    // Mesec obračuna: postojeći rewardMonth se čuva pri korekciji (ista isplata).
    // Nakon F4 guard-a iznad, `req.rewardMonth` ovde više NIKAD nije zaključen (taj slučaj
    // je već 422). isMonthClosed provera ostaje samo za NOVU potvrdu (rewardMonth null →
    // tekući mesec), gde nextOpenMonth pronalazi prvi otvoren ako je tekući zaključen.
    let month = req.rewardMonth;
    if (!month || (await this.isMonthClosed(month))) {
      month = await this.nextOpenMonth(monthKey(now));
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.changeRequest.update({
        where: { id },
        data: {
          finalScore: dto.score,
          rewardAmount: amount,
          rewardStatus: "CONFIRMED",
          rewardMonth: month,
        },
      });
      await this.writeEvent(tx, id, "SCORE_CONFIRMED", actor.userId, {
        score: dto.score,
        amount: amount.toString(),
        month,
      });
      return u;
    });
    return { data: updated };
  }

  /**
   * POST /zahtevi/:id/exclude — admin isključi predlog iz nagrađivanja (§12.3).
   * rewardStatus=EXCLUDED (+ razlog u event). Ne dira status zahteva. Zaključen (PAID) ne može.
   */
  async exclude(id: number, dto: ExcludeDto, actor: AuthUser) {
    this.assertAdmin(actor);
    validateExclude(dto);
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    if (req.rewardStatus === "PAID")
      throw new UnprocessableEntityException(
        "Isplaćena nagrada se ne može isključiti (mesec zaključen).",
      );
    // F4: isključivanje bi izvuklo nagradu iz meseca i promenilo njegov ukupan iznos —
    // za već zaključen mesec je zabranjeno (422), i kad status nije PAID (npr. zaostali CONFIRMED).
    if (req.rewardMonth && (await this.isMonthClosed(req.rewardMonth)))
      throw new UnprocessableEntityException(
        `Nagrada pripada zaključenom mesecu (${req.rewardMonth}) — ne može se isključiti.`,
      );

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.changeRequest.update({
        where: { id },
        data: {
          rewardStatus: "EXCLUDED",
          rewardAmount: null,
          rewardMonth: null,
        },
      });
      await this.writeEvent(tx, id, "REWARD_EXCLUDED", actor.userId, {
        reason: dto.reason ?? undefined,
      });
      return u;
    });
    return { data: updated };
  }

  // ── TARIFA (§12.2) ──────────────────────────────────────────────────────────

  /** GET /zahtevi/nagrade/tarife — aktuelna (važeća po oceni danas) + puna istorija. */
  async getTariffs(actor: AuthUser) {
    this.assertAdmin(actor);
    const now = new Date();
    const all = await this.prisma.changeRequestRewardTariff.findMany({
      orderBy: [{ score: "asc" }, { validFrom: "desc" }],
    });
    const current: { score: number; amount: string; validFrom: string }[] = [];
    for (const score of TARIFF_SCORES) {
      const row = all.find((r) => r.score === score && r.validFrom <= now);
      current.push({
        score,
        amount: row ? row.amount.toString() : "0",
        validFrom: row ? row.validFrom.toISOString().slice(0, 10) : "",
      });
    }
    const history = all.map((r) => ({
      id: r.id,
      score: r.score,
      amount: r.amount.toString(),
      currency: r.currency,
      validFrom: r.validFrom.toISOString().slice(0, 10),
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt.toISOString(),
    }));
    return { data: { current, history } };
  }

  /**
   * PUT /zahtevi/nagrade/tarife — izmena tarife = NOVI redovi (score 1–5) sa validFrom=danas.
   * Stari redovi se NE menjaju (istorija/snapshoti ostaju). Idempotentno za isti dan
   * (upsert nad uq score+valid_from → update iznosa ako je već upisan danas).
   */
  async putTariffs(dto: TariffPutDto, actor: AuthUser) {
    this.assertAdmin(actor);
    validateTariffPut(dto);
    // validFrom = danas (bez vremena — @db.Date). Normalizuj na ponoć UTC.
    const today = new Date();
    const validFrom = new Date(
      Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()),
    );

    const rows = await this.prisma.$transaction(async (tx) => {
      const out = [];
      for (const score of TARIFF_SCORES) {
        const amount = new Prisma.Decimal(dto.amounts[String(score)]);
        const existing = await tx.changeRequestRewardTariff.findFirst({
          where: { score, validFrom },
        });
        const row = existing
          ? await tx.changeRequestRewardTariff.update({
              where: { id: existing.id },
              data: { amount, createdByUserId: actor.userId },
            })
          : await tx.changeRequestRewardTariff.create({
              data: {
                score,
                amount,
                currency: "RSD",
                validFrom,
                createdByUserId: actor.userId,
              },
            });
        out.push(row);
      }
      return out;
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        score: r.score,
        amount: r.amount.toString(),
        validFrom: r.validFrom.toISOString().slice(0, 10),
      })),
    };
  }

  // ── MESEČNI OBRAČUN (§12.2) ─────────────────────────────────────────────────

  /**
   * GET /zahtevi/nagrade/obracun?month=YYYY-MM — po korisniku: broj predloga po ocenama,
   * suma, stavke (reqNo/naslov/ocena/iznos/status). Obuhvata CONFIRMED i PAID za taj mesec.
   */
  async payoutReport(month: string, actor: AuthUser) {
    this.assertAdmin(actor);
    if (!MONTH_RE.test(month))
      throw new UnprocessableEntityException(
        "Mesec mora biti oblika YYYY-MM (npr. 2026-08).",
      );

    const requests = await this.prisma.changeRequest.findMany({
      where: {
        rewardMonth: month,
        rewardStatus: { in: ["CONFIRMED", "PAID"] },
      },
      select: {
        id: true,
        reqNo: true,
        title: true,
        finalScore: true,
        rewardAmount: true,
        rewardStatus: true,
        createdByUserId: true,
      },
      orderBy: [{ createdByUserId: "asc" }, { reqNo: "asc" }],
    });

    const closed = await this.isMonthClosed(month);

    // Ime iz users (meki ref) — jedan upit za sve pogođene korisnike.
    const userIds = Array.from(new Set(requests.map((r) => r.createdByUserId)));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, fullName: true, email: true },
        })
      : [];
    const nameById = new Map(
      users.map((u) => [u.id, u.fullName || u.email || `#${u.id}`]),
    );

    type Item = {
      id: number;
      reqNo: string;
      title: string;
      score: number | null;
      amount: string | null;
      rewardStatus: string;
    };
    type UserRow = {
      userId: number;
      userName: string;
      countByScore: Record<string, number>;
      count: number;
      total: string;
      items: Item[];
    };
    const byUser = new Map<number, UserRow>();

    let grandTotal = new Prisma.Decimal(0);
    for (const r of requests) {
      let row = byUser.get(r.createdByUserId);
      if (!row) {
        row = {
          userId: r.createdByUserId,
          userName: nameById.get(r.createdByUserId) ?? `#${r.createdByUserId}`,
          countByScore: {},
          count: 0,
          total: "0",
          items: [],
        };
        byUser.set(r.createdByUserId, row);
      }
      const scoreKey = String(r.finalScore ?? "?");
      row.countByScore[scoreKey] = (row.countByScore[scoreKey] ?? 0) + 1;
      row.count += 1;
      const amt = r.rewardAmount ?? new Prisma.Decimal(0);
      row.total = new Prisma.Decimal(row.total).plus(amt).toString();
      grandTotal = grandTotal.plus(amt);
      row.items.push({
        id: r.id,
        reqNo: r.reqNo,
        title: r.title,
        score: r.finalScore,
        amount: r.rewardAmount ? r.rewardAmount.toString() : null,
        rewardStatus: r.rewardStatus,
      });
    }

    const users_ = Array.from(byUser.values()).sort((a, b) =>
      a.userName.localeCompare(b.userName, "sr"),
    );

    return {
      data: {
        month,
        closed,
        total: grandTotal.toString(),
        userCount: users_.length,
        itemCount: requests.length,
        users: users_,
      },
    };
  }

  /**
   * POST /zahtevi/nagrade/obracun/:month/zakljuci — zaključi mesec: sve CONFIRMED tog
   * meseca → PAID (jedan audit event po zahtevu). Immutable: već zaključen (postoji PAID)
   * ili prazan (nema CONFIRMED) → 422. Determinizam: PAID red = signal zaključenja.
   */
  async closeMonth(month: string, actor: AuthUser) {
    this.assertAdmin(actor);
    if (!MONTH_RE.test(month))
      throw new UnprocessableEntityException(
        "Mesec mora biti oblika YYYY-MM (npr. 2026-08).",
      );
    if (await this.isMonthClosed(month))
      throw new UnprocessableEntityException(
        `Mesec ${month} je već zaključen.`,
      );

    // F5: CONFIRMED redovi se čitaju UNUTAR transakcije (pre updateMany, ista tx) da bi se
    // total/eventi/paidCount slagali i da paralelni poziv NE bi upisao duple REWARD_PAID.
    // Drugi poziv, koji uđe u tx posle prvog commit-a, vidi 0 CONFIRMED → 422 (nema šta).
    const result = await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.changeRequest.findMany({
        where: { rewardMonth: month, rewardStatus: "CONFIRMED" },
        select: { id: true, rewardAmount: true },
      });
      if (confirmed.length === 0)
        throw new UnprocessableEntityException(
          `Nema potvrđenih nagrada za ${month} — nema šta da se zaključi.`,
        );

      const upd = await tx.changeRequest.updateMany({
        where: { rewardMonth: month, rewardStatus: "CONFIRMED" },
        data: { rewardStatus: "PAID" },
      });
      for (const r of confirmed) {
        await this.writeEvent(tx, r.id, "REWARD_PAID", actor.userId, {
          month,
          amount: r.rewardAmount ? r.rewardAmount.toString() : null,
        });
      }
      const total = confirmed.reduce(
        (sum, r) => sum.plus(r.rewardAmount ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      );
      return { paidCount: upd.count, total: total.toString() };
    });

    return {
      data: { month, paidCount: result.paidCount, total: result.total },
    };
  }

  // ── KORISNIKOV OBRAČUN (§12.2, „Moje nagrade") ──────────────────────────────

  /**
   * GET /zahtevi/nagrade/moje?month=YYYY-MM — suma korisnikovih CONFIRMED/PAID nagrada
   * za mesec (row-scope: SAMO svoje). Bez tuđih iznosa. Tačnije od klijentskog računa
   * (ne zavisi od paginacije liste). Mesec izostavljen → tekući.
   */
  async myRewards(month: string | undefined, actor: AuthUser) {
    const m = month && MONTH_RE.test(month) ? month : monthKey(new Date());
    const rows = await this.prisma.changeRequest.findMany({
      where: {
        createdByUserId: actor.userId,
        rewardMonth: m,
        rewardStatus: { in: ["CONFIRMED", "PAID"] },
      },
      select: {
        id: true,
        reqNo: true,
        title: true,
        finalScore: true,
        rewardAmount: true,
        rewardStatus: true,
      },
      orderBy: { reqNo: "asc" },
    });
    const total = rows.reduce(
      (sum, r) => sum.plus(r.rewardAmount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    );
    return {
      data: {
        month: m,
        total: total.toString(),
        count: rows.length,
        items: rows.map((r) => ({
          id: r.id,
          reqNo: r.reqNo,
          title: r.title,
          score: r.finalScore,
          amount: r.rewardAmount ? r.rewardAmount.toString() : null,
          rewardStatus: r.rewardStatus,
        })),
      },
    };
  }
}
