import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SET-ROLE disciplina (audit §2.3.1, doktrina §A.2a) — statička invarijanta.
 *
 * `servosync2_app` je BYPASSRLS: direktan Prisma/`db.*` put ILI `withUser`/`runIdempotent`
 * (BEZ `SET LOCAL ROLE authenticated`) ZAOBILAZI svih 102 sy15 RLS politike. Jedan takav
 * propust u CMMS-u = potpuni gubitak row-scope-a (operator machine-scope, chief-bez-role,
 * WO dodeljeni/prijavilac, 24h pravilo, PII vozača…). Zato SVAKI pristup sy15 servisu iz
 * `odrzavanje.service.ts` MORA ići kroz RLS-svesnu putanju: `withUserRls` ili
 * `runIdempotentRls` (oba rade `SET LOCAL ROLE authenticated` u istoj tx).
 *
 * Test čita izvor i traži SVAKI `this.sy15.<član>` — jedini dozvoljeni članovi su
 * `withUserRls` i `runIdempotentRls`. Bilo šta drugo (`.db`, `.withUser(`,
 * `.runIdempotent(`, novi bypass) obara test sa jasnom porukom. (Storage proxy
 * `this.storage.*` je zaseban servis i NIJE DB put — ne proverava se ovde.)
 */
describe("Održavanje — SET-ROLE disciplina (BYPASSRLS tripwire)", () => {
  const SRC = readFileSync(
    join(__dirname, "odrzavanje.service.ts"),
    "utf8",
  );

  const ALLOWED = new Set(["withUserRls", "runIdempotentRls"]);

  it("svaki pristup `this.sy15.*` ide kroz withUserRls/runIdempotentRls (nikad BYPASSRLS put)", () => {
    const offenders: string[] = [];
    const re = /this\.sy15\.([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC)) !== null) {
      const member = m[1];
      if (!ALLOWED.has(member)) {
        const line = SRC.slice(0, m.index).split("\n").length;
        offenders.push(`this.sy15.${member} (linija ${line})`);
      }
    }
    expect({
      offenders,
      hint:
        offenders.length > 0
          ? "BYPASSRLS put: koristi withUserRls/runIdempotentRls (SET LOCAL ROLE authenticated)"
          : "ok",
    }).toEqual({ offenders: [], hint: "ok" });
  });

  it("ne poziva sirov `withUser(`/`runIdempotent(` (bez -Rls) niti `sy15.db`", () => {
    // Precizni patterni: `.withUserRls(`/`.runIdempotentRls(` NE upadaju (drugi sufiks).
    expect(/this\.sy15\.withUser\s*\(/.test(SRC)).toBe(false);
    expect(/this\.sy15\.runIdempotent\s*\(/.test(SRC)).toBe(false);
    expect(/this\.sy15\.db\b/.test(SRC)).toBe(false);
  });

  it("pozitivna kontrola: izvor STVARNO koristi RLS-svesne putanje", () => {
    expect(/this\.sy15\.withUserRls\(/.test(SRC)).toBe(true);
    expect(/this\.sy15\.runIdempotentRls\(/.test(SRC)).toBe(true);
  });
});
