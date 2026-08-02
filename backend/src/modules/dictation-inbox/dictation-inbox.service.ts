import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CLAIM_THROTTLE_POLICY, recordClaimAttempt } from "./claim-throttle";
import { USER_REF_NOT_FOUND, resolveUserRef } from "./user-ref";

/** Ko poziva `claim` (iz JWT-a) — potreban i za audit trag. */
export interface ClaimActor {
  userId: number;
  email?: string | null;
}

/** Telo `claim`-a: čije sanduče (opciono; bez toga = svoje). */
export interface ClaimTarget {
  ownerUserId?: number | null;
  ownerEmail?: string | null;
}

/** Sirovi red iz atomičnog UPDATE … RETURNING. */
interface ClaimedRow {
  id: number;
  text: string;
  created_at: Date;
}

/**
 * Diktafon „sanduče" (scenario B — telefon diktira, agent povlači).
 *
 * Telefon u pogonu diktira srpski (STT + doterivanje kroz `MediaAiService`), a
 * SREĐEN TEKST se ovde odlaže (`create`). Agent ga onda POVLAČI — dva puta:
 *
 *  1. INFRA (dosadašnji, i dalje važi): Claude Code na radnoj stanici u firmi ide
 *     SSH → `docker exec servosync-pg psql`, ručno `SELECT … user_id = 2 …` pa
 *     `UPDATE … SET delivered_at = now()`. Radi SAMO iz lokalne mreže.
 *  2. HTTP (`claim`, 2026-08-02): agent koji radi VAN lokalne mreže (Cursor/Claude
 *     u oblaku, pokrenut sa telefona) nema ni SSH ni 192.168.64.28. `claim` mu daje
 *     isti posao preko API-ja, pod njegovim tokenom, i to ATOMIČNO.
 *
 * `latest()` je za samu aplikaciju (prikaz „šta je poslednje poslato, još
 * nepreuzeto") — ČITA i ne troši.
 *
 * PRAVILO VLASNIKA (presuda 29.07): sanduče je jedno, ko PRVI povuče — njegov je;
 * nema vraćanja diktata na „neposlato". Zato `claim` mora biti atomičan — dve
 * paralelne sesije ne smeju dobiti isti red (vidi `claim()` niže).
 *
 * IDOR: `create`/`latest` su UVEK skopirani na `userId` iz JWT-a. `claim` je jedini
 * koji sme u TUĐE sanduče, i to isključivo uz eksplicitan red u `dictation_delegates`
 * (default-deny, 403 bez njega). V1 nema edit/delete (svesna odluka zadatka).
 * Čuva se samo tekst — audio se odbacuje nakon transkripcije.
 */
@Injectable()
export class DictationInboxService {
  private readonly logger = new Logger(DictationInboxService.name);
  /** Gornja granica dužine teksta (paritet DTO note; 422 iznad). */
  static readonly MAX_TEXT_LEN = 10_000;
  /**
   * Backpressure: koliko NEPREUZETIH diktata korisnik sme da nagomila. Ako Claude
   * ne povlači (ili neko spamuje), sanduče ne raste beskonačno, a stari duplikati ne
   * postaju mine za sledeći pull. Preko limita → 429 dok se postojeći ne preuzmu.
   */
  static readonly MAX_UNDELIVERED = 50;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upiši jedan diktat za tekućeg korisnika (`userId` iz JWT-a). Prazan ili
   * predugačak tekst → 422 (Unprocessable) sa ljudskom porukom na srpskom.
   */
  async create(userId: number, rawText: string) {
    const text = String(rawText ?? "").trim();
    if (!text) {
      throw new UnprocessableEntityException(
        "Nema teksta za slanje (diktat je prazan).",
      );
    }
    if (text.length > DictationInboxService.MAX_TEXT_LEN) {
      throw new UnprocessableEntityException(
        `Tekst je predugačak (${text.length} znakova; maksimum ${DictationInboxService.MAX_TEXT_LEN}). Pošalji u kraćim delovima.`,
      );
    }

    // Backpressure: ne gomilaj beskonačno ako Claude ne povlači (429, ne 500).
    const undelivered = await this.prisma.dictationInbox.count({
      where: { userId, deliveredAt: null },
    });
    if (undelivered >= DictationInboxService.MAX_UNDELIVERED) {
      throw new HttpException(
        `Previše nepreuzetih diktata (${undelivered}). Sačekaj da Claude povuče postojeće pa pošalji ponovo.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const row = await this.prisma.dictationInbox.create({
      data: { userId, text },
    });
    return { data: { id: row.id, createdAt: row.createdAt } };
  }

  /**
   * Poslednji NEISPORUČEN (`delivered_at IS NULL`) red OVOG korisnika, najnoviji
   * prvi. IDOR-safe: `where` uvek nosi `userId` iz JWT-a. Nema reda → `data: null`.
   */
  async latest(userId: number) {
    const row = await this.prisma.dictationInbox.findFirst({
      where: { userId, deliveredAt: null },
      orderBy: { createdAt: "desc" },
    });
    return { data: row ?? null };
  }

  // ------------------------------------------------------------------- claim

  /**
   * ATOMIČNO uzmi poslednji NEPREUZET diktat i istim upitom ga obeleži preuzetim.
   *
   * Zašto JEDAN upit, a ne `findFirst` pa `update`: između ta dva koraka druga
   * sesija stigne da pročita ISTI red — obe bi dobile isti diktat, a pravilo je
   * „ko prvi povuče — njegov je". `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP
   * LOCKED LIMIT 1) RETURNING …` je jedna izjava = jedna transakcija: `FOR UPDATE`
   * zaključa izabrani red, `SKIP LOCKED` natera paralelnu sesiju da PRESKOČI
   * zaključan red i uzme sledeći (ili ništa), pa dva `claim`-a NIKAD ne vrate isti
   * red. Dodatni `delivered_at IS NULL` u spoljnom WHERE je pojas uz tregere.
   *
   * `ownerUserId`/`ownerEmail` (opciono) = TUĐE sanduče; dozvoljeno samo ako u
   * `dictation_delegates` postoji red (vlasnik, pozivalac) — inače 403.
   *
   * Vraća `{ data: { id, text, createdAt } }` ili `{ data: null }` (prazno sanduče).
   * Tekst se NE loguje niti upisuje u audit — može nositi poslovne podatke.
   */
  async claim(actor: ClaimActor, target: ClaimTarget = {}) {
    // 1) Rate-limit po pozivaocu — `claim` je destruktivan, ne sme u petlju.
    const retryAfter = recordClaimAttempt(actor.userId);
    if (retryAfter > 0) {
      throw new HttpException(
        `Previše poziva (granica ${CLAIM_THROTTLE_POLICY.MAX_CLAIMS} u minutu). Pokušaj ponovo za ${retryAfter} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2) Čije sanduče — svoje (default) ili tuđe uz delegaciju.
    const ownerUserId = await this.resolveOwner(actor, target);
    const delegated = ownerUserId !== actor.userId;

    // 3) Uzmi + markiraj JEDNIM upitom (atomičnost, vidi doc-comment).
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>(
      Prisma.sql`
        UPDATE dictation_inbox
           SET delivered_at = now()
         WHERE id = (
                 SELECT id
                   FROM dictation_inbox
                  WHERE user_id = ${ownerUserId}
                    AND delivered_at IS NULL
                  ORDER BY created_at DESC
                    FOR UPDATE SKIP LOCKED
                  LIMIT 1
               )
           AND delivered_at IS NULL
        RETURNING id, text, created_at`,
    );

    const row = rows[0];
    if (!row) return { data: null };

    // 4) Audit: ko je i ČIJI diktat povukao. Bez teksta — samo dužina.
    await this.auditClaim(actor, ownerUserId, delegated, row);

    return {
      data: {
        id: Number(row.id),
        text: row.text,
        createdAt: row.created_at,
      },
    };
  }

