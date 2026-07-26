/*
 * Talas A — tipovi scheduler pogona. Rasporedi su u Europe/Belgrade LOKALNOM
 * vremenu (paritet 1.0 namere: „korektivne ujutru", „sedmični petak 08h") —
 * DST računa belgrade-time util, pa dupli UTC slotovi iz 1.0 nisu potrebni.
 */

export type JobSchedule =
  | { kind: "daily"; at: string } // "HH:MM" lokalno
  | { kind: "weekly"; isoDow: number; at: string } // 1=pon … 7=ned
  | { kind: "everyMinutes"; minutes: number };

export interface JobRunContext {
  /** UTC trenutak termina za koji se posao izvršava (ne „sada"). */
  scheduledFor: Date;
}

export interface ScheduledJob {
  /** Stabilan ključ (ide u scheduled_job_runs.job_key) — ne menjati posle uvođenja. */
  key: string;
  /** Kratak opis za /scheduler listu. */
  description: string;
  schedule: JobSchedule;
  /**
   * Koliko minuta posle termina još sme da se nadoknadi propušten slot (restart/
   * deploy u trenutku termina). Default: daily/weekly 180, everyMinutes = period.
   */
  catchUpMinutes?: number;
  /**
   * `app_switches.key` korisničkog prekidača. Kad je postavljen, scheduler PRE
   * svakog izvršenja (i zakazanog i `run-now`) proverava red u `app_switches` —
   * to je JEDNA kapija za sve poslove, umesto da svaki ulaz pamti da je pozove.
   * Nema reda = uključeno (OFF-prekidač: odsustvo reda ne sme tiho da ugasi posao).
   */
  switchKey?: string;
  /** Izvrši posao; vraćeni string ide u dnevnik kao summary. */
  run(ctx: JobRunContext): Promise<string | void>;
}

export const JOB_STATUS = {
  RUNNING: "RUNNING",
  DONE: "DONE",
  FAILED: "FAILED",
} as const;

/** Maksimalan broj pokušaja jednog termina (prvi + retry-ji u catch-up prozoru). */
export const MAX_ATTEMPTS = 3;
