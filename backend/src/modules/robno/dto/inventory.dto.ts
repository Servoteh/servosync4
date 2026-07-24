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
 * Zaključivanje popisa — kreira robne dokumente VISAK (višak) i MANJAK (manjak).
 *
 * Vrste dokumenta (`DocumentType.code`) su opcione; podrazumevano roba: `VISAR` (Sema 46 → 1320/6740)
 * i `MANJR` (Sema 50 → 1320/5741). Za magacin materijala prosledi `VISAM` / `MANJM` (Sema 41/49,
 * doc 39 §D). Telo sme biti prazno — tada se koriste podrazumevane roba-vrste.
 */
export interface FinalizeInventoryCountDto {
  /** Vrsta dokumenta za višak (default `VISAR`). */
  surplusDocumentTypeCode?: string;
  /** Vrsta dokumenta za manjak (default `MANJR`). */
  shortageDocumentTypeCode?: string;
}
