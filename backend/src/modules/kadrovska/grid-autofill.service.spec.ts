import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  KadrovskaGridAutofillService,
  proposeHoursFromPresence,
  proposeHoursForDay,
  GRID_AUTOFILL_MARKER,
} from "./grid-autofill.service";
import { GridAutofillRunDto } from "./dto/kadrovska-mutation.dto";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/** „Juče" u pogonskoj zoni — deterministički (isti izračun kao servis) za klamp test. */
function belgradeYesterday(): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Zahtev 012/26 + 044/26 — dnevni auto-predlog grida iz kapije. Pinuje:
 * (1) predlog iz STVARNOG prisustva (NE paušalno 8h) — sečeno NANIŽE na pola sata
 *     (D2, 044/26): 6.52 → 6.5, 6.75 → 6.5, 5.05 → 5.0; od 03.08.2026 (revizija O-5)
 *     BEZ ijedne kape na 8h — 9.08 → 9.0 i 7.8 → 7.5 (v. describe niže);
 * (2) upis je INSERT … ON CONFLICT (employee_id, work_date) DO NOTHING (idempotentno,
 *     nikad ne gazi ručni unos) + marker last_edited_by='auto:kapija';
 * (3) VIKEND SA čistim kucanjem se predlaže kao REDOVNI sati (D1, 044/26 — više se NE
 *     preskače); van-opsega [1h..14h] se preskače;
 * (4) NERADNI PRAZNIK od 01.08.2026 NEMA nikakav poseban tretman — i delimično kucanje
 *     se predlaže (ranije se preskakalo jer bi pojelo garantovanih 8h; O-1 je to
 *     promenio → sati se sada DODAJU na 8h, pa autofill samo beleži evidenciju, a
 *     kontrolu radi kadrovska mesečno). Autofill zato uopšte VIŠE NE ČITA kadr_holidays;
 * (5) kill-switch KADROVSKA_GRID_AUTOFILL=false → no-op; (6) dryRun ne piše.
 */

type SqlLike = { strings: string[]; values: unknown[] };
const textOf = (m: jest.Mock): string =>
  ((m.mock.calls[0]?.[0] as SqlLike)?.strings ?? []).join(" ? ");
const valuesOf = (m: jest.Mock): unknown[] =>
  (m.mock.calls[0]?.[0] as SqlLike)?.values ?? [];

/** Praznik u fixture-u: string = pravi NERADNI praznik; objekat = eksplicitan is_workday. */
type HolidayFixture = string | { date: string; isWorkday: boolean };

/** kadr_holidays redovi iz fixture-a, uz poštovanje `where.isWorkday` filtera. */
function holidayRowsFor(
  fixtures: HolidayFixture[] | undefined,
  wantIsWorkday: boolean | undefined,
): { holidayDate: Date }[] {
  return (fixtures ?? [])
    .map((h) => (typeof h === "string" ? { date: h, isWorkday: false } : h))
    .filter((h) => wantIsWorkday === undefined || h.isWorkday === wantIsWorkday)
    .map((h) => ({ holidayDate: new Date(`${h.date}T00:00:00Z`) }));
}

function makeSvc(opts: {
  vsGridRows?: { employee_id: string; day: Date; presence_hours: number }[];
  holidays?: HolidayFixture[];
  executeResult?: number;
  flag?: string;
  dbThrows?: boolean;
}) {
  if (opts.flag === undefined) delete process.env.KADROVSKA_GRID_AUTOFILL;
  else process.env.KADROVSKA_GRID_AUTOFILL = opts.flag;

  const queryRaw = jest.fn().mockResolvedValue(opts.vsGridRows ?? []);
  const executeRaw = jest
    .fn()
    .mockResolvedValue(opts.executeResult ?? opts.vsGridRows?.length ?? 0);
  // Mock POŠTUJE `where.isWorkday` — inače bi test „radna subota" prošao lažno.
  const holidayFindMany = jest
    .fn()
    .mockImplementation((args?: { where?: { isWorkday?: boolean } }) =>
      Promise.resolve(holidayRowsFor(opts.holidays, args?.where?.isWorkday)),
    );
  const db = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    kadrHoliday: { findMany: holidayFindMany },
  };
  const sy15 = {
    get db() {
      if (opts.dbThrows) throw new Error("sy15 nije konfigurisan (boot faza)");
      return db;
    },
  } as unknown as Sy15Service;
  const svc = new KadrovskaGridAutofillService(sy15);
  return { svc, queryRaw, executeRaw, holidayFindMany };
}

