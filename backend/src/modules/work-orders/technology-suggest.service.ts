import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  drawingMatch,
  estimateForDrawing,
  isGenericDrawing,
  wcQuantiles,
  MALO_N,
  TP_VALIDNA,
  type RawSqlClient,
  type DrawingOrderRow,
} from "./time-estimate.service";

/**
 * TALAS AI-6 — PREDLOG TEHNOLOGIJE IZ ISTORIJE CRTEŽA (ponovna upotreba).
 *
 * NIJE LLM i NIJE generisanje nove tehnologije. Kad tehnolog otvori nalog za
 * crtež koji je VEĆ RAĐEN (21–36% posla se ponavlja), ovaj servis iz PROŠLIH
 * naloga tog crteža sklopi GOTOV NACRT tehnološkog postupka: redosled operacija,
 * radna mesta, plan (Tpz/Tk) i STVARNU procenu vremena po radnom mestu — kao
 * PREDLOG koji tehnolog prihvata ili dorađuje. Read-only, nivo 3 autonomije
 * (draft): ništa se NE upisuje automatski (plan §2.2, human-in-the-loop).
 *
 * ── ODNOS PREMA AI-5 (reuse, ne kopija) ─────────────────────────────────────
 * Sva „stvarna vremena" idu kroz iste pure-funkcije kao Talas AI-5
 * (`time-estimate.service`): `estimateForDrawing` (agregat plan-vs-stvarno po RM
 * za baš ovaj crtež) i `wcQuantiles` (h/kom po radnom mestu iz cele istorije).
 * Time važi ISTI filter šuma `TP_VALIDNA` (>=1 min, <=720 h, is_process_finished,
 * zero-piece izbačen), ista simetrična agregacija (po nalogu+RM), order-qty
 * denominator i kvantili p25/p50/p75 sa `n` — AI-6 ne izmišlja svoju računicu.
 * Poklapanje crteža ide kroz deljeni `drawingMatch` (isti indeksirani izraz kao
 * `core-tools`, `work-orders.service`, AI-5).
 *
 * ── ŠTA AI-6 DODAJE PREKO AI-5 ──────────────────────────────────────────────
 * AI-5 daje AGREGAT po radnom mestu (min/median h za ceo crtež), ali NE i sam
 * RUTING (uređenu listu operacija sa opisima). AI-6 bira REPREZENTATIVAN nalog i
 * iz njega uzima ruting. „Reprezentativan" = potpis rutinga (uređen niz šifri
 * radnih mesta) koji se javlja na NAJVIŠE naloga; kod izjednačenja najskoriji,
 * uz prednost nalogu koji je STVARNO proizveden (ima bar jednu validnu prijavu).
 *
 * ── NEKONZISTENTNI RUTINZI (mereno na produ: 51% ponovljenih crteža) ─────────
 * Pola crteža sa >=2 naloga ima RAZLIČIT postupak između naloga (npr. izostave
 * se međufazne kontrole). Zato se rutinzi NE spajaju u prosek: broje se varijante
 * potpisa i vraća se `konzistentno=false` + lista svih varijanti („6 naloga, 2
 * različita postupka") — predlaže se najčešći, a tehnolog vidi da ima izbora.
 *
 * ── NEMA ISTORIJE (84% crteža je unikat) ────────────────────────────────────
 * Za crtež bez prethodnog rutinga vraća se EKSPLICITNO `ima_istoriju:false` sa
 * porukom — NE prazan objekat koji liči na „nema operacija". Generički/„opšti"
 * broj crteža (<3 alfanum. znaka) se NE agregira (spojio bi nepovezan rad).
 */

/** Jedna predložena operacija rutinga (plan + stvarna procena vremena). */
export interface SuggestedOperation {
  /** Redni broj operacije (operation_number reprezentativnog naloga). */
  rb: number;
  radno_mesto: string;
  naziv_radnog_mesta: string | null;
  opis: string | null;
  /** Norma pripreme Tpz (SATI, PO NALOGU) iz reprezentativnog naloga. */
  plan_tpz: number | null;
  /** Norma ciklusa Tk (SATI, PO KOMADU) iz reprezentativnog naloga. */
  plan_tk: number | null;
  /**
   * Stvarna procena po RADNOM MESTU (h/kom, cela istorija RM) — AI-5 wcQuantiles.
   * `null` kad na tom RM nema nijedne validne prijave (npr. međufazna kontrola,
   * koja se ne štancuje na kiosku).
   */
  rm_procena: {
    n: number;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    malo_podataka: boolean;
  } | null;
  /** Stvarni sati PO NALOGU baš ovog crteža na tom RM (AI-5 estimateForDrawing). */
  crtez_procena: {
    n_naloga: number;
    stvarno_h_p50: number | null;
    stvarno_h_min: number | null;
  } | null;
}

