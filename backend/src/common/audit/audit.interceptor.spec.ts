import { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of } from "rxjs";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditInterceptor } from "./audit.interceptor";

/** Minimalan `ExecutionContext` — interceptor iz njega čita samo HTTP zahtev. */
function ctx(
  method: string,
  url: string,
  body: unknown,
  params?: Record<string, unknown>,
): ExecutionContext {
  const req = {
    method,
    originalUrl: url,
    url,
    ip: "10.0.0.1",
    headers: { "user-agent": "jest" },
    user: { userId: 42, email: "agent@servoteh.com" },
    body,
    params,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of({ ok: true }) };

describe("AuditInterceptor — šta sme, a šta NE sme u audit_log", () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let interceptor: AuditInterceptor;

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) } };
    interceptor = new AuditInterceptor(prisma as unknown as PrismaService);
  });

  /** `afterData` iz jedinog upisa koji je interceptor napravio. */
  function afterData(): Record<string, unknown> {
    const calls = prisma.auditLog.create.mock.calls as unknown as [
      { data: { afterData?: Record<string, unknown> } },
    ][];
    return calls[0][0].data.afterData ?? {};
  }

  it("🔴 DIKTAT: tekst NIKAD ne ulazi u audit — ostaje samo dokaz i dužina", async () => {
    // Spec modula tvrdi „tekst diktata se nikad ne loguje", ali je globalni audit do
    // sada uz svaki POST /v1/dictation-inbox upisivao CEO tekst u `after_data`
    // (potvrđeno na produkciji). Sanduče je komandni kanal i tekst ume da nosi
    // poslovne podatke — u audit sme samo trag da je nešto poslato.
    const tajna = "cena za Milanović doo je 1.240.000 dinara";
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/dictation-inbox", { text: tajna }),
        next,
      ),
    );

    expect(afterData().text).toBe("[redacted]");
    expect(afterData().text_len).toBe(tajna.length);
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "Milanović",
    );
  });

  it("🔴 REFINE: sirov transkript kroz /ai/refine curio bi kroz susednu rutu", async () => {
    // Telefon isti tekst prvo provuče kroz doterivanje, pa ga tek onda odloži u
    // sanduče. Da je redigovan samo `dictation-inbox`, tekst bi i dalje završio u
    // auditu — samo jednu rutu ranije.
    const tajna = "otkazujemo ugovor sa dobavljačem Petrović";
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/ai/refine", {
          tekst: tajna,
          profil: "napomena",
        }),
        next,
      ),
    );

    expect(afterData().tekst).toBe("[redacted]");
    expect(afterData().tekst_len).toBe(tajna.length);
    expect(afterData().profil).toBe("napomena"); // metapodatak ostaje — koristan je
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "Petrović",
    );
  });

  it("OSTALE RUTE se NE diraju — `text` drugde i dalje ide u audit u celosti", async () => {
    // Redakcija je namerno po resursu: audit ostalih modula je koristan baš zato
    // što se u njemu vidi šta je tačno promenjeno.
    await firstValueFrom(
      interceptor.intercept(
        ctx("PATCH", "/api/v1/work-orders/123", { text: "napomena o nalogu" }),
        next,
      ),
    );

    expect(afterData().text).toBe("napomena o nalogu");
    expect(afterData().text_len).toBeUndefined();
  });

  it("tajne (password/token/secret) ostaju redigovane na SVIM rutama", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/podesavanja/users", {
          email: "novi@servoteh.com",
          password: "Tajna123!",
          apiToken: "abc",
        }),
        next,
      ),
    );

    expect(afterData().password).toBe("[redacted]");
    expect(afterData().apiToken).toBe("[redacted]");
    expect(afterData().email).toBe("novi@servoteh.com");
  });

  it("GET se ne audituje uopšte (samo mutirajuće operacije)", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("GET", "/api/v1/dictation-inbox/last-claimed", {}),
        next,
      ),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────── TRAG RUTE (metadata)

  /** `metadata` iz jedinog upisa koji je interceptor napravio. */
  function metadata(): Record<string, unknown> {
    const calls = prisma.auditLog.create.mock.calls as unknown as [
      { data: { metadata?: Record<string, unknown> } },
    ][];
    return calls[0][0].data.metadata ?? {};
  }

  it("🔴 COPY-FROM: IZVOR kopiranja mora ostati u tragu", async () => {
    // 07.08.2026: prijavljeno je da se tehnološki postupak „sam pojavio" na novom
    // nalogu. Upisao ga je čovek klikom na „Kopiraj iz naloga", ali audit je pamtio
    // samo CILJ — `:sourceId` je bio šesti segment, a interceptor čita do petog.
    // Zbog toga se promašen izbor izvora nije mogao razlikovati od kvara u kodu.
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/work-orders/47717/copy-from/47719", {}, {
          id: "47717",
          sourceId: "47719",
        }),
        next,
      ),
    );

    expect(metadata().params).toEqual({ id: "47717", sourceId: "47719" });
    expect(metadata().path).toBe("/api/v1/work-orders/47717/copy-from/47719");
    // Izvođenje starih polja se NE menja — po njima se pretražuje istorija.
    const data = (
      prisma.auditLog.create.mock.calls as unknown as [
        { data: Record<string, unknown> },
      ][]
    )[0][0].data;
    expect(data.action).toBe("POST COPY-FROM");
    expect(data.entityType).toBe("work-orders");
    expect(data.entityId).toBe("47717");
  });

  it("operacija koja se menja ili briše mora biti prepoznatljiva (`opId`)", async () => {
    // 2.171 poziv u 30 dana; do sada se videlo samo da je nalog dirnut, ne i KOJA
    // operacija — pa se izmena norme nije mogla vezati za red.
    await firstValueFrom(
      interceptor.intercept(
        ctx(
          "DELETE",
          "/api/v1/work-orders/47717/operations/232726",
          undefined,
          { id: "47717", opId: "232726" },
        ),
        next,
      ),
    );

    expect(metadata().params).toEqual({ id: "47717", opId: "232726" });
  });

  it("ruta bez parametara upisuje bar putanju (trag nikad nije prazan)", async () => {
    await firstValueFrom(
      interceptor.intercept(ctx("POST", "/api/v1/sync/run", {}), next),
    );

    expect(metadata()).toEqual({ path: "/api/v1/sync/run" });
  });

  it("upitni deo (`?…`) ne ulazi u trag — tamo umeju da budu filteri, ne identitet", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("PATCH", "/api/v1/work-orders/123?tab=operacije", {}, { id: "123" }),
        next,
      ),
    );

    expect(metadata().path).toBe("/api/v1/work-orders/123");
  });

  it("🔴 tuđi e-mail iz putanje NE sme da uđe u trag (sastanci/učesnici)", async () => {
    // Trag rute inače uvodi NOV podatak u audit: `:email` je šesti segment na
    // PATCH/DELETE /sastanci/:id/ucesnici/:email i do sada ga u `audit_log` nije
    // bilo. To je TUĐA adresa (učesnikova), a retencija je 24 meseca.
    await firstValueFrom(
      interceptor.intercept(
        ctx(
          "DELETE",
          "/api/v1/sastanci/8f3c/ucesnici/pera.peric@servoteh.com",
          undefined,
          { id: "8f3c", email: "pera.peric@servoteh.com" },
        ),
        next,
      ),
    );

    expect(metadata().path).toBe("/api/v1/sastanci/8f3c/ucesnici/[redacted]");
    expect(metadata().params).toEqual({ id: "8f3c", email: "[redacted]" });
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "pera.peric",
    );
  });

  it("e-mail u `%40` obliku se takođe redigure", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx(
          "PATCH",
          "/api/v1/sastanci/8f3c/ucesnici/mika%40servoteh.com",
          {},
          { id: "8f3c" },
        ),
        next,
      ),
    );

    expect(metadata().path).toBe("/api/v1/sastanci/8f3c/ucesnici/[redacted]");
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(
      "mika",
    );
  });

  it("redakcija ne dira obične brojčane segmente (kopiranje ostaje čitljivo)", async () => {
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/work-orders/47717/copy-from/47719", {}, {
          id: "47717",
          sourceId: "47719",
        }),
        next,
      ),
    );

    expect(metadata().path).toContain("47719");
  });

  it("neimenovane (numeričke) grupe iz Express-a se ne upisuju", async () => {
    // Express uz imenovane parametre ume da doda i `0`, `1`… za wildcard grupe;
    // čitaocu audita ne znače ništa i samo prljaju trag.
    await firstValueFrom(
      interceptor.intercept(
        ctx("POST", "/api/v1/documents/5/files/x.pdf", {}, {
          id: "5",
          0: "x.pdf",
        }),
        next,
      ),
    );

    expect(metadata().params).toEqual({ id: "5" });
  });

  it("pad audit upisa NE obara zahtev (fire-and-forget)", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(
      firstValueFrom(
        interceptor.intercept(
          ctx("POST", "/api/v1/dictation-inbox", { text: "x" }),
          next,
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });
});