  /**
   * Razreši „čije sanduče" i presudi sme li pozivalac u njega.
   *
   * Bez `ownerUserId`/`ownerEmail` → svoje (dosadašnje ponašanje, ništa se ne menja).
   * Sa njima → mora postojati red u `dictation_delegates` (vlasnik, pozivalac).
   * Nepoznat vlasnik daje ISTI 403 kao „nemaš dozvolu" — ruta ne sme da bude orakl
   * za nabrajanje naloga/e-mailova.
   */
  private async resolveOwner(
    actor: ClaimActor,
    target: ClaimTarget,
  ): Promise<number> {
    const resolved = await resolveUserRef(
      this.prisma,
      { userId: target.ownerUserId, email: target.ownerEmail },
      "owner",
    );
    if (resolved === null) return actor.userId; // ništa prosleđeno = svoje sanduče
    if (resolved === USER_REF_NOT_FOUND) throw this.noDelegation();
    if (resolved === actor.userId) return resolved; // svoje, samo eksplicitno

    const link = await this.prisma.dictationDelegate.findFirst({
      where: { ownerUserId: resolved, delegateUserId: actor.userId },
      select: { id: true },
    });
    if (!link) throw this.noDelegation();
    return resolved;
  }

  private noDelegation(): ForbiddenException {
    return new ForbiddenException(
      "Nemaš dozvolu da povučeš tuđe diktate. Traži od administratora da doda delegaciju (dictation_delegates).",
    );
  }

  /**
   * Audit trag preuzimanja — best-effort (pad audita NE sme da obori claim; diktat
   * je već markiran preuzetim i drugog pokušaja nema).
   *
   * Globalni `AuditInterceptor` već upisuje generički red za POST rutu, ali njemu je
   * `entityId` doslovno „claim" (izvodi ga iz URL-a) i ne zna KOJI je red uzet. Ovaj
   * upis nosi pravu informaciju: id diktata, čije je sanduče i da li je preko
   * delegacije. Tekst se NE upisuje — samo `text_len`.
   */
  private async auditClaim(
    actor: ClaimActor,
    ownerUserId: number,
    delegated: boolean,
    row: ClaimedRow,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorUserId: actor.userId,
          actorUsername: actor.email ?? null,
          action: "CLAIM diktat",
          entityType: "dictation_inbox",
          entityId: String(row.id),
          afterData: {
            owner_user_id: ownerUserId,
            claimed_by_user_id: actor.userId,
            delegated,
            // NIKAD tekst — može nositi poslovne podatke.
            text_len: row.text.length,
            claimed_at: new Date().toISOString(),
          },
        },
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Audit upis za claim diktata #${row.id} nije uspeo: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
