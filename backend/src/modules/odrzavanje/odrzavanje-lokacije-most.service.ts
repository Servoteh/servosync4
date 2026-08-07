import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { maintMachineDeptCode } from "./maint-dept-code";

/**
 * 🔴 ŠAV KA LOKACIJAMA — privremeni MOST, i to je DUG za korak 3 seobe.
 *
 * ── Šta je izvorno radilo ────────────────────────────────────────────────────
 * U sy15 na `maint_machines` stoji `AFTER INSERT OR UPDATE` triger
 * `trg_maint_machines_loc_sync` -> `maint_machines_sync_to_loc()`, koji PIŠE u
 * `public.loc_locations` — dakle u TUĐI domen (Lokacije, korak 3). Izmereno
 * 06.08.2026: 86/86 aktivnih praćenih mašina ima red u `loc_locations`
 * (90 `MACHINE` lokacija ukupno). FK graf taj šav NE POKAZUJE — našao ga je
 * `pg_trigger` + čitanje tela.
 *
 * Pravilo trigera (prepisano doslovno):
 *   INSERT: upiši SAMO aktivnu (`archived_at IS NULL`) i praćenu (`tracked`)
 *           mašinu, i to kao dete „hale" čija je šifra `maint_machine_dept_code`.
 *           Ako hale nema -> `RAISE WARNING` i preskoči (NE obara upis mašine).
 *   UPDATE: prati `name`, `archived_at`, `tracked`. Ako reda nema a mašina je
 *           sada aktivna -> ponaša se kao INSERT. Inače ažurira `name` i
 *           `is_active`, i to samo kad se stvarno menjaju.
 *           Šifra (PK) se NE prati — preimenovanje ide kroz `maint_machine_rename`
 *           koji `loc_locations` NAMERNO ne dira.
 *
 * ── Zašto MOST, a ne prepis nad 3.0 ─────────────────────────────────────────
 * Pod `ODRZAVANJE_IZVOR=3.0` mašine su u 3.0 bazi, ali `loc_locations` je i dalje
 * u sy15 (Lokacije = korak 3, još nisu preseljene; 3.0 `maint_locations` je
 * DRUGA tabela — CMMS stablo, ne stablo Lokacija). Da ovaj upis nestane,
 * novougrađena mašina ne bi dobila lokaciju, a arhivirana bi u Reversima ostala
 * „aktivna" — tiho, bez ijedne greške u logu.
 *
 * 🔴 SVESNO ODSTUPANJE OD IZVORA (jedno, i mora se znati):
 * u sy15 je upis u `loc_locations` bio u ISTOJ transakciji kao upis mašine, pa
 * se rollback-om vraćalo oboje. Ovde su to dve baze — most se zato poziva TEK
 * POSLE commit-a 3.0 transakcije i **fail-soft** je (greška se loguje, ne diže).
 * Obrazloženje: izvor je i sam bio fail-soft za jedini realan kvar (nema hale ->
 * `RAISE WARNING`), a obaranje čuvanja mašine zbog nedostupne TUĐE baze bilo bi
 * gore od privremenog razilaženja. Razilaženje se sanira samo od sebe: operacija
 * je idempotentna (`ON CONFLICT DO NOTHING` + uslovni `UPDATE`), pa je sledeća
 * izmena iste mašine popravlja.
 *
 * ── Kad ovo umire ───────────────────────────────────────────────────────────
 * Sa korakom 3 (Reversi + Lokacije). Tada `loc_locations` prelazi u 3.0 i most
 * postaje običan upis u istu bazu — u istoj transakciji, bez odstupanja iznad.
 * Do tada je ovo JEDINI upis održavanja u sy15 pod `ODRZAVANJE_IZVOR=3.0`.
 */
@Injectable()
export class OdrzavanjeLokacijeMostService {
  private readonly log = new Logger(OdrzavanjeLokacijeMostService.name);

  constructor(
    private readonly sy15: Sy15Service,
    @Optional() private readonly izvor?: OdrzavanjeSourceService,
  ) {}

