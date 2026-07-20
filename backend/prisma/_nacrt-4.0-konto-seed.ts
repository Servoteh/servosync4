// ─────────────────────────────────────────────────────────────────────────────
// NACRT — Faza 1 (4.0): seed za konto registre (SaldakontoAccount + VatAccountMap)
// ─────────────────────────────────────────────────────────────────────────────
// STATUS: PRIPREMLJEN PODATAK — verifikovan iz _legacy .../Kontni plan.csv (1389 konta).
// Ide u prisma/seed kad baza + modeli budu spremni. `name` iz CSV Opis-a se drži na
// Account.description; ovde je komentar radi provere.
//
// ⚠️ 3 KOLIZIJE ŠIFRI iz uputstva vs stvarni kontni plan (potvrđeno, rešeno u korist CSV-a):
//   • 1500 (uputstvo) NE POSTOJI → koristi se 1510 "Placeni avansi u inostranstvu (materijal)"
//   • 4630 u CSV = "Obaveze prema radnicima" (NE ino-dobavljač!) → ino dobavljač = 4360
//   • 2790 u CSV = "Potraživanja za preplaćeni PDV" (ne "pretplata/transit")
// ─────────────────────────────────────────────────────────────────────────────

export const saldakontoAccountSeed = [
  // KUPCI (receivable)
  { account: '2040', side: 'receivable', controlAccount: '204', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // Kupci u zemlji (csv:249) — IFR
  { account: '2050', side: 'receivable', controlAccount: '205', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // Kupci u inostranstvu (csv:250) — IZVOZ, devizno
  { account: '2020', side: 'receivable', controlAccount: '202', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // Kupci u zemlji - ostala povezana (csv:240) — IFUSL/KNO
  { account: '2010', side: 'receivable', controlAccount: '201', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // Kupci u inostranstvu - matična i zavisna (csv:238)
  // DOBAVLJAČI (payable)
  { account: '4350', side: 'payable', controlAccount: '435', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // DOBAVLJAČI U ZEMLJI (csv:596) — UFROB/UFMAT/TROS
  { account: '4351', side: 'payable', controlAccount: '435', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // DOBAVLJAČI U ZEMLJI - FIZIČKA LICA (csv:597)
  { account: '4360', side: 'payable', controlAccount: '436', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // DOBAVLJAČI U INOSTRANSTVU (csv:598) — devizno
  // DATI AVANSI (receivable — potraživanje prema dobavljaču)
  { account: '1520', side: 'receivable', controlAccount: '152', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // Plaćeni avansi za robu u zemlji (csv:227)
  { account: '1521', side: 'receivable', controlAccount: '152', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // ...bez PDV (csv:228)
  { account: '1530', side: 'receivable', controlAccount: '153', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // Plaćeni avansi za robu u inostranstvu (csv:230)
  { account: '1510', side: 'receivable', controlAccount: '151', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // Plaćeni avansi u inostranstvu (materijal) (csv:226) — ZAMENA za doc "1500"
  // PRIMLJENI AVANSI (payable — obaveza prema kupcu)
  { account: '4300', side: 'payable', controlAccount: '430', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: false }, // Primljeni avansi, depoziti i kaucije (csv:575) — AVR
  { account: '4302', side: 'payable', controlAccount: '430', tracksOpenItems: true, holdsDinBalance: true, holdsFxBalance: true },  // Primljeni avansi od pravnih lica inostranstvo (csv:577) — devizno
];

// PDV konta — model VatAccountMap se uvodi u Fazi 6; seed spreman.
export const vatAccountMapSeed = [
  // ULAZNI (pretporez)
  { account: '2700', name: 'PDV u primljenim fakturama 20%', direction: 'input', rate: 20, role: 'standard' },
  { account: '2710', name: 'PDV u primljenim fakturama 10%', direction: 'input', rate: 10, role: 'standard' },
  { account: '2704', name: 'PDV prethodni koji se ne može koristiti 20%', direction: 'input', rate: 20, role: 'ne-koristi-se' },
  { account: '2714', name: 'Nepriznat PDV 10%', direction: 'input', rate: 10, role: 'ne-koristi-se' },
  { account: '2740', name: 'PDV plaćen pri uvozu dobara 20%', direction: 'input', rate: 20, role: 'carinski' },
  { account: '2750', name: 'PDV plaćen pri uvozu dobara 10%', direction: 'input', rate: 10, role: 'carinski' },
  { account: '2720', name: 'PDV u datim avansima 20%', direction: 'input', rate: 20, role: 'avans' },
  { account: '27200', name: 'PDV u datim avansima 20% - zatvaranje avansa', direction: 'input', rate: 20, role: 'avans' },
  { account: '2730', name: 'PDV u datim avansima 10%', direction: 'input', rate: 10, role: 'avans' },
  { account: '2760', name: 'PDV obračunat na usluge inostranih lica 20%', direction: 'input', rate: 20, role: 'standard' },
  { account: '2790', name: 'Potraživanja za preplaćeni PDV', direction: 'input', rate: null, role: 'transit' },
  // IZLAZNI (obaveza za PDV)
  { account: '4700', name: 'PDV po izdatim fakturama 20%', direction: 'output', rate: 20, role: 'standard' },
  { account: '4701', name: 'PDV 20% na prodate proizvode (domaće tržište)', direction: 'output', rate: 20, role: 'standard' },
  { account: '4702', name: 'PDV 20% na prodate robe (domaće tržište)', direction: 'output', rate: 20, role: 'standard' },
  { account: '4703', name: 'Obaveze za PDV - USLUGE 20%', direction: 'output', rate: 20, role: 'standard' },
  { account: '4710', name: 'PDV po izdatim fakturama 10%', direction: 'output', rate: 10, role: 'standard' },
  { account: '4720', name: 'PDV po primljenim avansima 20%', direction: 'output', rate: 20, role: 'avans' },
  { account: '47200', name: 'PDV po primljenim avansima 20% - pokrivanje avansa', direction: 'output', rate: 20, role: 'avans' },
  { account: '4730', name: 'PDV po primljenim avansima 10%', direction: 'output', rate: 10, role: 'avans' },
  { account: '4740', name: 'PDV po osnovu sopstvene potrošnje 20%', direction: 'output', rate: 20, role: 'standard' },
  { account: '4760', name: 'PDV 20% po osnovu prodaje za gotovinu', direction: 'output', rate: 20, role: 'standard' },
  { account: '4761', name: 'PDV 10% za gotovinu', direction: 'output', rate: 10, role: 'standard' },
  { account: '4790', name: 'Obaveze za PDV (uplatni račun)', direction: 'output', rate: null, role: 'transit' },
];

// TODO(Faza 1): kontrolni konto — BigBit KontoKupca()/KontoDobavljaca() koristi PO JEDAN
// (config). Ovde je predložena LISTA (doc 30 §C). Ako se ide na jedan kontrolni po strani,
// 2010/2020/2040 → isti controlAccount, i 4350/4351/4360 → isti. Potvrditi iz BigBit šema.
