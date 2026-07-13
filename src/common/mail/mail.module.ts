import { Global, Module } from "@nestjs/common";
import { MailService } from "./mail.service";

/**
 * Globalni mailer (Resend). Global jer je presečna infrastruktura kao Prisma —
 * bilo koji modul koji šalje mejl injektuje `MailService` bez ponovnog importa.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
