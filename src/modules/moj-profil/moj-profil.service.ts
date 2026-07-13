import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { jsonSafe } from "../../common/sy15/json-safe";
import type { AttendanceRangeQueryDto } from "./dto/moj-profil-query.dto";

/**
 * Moj profil — 3.0 TALAS D, R1 read sloj (MODULE_SPEC_pb_profil_podesavanja_30.md §0.2/§3.2).
 * KLJUČNI NALAZ (§0.2): Moj profil NEMA NIJEDNU SVOJU TABELU — čist AGREGATOR nad tuđim
 * domenima (Kadrovska/G, Reversi, Podešavanja/D). Sav pristup ide kroz `Sy15Service.withUserRls`
 * (GUC claims `email`+`sub` + SET LOCAL ROLE authenticated); postojeći DEFINER RPC-ovi i RLS
 * „moji" pregledi rade NETAKNUTI — paritet po konstrukciji, TELA RPC-ova se NE diraju (vlasnik
 * ostaje Talas G, presuda D6). Scope visi na `lower(email) → v_employees_safe` aktivan red
 * (bez reda = prazan profil, poruka „Nismo pronašli…"). Self-tabele se dodatno filtriraju po
 * `employee_id` (paritet 1.0 klijentskih `.eq(employee_id, …)` filtera — pojas i tregeri uz RLS).
 * Mutacije (submit GO/nadoknada/plaćeno, korekcija prisustva, ack, 360) su R2. Reversi zaduženja
 * = reuse `/reversi/reports/my-*` (bez novog koda — §3.2, ne dupliramo Reversi).
 */
@Injectable()
export class MojProfilService {
  constructor(private readonly sy15: Sy15Service) {}

