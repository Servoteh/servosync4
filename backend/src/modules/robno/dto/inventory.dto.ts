/**
 * DTO-ovi za popis / inventuru (`inventory_counts` + `inventory_count_items`, doc 39 §D).
 *
 * Tok (doc 39 §D): **predpunjenje** iz robnog (`POPIS_DopisiKolKNG`, cena `CenaZaUpisUPopis`) →
 * **unos `KolPop`** → **razlika** (`RazlikaKol = KolPop − KolKng`) → **knjiženje** (VISAK/MANJAK
 * robni dokumenti, carry-over doc 27). Predpunjenje/razliku/knjiženje radi server — klijent samo
 * kreira popis, unosi popisane količine i zaključuje.
 *
 * Količine su STRING u JSON-u (BACKEND_RULES §6: Decimal kao string); servis ih parsira u `Prisma.Decimal`.
 */

/** Kreiranje popisa (server predpunjava stavke iz costing-a AS-OF na datum popisa). */
export interface CreateInventoryCountDto {
  /** Meki ref `warehouses.id` — magacin nad kojim se radi popis. Obavezno. */
  warehouseId: number;
  /** ISO datum popisa (as-of ključ za knjigovodstveno stanje `KolKng` i cenu). Izostane → sada. */
  countDate?: string;
  note?: string;
}

/** Unos popisane (fizičke) količine za jednu stavku popisa (`KolPop`). */
export interface UpdateInventoryCountItemDto {
  /** Popisana količina — nenegativan Decimal (string ili number). */
  countedQuantity: string | number;
}

/**
 * Zaključivanje popisa — kreira SAMO robni dokument VIŠKA.
 *
 * Vrsta dokumenta (`DocumentType.code`) je opciona; podrazumevano roba `VISAR` (Sema 46 →
 * 1320/6740). Za magacin materijala prosledi `VISAM` (Sema 41, doc 39 §D). Telo sme biti
 * prazno — tada se koristi podrazumevana roba-vrsta.
 *
 * 🔴 MANJAK NEMA SVOJU VRSTU DOKUMENTA (07.08.2026): popis sa manjkom se ODBIJA, ne knjiži —
 * odluka knjigovođe „takav dokument ne treba da postoji" (obrazloženje i merenja u
 * `InventoryService.finalize`). Polje `shortageDocumentTypeCode` je zato uklonjeno; ako ga
 * neki stariji klijent i dalje šalje, biće ignorisano (ruta ne odbija nepoznata polja).
 */
export interface FinalizeInventoryCountDto {
  /** Vrsta dokumenta za višak (default `VISAR`). */
  surplusDocumentTypeCode?: string;
}