// v_attendance_vs_grid red (samo kolone koje job čita).
function vsRow(day: string, presence: number) {
  return {
    employee_id: "3b241101-e2bb-4255-8caf-4136c566a962",
    day: new Date(`${day}T00:00:00Z`),
    presence_hours: presence,
  };
}

afterEach(() => {
  delete process.env.KADROVSKA_GRID_AUTOFILL;
  jest.restoreAllMocks();
});

describe("proposeHoursFromPresence (STVARNI sati, NE paušalno 8h)", () => {
  it("skraćeno radno vreme (~5h) → sečeno NANIŽE, NE 8h (Antić/Pavlović)", () => {
    expect(proposeHoursFromPresence(5.0)).toBe(5.0);
    expect(proposeHoursFromPresence(5.05)).toBe(5.0);
    expect(proposeHoursFromPresence(5.3)).toBe(5.0); // FLOOR: 5.3 → 5.0 (ne 5.5)
    expect(proposeHoursFromPresence(4.8)).toBe(4.5); // FLOOR: 4.8 → 4.5 (ne 5.0)
  });

  it("D2 (044/26) — sečenje NANIŽE na pola sata (Duško: 6.52h → 6.5)", () => {
    expect(proposeHoursFromPresence(6.52)).toBe(6.5); // Duško subota 2026-07-25
    expect(proposeHoursFromPresence(6.75)).toBe(6.5); // FLOOR: 6.75 → 6.5 (ne 7.0)
    expect(proposeHoursFromPresence(6.99)).toBe(6.5); // tik ispod 7 → 6.5
    expect(proposeHoursFromPresence(6.5)).toBe(6.5); // tačno pola → ostaje
  });

  it("revizija O-5 (03.08.2026): DUŽI dan se više NE kapira na 8 — 9.08h → 9.0", () => {
    // Povod: Duško Kostić (012/26) 21–22.07.2026 po kapiji 9h, grid dobio 8h. Stara
    // kapa `>= 7.6 → 8` je tiho jela sate; vlasnik ju je ukinuo („grid = ogledalo
    // kapije"). Merenje jun–jul 2026: 918 dana dobija VIŠE (+1.046 h).
    expect(proposeHoursFromPresence(9.08)).toBe(9.0); // Bulović 01.05. 08:30–17:35
    expect(proposeHoursFromPresence(9.5)).toBe(9.5); // NE 8 — razdvajanje redovni/prekovremeni radi urednik
    expect(proposeHoursFromPresence(12.3)).toBe(12.0); // FLOOR na pola sata i nagore
    expect(proposeHoursFromPresence(8.4)).toBe(8.0);
    expect(proposeHoursFromPresence(8.0)).toBe(8.0); // tačno 8 ostaje 8 (nema kape ni u jednom smeru)
    expect(proposeHoursFromPresence(14.0)).toBe(14.0); // tačno na CEIL → još uvek predlog
  });

  it("revizija O-5 (03.08.2026): 7.6–7.99h više NIJE 8 nego 7.5 — NAMERAN gubitak, vlasnik potvrdio", () => {
    // ⚠️ NE „popravljati" nazad na 8. Vlasniku je PRE odluke pokazano merenje nad
    // živim jun–jul podacima: 1.087 dana ide NANIŽE (ukupno −544 h) i to je tačno
    // ovaj opseg. Odlučio je svesno: evidencija = dokaz sa kapije, a Nikola Mrkajić
    // normalizuje u mesečnoj kontroli grida. Detalji: docs/ODLUKE_O_ZARADAMA.md (O-5).
    expect(proposeHoursFromPresence(7.8)).toBe(7.5); // ranije 8 → sada 7.5 (namerno)
    expect(proposeHoursFromPresence(7.6)).toBe(7.5); // stara donja granica „pun dan"
    expect(proposeHoursFromPresence(7.95)).toBe(7.5);
    expect(proposeHoursFromPresence(7.99)).toBe(7.5);
  });

  it("srednje kratko (6–7.5h) → sečeno NANIŽE na pola sata", () => {
    expect(proposeHoursFromPresence(6.7)).toBe(6.5);
    expect(proposeHoursFromPresence(7.5)).toBe(7.5); // tačno pola → ostaje
    expect(proposeHoursFromPresence(7.4)).toBe(7.0); // FLOOR: 7.4 → 7.0 (ne 7.5)
  });

  it("van opsega → null (preskoči): <1h slučajno kucanje, >14h anomalija, null", () => {
    expect(proposeHoursFromPresence(0.5)).toBeNull();
    expect(proposeHoursFromPresence(0.9)).toBeNull(); // tik ispod FLOOR-a
    expect(proposeHoursFromPresence(14.1)).toBeNull(); // tik iznad CEIL-a → urednik ručno
    expect(proposeHoursFromPresence(15)).toBeNull();
    expect(proposeHoursFromPresence(null)).toBeNull();
    expect(proposeHoursFromPresence(Number.NaN)).toBeNull();
  });
});

