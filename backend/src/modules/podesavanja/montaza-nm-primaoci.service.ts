import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Podešavanja → Notifikacije: UREDIVA lista primalaca obaveštenja o neusaglašenosti
 * na montaži (zahtev 034/26 — „Nenad Jaraković može da koriguje, ako misli da treba").
 *
 * Izvor = app-owned tabela `montaza_nm_primaoci` (glavna baza); čitaju je
 * `MontazaNmMailService` (mejl) i `MontazaNeusaglasenostiService` (zvonce) pri
 * SVAKOM slanju, pa izmena ovde važi od sledeće prijave — bez keša, bez deploy-a.
 *
 * Semantika po doktrini tabele (obrazac `masina_otpis_primaoci`):
 *   • „ukloni" = `active = FALSE` (soft) — istorija ostaje, red se ne briše;
 *   • ponovno dodavanje istog mejla REAKTIVIRA ugašeni red (ne pravi duplikat —
 *     unique po mejlu); aktivan duplikat → 409;
 *   • mejl se normalizuje (trim + lower) — DB CHECK isto zahteva, pa bi sirov
 *     unos sa velikim slovom pao na constraint-u umesto da lepo javi grešku.
 *
 * Guard je na kontroleru (`settings.system` = samo admin); ovde nema dodatnih
 * provera identiteta — actor se beleži u `created_by_user_id` radi traga.
 */
@Injectable()
export class MontazaNmPrimaociService {
  private readonly logger = new Logger(MontazaNmPrimaociService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Aktivni primaoci za ekran (redosled unosa). */
  async list() {
    const rows = await this.prisma.montazaNmPrimalac.findMany({
      where: { active: true },
      orderBy: { id: "asc" },
      select: {
        email: true,
        fullName: true,
        note: true,
        createdAt: true,
      },
    });
    return { data: rows };
  }

  /**
   * Dodaj primaoca (ili reaktiviraj ugašenog). Aktivan duplikat → 409.
   * `fullName`/`note` na reaktivaciji pregazuju stare vrednosti samo ako su prosleđeni.
   */
  async add(
    actorUserId: number,
    emailRaw: string,
    fullName?: string,
    note?: string,
  ) {
    const email = emailRaw.trim().toLowerCase();
    const cleanName = fullName?.trim() || null;
    const cleanNote = note?.trim() || null;

    const existing = await this.prisma.montazaNmPrimalac.findUnique({
      where: { email },
    });
    if (existing?.active) {
      throw new ConflictException(`Primalac ${email} je već na listi.`);
    }

    const row = existing
      ? await this.prisma.montazaNmPrimalac.update({
          where: { email },
          data: {
            active: true,
            updatedAt: new Date(), // model nema @updatedAt — ručno (obrazac tabele)
            ...(cleanName ? { fullName: cleanName } : {}),
            ...(cleanNote ? { note: cleanNote } : {}),
          },
        })
      : await this.prisma.montazaNmPrimalac.create({
          data: {
            email,
            fullName: cleanName,
            note: cleanNote,
            createdByUserId: actorUserId,
          },
        });

    this.logger.log(
      `Primalac neusaglašenosti ${email} ${existing ? "reaktiviran" : "dodat"} (user #${actorUserId}).`,
    );
    return {
      data: {
        email: row.email,
        fullName: row.fullName,
        note: row.note,
        createdAt: row.createdAt,
      },
    };
  }

  /** Ugasi primaoca (soft — `active = FALSE`). Nepostojeći/već ugašen → 404. */
  async remove(actorUserId: number, emailRaw: string) {
    const email = emailRaw.trim().toLowerCase();
    const res = await this.prisma.montazaNmPrimalac.updateMany({
      where: { email, active: true },
      data: { active: false, updatedAt: new Date() },
    });
    if (res.count === 0) {
      throw new NotFoundException(`Primalac ${email} nije na listi.`);
    }
    this.logger.log(
      `Primalac neusaglašenosti ${email} uklonjen (user #${actorUserId}).`,
    );
    return { data: { email, removed: true } };
  }
}