/** Jedna varijanta rutinga (grupa naloga sa istim potpisom) — za nekonzistenciju. */
export interface RutingVarijanta {
  broj_naloga: number;
  /** Broj operacija u toj varijanti (iz njenog najskorijeg naloga). */
  operacija: number;
  /** Uređen niz šifri radnih mesta (potpis rutinga, uklj. ponavljanja). */
  radna_mesta: string[];
  najskoriji_ident: string;
  najskoriji_otvoren: string | null;
  /** true = ova varijanta je predložena (najčešća / najskorija). */
  izabran: boolean;
  /**
   * RN te varijante koji „Prepiši ovu" kopira (review [4]) — najskoriji PROIZVEDEN
   * nalog varijante, inače najskoriji. Kod nekonzistentnih rutinga tehnolog može
   * da prepiše baš varijantu koju gleda, ne samo predloženu.
   */
  kopiraj_id: number;
  kopiraj_ident: string;
}

export interface TechnologySuggestion {
  ima_istoriju: true;
  crtez: string;
  /** Broj PROŠLIH naloga (sa rutingom) koji čine osnovu predloga. */
  osnov_naloga: number;
  /** Svi nalozi tog crteža (uklj. bez rutinga) — iz AI-5 estimateForDrawing. */
  ukupno_naloga: number;
  /** true = svi nalozi imaju isti postupak (jedna varijanta rutinga). */
  konzistentno: boolean;
  broj_varijanti: number;
  varijante: RutingVarijanta[];
  reprezentativan_nalog: {
    /** RN id — FE ga koristi za „Prepiši ovaj postupak" (postojeći copy-from tok). */
    id: number;
    ident: string;
    varijanta: number;
    kolicina: number;
    otvoren: string | null;
    /** true = nalog ima bar jednu validnu prijavu (postupak stvarno izveden). */
    proizveden: boolean;
  };
  operacije: SuggestedOperation[];
  /** Raniji nalozi istog crteža (dokazi za drill-down) — iz AI-5. */
  poslednji_nalozi: DrawingOrderRow[];
  napomena: string;
}

export interface NemaTehnologije {
  ima_istoriju: false;
  crtez: string;
  genericki: boolean;
  ukupno_naloga: number;
  poruka: string;
}

const PRAZAN_UPIT = {
  greska: "prazan_upit" as const,
  poruka: "Navedi broj crteža ili ident broj naloga.",
};

/** Gornja granica kandidata — potpis se računa po nalogu, pa je scan jeftin. */
const MAX_KANDIDATA = 200;

interface Kandidat {
  id: number;
  ident: string;
  varijanta: number;
  kolicina: number;
  otvoren: string | null;
  operacija: number;
  potpis: string;
  proizveden: boolean;
}

export interface SuggestOpts {
  /**
   * RN koji se izuzima iz osnove — TRENUTNI nalog za koji se predlog traži.
   * „Predlog iz PROŠLIH naloga" ne sme da uključi sam sebe (npr. kad tehnolog
   * već ima delimičan ruting na tekućem RN-u).
   */
  excludeWorkOrderId?: number;
  /**
   * Preskoči ident→crtež razrešavanje (review [11]): REST/FE UVEK šalje pravi
   * broj crteža (`rn.drawingNumber`), pa je ~116 ms Seq Scan `poIdentu` lookup
   * čist trošak. Alat asistenta OSTAVLJA `false` (model sme poslati ident broj).
   */
  skipIdentResolve?: boolean;
}

/**
 * PREDLOG TEHNOLOGIJE za dati broj crteža (ili ident broj RN-a → razreši crtež).
 * Vraća reprezentativan ruting + stvarnu procenu vremena, ili jasan „nema
 * istorije". Sve READ-ONLY nad glavnom bazom; ništa se ne upisuje.
 */
