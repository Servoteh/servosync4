import {
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Diktafon „sanduče" (scenario B — telefon diktira, Claude povlači).
 *
 * Telefon u pogonu diktira srpski (STT + doterivanje kroz `MediaAiService`), a
 * SREĐEN TEKST se ovde odlaže (`create`). Claude Code na Windows radnoj stanici ga
 * POVLAČI READ-ONLY preko infra pristupa (SSH → `docker exec … psql`) i markira
 * `delivered_at` — NE preko ovog servisa/HTTP-a/JWT-a. `latest()` je za samu
 * aplikaciju (eventualni prikaz „šta je poslednje poslato, još nepreuzeto").
 *
 * IDOR: obe metode su UVEK skopirane na `userId` iz JWT-a — korisnik upisuje i vidi
 * ISKLJUČIVO svoje redove; nema rute koja prima tuđi `user_id`. V1 nema edit/delete
 * (svesna odluka zadatka). Čuva se samo tekst — audio se odbacuje nakon transkripcije.
 */
@Injectable()
export class DictationInboxService {
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
}
