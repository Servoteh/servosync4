/**
 * „Sažmi zapisnik" (port edge `sastanci-ai-summary`) — prompt builder (čist, testabilan).
 * FE sklopi objekat sastanka; BE složi user-content i pozove Anthropic (AiProviderService).
 */

export interface SummaryAkcija {
  rb?: number | null;
  naslov?: string | null;
  opis?: string | null;
  odgovoran?: string | null;
  rok?: string | null;
  status?: string | null;
}
export interface SummaryGrupa {
  code?: string | null;
  naziv?: string | null;
  akcije?: SummaryAkcija[];
}
export interface SummarySastanak {
  naslov?: string | null;
  datum?: string | null;
  vreme?: string | null;
  mesto?: string | null;
  ucesnici?: string[];
  grupe?: SummaryGrupa[];
  diff?: { dodato?: number; zavrseno?: number; kasni?: number } | null;
}

export const SUMMARY_ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export const SUMMARY_SYSTEM_PROMPT = `Ti si asistent koji piše sažetke poslovnih sastanaka na srpskom jeziku (ekavica, latinica).
Na osnovu zapisnika i akcionog plana napiši kratak, jasan izvršni rezime za rukovodstvo.

Struktura odgovora (koristi tačno ove naslove kao podebljane redove):
**Ukratko** — 2–4 rečenice o glavnom fokusu sastanka.
**Ključne odluke i prioriteti** — lista najvažnijih tačaka (• po stavci).
**Kritični zadaci i rokovi** — lista zadataka koji gore: ko je odgovoran i do kada (• po stavci).
**Rizici / blokade** — stavke u statusu Blokirano/Odloženo ili bez odgovornog/roka; ako ih nema, napiši „Nema uočenih blokada.".

Pravila:
- Piši konkretno i sažeto, bez uvodnih fraza tipa „Evo rezimea".
- Ne izmišljaj podatke kojih nema u ulazu.
- Imena, RN-ove i rokove prenesi tačno kako su dati.
- Ceo odgovor je čist tekst (bez markdown tabela), maksimalno ~250 reči.`;

const STATUS_LABEL: Record<string, string> = {
  todo: "Za rad",
  u_toku: "U toku",
  in_progress: "U toku",
  zavrsen: "Završen",
  done: "Završen",
  blokirano: "Blokirano",
  blocked: "Blokirano",
  odlozeno: "Odloženo",
  otkazan: "Otkazan",
};

function statusLabel(s?: string | null): string {
  if (!s) return "—";
  return STATUS_LABEL[s] || s;
}

export function buildSummaryContent(sast: SummarySastanak): string {
  const lines: string[] = [];
  lines.push(`Sastanak: ${sast.naslov || "(bez naslova)"}`);
  if (sast.datum)
    lines.push(`Datum: ${sast.datum}${sast.vreme ? " u " + sast.vreme : ""}`);
  if (sast.mesto) lines.push(`Mesto: ${sast.mesto}`);
  if (sast.ucesnici && sast.ucesnici.length) {
    lines.push(`Učesnici: ${sast.ucesnici.join(", ")}`);
  }
  if (sast.diff) {
    const d = sast.diff;
    lines.push(
      `Od prošlog zaključanog sastanka: novih zadataka ${d.dodato ?? 0}, završeno ${d.zavrseno ?? 0}, kasni ${d.kasni ?? 0}.`,
    );
  }
  lines.push("");
  lines.push(
    "AKCIONI PLAN (zadaci, grupisani po RN/projektu, redom prioriteta):",
  );

  const grupe = sast.grupe || [];
  if (!grupe.length) lines.push("(nema zadataka)");
  grupe.forEach((g) => {
    const head =
      [g.code, g.naziv].filter(Boolean).join(" — ") || "Bez RN / projekta";
    lines.push("");
    lines.push(`### ${head}`);
    (g.akcije || []).forEach((a, i) => {
      const parts: string[] = [];
      parts.push(`${a.rb ?? i + 1}. ${a.naslov || "(bez naslova)"}`);
      if (a.opis) parts.push(`   Opis: ${a.opis}`);
      const meta: string[] = [];
      if (a.odgovoran) meta.push(`Odgovoran: ${a.odgovoran}`);
      if (a.rok) meta.push(`Rok: ${a.rok}`);
      meta.push(`Status: ${statusLabel(a.status)}`);
      parts.push(`   [${meta.join(" · ")}]`);
      lines.push(parts.join("\n"));
    });
  });

  return lines.join("\n");
}
