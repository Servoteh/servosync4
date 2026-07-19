import { Module } from "@nestjs/common";
import { PostingEngineService } from "./posting.service";

/**
 * GL posting modul (Faza 2/3) — auto-kontiranje robnog dokumenta u nalog GK.
 * Izlaže `PostingEngineService.postFromStockDocument(docId)`. Controller/REST se
 * dodaje kada robni modul (Faza 3) veže „proknjiži" akciju; za sada servis-only.
 * PrismaModule je @Global — ne treba ga uvoziti ovde.
 */
@Module({
  providers: [PostingEngineService],
  exports: [PostingEngineService],
})
export class PostingModule {}
