import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { LaunchNotifyService } from "./launch-notify.service";

/**
 * Zaseban mini-modul za „primopredaja lansirana" obaveštenje (zahtev 016/26 dopuna).
 *
 * Postoji da bi ga uvezao i `WorkOrdersModule` (lansiranje sa ekrana „Radni nalozi")
 * BEZ uvlačenja celog `HandoversModule` — zavisnost ostaje jednosmerna i uska, pa
 * nema rizika od cirkularnog import-a kad handovers jednom zatreba work-orders.
 * `MailService` je globalan (`MailModule` @Global), zato nije u `imports`.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [LaunchNotifyService],
  exports: [LaunchNotifyService],
})
export class LaunchNotifyModule {}