export async function suggestForDrawing(
  prisma: RawSqlClient,
  crtezRaw: string,
  opts: SuggestOpts = {},
): Promise<TechnologySuggestion | NemaTehnologije | typeof PRAZAN_UPIT> {
  const input = (crtezRaw ?? "").trim();
  if (!input) return PRAZAN_UPIT;

  // REUSE AI-5: razrešava ident→crtež, detektuje generički, daje agregat
  // plan-vs-stvarno po RM za baš ovaj crtež i listu ranijih naloga (dokazi).
  // `skipIdentResolve` (review [11]): REST/FE šalje pravi broj crteža → bez
  // suvišnog Seq Scan ident lookup-a.
  const draw = await estimateForDrawing(prisma, input, {
    skipIdentResolve: opts.skipIdentResolve,
  });
  if ("greska" in draw) return PRAZAN_UPIT;
  const crtez = draw.crtez;
  if (draw.genericki) {
    return {
      ima_istoriju: false,
      crtez,
      genericki: true,
      ukupno_naloga: 0,
      poruka:
        "Broj crteža je generički/„opšti“ — istorija tehnologije se ne predlaže (spojila bi nepovezane naloge).",
    };
  }

  // Kandidati = prošli nalozi TOG crteža koji IMAJU ruting. `potpis` = uređen niz
  // šifri radnih mesta (redosled operacija) → identitet rutinga; NAMERNO nosi samo
  // RM šifre, ne Tpz/Tk/opis (review [3]): sitne razlike u normama bi razbile svaki
  // ruting u zasebnu „varijantu" i pretvorile alarm nekonzistencije u šum.
  // `proizveden` = postupak je stvarno izveden (bar jedna validna prijava — TP_VALIDNA).
  //
  // OSNOVA JE ORIGINALNA, IZVEDENA TEHNOLOGIJA (review [0][1][5][8]):
  //  • `quality_type_id = 0` — izbaci ŠKART/DORADU (=2 dorada, =3 škart u sistemu):
  //    njihov ruting je popravka, ne originalna izrada.
  //  • `parent_work_order_id = 0` — izbaci dete-naloge (-S/-D ponovke): kopije/
  //    dorade, ne izvorni postupak.
  const excl = opts.excludeWorkOrderId;
  const kandidati = await prisma.$queryRaw<Kandidat[]>(Prisma.sql`
    WITH nalozi AS (
      SELECT wo.id, wo.ident_number AS ident, wo.variant AS varijanta,
             wo.piece_count AS kolicina, wo.entered_at,
             to_char(wo.entered_at, 'DD.MM.YYYY') AS otvoren
        FROM work_orders wo
       WHERE ${drawingMatch(Prisma.sql`wo.drawing_number`, crtez)}
         AND COALESCE(wo.quality_type_id, 0) = 0
         AND COALESCE(wo.parent_work_order_id, 0) = 0
         ${excl ? Prisma.sql`AND wo.id <> ${excl}` : Prisma.empty}
    ),
    ruting AS (
      SELECT woo.work_order_id AS id, count(*)::int AS operacija,
             string_agg(woo.work_center_code, '>'
                        ORDER BY woo.operation_number, woo.work_center_code) AS potpis
        FROM work_order_operations woo
        JOIN nalozi n ON n.id = woo.work_order_id
       GROUP BY 1
    )
    SELECT n.id, n.ident, n.varijanta, n.kolicina, n.otvoren,
           r.operacija, r.potpis,
           EXISTS (
             SELECT 1 FROM tech_processes tp
              WHERE tp.work_order_id = n.id AND ${TP_VALIDNA}
           ) AS proizveden
      FROM nalozi n
      JOIN ruting r ON r.id = n.id
     ORDER BY n.entered_at DESC
     LIMIT ${MAX_KANDIDATA}`);

  if (!kandidati.length) {
    // draw.broj_naloga broji SVE naloge crteža (uklj. tekući i one bez rutinga).
    const bezRutinga = draw.broj_naloga - (excl ? 1 : 0) > 0;
    return {
      ima_istoriju: false,
      crtez,
      genericki: false,
      ukupno_naloga: draw.broj_naloga,
      poruka: bezRutinga
        ? "Crtež je već korišćen, ali nijedan raniji nalog nema unet tehnološki postupak — nema šta da se predloži."
        : "Nema prethodne tehnologije za ovaj crtež — radi se prvi put.",
    };
  }

  // Grupisanje po potpisu rutinga. `kandidati` su DESC po datumu → prvi red svake
  // grupe je NAJSKORIJI nalog te varijante.
  const grupe = new Map<string, Kandidat[]>();
  for (const r of kandidati) {
    const g = grupe.get(r.potpis);
    if (g) g.push(r);
    else grupe.set(r.potpis, [r]);
  }

  // IZBOR REPREZENTATIVNE VARIJANTE (review [0][1][5][8]) — `proizveden` ulazi u
  // RANGIRANJE, ne samo kao tie-break unutar već izabrane grupe. Bez ovoga se
  // (na 8,6% crteža) bira NEPROIZVEDEN ruting iako proizveden postoji: kod svih-
  // različitih potpisa (svaka grupa = 1) pobeđivao je puki najskoriji, koji je
  // često nedovršen/parcijalan nacrt. Zato:
  //  1. skup potpisa za izbor = SAMO proizvedeni, kad ijedan postoji (inače svi —
  //     napomena tada upozorava da nema dokaza o izvođenju),
  //  2. među njima najčešći; kod izjednačenja najskoriji (order-stable nad DESC).
  const proizvedeniPotpisi = new Set(
    kandidati.filter((r) => r.proizveden).map((r) => r.potpis),
  );
  const izborniPotpisi = proizvedeniPotpisi.size
    ? proizvedeniPotpisi
    : new Set(grupe.keys());
  let maxBroj = 0;
  for (const p of izborniPotpisi) {
    maxBroj = Math.max(maxBroj, grupe.get(p)?.length ?? 0);
  }
  let izabranPotpis = kandidati[0].potpis;
  for (const r of kandidati) {
    if (
      izborniPotpisi.has(r.potpis) &&
      (grupe.get(r.potpis)?.length ?? 0) === maxBroj
    ) {
      izabranPotpis = r.potpis;
      break;
    }
  }
  const izabraniRedovi = grupe.get(izabranPotpis) ?? [kandidati[0]];
  // Reprezentativan nalog varijante: najskoriji PROIZVEDEN, inače najskoriji.
  const repZa = (redovi: Kandidat[]): Kandidat =>
    redovi.find((r) => r.proizveden) ?? redovi[0];
  const rep = repZa(izabraniRedovi);

  // Ruting reprezentativnog naloga = sam PREDLOG operacija.
  const operacijeRaw = await prisma.$queryRaw<
    {
      rb: number;
      radno_mesto: string;
      naziv_radnog_mesta: string | null;
      opis: string | null;
      plan_tpz: number | null;
      plan_tk: number | null;
    }[]
  >(Prisma.sql`
    SELECT woo.operation_number AS rb, woo.work_center_code AS radno_mesto,
           o.work_center_name AS naziv_radnog_mesta, woo.work_description AS opis,
           woo.setup_time::float8 AS plan_tpz, woo.cycle_time::float8 AS plan_tk
      FROM work_order_operations woo
      LEFT JOIN operations o ON o.work_center_code = woo.work_center_code
     WHERE woo.work_order_id = ${rep.id}
     ORDER BY woo.operation_number
     LIMIT 60`);

  // Stvarna procena po radnom mestu (h/kom, cela istorija) — REUSE AI-5 wcQuantiles.
  const codes = [...new Set(operacijeRaw.map((o) => o.radno_mesto))];
  const wc = await wcQuantiles(prisma, codes);
  const wcMap = new Map(wc.map((r) => [r.radno_mesto, r]));
  // Stvarni sati baš OVOG crteža po RM (h/nalog) — iz AI-5 estimateForDrawing.
  const crtezMap = new Map(draw.po_radnom_mestu.map((r) => [r.radno_mesto, r]));

  const operacije: SuggestedOperation[] = operacijeRaw.map((op) => {
    const q = wcMap.get(op.radno_mesto);
    const cr = crtezMap.get(op.radno_mesto);
    return {
      rb: op.rb,
      radno_mesto: op.radno_mesto,
      naziv_radnog_mesta: op.naziv_radnog_mesta,
      opis: op.opis,
      plan_tpz: op.plan_tpz,
      plan_tk: op.plan_tk,
      rm_procena:
        q && q.n > 0
          ? {
              n: q.n,
              p25: q.p25,
              p50: q.p50,
              p75: q.p75,
              malo_podataka: q.n < MALO_N,
            }
          : null,
      crtez_procena:
        cr && (cr.naloga_sa_prijavom ?? 0) > 0
          ? {
              n_naloga: cr.naloga_sa_prijavom ?? 0,
              stvarno_h_p50: cr.stvarno_h_p50,
              stvarno_h_min: cr.stvarno_h_min,
            }
          : null,
    };
  });

  const varijante: RutingVarijanta[] = [...grupe.entries()]
    .map(([potpis, redovi]) => {
      const rv = repZa(redovi); // reprezentativan nalog BAŠ te varijante (copy izvor)
      return {
        broj_naloga: redovi.length,
        operacija: rv.operacija,
        radna_mesta: potpis.split(">"),
        najskoriji_ident: redovi[0].ident,
        najskoriji_otvoren: redovi[0].otvoren,
        izabran: potpis === izabranPotpis,
        kopiraj_id: rv.id,
        kopiraj_ident: rv.ident,
      };
    })
    .sort((a, b) => b.broj_naloga - a.broj_naloga);

  const konzistentno = grupe.size === 1;
  const osnov = kandidati.length;

  return {
    ima_istoriju: true,
    crtez,
    osnov_naloga: osnov,
    ukupno_naloga: draw.broj_naloga,
    konzistentno,
    broj_varijanti: grupe.size,
    varijante,
    reprezentativan_nalog: {
      id: rep.id,
      ident: rep.ident,
      varijanta: rep.varijanta,
      kolicina: rep.kolicina,
      otvoren: rep.otvoren,
      proizveden: rep.proizveden,
    },
    operacije,
    poslednji_nalozi: draw.poslednji_nalozi,
    napomena:
      `Predlog je REPREZENTATIVAN ruting iz ${osnov} prošlih REGULARNIH naloga ovog crteža ` +
      `(škart/dorada i dete-nalozi izuzeti; prednost postupku koji je STVARNO proizveden, pa najčešćem, pa najskorijem). ` +
      `„plan_tpz“/„plan_tk“ su norme u SATIMA iz reprezentativnog naloga — Tpz PO NALOGU, Tk PO KOMADU. ` +
      `„rm_procena“ = koliko slični poslovi STVARNO traju po komadu na tom radnom mestu (interval p25–p75 iz cele istorije; mali n označen). ` +
      `„crtez_procena“ = stvarni sati PO NALOGU baš ovog crteža na tom RM. ` +
      (rep.proizveden
        ? ""
        : "PAŽNJA: nijedan nalog ovog crteža nema potvrđenu proizvodnju — predlog je iz nedovršenog/neproverenog rutinga, uzmi sa rezervom. ") +
      (konzistentno
        ? "Svi regularni nalozi imaju isti postupak."
        : `PAŽNJA: nalozi se razlikuju — ${grupe.size} različitih postupaka na ${osnov} naloga; predložen je proizveden/najčešći, proveri koji odgovara.`) +
      " Predlog je informativan — tehnolog ga prihvata ili dorađuje; ništa se ne upisuje automatski.",
  };
}

/**
 * NestJS omotač — `{ data }` envelope (BACKEND_RULES §5) nad pure-funkcijom koju
 * dele i endpoint i alat asistenta. Sav rad je READ-ONLY nad glavnom bazom.
 */
@Injectable()
export class TechnologySuggestService {
  constructor(private readonly prisma: PrismaService) {}

  async forDrawing(crtez: string, excludeWorkOrderId?: number) {
    // REST/FE UVEK šalje pravi broj crteža (`rn.drawingNumber`) → preskoči ident
    // razrešavanje (review [11]). Alat asistenta zove pure funkciju bez ovog flag-a.
    return {
      data: await suggestForDrawing(this.prisma, crtez, {
        excludeWorkOrderId,
        skipIdentResolve: true,
      }),
    };
  }
}
