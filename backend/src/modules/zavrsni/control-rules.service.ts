/**
 * CONTROL RULES SERVICE — kontrolna pravila završnog računa (Faza 7, D9).
 * =========================================================================
 * Motor kontrolnih pravila nad IZRAČUNATIM AOP vrednostima jednog obračuna
 * (FinancialStatementLine.amount). Svako pravilo poredi dve strane (linearne
 * kombinacije AOP pozicija) i prolazi ako su jednake u okviru tolerancije.
 *
 * BigBit ekvivalent: ZR_AOP_Pravila (kontrolna pravila po obrascu) — ta tabela je
 * binarna u .MDB i NIJE seed-ovana (doc 44 §8 t.4). Zato je katalog ovde HARDKODOVAN
 * za minimalni skup (BS: aktiva=pasiva; BU: rezultat konzistentan). TODO(zr-aop-pravila,
 * Talas 2): premestiti katalog u bazu (npr. model ControlRuleDefinition) i seed-ovati
 * iz ZR_AOP_Pravila dump-a; motor (evaluacija) ostaje isti, samo se lista puni iz DB.
 *
 * AOP OZNAKE (verbatim iz prisma/seed/balance-formulas-real.sql):
 *   BS: UKUPNA AKTIVA = 0001, UKUPNA PASIVA = 0401
 *   BU: NETO DOBITAK = 1068, DOBITAK PRE OPOREZIVANJA = 1064, Porez na dobitak = 1066,
 *       POSLOVNI DOBITAK = 1025, POSLOVNI PRIHODI = 1001, POSLOVNI RASHODI = 1010
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2): sve vrednosti su Prisma.Decimal; poređenje
 * kroz apsolutnu razliku |left-right| <= TOLERANCE.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { STATEMENT_TYPE } from "./statement-type";

const D = Prisma.Decimal;

/**
 * Tolerancija jednakosti (dinar). Iznosi su Decimal(19,4) pune preciznosti (nisu
 * zaokruženi), pa je za balansiran nalog aktiva=pasiva tačno; malu toleranciju
 * držimo radi zaokruživanja u pojedinačnim AOP formulama (deljenja/neto pozicije).
 */
const TOLERANCE = new D("0.01");

/** Jedan sabirak strane pravila: AOP pozicija sa znakom (+1 / -1). */
interface AopTerm {
  aop: string;
  sign: 1 | -1;
}

/** Kontrolno pravilo: naziv + dve strane (linearne kombinacije AOP-a) po obrascu. */
interface ControlRuleDef {
  name: string;
  statementType: string;
  left: AopTerm[];
  right: AopTerm[];
}

/** Rezultat evaluacije jednog pravila (kontroler vraća niz ovih; FE zeleno/crveno). */
export interface ControlResult {
  name: string;
  left: string; // Decimal → string (.toFixed(4))
  right: string; // Decimal → string (.toFixed(4))
  passed: boolean;
}

const plus = (aop: string): AopTerm => ({ aop, sign: 1 });
const minus = (aop: string): AopTerm => ({ aop, sign: -1 });

/**
 * Kontrolna pravila nad ZVANIČNIM AOP oznakama obrasca (Pravilnik 89/2020), usklađena
 * sa seed-om autentičnih formula (`20260726090000_seed_balance_formulas_autenticne`).
 *
 * Prethodni katalog je bio vezan za oznake starog rekonstrukcionog seed-a i posle
 * zamene je bio neupotrebljiv — obe greške su otkrivene studijom BigBita:
 *   • `0001 == 0401` — AOP 0001 je „upisani a neuplaćeni kapital" (0), a NE ukupna
 *     aktiva (to je 0059). Pravilo bi tvrdo padalo i blokiralo finalizaciju obračuna.
 *   • `1068 == 1064 − 1066` — AOP 1064/1066/1068 u obrascu NE POSTOJE. Zbir
 *     nepostojećih pozicija je 0, pa je pravilo LAŽNO PROLAZILO: kontrola koja ništa
 *     ne kontroliše je opasnija od kontrole koja pada.
 *
 * Pravila rezultata su namerno pisana kao PAROVI (dobitak − gubitak): iznosi u obrascu
 * su klampovani na nulu, pa bi `1025 == 1001 − 1013` padalo svaki put kad firma posluje
 * sa gubitkom, iako je bilans tačan. Par važi u oba smera.
 * U komentaru uz svako pravilo su vrednosti iz PREDATOG obrasca 2023 / 2022 — služe kao
 * regresiona referenca kad se motor menja.
 */