describe("proposeHoursForDay (odluka za JEDAN dan — bez kalendarskih izuzetaka)", () => {
  it("prosleđuje rezultat proposeHoursFromPresence 1:1 (nema više kapije za dan)", () => {
    expect(proposeHoursForDay(6.52)).toEqual({ hours: 6.5, reason: null });
    expect(proposeHoursForDay(8.2)).toEqual({ hours: 8, reason: null });
    // revizija O-5 (03.08.2026): 7.6h više NIJE „pun dan (8)" nego doslovnih 7.5
    expect(proposeHoursForDay(7.6)).toEqual({ hours: 7.5, reason: null });
    expect(proposeHoursForDay(9.08)).toEqual({ hours: 9, reason: null }); // bez kape nagore
    expect(proposeHoursForDay(2.5)).toEqual({ hours: 2.5, reason: null });
    expect(proposeHoursForDay(7.5)).toEqual({ hours: 7.5, reason: null });
  });

  it("van opsega → jedini preostali razlog preskakanja je out_of_band", () => {
    expect(proposeHoursForDay(0.5)).toEqual({
      hours: null,
      reason: "out_of_band",
    });
    expect(proposeHoursForDay(15)).toEqual({
      hours: null,
      reason: "out_of_band",
    });
    expect(proposeHoursForDay(null)).toEqual({
      hours: null,
      reason: "out_of_band",
    });
  });
});

