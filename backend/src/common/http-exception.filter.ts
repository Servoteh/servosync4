import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Globalni exception filter (review Opus 5 — bezbednost).
 *
 * PROBLEM: bez filtera svaka neuhvaćena greška (Prisma, TypeError, raw SQL) ide
 * klijentu sa punom porukom — a Prisma greške sadrže imena tabela/kolona i deo
 * upita (`Raw query failed... ERROR: operator does not exist: integer = jsonb`).
 * To je curenje detalja šeme napadaču i zbunjujuća poruka korisniku.
 *
 * REŠENJE: poslovne greške (HttpException — naše tipizirane 4xx sa srpskim porukama)
 * prolaze NEPROMENJENE; sve ostalo se loguje SA stack trace-om na serveru, a klijent
 * dobija generičku 500 poruku + `traceId` po kojem se u logu nađe stvarni uzrok.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Unhandled");

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Poslovne greške (BadRequest/Conflict/UnprocessableEntity/Forbidden…) su namerne
    // i nose poruku za korisnika — prosleđuju se kakve jesu.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json(exception.getResponse());
      return;
    }

    // Neočekivano: log sa punim detaljima (server), generička poruka (klijent).
    const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const detail = exception instanceof Error ? exception.stack : String(exception);
    this.logger.error(
      `[${traceId}] ${req.method} ${req.url} — ${detail}`,
    );

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        "Neočekivana greška na serveru. Prijavi administratoru šifru greške.",
      traceId,
    });
  }
}