const CONTROL_RULES: ControlRuleDef[] = [
  {
    // predati obrazac: 868.293 (2023) / 638.633 (2022)
    name: "Bilansna ravnoteža: ukupna aktiva = ukupna pasiva",
    statementType: STATEMENT_TYPE.BALANCE_SHEET,
    left: [plus("0059")],
    right: [plus("0456")],
  },
  {
    // 167.829 / 141.428
    name: "Kapital = zbir komponenti kapitala",
    statementType: STATEMENT_TYPE.BALANCE_SHEET,
    left: [plus("0401")],
    right: [
      plus("0402"),
      plus("0403"),
      plus("0404"),
      plus("0405"),
      plus("0406"),
      minus("0407"),
      plus("0408"),
      plus("0411"),
      minus("0412"),
    ],
  },
  {
    // 653.419 / 422.440
    name: "Ukupni prihodi = zbir grupa prihoda",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1043")],
    right: [plus("1001"), plus("1027"), plus("1039"), plus("1041")],
  },
  {
    // 617.063 / 376.763
    name: "Ukupni rashodi = zbir grupa rashoda",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1044")],
    right: [plus("1013"), plus("1032"), plus("1040"), plus("1042")],
  },
  {
    // PAR (dobitak − gubitak): 20.133 / 38.389
    name: "Poslovni rezultat = poslovni prihodi − poslovni rashodi",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1025"), minus("1026")],
    right: [plus("1001"), minus("1013")],
  },
  {
    // PAR: −3.096 / −3.806 (Servoteh je u obe godine u gubitku iz finansiranja)
    name: "Rezultat finansiranja = finansijski prihodi − finansijski rashodi",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1037"), minus("1038")],
    right: [plus("1027"), minus("1032")],
  },
  {
    // PAR: 34.636 / 41.817
    name: "Neto rezultat = rezultat pre oporezivanja − porez i lična primanja",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1055"), minus("1056")],
    right: [
      plus("1049"),
      minus("1050"),
      minus("1051"),
      minus("1052"),
      plus("1053"),
      minus("1054"),
    ],
  },
];

/** Obračun za koji se traže kontrole ne postoji. */
export class ControlStatementNotFoundException extends NotFoundException {
  readonly code = "ZR_STATEMENT_NOT_FOUND";
  constructor(statementId: number) {
    super(`FinancialStatement ${statementId} ne postoji.`);
    this.name = "ControlStatementNotFoundException";
  }
}

@Injectable()
export class ControlRulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Evaluiraj sva pravila primenljiva na obrazac datog obračuna. Vraća
   * [{name, left, right, passed}] — prazan niz ako obrazac nema definisana pravila
   * (npr. SI/statistički). AOP pozicije koje ne postoje u obračunu tretiraju se kao 0.
   */
  async evaluateControls(statementId: number): Promise<ControlResult[]> {
    const statement = await this.prisma.financialStatement.findUnique({
      where: { id: statementId },
      include: { lines: true },
    });
    if (!statement) {
      throw new ControlStatementNotFoundException(statementId);
    }

    const amounts = new Map<string, Prisma.Decimal>();
    for (const l of statement.lines) {
      amounts.set(l.aop, l.amount instanceof D ? l.amount : new D(l.amount));
    }

    const rules = CONTROL_RULES.filter(
      (r) => r.statementType === statement.statementType,
    );

    return rules.map((rule) => {
      const left = sumTerms(rule.left, amounts);
      const right = sumTerms(rule.right, amounts);
      const passed = left.sub(right).abs().lessThanOrEqualTo(TOLERANCE);
      return {
        name: rule.name,
        left: left.toFixed(4),
        right: right.toFixed(4),
        passed,
      };
    });
  }
}

/** Σ (sign × AOP.amount) za sabirke jedne strane; nedostajući AOP = 0. */
function sumTerms(
  terms: AopTerm[],
  amounts: Map<string, Prisma.Decimal>,
): Prisma.Decimal {
  let acc = new D(0);
  for (const t of terms) {
    const v = amounts.get(t.aop) ?? new D(0);
    acc = t.sign === 1 ? acc.add(v) : acc.sub(v);
  }
  return acc;
}