describe("KadrovskaGridAutofillService.run", () => {
  it("čita v_attendance_vs_grid sa signalima 'regularnog praznog dana' + raspon u params", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.run({ from: "2026-07-01", to: "2026-07-08" });
    const t = textOf(queryRaw);
    expect(t).toContain("FROM v_attendance_vs_grid");
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
    expect(t).toContain("COALESCE(v.grid_field_hours, 0) = 0");
    expect(t).toContain("open_intervals = 0");
    expect(t).toContain("first_in IS NOT NULL");
    expect(t).toContain("last_out IS NOT NULL");
    // Zamena dana (31.07.2026): dan sa odobrenim 'dan_odmora' zahtevom se NE predlaže
    // (+1 dan GO umesto plaćenih sati — nikad oboje).
    expect(t).toContain("FROM makeup_requests");
    expect(t).toContain("'dan_odmora'");
    expect(t).toContain("COALESCE(mr.weekend_work_date, mr.absence_date) = v.day");
    expect(valuesOf(queryRaw)).toEqual(
      expect.arrayContaining(["2026-07-01", "2026-07-08"]),
    );
  });

  it("skraćeno vreme (5h) upisuje se kao 5.0 (NE 8h) + marker + ON CONFLICT DO NOTHING", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 5.05)], // utorak
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    const t = textOf(executeRaw);
    expect(t).toContain("INSERT INTO work_hours");
    expect(t).toContain("ON CONFLICT (employee_id, work_date) DO NOTHING");
    const v = valuesOf(executeRaw);
    expect(v[0]).toBe(GRID_AUTOFILL_MARKER); // last_edited_by = 'auto:kapija'
    // unnest nizovi: [marker, empIds[], dates[], hrs[]] → sati = 5 (NE 8)
    expect(v).toEqual(expect.arrayContaining([["2026-07-07"], [5]]));
  });

  it("pun radni dan → predlog 8", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.1)],
      executeResult: 1,
    });
    await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[8]]));
  });

  it("DUŽI dan (9.08h) upisuje 9.0, NE 8 — revizija O-5, povod 012/26 (Duško 21–22.07.)", async () => {
    // Do 03.08.2026 bi ovaj dan otišao u grid kao 8h i sat rada bi nestao iz
    // evidencije (dan posle upisa postaje grid_covered → niko ga ne ispravlja).
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-21", 9.08)], // utorak
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-21", to: "2026-07-21" });
    expect(data.proposed).toBe(1);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[9]]));
  });

  it("7.8h upisuje 7.5, NE 8 — NAMERAN ishod revizije O-5 (vlasnik potvrdio uz merenje)", async () => {
    // Merenje jun–jul 2026 pokazano vlasniku PRE odluke: 1.087 dana ide naniže
    // (−544 h ukupno), svi iz opsega 7.6–7.99h. Odluka: grid je ogledalo kapije,
    // normalizuje kadrovska mesečno. NE vraćati kapu bez nove odluke (O-5).
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 7.8)],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(1);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[7.5]]));
  });

  it("vikend (subota 2026-07-25) SA čistim kucanjem → predlaže se kao REDOVNI (D1) — NIJE preskočen", async () => {
    // Duško Kostić: subota 08:00–14:31 = 6.52h prisustva → 6.5h redovnih (D1+D2).
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-25", 6.52)],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-25", to: "2026-07-25" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    expect(data.skippedWeekendHoliday).toBe(0); // vikend se NIKAD ne broji kao preskočen
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[6.5]]));
  });

  it("NERADNI praznik + PUN dan (8.2h) → predlaže se kao 8", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-05-01", 8.2)], // Praznik rada (petak), neradni
      holidays: ["2026-05-01"],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-05-01", to: "2026-05-01" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    expect(data.skippedWeekendHoliday).toBe(0);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[8]]));
  });

  it("NERADNI praznik + DUŽI dan (9.5h) → upisuje se 9.5 (ni praznična kapija ni kapa na 8)", async () => {
    // Dve nezavisne odluke se ovde ukrštaju: Č-5 (01.08.2026) je ukinuo prazničnu
    // kapiju, a revizija O-5 (03.08.2026) kapu na 8h. Autofill upisuje DOSLOVNO
    // odrađene sate; 8h plaćenog praznika po O-1 dodaje OBRAČUN (payroll-calc), ne
    // ovaj upis — pa 9.5 ovde nije „duplo", nego evidencija stvarnog rada.
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-05-01", 9.5)], // Praznik rada (petak), neradni
      holidays: ["2026-05-01"],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-05-01", to: "2026-05-01" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    expect(data.skippedWeekendHoliday).toBe(0);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[9.5]]));
  });

  it("NERADNI praznik + DELIMIČNO kucanje (2.5h) → SADA SE UPISUJE kao 2.5 (kapija ukinuta 01.08.2026)", async () => {
    // Ranije preskočeno: upis sati je pojeo garantovanih 8h plaćenog praznika. Posle
    // O-1 (263a4db6) obračun sate DODAJE na 8h (praznikRadSati 2.5 + praznikPlaceniSati
    // 8), pa autofill beleži evidenciju ko je dodatno radio (O-4 + presuda 01.08.2026);
    // dvostruka isplata je NAMERNA, kontrolu radi kadrovska mesečno.
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-05-01", 2.5)],
      holidays: ["2026-05-01"],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-05-01", to: "2026-05-01" });
    expect(data.candidates).toBe(1);
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(1);
    expect(data.skippedOutOfBand).toBe(0);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[2.5]]));
    // Sažetak zadržava polje radi API-kompatibilnosti, ali ono je TRAJNO 0.
    expect(data.skippedWeekendHoliday).toBe(0);
  });

  it("kadr_holidays sa is_workday=TRUE (radna subota) → običan dan (6.52h → 6.5)", async () => {
    // Trivijalno tačno otkad autofill uopšte ne gleda kalendar praznika; test ostaje
    // kao brana da se radni-dan izuzetak nikad ne počne tretirati kao praznik.
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-25", 6.52)], // subota
      holidays: [{ date: "2026-07-25", isWorkday: true }],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-07-25", to: "2026-07-25" });
    expect(data.proposed).toBe(1);
    expect(data.skippedWeekendHoliday).toBe(0);
    expect(valuesOf(executeRaw)).toEqual(expect.arrayContaining([[6.5]]));
  });

  it("idempotentno / ne-prepisivanje: već popunjen dan (DO NOTHING → 0 upisa) iako je predložen", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.0)],
      executeResult: 0, // svi redovi u konfliktu → ništa upisano (ručni unos ostaje netaknut)
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(0);
    expect(textOf(executeRaw)).toContain("DO NOTHING");
  });

  it("kill-switch KADROVSKA_GRID_AUTOFILL=false → no-op (bez čitanja i upisa)", async () => {
    const { svc, queryRaw, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 8.0)],
      flag: "false",
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(data.enabled).toBe(false);
    expect(data.inserted).toBe(0);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("dryRun: izračuna predlog ali NE piše", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 5.0)],
    });
    const { data } = await svc.run({
      from: "2026-07-07",
      to: "2026-07-07",
      dryRun: true,
    });
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("out-of-band prisustvo (0.5h / 15h) → skippedOutOfBand, bez upisa", async () => {
    const { svc, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-07-07", 0.5), vsRow("2026-07-08", 15)], // uto, sre
    });
    const { data } = await svc.run({ from: "2026-07-07", to: "2026-07-08" });
    expect(data.proposed).toBe(0);
    expect(data.skippedOutOfBand).toBe(2);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("KLAMP: to=danas/budućnost → obrađuje SAMO do juče (danas se ne dira)", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await svc.run({ to: "2999-12-31" });
    const yd = belgradeYesterday();
    // read params = [from, to]; from default = to (klampovano na juče)
    expect(valuesOf(queryRaw)).toEqual([yd, yd]);
    expect(valuesOf(queryRaw)).not.toContain("2999-12-31");
  });

  it("kalendar praznika se VIŠE UOPŠTE NE ČITA (kapija ukinuta → nema kadr_holidays upita)", async () => {
    const { svc, holidayFindMany } = makeSvc({
      vsGridRows: [vsRow("2026-05-01", 3.0)], // neradni praznik, delimično kucanje
      holidays: ["2026-05-01"],
      executeResult: 1,
    });
    const { data } = await svc.run({ from: "2026-05-01", to: "2026-05-01" });
    expect(holidayFindMany).not.toHaveBeenCalled();
    expect(data.proposed).toBe(1); // praznik ne menja ishod
  });

  it("bez kandidata → i dalje nula dodatnih upita (noć bez kucanja)", async () => {
    const { svc, holidayFindMany } = makeSvc({ vsGridRows: [] });
    await svc.run({ from: "2026-07-07", to: "2026-07-07" });
    expect(holidayFindMany).not.toHaveBeenCalled();
  });

  it("pokriven dan / dan sa odsustvom se NIKAD ne dira (SQL filter + DO NOTHING)", async () => {
    // Dve nezavisne brane: (1) kandidatski SQL izbacuje grid_covered=true i
    // absence_code IS NOT NULL, pa takvi dani nikad ni ne stignu do predloga;
    // (2) i da stignu, INSERT … ON CONFLICT DO NOTHING ne prepisuje postojeći red.
    const { svc, queryRaw, executeRaw } = makeSvc({
      vsGridRows: [vsRow("2026-05-01", 2.5)], // neradni praznik, delimično
      holidays: ["2026-05-01"],
      executeResult: 0, // red već postoji (ručni unos / odsustvo) → 0 upisa
    });
    const { data } = await svc.run({ from: "2026-05-01", to: "2026-05-01" });
    const t = textOf(queryRaw);
    expect(t).toContain("grid_covered = false");
    expect(t).toContain("absence_code IS NULL");
    expect(data.proposed).toBe(1);
    expect(data.inserted).toBe(0);
    expect(textOf(executeRaw)).toContain(
      "ON CONFLICT (employee_id, work_date) DO NOTHING",
    );
  });
});