  /**
   * Parnjak `maint_machines_sync_to_loc()` za INSERT i UPDATE.
   *
   * Poziva se POSLE uspešnog upisa mašine u 3.0. `staro` je stanje pre izmene
   * (`undefined` za INSERT) — služi samo da se prepozna koja je grana izvora.
   *
   * Nikad ne baca: svaka greška se loguje kao WARN i vraća `{ ok: false }`.
   */
  async syncMachineToLoc(
    m: {
      machineCode: string;
      name: string | null;
      archivedAt: Date | null;
      tracked: boolean;
    },
    op: "INSERT" | "UPDATE",
  ): Promise<{ ok: boolean; akcija: "insert" | "update" | "preskoceno" }> {
    try {
      return await this.sync(m, op);
    } catch (e) {
      // Fail-soft po dizajnu (v. zaglavlje). Mašina JE sačuvana u 3.0; ovde je
      // pao samo derivat u tuđoj bazi, koji sledeća izmena iste mašine popravlja.
      this.log.warn(
        `Most ka loc_locations nije uspeo za mašinu ${m.machineCode} (${op}): ` +
          `${e instanceof Error ? e.message : String(e)}. ` +
          "Mašina je sačuvana; lokacija će se poravnati pri sledećoj izmeni. " +
          "Ovaj most nestaje sa korakom 3 (Lokacije).",
      );
      return { ok: false, akcija: "preskoceno" };
    }
  }

  private async sync(
    m: {
      machineCode: string;
      name: string | null;
      archivedAt: Date | null;
      tracked: boolean;
    },
    op: "INSERT" | "UPDATE",
  ): Promise<{ ok: boolean; akcija: "insert" | "update" | "preskoceno" }> {
    const code = (m.machineCode ?? "").trim();
    if (code.length === 0) return { ok: true, akcija: "preskoceno" };

    if (op === "INSERT") {
      // Izvor: upiši SAMO aktivnu i praćenu mašinu.
      if (m.archivedAt != null || m.tracked === false) {
        return { ok: true, akcija: "preskoceno" };
      }
      return this.upisi(code, m.name);
    }

    const trebaAktivna = m.archivedAt == null && m.tracked !== false;
    const postoji = await this.sy15.db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM public.loc_locations WHERE location_code = ${code} LIMIT 1`,
    );
    if (postoji.length === 0) {
      // „Mašina je bila netracked pa je vraćena" — izvor tada radi INSERT.
      if (!trebaAktivna) return { ok: true, akcija: "preskoceno" };
      return this.upisi(code, m.name);
    }

    const naziv = (m.name ?? "").trim();
    await this.sy15.db.$executeRaw(Prisma.sql`
      UPDATE public.loc_locations
         SET name = COALESCE(NULLIF(${naziv}, ''), name),
             is_active = ${trebaAktivna}
       WHERE location_code = ${code}
         AND (name IS DISTINCT FROM COALESCE(NULLIF(${naziv}, ''), name)
              OR is_active IS DISTINCT FROM ${trebaAktivna})`);
    return { ok: true, akcija: "update" };
  }

  /** INSERT grana — nađi halu po `maint_machine_dept_code` pa upiši dete. */
  private async upisi(
    code: string,
    name: string | null,
  ): Promise<{ ok: boolean; akcija: "insert" | "preskoceno" }> {
    const deptCode = maintMachineDeptCode(code);
    const hala = await this.sy15.db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM public.loc_locations WHERE location_code = ${deptCode} LIMIT 1`,
    );
    if (hala.length === 0) {
      // Doslovno kao `RAISE WARNING` u izvoru: NE obaraj upis mašine.
      this.log.warn(
        `maint_machines_sync_to_loc: dept hala ${deptCode} ne postoji za mašinu ${code}; preskačem loc_locations sync.`,
      );
      return { ok: true, akcija: "preskoceno" };
    }
    const naziv =
      (name ?? "").trim().length > 0 ? (name as string).trim() : `Mašina ${code}`;
    await this.sy15.db.$executeRaw(Prisma.sql`
      INSERT INTO public.loc_locations
        (location_code, name, location_type, parent_id, is_active, notes)
      VALUES (${code}, ${naziv}, 'MACHINE'::public.loc_type_enum, ${hala[0].id}::uuid, TRUE,
              'Auto-sync iz maint_machines (most 3.0 -> sy15, korak 2 seobe).')
      ON CONFLICT DO NOTHING`);
    return { ok: true, akcija: "insert" };
  }

  /**
   * `true` kad most treba pozvati iz aplikacije (pod `ODRZAVANJE_IZVOR=3.0`).
   * Pod `sy15` posao i dalje radi DB triger — dupli poziv bi bio bezopasan
   * (idempotentan), ali nepotreban.
   */
  aktivan(): boolean {
    return this.izvor?.isThreeZero === true;
  }
}
