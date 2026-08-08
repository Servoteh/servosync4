import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { OdrzavanjeSourceService } from "../../common/sy15/odrzavanje-source.service";
import { LokacijeSourceService } from "../../common/sy15/lokacije-source.service";
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
 * izmena iste mašine popravlja. Vlasnik je 08.08.2026 potvrdio da fail-soft OSTAJE.
 *
 * ── 🔴 NALAZ C (protivnička provera, treći krug 08.08.2026) ─────────────────
 * Do ove izmene je most bio uslovljen ISKLJUČIVO `ODRZAVANJE_IZVOR=3.0`, bez
 * ijedne `LOKACIJE_IZVOR` kapije. A `loc_locations` JESTE među 21 tabelom koju
 * korak 3 seli (`scripts/migrate-reversi-lokacije-sy15.ts`). Posledica pod
 * `ODRZAVANJE_IZVOR=3.0` + `LOKACIJE_IZVOR=3.0`: lokacija svake mašine odlazi u
 * NAPUŠTENU sy15 bazu koju posle preklopa niko ne čita — i to TIHO, jer je most
 * fail-soft (WARN + `{ok:false}`), pa ni greške nema. Vlasnikova odluka o
 * fail-softu pokriva PRELAZNI režim (Održavanje na 3.0, Lokacije još na sy15);
 * stanje POSLE seobe Lokacija njome nije razmatrano.
 *
 * ── ODLUKA (08.08.2026): most PRATI `LOKACIJE_IZVOR` ────────────────────────
 *   `LOKACIJE_IZVOR=sy15` (PODRAZUMEVANO, i danas na produkciji) — ponašanje je
 *       NEPROMENJENO, red u red kao pre; to je jedini režim koji danas postoji.
 *   `LOKACIJE_IZVOR=3.0` — most se GASI, i to GLASNO (`ERROR` u logu na startu i
 *       na svakom pozivu, `{ ok: false, akcija: "brana" }`).
 *
 * Zašto GAŠENJE, a ne „piši u 3.0" (odbačena varijanta, i to je mereno):
 *   1. `loc_locations` u 3.0 nema prepisan `loc_locations_guard_and_path` — to je
 *      stavka **P1** runbook-a §7. Bez njega bi red imao `path_cached=''` i
 *      `depth=0`, dakle red KOJI POSTOJI a u stablu je pogrešan. To je gore od
 *      reda kog nema: pogrešan red se ne primeti, a nedostatak se traži.
 *   2. 3.0 `loc_locations.id` nema DB default (`@default(uuid(4))` je klijentski,
 *      migracija ima samo `"id" UUID NOT NULL`) — sirov `INSERT` bez `id` pada.
 *   3. Format `path_cached` u sy15 nije izmeren (nema VPN-a u trenutku pisanja);
 *      pogađanje formata bi bilo izmišljanje ponašanja, a ne prepis.
 * Zato: brana sada, a upis u 3.0 (u ISTOJ transakciji kao mašina — odstupanje
 * iznad tada nestaje) ulazi u P1, uz `loc_locations_guard_and_path`. Runbook §7.
 *
 * 🔴 ŠTA SE OSLANJA NA OVO (provereno pre izmene, treći krug):
 *   • `aktivan()` NIJE promenjen — i dalje znači isključivo `ODRZAVANJE_IZVOR=3.0`.
 *     Planirani pozivaoci u `odrzavanje.service.ts` (danas ih još nema; most je
 *     provajdovan i izvožen, ali nepozvan) time ne menjaju ponašanje. Brana je
 *     NAMERNO unutar `syncMachineToLoc`, a ne u `aktivan()`: drži i kad pozivalac
 *     zaboravi da pita `aktivan()`.
 *   • Fail-soft ugovor („nikad ne baca") je očuvan — brana vraća, ne baca.
 *   • Povratni tip je proširen članom `"brana"`; `tsc` bi našao svakog potrošača
 *     koji radi iscrpan `switch` (nema ga — jedini potrošači su testovi).
 *   • `OdrzavanjeModule` sada uvozi `ReversiLokacijeIzvorModule` (da prekidač NE
 *     bude mrtav — pouka prvog kruga). Taj modul u `onModuleInit` zove
 *     `assertSpojeniIzvori`; u aplikaciji ga već uvoze `ReversiModule` i
 *     `LocationsModule`, pa novog načina da se boot obori NEMA.
 *
 * ── Kad ovo umire ───────────────────────────────────────────────────────────
 * Sa korakom 3 (Reversi + Lokacije), i to u P1: tada `loc_locations` prelazi u 3.0
 * i most postaje običan upis u istu bazu — u istoj transakciji, bez odstupanja
 * iznad. Do tada je ovo JEDINI upis održavanja u sy15 pod `ODRZAVANJE_IZVOR=3.0`.
 */
@Injectable()
export class OdrzavanjeLokacijeMostService implements OnModuleInit {
  private readonly log = new Logger(OdrzavanjeLokacijeMostService.name);

  constructor(
    private readonly sy15: Sy15Service,
    @Optional() private readonly izvor?: OdrzavanjeSourceService,
    @Optional() private readonly lokIzvor?: LokacijeSourceService,
  ) {}

  /**
   * Glasno na STARTU, ne tek pri prvoj izmeni mašine. Pouka „docker restart ne
   * čita env" (07.08.2026): pogrešan prekidač ume da radi neprimećeno, a ovde bi
   * to značilo mašine bez lokacije sve dok neko ne primeti prazno stablo.
   */
  onModuleInit(): void {
    // 🔴 USLOV JE SAMO `lokacijeNa30()`, NE i `aktivan()`. Ranije je stajalo
    // `aktivan() && lokacijeNa30()`, pa je poruka ĆUTALA u stanju koje preklop
    // STVARNO proizvodi — a runbook §6 korak 10 odsustvo te poruke čita kao
    // „P1 je gotov". Dakle lažno zeleno, gore od samog kvara.
    //
    // Izmereno 08.08.2026: `ODRZAVANJE_IZVOR` je NEPOSTAVLJEN i 3.0 `maint_*`
    // su prazne → korak 2 nije preklopljen, a korak 6 postavlja SAMO
    // `REVERSI_IZVOR` i `LOKACIJE_IZVOR`. Stanje posle preklopa je zato
    // `ODRZAVANJE=sy15 + LOKACIJE=3.0`.
    //
    // U OBA stanja lokacija mašine završi u NAPUŠTENOJ sy15 tabeli, a živa 3.0
    // `loc_locations` ne dobije red — menja se samo KO je pisac:
    //   • `ODRZAVANJE=3.0`  → pisac bi bio ovaj most; brana ga hvata u letu
    //     (`syncMachineToLoc` vraća `akcija: "brana"`).
    //   • `ODRZAVANJE=sy15` → pisac je **sy15 TRIGER**
    //     `trg_maint_machines_loc_sync`, jer se mašine i dalje upisuju u sy15
    //     `maint_machines`. Taj pisac je u bazi i ovaj kod ga NE MOŽE zaustaviti
    //     — može samo da ga glasno prijavi.
    if (!this.lokacijeNa30()) return;
    this.prijaviBranu(
      this.aktivan()
        ? "start"
        : "start — pisac je sy15 TRIGER `trg_maint_machines_loc_sync`, ne ovaj most; " +
            "kod ga ne može zaustaviti (mašine su još u sy15 `maint_machines`)",
    );
  }

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
  ): Promise<{
    ok: boolean;
    akcija: "insert" | "update" | "preskoceno" | "brana";
  }> {
    // 🔴 NALAZ C: pod `LOKACIJE_IZVOR=3.0` sy15 `loc_locations` je NAPUŠTENA
    // tabela. Upis u nju ne bi bio „malo zastareo" nego nevidljiv, pa se ovde
    // staje — glasno, jer je most inače fail-soft i tih.
    if (this.lokacijeNa30()) {
      this.prijaviBranu(`mašina ${m.machineCode} (${op})`);
      return { ok: false, akcija: "brana" };
    }
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
      (name ?? "").trim().length > 0
        ? (name as string).trim()
        : `Mašina ${code}`;
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
   *
   * 🔴 NAMERNO ne gleda `LOKACIJE_IZVOR`: značenje ove metode je „gde su mašine",
   * a ne „gde su lokacije". Brana za lokacije stoji u `syncMachineToLoc` da bi
   * važila i za pozivaoca koji `aktivan()` uopšte ne pita.
   */
  aktivan(): boolean {
    return this.izvor?.isThreeZero === true;
  }

  /**
   * `true` kad su Lokacije preklopljene na 3.0 — tada je sy15 `loc_locations`
   * napuštena tabela. Bez provajdera (test bez modula) vraća `false`, dakle
   * ponašanje kao `sy15` — nikad kao `3.0` (pravilo iz `IzvorPrekidac`-a:
   * nepoznato/neožičeno se NIKAD ne tumači kao preklopljeno).
   */
  private lokacijeNa30(): boolean {
    return this.lokIzvor?.isThreeZero === true;
  }

  /** Jedna poruka, dva mesta (start + poziv) — da se u logu traži isti tekst. */
  private prijaviBranu(gde: string): void {
    this.log.error(
      `LOKACIJE_IZVOR=3.0 — most maint_machines -> loc_locations je UGAŠEN (${gde}). ` +
        "sy15 `loc_locations` je posle preklopa napuštena tabela; upis u nju bio bi " +
        "nevidljiv. Nove/izmenjene mašine zato NEĆE dobiti red u stablu lokacija dok " +
        "se most ne prepiše na 3.0 (runbook §7, P1 — uz `loc_locations_guard_and_path`). " +
        "Povratak: LOKACIJE_IZVOR=sy15 + restart.",
    );
  }
}
