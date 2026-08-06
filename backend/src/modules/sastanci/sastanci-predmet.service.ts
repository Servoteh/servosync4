import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  klasifikujPredmet,
  legacyPredmetIds,
  predmetIdIzUuid,
  type PredmetUlaz,
} from "./sastanci-predmet";

/**
 * Razrešavanje PREDMETA iz zahteva (uuid ili `Int`) u 3.0 `projects.id` —
 * blokada 5, backend deo. Čista logika je u `sastanci-predmet.ts`; ovde su
 * samo baza i keš.
 *
 * KEŠ: obrnut prevod (uuid -> Int) traži da se za svaki poznat `projects.id`
 * izračuna uuid i uporedi — md5 je jednosmeran. 3.0 `projects` ima ~7.600
 * redova, pa je to jedan `SELECT id` i ~7.600 md5 operacija (reda veličine
 * milisekunde). Rezultat se kešira po procesu.
 *
 * PROMAŠAJ NIJE ODMAH GREŠKA: keš se osveži JEDNOM i tek onda se odustaje —
 * predmet napravljen posle poslednjeg punjenja keša mora da prođe bez restarta
 * backend-a. Drugi promašaj je 422, nikad tiho `null` (v. „bezbedan smer" u
 * `sastanci-predmet.ts`).
 */
@Injectable()
export class SastanciPredmetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Svi poznati `projects.id` — kandidati za obrnut prevod. */
  private kandidati: number[] | null = null;

  private async ucitajKandidate(): Promise<number[]> {
    const rows = await this.prisma.project.findMany({ select: { id: true } });
    // Izmereni izuzeci ulaze u skup i kad ih `projects` nema (npr. predmet
    // obrisan u međuvremenu) — njihov prevod je činjenica, ne izvod iz tabele.
    const ids = new Set<number>(rows.map((r) => r.id));
    for (const id of legacyPredmetIds()) ids.add(id);
    this.kandidati = [...ids];
    return this.kandidati;
  }

  /** Ručno pražnjenje keša (test / novi predmet). */
  resetCache(): void {
    this.kandidati = null;
  }

  /**
   * uuid -> `projects.id`. Prvi promašaj osvežava keš; drugi baca 422.
   */
  private async idIzUuid(uuid: string): Promise<number> {
    const prvi = this.kandidati ?? (await this.ucitajKandidate());
    const pogodak = predmetIdIzUuid(uuid, prvi);
    if (pogodak !== null) return pogodak;
    // Keš je možda star (predmet nastao posle punjenja) — jedno osvežavanje.
    const drugi = await this.ucitajKandidate();
    const ponovo = predmetIdIzUuid(uuid, drugi);
    if (ponovo !== null) return ponovo;
    throw new UnprocessableEntityException(
      `Predmet (projekatId) "${uuid}" nema parnjaka u 3.0 registru predmeta. ` +
        "Osveži listu predmeta i izaberi ponovo.",
    );
  }

  /**
   * Vrednost za Prisma `data`/`where` iz DTO ulaza:
   *   `undefined` -> `undefined` (polje se ne dira),
   *   `null`/`''` -> `null` (veza se briše),
   *   broj/uuid   -> `Int`.
   *
   * Neispravan oblik (ni broj ni uuid) je 422 — DTO to već odbija na 400, pa je
   * ovo druga brana za interne pozivaoce.
   */
  async razresi(v: PredmetUlaz): Promise<number | null | undefined> {
    let k: ReturnType<typeof klasifikujPredmet>;
    try {
      k = klasifikujPredmet(v);
    } catch (e) {
      throw new UnprocessableEntityException((e as Error).message);
    }
    switch (k.vrsta) {
      case "nedirano":
        return undefined;
      case "obrisi":
        return null;
      case "id":
        return k.id;
      case "uuid":
        return this.idIzUuid(k.uuid);
    }
  }

  /**
   * Isto, ali za FILTER: `undefined` kad filtera nema. Razlika prema `razresi`
   * je što prazan filter NIJE „obriši" nego „bez filtera".
   */
  async razresiFilter(v: PredmetUlaz): Promise<number | undefined> {
    if (v === undefined || v === null || v === "") return undefined;
    const out = await this.razresi(v);
    return out ?? undefined;
  }
}
