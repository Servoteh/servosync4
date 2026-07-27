import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Planeri predmeta (zahtev 016/26, Strahinja) — app-owned overlay `predmet_planeri`.
 * 3.0-native (PrismaService, glavna baza), ODVOJEN od sy15 predmet-aktivacija RPC-ova:
 * `project_id` overlay-a = `projects.id` (isti id-prostor kao `item_id` iz Podešavanja
 * predmeta — legacy BigBit predmet id). `projectId = NULL` = globalni planer (prima SVA
 * lansiranja). Dodela je „replace" semantika (obriši-pa-upiši) po predmetu/globalno, pa
 * nema delimičnih stanja ni duplikata. Obaveštenje o lansiranju šalje handovers.launch hook.
 */
@Injectable()
export class PredmetPlaneriService {
  /** Zaštita od slučajnog ogromnog seta (UI picker); poslovno je nekoliko planera po predmetu. */
  private static readonly MAX_PER_TARGET = 20;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pregled za Podešavanje predmeta: mapa predmet→planeri (samo predmeti koji IMAJU planere),
   * globalni planeri i kandidati (aktivni nalozi) za picker. FE spaja po `item_id === projectId`.
   *
   * Dodeljeni planeri se dekorišu preko ZASEBNOG lookup-a (aktivni ∪ neaktivni) — inače bi
   * planer koji je u međuvremenu deaktiviran nestao iz imena, a FE ga ne bi mogao ni skinuti
   * (soft-lock). `active` flag omogućava FE-u da ga prikaže/ukloni; picker (`candidates`) ostaje
   * samo aktivni. Isti razlog zašto replace() prihvata postojeći-neaktivni ID (vidi dole).
   */
  async overview() {
    const [rows, candidates] = await Promise.all([
      this.prisma.predmetPlaner.findMany({
        orderBy: [{ projectId: "asc" }, { id: "asc" }],
        select: { projectId: true, plannerUserId: true },
      }),
      this.prisma.user.findMany({
        where: { active: true },
        orderBy: { fullName: "asc" },
        select: { id: true, fullName: true, email: true },
      }),
    ]);

    // Dekoracija dodeljenih: obuhvata i neaktivne (da im ime/status ostanu vidljivi u FE-u).
    const assignedIds = [...new Set(rows.map((r) => r.plannerUserId))];
    const assignedUsers = assignedIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: assignedIds } },
          select: { id: true, fullName: true, email: true, active: true },
        })
      : [];
    const byUser = new Map(assignedUsers.map((u) => [u.id, u]));
    const decorate = (userId: number) => ({
      userId,
      fullName: byUser.get(userId)?.fullName ?? null,
      email: byUser.get(userId)?.email ?? null,
      active: byUser.get(userId)?.active ?? false,
    });

    const assignments: Record<number, ReturnType<typeof decorate>[]> = {};
    const globals: ReturnType<typeof decorate>[] = [];
    for (const r of rows) {
      if (r.projectId == null) globals.push(decorate(r.plannerUserId));
      else (assignments[r.projectId] ??= []).push(decorate(r.plannerUserId));
    }

    return {
      data: {
        assignments,
        globals,
        candidates: candidates.map((u) => ({
          userId: u.id,
          fullName: u.fullName,
          email: u.email,
          active: true,
        })),
      },
    };
  }

  /** Zameni planere jednog predmeta (obriši-pa-upiši). `itemId` = projects.id. */
  async setForProject(
    itemId: number,
    userIds: number[],
    actorUserId: number | null,
  ) {
    const projectId = this.requirePositiveInt(
      itemId,
      "Neispravan ID predmeta.",
    );
    return this.replace({ projectId }, userIds, actorUserId, projectId);
  }

  /** Zameni globalne planere (prati sva lansiranja) — redovi sa `project_id IS NULL`. */
  setGlobals(userIds: number[], actorUserId: number | null) {
    return this.replace({ projectId: null }, userIds, actorUserId, null);
  }

  /**
   * Zajednička „replace" logika: validira id-jeve (postoje + aktivni), pa u jednoj
   * transakciji obriše postojeće redove za metu i upiše novi set. Prazan set = samo brisanje.
   */
  private async replace(
    scope: { projectId: number | null },
    userIds: number[],
    actorUserId: number | null,
    projectIdForResponse: number | null,
  ) {
    const clean = this.normalizeUserIds(userIds);
    if (clean.length) {
      // Odbij samo NEPOZNAT nalog (ne postoji). Postojeći-neaktivni se PRIHVATA: već
      // dodeljen planer koji je kasnije deaktiviran mora ostati sačuvljiv/uklonjiv (inače
      // soft-lock — vidi overview). Novi ID-jevi dolaze iz picker-a koji nudi samo aktivne,
      // pa je i dalje nemoguće dodeliti izmišljen nalog. Lansiranje ionako mejluje samo aktivne.
      const known = await this.prisma.user.findMany({
        where: { id: { in: clean } },
        select: { id: true },
      });
      const knownSet = new Set(known.map((u) => u.id));
      const missing = clean.filter((id) => !knownSet.has(id));
      if (missing.length)
        throw new UnprocessableEntityException(
          `Nepoznat nalog planera: ${missing.join(", ")}.`,
        );
    }

    await this.prisma.$transaction(async (tx) => {
      // Advisory lock po scope-u (predmet ili globalni) serijalizuje konkurentne replace-ove
      // nad ISTOM metom: bez njega dva paralelna prva-upisa u prazan scope daju P2002 (untyped
      // 500) ili spojen skup (izgubljena zamena). Globalni scope (projectId NULL) → ključ 0
      // (nijedan predmet nema id 0). `skipDuplicates` je dodatni pojas (idempotentan re-upis).
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(5262414, ${scope.projectId ?? 0}::int)`,
      );
      // `projectId: null` u Prisma where-u znači IS NULL — tačno gađa globalne redove.
      await tx.predmetPlaner.deleteMany({
        where: { projectId: scope.projectId },
      });
      if (clean.length)
        await tx.predmetPlaner.createMany({
          data: clean.map((plannerUserId) => ({
            projectId: scope.projectId,
            plannerUserId,
            createdByUserId: actorUserId,
          })),
          skipDuplicates: true,
        });
    });

    return {
      data: {
        projectId: projectIdForResponse,
        global: scope.projectId === null,
        plannerUserIds: clean,
      },
    };
  }

  private normalizeUserIds(ids: unknown): number[] {
    if (!Array.isArray(ids))
      throw new UnprocessableEntityException(
        "planerUserIds mora biti niz ID-jeva.",
      );
    const out: number[] = [];
    for (const raw of ids) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0)
        throw new UnprocessableEntityException(
          "Svaki planer mora biti pozitivan ceo broj (ID naloga).",
        );
      if (!out.includes(n)) out.push(n); // dedup, čuva redosled
    }
    if (out.length > PredmetPlaneriService.MAX_PER_TARGET)
      throw new UnprocessableEntityException(
        `Najviše ${PredmetPlaneriService.MAX_PER_TARGET} planera po predmetu.`,
      );
    return out;
  }

  private requirePositiveInt(v: number, message: string): number {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0)
      throw new UnprocessableEntityException(message);
    return n;
  }
}
