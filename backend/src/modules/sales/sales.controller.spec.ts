/**
 * SALES CONTROLLER — testovi PROSLEĐIVANJA tela rute do servisa.
 * =========================================================================
 * ZAŠTO POSTOJI: drugi krug nezavisnog pregleda je mutacijom pokazao da centralni
 * defekt stavke C nema nijedan automatski čuvar — uklanjanje reda `amount: body?.amount`
 * iz `applyAdvance` preživelo je PUN paket od 2.644 testa. A upravo je taj red uslov
 * da N:M podela avansa (37.902 → 20.802 + 17.100) uopšte radi kroz aplikaciju: DTO ga
 * prima, servis ga koristi, ekran ga šalje, ali ga je kontroler ispuštao gradeći nov
 * objekat `{ invoiceId, advanceInvoiceId }`.
 *
 * Gore od 422: kad je konačni račun VEĆI od avansa nema nikakve greške — korisnik unese
 * 5.000, a sistem odbije ceo preostali avans (37.902) i proknjiži GL storno na taj iznos.
 */

import { SalesController } from "./sales.controller";

type Call = Record<string, unknown>;

function controller(calls: Call[]) {
  const advanceInvoice = {
    // eslint-disable-next-line @typescript-eslint/require-await
    applyAdvance: async (input: Call) => {
      calls.push({ route: "applyAdvance", ...input });
      return { ok: true };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    markAdvancePaid: async (input: Call) => {
      calls.push({ route: "markAdvancePaid", ...input });
      return { ok: true };
    },
  };
  return new SalesController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    advanceInvoice as never,
    // SalesService (izmena dokumenta) — ovaj set testova ga ne dira.
    {} as never,
  );
}

const USER = { userId: 1, email: "nesa@servoteh.com" } as never;

describe("SalesController — odbijanje avansa na konačnom računu", () => {
  it("prosleđuje `amount` servisu (delimično odbijanje kroz HTTP)", async () => {
    const calls: Call[] = [];
    await controller(calls).applyAdvance(
      353,
      { advanceInvoiceId: 13, amount: "20802.00" },
      { user: USER },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      invoiceId: 353,
      advanceInvoiceId: 13,
      amount: "20802.00",
    });
  });

  it("bez `amount` prosleđuje undefined (servis tada odbija ceo preostali avans)", async () => {
    const calls: Call[] = [];
    await controller(calls).applyAdvance(
      353,
      { advanceInvoiceId: 13 },
      { user: USER },
    );
    expect(calls[0].amount).toBeUndefined();
  });

  it("iznos se NE provlači kroz Number() — string ostaje string (BACKEND_RULES §3)", async () => {
    const calls: Call[] = [];
    await controller(calls).applyAdvance(
      353,
      { advanceInvoiceId: 13, amount: "17100.0050" },
      { user: USER },
    );
    expect(calls[0].amount).toBe("17100.0050");
    expect(typeof calls[0].amount).toBe("string");
  });

  it("naplata avansa prosleđuje datum i iznos (rate — kumulativna naplata)", async () => {
    const calls: Call[] = [];
    await controller(calls).markAdvancePaid(
      13,
      { paidAt: "2026-07-28", amount: "10000.00" },
      { user: USER },
    );
    expect(calls[0]).toMatchObject({
      advanceInvoiceId: 13,
      paidAt: "2026-07-28",
      amount: "10000.00",
    });
  });
});