describe("KadrovskaGridAutofillService interni dnevni tik (ODLUKE #24)", () => {
  it("onModuleInit: tik se NE pokreće u test okruženju (NODE_ENV=test)", () => {
    const { svc } = makeSvc({});
    const spy = jest.spyOn(global, "setInterval");
    svc.onModuleInit(); // jest postavlja NODE_ENV='test'
    expect(spy).not.toHaveBeenCalled();
  });

  it("onModuleInit: development (ne-production) → tik mrtav (nema setInterval)", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const { svc } = makeSvc({});
      const spy = jest.spyOn(global, "setInterval");
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("onModuleInit: van testa + flag on → setInterval(unref) aktivan; destroy ga čisti", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { svc } = makeSvc({}); // flag nepostavljen → default UKLJUČEN
      const unref = jest.fn();
      const fakeTimer = { unref } as unknown as NodeJS.Timeout;
      const setSpy = jest
        .spyOn(global, "setInterval")
        .mockReturnValue(fakeTimer);
      const clrSpy = jest
        .spyOn(global, "clearInterval")
        .mockImplementation(() => {});
      svc.onModuleInit();
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(unref).toHaveBeenCalled(); // ne drži proces
      svc.onModuleDestroy();
      expect(clrSpy).toHaveBeenCalledWith(fakeTimer);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("onModuleInit: flag off → tik potpuno mrtav (nema setInterval)", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { svc } = makeSvc({ flag: "false" });
      const spy = jest.spyOn(global, "setInterval");
      svc.onModuleInit();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("tik: obrađuje JUČE jednom dnevno — drugi tik istog dana je NO-OP (lastRunDay)", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    // now = 2026-07-08 06:00 → juče = 2026-07-07
    await (svc as unknown as { tick: (n: unknown) => Promise<void> }).tick({
      day: "2026-07-08",
      hour: 6,
    });
    await (svc as unknown as { tick: (n: unknown) => Promise<void> }).tick({
      day: "2026-07-08",
      hour: 9,
    });
    expect(queryRaw).toHaveBeenCalledTimes(1); // drugi tik preskočen
    expect(valuesOf(queryRaw)).toEqual(expect.arrayContaining(["2026-07-07"]));
  });

  it("tik: prerano (pre 05:00) → ne radi", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [] });
    await (svc as unknown as { tick: (n: unknown) => Promise<void> }).tick({
      day: "2026-07-08",
      hour: 4,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("tik: flag off → ne radi", async () => {
    const { svc, queryRaw } = makeSvc({ vsGridRows: [], flag: "false" });
    await (svc as unknown as { tick: (n: unknown) => Promise<void> }).tick({
      day: "2026-07-08",
      hour: 6,
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("tik: greška (sy15 nedostupan u boot fazi) se LOGUJE, NE baca", async () => {
    const { svc } = makeSvc({ dbThrows: true });
    await expect(
      (svc as unknown as { tick: (n: unknown) => Promise<void> }).tick({
        day: "2026-07-08",
        hour: 6,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("GridAutofillRunDto — stroga validacija datuma (YYYY-MM-DD)", () => {
  it("prihvata ispravne YYYY-MM-DD i prazno telo", async () => {
    for (const body of [
      {},
      { from: "2026-07-01", to: "2026-07-24" },
      { to: "2026-07-24", dryRun: true },
    ]) {
      const dto = plainToInstance(GridAutofillRunDto, body);
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it("odbija delimične/nestandardne datume (IsISO8601 bi ih propustio → PG 500)", async () => {
    for (const bad of [
      "2026-07",
      "2026-W30",
      "07/01/2026",
      "danas",
      "2026-7-1",
    ]) {
      const dto = plainToInstance(GridAutofillRunDto, { from: bad });
      expect((await validate(dto)).length).toBeGreaterThan(0);
    }
  });
});
