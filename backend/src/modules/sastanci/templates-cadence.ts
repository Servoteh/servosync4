/**
 * Port 1.0 `sastanciTemplates.nextOccurrence` (klijentska logika → BE servis, spec §3).
 * Računa sledeći kalendarski datum (YYYY-MM-DD, LOKALNI dan bez TZ drift-a) za dati
 * ritam šablona. Paritet 1:1 sa 1.0 (none/daily/weekly/biweekly/monthly). Čista fn —
 * bez DB/HTTP, unit-testabilna.
 */

export interface CadenceTemplate {
  cadence: string;
  cadenceDow?: number | null;
  cadenceDom?: number | null;
  createdAt?: string | Date | null;
}

function toLocalYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function nextOccurrence(
  t: CadenceTemplate,
  fromDate: Date = new Date(),
): string {
  if (!t || t.cadence === "none") return toLocalYMD(fromDate);
  const from = new Date(
    fromDate.getFullYear(),
    fromDate.getMonth(),
    fromDate.getDate(),
  );

  if (t.cadence === "daily") return toLocalYMD(addDays(from, 1));

  if (t.cadence === "monthly" && t.cadenceDom != null) {
    let y = from.getFullYear();
    let m = from.getMonth();
    const dom = Math.min(Math.max(1, t.cadenceDom), 31);
    let tryDate = new Date(y, m, dom);
    if (tryDate < from) {
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
      tryDate = new Date(y, m, dom);
    }
    while (tryDate.getMonth() !== m) {
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
      tryDate = new Date(y, m, dom);
    }
    return toLocalYMD(tryDate);
  }

  const targetDow = t.cadenceDow != null ? t.cadenceDow : 1;

  let cur = new Date(from);
  for (let i = 0; i < 400; i++) {
    if (cur.getDay() === targetDow) break;
    cur = addDays(cur, 1);
  }

  if (t.cadence === "weekly") return toLocalYMD(cur);

  if (t.cadence === "biweekly") {
    const anchor = t.createdAt ? new Date(t.createdAt) : new Date(2024, 0, 1);
    const anchor0 = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate(),
    );
    const aDay = Math.floor(anchor0.getTime() / 86400000);
    let cur2 = new Date(from);
    for (let j = 0; j < 500; j++) {
      if (cur2.getDay() === targetDow) {
        const cDay = Math.floor(
          new Date(
            cur2.getFullYear(),
            cur2.getMonth(),
            cur2.getDate(),
          ).getTime() / 86400000,
        );
        if (Math.floor((cDay - aDay) / 7) % 2 === 0) return toLocalYMD(cur2);
        cur2 = addDays(cur2, 7);
        continue;
      }
      cur2 = addDays(cur2, 1);
    }
  }

  return toLocalYMD(cur);
}
