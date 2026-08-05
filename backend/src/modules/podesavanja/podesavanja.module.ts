import { Module } from "@nestjs/common";
import { PodesavanjaController } from "./podesavanja.controller";
import { PodesavanjaService } from "./podesavanja.service";
import { PodesavanjaUsersService } from "./podesavanja-users.service";
import { PredmetPlaneriService } from "./predmet-planeri.service";
import { SyncSwitchService } from "./sync-switch.service";
import { CompanyDetailsService } from "./company-details.service";
import { PaymentAccountsService } from "./payment-accounts.service";
import { MontazaNmPrimaociService } from "./montaza-nm-primaoci.service";
import { KnjigovodstvoController } from "./knjigovodstvo.controller";
import { DocumentSequencesService } from "./document-sequences.service";
import { ServiceRevenueTypeService } from "../sales/service-revenue-type.service";

/** Podešavanja (RBAC admin + matični + sistem) — 3.0 TALAS D (podaci u sy15 — Sy15Module).
 *  D1 (R2) dvostrano upravljanje nalozima = `PodesavanjaUsersService` (GoTrue+sy15+2.0).
 *  Planeri predmeta (016/26) = `PredmetPlaneriService` (3.0-native, glavna baza).
 *  `SyncSwitchService` je EKSPORTOVAN namerno: prekidač noćnog BigBit uvoza mora da se
 *  poštuje i u sync/scheduler modulima (uvezu `PodesavanjaModule` i injektuju servis).
 *  Nema ciklusa — Podešavanja ne zavise ni od sync-a ni od scheduler-a. */
@Module({
  controllers: [PodesavanjaController, KnjigovodstvoController],
  providers: [
    PodesavanjaService,
    PodesavanjaUsersService,
    PredmetPlaneriService,
    SyncSwitchService,
    // Matični podaci firme (memorandum + IBAN/SWIFT za ino fakturu). Do 27.07.2026.
    // tabela `companies` nije imala nijednog pisca — podaci su stizali samo iz BigBita.
    CompanyDetailsService,
    // Devizni računi (`payment_accounts.iban/swift/bank_address/currency`) — blok banke na
    // izvoznoj fakturi. Kolone su dodate 01.08.2026, štampa ih čita, a pisca nisu imale:
    // izvozni račun je izlazio bez ijedne bankarske instrukcije.
    PaymentAccountsService,
    // 034/26: urediva lista primalaca obaveštenja o neusaglašenosti na montaži
    // (montaza_nm_primaoci) — mail/zvonce je čitaju direktno, ovo je samo admin CRUD.
    MontazaNmPrimaociService,
    // Brojači dokumenata (O-F11) — startni broj po seriji i godini + brana „broj već
    // postoji u knjizi". Registar serija se uvozi iz `sales/numbering.service.ts`; sam
    // servis zavisi SAMO od Prisme, pa `PodesavanjaModule` ne mora da uvozi `SalesModule`
    // (a i ne sme — `SalesModule` bi tako povukao ceo lanac Posting/GL/SEF/Robno u
    // Podešavanja, i to samo zbog jednog čitanja šifarnika).
    DocumentSequencesService,
    // Šifarnik vrsta usluge (P10) — ISTA klasa koju provajduje i `SalesModule`.
    // Nest pravi po jednu instancu PO MODULU; to je ovde bezopasno i namerno: servis je
    // bez stanja (drži samo `PrismaService`), a alternativa — uvoz `SalesModule`-a — bi
    // vezala Podešavanja za ceo prodajni lanac. Ista klasa znači i jedna te ista pravila
    // (provera konta, poreskog tretmana, jedinstvene šifre) na oba ulaza.
    ServiceRevenueTypeService,
  ],
  exports: [SyncSwitchService],
})
export class PodesavanjaModule {}