  /** Profil header + uloge/override (v_employees_safe email→red + get_my_user_roles DEFINER). */
  me(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      const roles = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM get_my_user_roles()`,
      );
      return {
        data: {
          hasProfile: emp != null,
          employee: emp,
          roles: jsonSafe(roles),
          ...(emp == null
            ? { message: "Nismo pronašli vaš zaposlenički profil." }
            : {}),
        },
      };
    });
  }

  /** GO: saldo (v_vacation_balance, tekuća godina) + zahtevi + istorija (self-scope). */
  vacation(email: string) {
    const year = new Date().getFullYear();
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [balance, requests, history] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM v_vacation_balance WHERE employee_id = ${emp.id}::uuid AND year = ${year}`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM vacation_requests WHERE employee_id = ${emp.id}::uuid ORDER BY date_from DESC`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM vacation_history WHERE employee_id = ${emp.id}::uuid ORDER BY year DESC`,
        ),
      ]);
      return {
        data: {
          balance: jsonSafe(balance)[0] ?? null,
          requests: jsonSafe(requests),
          history: jsonSafe(history),
        },
      };
    });
  }

  /** Nadoknada sati + plaćeno odsustvo (self-scope). */
  makeupAndPaidLeave(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [makeup, paidLeave] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM makeup_requests WHERE employee_id = ${emp.id}::uuid ORDER BY created_at DESC`,
        ),
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT * FROM paid_leave_requests WHERE employee_id = ${emp.id}::uuid ORDER BY created_at DESC`,
        ),
      ]);
      return {
        data: { makeup: jsonSafe(makeup), paidLeave: jsonSafe(paidLeave) },
      };
    });
  }

  /** Moje prisustvo (v_attendance_daily, dnevni pregled u opsegu; default tekući mesec). */
  attendance(email: string, q: AttendanceRangeQueryDto) {
    const { from, to } = monthRange(q.from, q.to);
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM v_attendance_daily
           WHERE employee_id = ${emp.id}::uuid AND day >= ${from}::date AND day <= ${to}::date
           ORDER BY day DESC`,
      );
      return { data: { from, to, days: jsonSafe(rows) } };
    });
  }

  /** Razgovori (employee_talks self; „Upoznat sam"/korektivne mere su R2/G). */
  talks(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM employee_talks WHERE employee_id = ${emp.id}::uuid ORDER BY talk_date DESC`,
      );
      return { data: jsonSafe(rows) };
    });
  }

  /** Očekivanja zaposlenog (self; Prisma model — RLS self ∨ mgmt scope u DB). */
  expectations(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const rows = await tx.employeeExpectation.findMany({
        where: { employeeId: emp.id },
        orderBy: [{ createdAt: "desc" }],
      });
      return { data: rows };
    });
  }

  /** Opis pozicije (job_positions po position_id zaposlenog; PDF port je R3). */
  position(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      if (emp.positionId == null) return { data: null };
      const pos = await tx.jobPosition.findUnique({
        where: { id: emp.positionId },
      });
      return { data: pos };
    });
  }

  /** Vrednosti firme (company_profile id=1; SELECT svima). */
  companyValues(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.companyProfile.findUnique({ where: { id: 1 } });
      return { data };
    });
  }

  /** Kolege na odsustvu danas (absences preseca DANAS; ime iz v_employees_safe). */
  colleaguesOnLeave(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT a.employee_id, a.type, a.date_from, a.date_to, e.full_name, e.department
           FROM absences a
           JOIN v_employees_safe e ON e.id = a.employee_id
           WHERE a.archived_at IS NULL
             AND a.date_from <= CURRENT_DATE AND a.date_to >= CURRENT_DATE
           ORDER BY e.full_name`,
      );
      return { data: jsonSafe(rows) };
    });
  }

  /** Presek za landing (GO saldo + otvoreni zahtevi + mesečni sati prisustva + razgovori). */
  summary(email: string) {
    const year = new Date().getFullYear();
    const { from, to } = monthRange();
    return this.withUserMapped(email, async (tx) => {
      const emp = await this.resolveEmployee(tx, email);
      if (emp == null) return this.emptyProfile();
      const [balance, openReq, presence, talks] = await Promise.all([
        tx.$queryRaw<{ days_remaining: number | null }[]>(
          Prisma.sql`SELECT days_remaining FROM v_vacation_balance WHERE employee_id = ${emp.id}::uuid AND year = ${year}`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM vacation_requests
             WHERE employee_id = ${emp.id}::uuid AND status IN ('pending', 'sef_approved')`,
        ),
        tx.$queryRaw<{ hours: unknown }[]>(
          Prisma.sql`SELECT COALESCE(sum(presence_hours), 0) AS hours FROM v_attendance_daily
             WHERE employee_id = ${emp.id}::uuid AND day >= ${from}::date AND day <= ${to}::date`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM employee_talks
             WHERE employee_id = ${emp.id}::uuid AND shared_at IS NOT NULL AND acknowledged_at IS NULL`,
        ),
      ]);
      return {
        data: {
          employee: { id: emp.id, fullName: emp.full_name },
          vacationDaysRemaining: balance[0]?.days_remaining ?? null,
          openVacationRequests: Number(openReq[0]?.n ?? 0),
          monthPresenceHours: Number(presence[0]?.hours ?? 0),
          unacknowledgedTalks: Number(talks[0]?.n ?? 0),
        },
      };
    });
  }

  // ---------- interno ----------

  /** Aktivan employee red po email-u (v_employees_safe; null = prazan profil). */
  private async resolveEmployee(
    tx: Sy15Tx,
    email: string,
  ): Promise<{
    id: string;
    full_name: string | null;
    positionId: number | null;
  } | null> {
    const rows = await tx.$queryRaw<
      { id: string; full_name: string | null; position_id: number | null }[]
    >(
      Prisma.sql`SELECT id, full_name, position_id FROM v_employees_safe
         WHERE lower(email) = lower(${email}) LIMIT 1`,
    );
    const r = rows[0];
    return r
      ? { id: r.id, full_name: r.full_name, positionId: r.position_id }
      : null;
  }

  private emptyProfile() {
    return {
      data: null,
      meta: { message: "Nismo pronašli vaš zaposlenički profil." },
    };
  }

  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** SQLSTATE → HTTP (paritet Reversi/Sastanci §5): 42501→403, P0001/P0002/23514→422, 23505→409. */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}

/** Opseg meseca 'YYYY-MM-DD' (default: tekući mesec, Europe/Belgrade sidro). */
function monthRange(from?: string, to?: string): { from: string; to: string } {
  if (from && to) return { from, to };
  const belgrade = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
  }).format(new Date());
  const [y, m] = belgrade.split("-");
  const firstDay = `${y}-${m}-01`;
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  return {
    from: from ?? firstDay,
    to: to ?? `${y}-${m}-${String(lastDay).padStart(2, "0")}`,
  };
}
