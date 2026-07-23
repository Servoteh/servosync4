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
 * Hardkodovani katalog (TODO Talas 2 → DB). Minimalni skup po zadatku:
 *   BS — bilansna ravnoteža: UKUPNA AKTIVA (0001) == UKUPNA PASIVA (0401)
 *   BU — konzistentnost rezultata:
 *        NETO DOBITAK (1068) == DOBITAK PRE OPOREZIVANJA (1064) − Porez (1066)
 *        POSLOVNI DOBITAK (1025) == POSLOVNI PRIHODI (1001) − POSLOVNI RASHODI (1010)
 */
const CONTROL_RULES: ControlRuleDef[] = [
  {
    name: "Bilansna ravnoteža: aktiva = pasiva",
    statementType: STATEMENT_TYPE.BALANCE_SHEET,
    left: [plus("0001")],
    right: [plus("0401")],
  },
  {
    name: "Neto dobitak = dobitak pre oporezivanja − porez",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1068")],
    right: [plus("1064"), minus("1066")],
  },
  {
    name: "Poslovni dobitak = poslovni prihodi − poslovni rashodi",
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    left: [plus("1025")],
    right: [plus("1001"), minus("1010")],
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
