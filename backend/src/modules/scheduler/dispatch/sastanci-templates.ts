/*
 * Talas A-2b — VERAN port 1.0 edge šablona
 * (servoteh-plan-montaze/supabase/functions/sastanci-notify-dispatch/templates.ts).
 *
 * Svi tekstovi su srpski, latinica. HTML koristi inline CSS (Outlook/Gmail).
 * Boje, badge-ovi, meta tabele i tekstualne varijante su prepisani 1:1 —
 * primalac ne sme da primeti da je pošiljalac promenio motor.
 *
 * ⚠️ JEDINO NAMERNO ODSTUPANJE OD EDGE-a: OBLIK DEEP-LINKOVA (fix mrtvih linkova).
 *   Edge gradi `${APP_URL}sastanci/<uuid>` — to je bila ruta 1.0 SPA-a. Posle
 *   prelaska domena na 3.0 (statički export, `[id]` rute ne postoje — vidi
 *   DESIGN §8) ta putanja vraća 404, pa je GLAVNI CTA u SVIM sastanci mejlovima
 *   MRTAV od domen-flipa (17.07.2026). 3.0 radni oblik je query deep-link koji
 *   `frontend/src/app/sastanci/page.tsx` zaista čita:
 *     • detalj sastanka → `${APP_URL}sastanci?open=<id>`   (page.tsx: `sp.get('open')`)
 *     • tab            → `${APP_URL}sastanci?tab=<key>`    (page.tsx: `?tab=` alias mapa)
 *   Footer „Promeni podešavanja notifikacija" → `?tab=podesavanja` (admin tab
 *   `PodesavanjaTab` = „Podešavanja notifikacija (paritet 1.0
 *   podesavanjaNotifikacijaTab)"). Edge je pokazivao na
 *   `sastanci/podesavanja-notifikacija` — takođe 404.
 *
 * Druga sitna razlika: edge računa lokalne `preheader` konstante po šablonu, ali
 * ih NIKAD ne prosleđuje — `buildEmailFor` zove `layout(html, content.subject, …)`.
 * Preheader je dakle uvek subject; mrtve konstante ovde nisu prenete (render je
 * identičan, samo bez mrtvog koda).
 */

export type EmailContent = {
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

const PRIMARY = "#2563eb";
const GRAY = "#6b7280";
const BORDER = "#e5e7eb";
const BG_GRAY = "#f9fafb";

/** Tab u 3.0 `/sastanci` koji drži podešavanja notifikacija (page.tsx ADMIN_ITEMS). */
const SETTINGS_TAB = "podesavanja";

/**
 * `String()` nad poljem payload-a. Payload je `Record<string, unknown>` (JSONB iz
 * outbox reda), pa TS ne zna da je vrednost skalar — bez ovog omotača svaki
 * `String(p.x ?? "")` pali lint pravilo `no-base-to-string`. Runtime je
 * znak-za-znak isti kao edge izraz `String(x ?? '')`.
 */
export function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  // Ne-skalar u payload-u nije očekivan; edge bi ovde dao '[object Object]' pa
  // zadržavamo isto ponašanje umesto da bacamo/gutamo poruku.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(v);
}

/**
 * HTML-escape za korisnička polja (naslov, mesto, organizator, zaduženja…) —
 * Resend renderuje `html` kao pravi HTML, pa bez ovoga je moguć HTML/XSS
 * injection u mejlu koji ide svim učesnicima. NE koristi se za subject/text.
 */
function esc(s: unknown): string {
  return str(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deep-link na detalj sastanka (3.0 oblik: `?open=`); bez id-a → lista. */
export function sastanakLink(appUrl: string, sastanakId: string): string {
  return sastanakId
    ? `${appUrl}sastanci?open=${encodeURIComponent(sastanakId)}`
    : `${appUrl}sastanci`;
}

function layout(
  bodyHtml: string,
  preheader: string,
  appUrl: string,
  settingsUrl: string,
): string {
  return `<!DOCTYPE html>
<html lang="sr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Servoteh</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</span>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" border="0"
           style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;
                  border:1px solid ${BORDER};overflow:hidden;">

      <!-- Header -->
      <tr><td style="background:${PRIMARY};padding:20px 32px;">
        <span style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:0.5px;">
          SERVOTEH d.o.o.
        </span>
        <span style="color:#bfdbfe;font-size:13px;margin-left:12px;">Sistem za upravljanje</span>
      </td></tr>

      <!-- Body -->
      <tr><td style="padding:32px;">
        ${bodyHtml}
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:${BG_GRAY};padding:16px 32px;border-top:1px solid ${BORDER};">
        <p style="margin:0;font-size:12px;color:${GRAY};line-height:1.6;">
          Ovo je automatska poruka iz Servoteh sistema.<br>
          <a href="${settingsUrl}" style="color:${PRIMARY};text-decoration:none;">
            Promeni podešavanja notifikacija
          </a>
          &nbsp;·&nbsp;
          <a href="${appUrl}" style="color:${PRIMARY};text-decoration:none;">
            Otvori aplikaciju
          </a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function badge(text: string, color: string): string {
  return `<span style="display:inline-block;background:${color}20;color:${color};
    border:1px solid ${color}40;border-radius:4px;padding:2px 8px;
    font-size:12px;font-weight:600;">${esc(text)}</span>`;
}

function metaRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:4px 0;font-size:13px;color:${GRAY};width:120px;">${esc(label)}</td>
    <td style="padding:4px 0;font-size:13px;color:#111827;font-weight:600;">${value ? esc(value) : "—"}</td>
  </tr>`;
}

type Zad = { naslov: string; rok: string; status: string };

function zaduzenjaHtml(p: Record<string, unknown>): string {
  const list = Array.isArray(p.zaduzenja) ? (p.zaduzenja as Zad[]) : [];
  if (!list.length) {
    return `<p style="margin:0 0 20px;font-size:13px;color:${GRAY};">Trenutno nemaš otvorenih zaduženja u akcionom planu. 👍</p>`;
  }
  const rows = list
    .slice(0, 20)
    .map((z) => {
      const late = z.status === "kasni";
      return `<li style="margin:3px 0;${late ? "color:#dc2626;" : ""}">${esc(z.naslov)}${z.rok ? ` — <strong>${esc(z.rok)}</strong>` : ""}${late ? " (kasni)" : ""}</li>`;
    })
    .join("");
  return `
    <div style="background:${BG_GRAY};border-left:4px solid #d97706;border-radius:4px;padding:14px 18px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:14px;font-weight:bold;color:#111827;">Tvoja otvorena zaduženja (${list.length})</p>
      <ul style="margin:0;padding-left:18px;font-size:13px;color:#374151;">${rows}</ul>
    </div>`;
}

function zaduzenjaText(p: Record<string, unknown>): string {
  const list = Array.isArray(p.zaduzenja) ? (p.zaduzenja as Zad[]) : [];
  if (!list.length) return "";
  return (
    "Tvoja zaduženja:\n" +
    list
      .slice(0, 20)
      .map((z) => `- ${z.naslov}${z.rok ? " (" + z.rok + ")" : ""}`)
      .join("\n") +
    "\n\n"
  );
}

// ── Šabloni ──────────────────────────────────────────────────────────────────

function tAkcijaNew(p: Record<string, unknown>): EmailContent {
  const naslov = str(p.naslov);
  const rok = str(p.rok_text ?? p.rok);
  const odgLabel = str(p.odg_label);
  const prioritet = str(p.prioritet);

  const subject = `Nova akcija: ${naslov}`;

  const prioBadge =
    prioritet === "visok"
      ? badge("Visok prioritet", "#dc2626")
      : prioritet === "srednji"
        ? badge("Srednji prioritet", "#d97706")
        : "";

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Nova akcija</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Dodeljena ti je nova akcija.</p>
    <div style="background:${BG_GRAY};border-left:4px solid ${PRIMARY};
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      ${prioBadge}
      <table style="margin-top:12px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${rok ? metaRow("Rok", rok) : ""}
        ${odgLabel ? metaRow("Odgovoran", odgLabel) : ""}
      </table>
    </div>`;

  const text = `Nova akcija: ${naslov}\n${rok ? "Rok: " + rok + "\n" : ""}${odgLabel ? "Odgovoran: " + odgLabel + "\n" : ""}`;

  return { subject, html, text };
}

function tAkcijaChanged(p: Record<string, unknown>): EmailContent {
  const naslov = str(p.naslov);
  const rok = str(p.rok_text ?? p.rok);
  const statusNew = str(p.status_new);
  const statusOld = str(p.status_old);
  const odgLabel = str(p.odg_label);

  const subject = `Akcija ažurirana: ${naslov}`;

  const statusLine =
    statusOld && statusNew && statusOld !== statusNew
      ? `<p style="margin:8px 0 0;font-size:13px;color:${GRAY};">
         Status: <s>${esc(statusOld)}</s> → <strong>${esc(statusNew)}</strong>
       </p>`
      : "";

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Akcija ažurirana</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Tvoja akcija je promenjena.</p>
    <div style="background:${BG_GRAY};border-left:4px solid #d97706;
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      <table style="margin-top:8px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${rok ? metaRow("Rok", rok) : ""}
        ${odgLabel ? metaRow("Odgovoran", odgLabel) : ""}
      </table>
      ${statusLine}
    </div>`;

  const text = `Akcija ažurirana: ${naslov}\n${rok ? "Rok: " + rok + "\n" : ""}${statusNew ? "Status: " + statusNew + "\n" : ""}`;

  return { subject, html, text };
}

function tMeetingInvite(
  p: Record<string, unknown>,
  appUrl: string,
): EmailContent {
  const naslov = str(p.naslov);
  const datum = str(p.datum);
  const vreme = str(p.vreme);
  const mesto = str(p.mesto);
  const tip = str(p.tip);
  const organizator = str(p.organizator);
  const sastanakId = str(p.sastanak_id);

  const datumFmt = datum ? datum.split("-").reverse().join(".") : "";
  const subject = `Pozivnica: ${naslov} — ${datumFmt}`;

  const link = sastanakLink(appUrl, sastanakId);

  // Potvrda dolaska (RSVP magic-link) — samo ako je dispatcher dodao URL-ove u
  // payload. (Podsetnici i druge poruke nemaju ova polja → sekcija se ne renderuje.)
  const rsvpYes = str(p.rsvp_yes_url);
  const rsvpNo = str(p.rsvp_no_url);
  const rsvpHtml = rsvpYes
    ? `
    <div style="border-top:1px solid ${BORDER};margin-top:24px;padding-top:20px;">
      <p style="margin:0 0 12px;font-size:14px;font-weight:bold;color:#111827;">Potvrda dolaska</p>
      <p style="margin:0 0 14px;font-size:13px;color:${GRAY};">Molimo te da potvrdiš dolazak jednim klikom:</p>
      <table cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
        <tr>
          <td style="padding-right:10px;">
            <a href="${esc(rsvpYes)}"
               style="display:inline-block;background:#15803d;color:#ffffff;
                      text-decoration:none;padding:10px 20px;border-radius:6px;
                      font-size:14px;font-weight:600;">
              ✅ Dolazim
            </a>
          </td>
          <td>
            <a href="${esc(rsvpNo)}"
               style="display:inline-block;background:#dc2626;color:#ffffff;
                      text-decoration:none;padding:10px 20px;border-radius:6px;
                      font-size:14px;font-weight:600;">
              ❌ Ne dolazim
            </a>
          </td>
        </tr>
      </table>
    </div>`
    : "";
  const rsvpText = rsvpYes
    ? `\nPotvrdi dolazak:\n  Dolazim: ${rsvpYes}\n  Ne dolazim: ${rsvpNo}\n`
    : "";

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Pozivnica na sastanak</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Pozvani ste na sledeći sastanak.</p>
    <div style="background:${BG_GRAY};border-left:4px solid ${PRIMARY};
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      ${tip ? badge(tip, PRIMARY) : ""}
      <table style="margin-top:12px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${datumFmt ? metaRow("Datum", datumFmt) : ""}
        ${vreme ? metaRow("Vreme", vreme) : ""}
        ${mesto ? metaRow("Mesto", mesto) : ""}
        ${organizator ? metaRow("Organizator", organizator) : ""}
      </table>
    </div>
    <div style="background:#fff8ec;border:1px solid #f5d9a8;border-radius:6px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#5b4a2a;">
      <strong>Pre sastanka — pripremi se:</strong>
      <ul style="margin:8px 0 0;padding-left:18px;">
        <li>Pogledaj <strong>zapisnik sa prošlog sastanka</strong> i svoja <strong>zaduženja</strong> (Akcije → „Samo moje").</li>
        <li>Za svoje projekte upiši kratku <strong>pripremu</strong> (status, problemi) u tabu <strong>Priprema</strong> i čekiraj „Pripremljen".</li>
        <li><strong>Otvori teme i probleme</strong> (nove ili sa prošlog) koje želiš da se reše na sastanku.</li>
      </ul>
      ${p.imaPrethodniZapisnik ? '<p style="margin:8px 0 0;font-weight:bold;">📎 Zapisnik sa prošlog sastanka je u prilogu ove poruke.</p>' : ""}
    </div>
    ${zaduzenjaHtml(p)}
    <p style="margin:0 0 12px;font-size:13px;color:${GRAY};">📅 U prilogu je i poziv za kalendar (<strong>sastanak.ics</strong>) — otvori ga da dodaš termin u Outlook/Google.</p>
    <p style="margin:0;">
      <a href="${link}"
         style="display:inline-block;background:${PRIMARY};color:#ffffff;
                text-decoration:none;padding:10px 20px;border-radius:6px;
                font-size:14px;font-weight:600;">
        Otvori i pripremi se
      </a>
    </p>
    ${rsvpHtml}`;

  const text = `Pozivnica: ${naslov}\nDatum: ${datumFmt}${vreme ? "\nVreme: " + vreme : ""}${mesto ? "\nMesto: " + mesto : ""}\n\n${zaduzenjaText(p)}Pre sastanka: pogledaj prošli zapisnik${p.imaPrethodniZapisnik ? " (u prilogu)" : ""} i svoja zaduženja, upiši pripremu u tabu Priprema (čekiraj „Pripremljen") i otvori teme/probleme.\n${link}\n${rsvpText}`;

  return {
    subject,
    html,
    text,
    replyTo: organizator.includes("@") ? organizator : undefined,
  };
}

function tMeetingLocked(
  p: Record<string, unknown>,
  appUrl: string,
): EmailContent {
  const naslov = str(p.naslov);
  const datum = str(p.datum);
  const vreme = str(p.vreme);
  const zakljucaoBy = str(p.zakljucan_by ?? p.organizator);
  const sastanakId = str(p.sastanak_id);

  const datumFmt = datum ? datum.split("-").reverse().join(".") : "";
  const subject = `Zapisnik: ${naslov}`;

  const link = sastanakLink(appUrl, sastanakId);

  const d = p.diff as
    | { novo?: number; zavrseno?: number; kasni?: number; aktivnih?: number }
    | undefined;
  const diffHtml = d
    ? `
    <div style="margin:0 0 18px;font-size:13px;">
      <strong>Od prošlog sastanka:</strong>
      ${badge("▲ " + (d.novo ?? 0) + " novo", "#d8591b")}
      ${badge("✓ " + (d.zavrseno ?? 0) + " završeno", "#059669")}
      ${badge("⚠ " + (d.kasni ?? 0) + " kasni", "#dc2626")}
      ${badge((d.aktivnih ?? 0) + " aktivnih", "#2563eb")}
    </div>`
    : "";
  const diffText = d
    ? `Od prošlog sastanka: ${d.novo ?? 0} novo, ${d.zavrseno ?? 0} završeno, ${d.kasni ?? 0} kasni, ${d.aktivnih ?? 0} aktivnih.\n`
    : "";

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Sastanak zaključan</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">
      Zapisnik je finalizovan. <strong>PDF zapisnik je u prilogu ove poruke.</strong>
    </p>
    <div style="background:${BG_GRAY};border-left:4px solid #059669;
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      <table style="margin-top:8px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${datumFmt ? metaRow("Datum", datumFmt) : ""}
        ${vreme ? metaRow("Vreme", vreme) : ""}
        ${zakljucaoBy ? metaRow("Zaključio", zakljucaoBy) : ""}
      </table>
    </div>
    ${diffHtml}
    <p style="margin:0 0 8px;font-size:13px;color:${GRAY};">
      Ako prilog nije vidljiv, zapisnik možete otvoriti i u aplikaciji:
    </p>
    <p style="margin:0;">
      <a href="${link}"
         style="display:inline-block;background:#059669;color:#ffffff;
                text-decoration:none;padding:10px 20px;border-radius:6px;
                font-size:14px;font-weight:600;">
        Otvori u aplikaciji
      </a>
    </p>`;

  const text = `Zapisnik: ${naslov}\nDatum: ${datumFmt}\n${diffText}PDF zapisnik je u prilogu. Možete ga otvoriti i u aplikaciji: ${link}`;

  return { subject, html, text };
}

function tActionReminder(p: Record<string, unknown>): EmailContent {
  const naslov = str(p.naslov);
  const rok = str(p.rok_text ?? p.rok);
  const prioritet = str(p.prioritet);
  const odgLabel = str(p.odg_label);

  const isKasni =
    p.rok &&
    new Date(str(p.rok)) <
      new Date(str(p.reminder_for ?? new Date().toISOString().slice(0, 10)));
  const isToday = p.rok && str(p.rok) === str(p.reminder_for);

  const urgencija = isKasni
    ? badge("KASNI", "#dc2626")
    : isToday
      ? badge("Rok danas", "#d97706")
      : badge("Rok sutra", "#2563eb");

  const subject = isKasni
    ? `Akcija kasni: ${naslov}`
    : isToday
      ? `Rok danas: ${naslov}`
      : `Rok sutra: ${naslov}`;

  const prioBadge =
    prioritet === "visok"
      ? badge("Visok prioritet", "#dc2626")
      : prioritet === "srednji"
        ? badge("Srednji prioritet", "#d97706")
        : "";

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Podsetnik za akciju</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Imate akciju kojoj se bliži rok.</p>
    <div style="background:${BG_GRAY};border-left:4px solid ${isKasni ? "#dc2626" : isToday ? "#d97706" : PRIMARY};
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 6px;font-size:16px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      <div style="margin-bottom:8px;">${urgencija} ${prioBadge}</div>
      <table style="border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${rok ? metaRow("Rok", rok) : ""}
        ${odgLabel ? metaRow("Odgovoran", odgLabel) : ""}
      </table>
    </div>`;

  const text = `${subject}\n${rok ? "Rok: " + rok + "\n" : ""}${odgLabel ? "Odgovoran: " + odgLabel + "\n" : ""}`;

  return { subject, html, text };
}

function tMeetingReminder(
  p: Record<string, unknown>,
  appUrl: string,
): EmailContent {
  const naslov = str(p.naslov);
  const datum = str(p.datum);
  const vreme = str(p.vreme);
  const mesto = str(p.mesto);
  const tip = str(p.tip);
  const organizator = str(p.organizator);
  const sastanakId = str(p.sastanak_id);

  const datumFmt = datum ? datum.split("-").reverse().join(".") : "";
  const subject = `Sutra: ${naslov}${vreme ? " u " + vreme : ""}`;

  const link = sastanakLink(appUrl, sastanakId);

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Podsetnik za sastanak</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Sutra imate zakazan sastanak.</p>
    <div style="background:#eff6ff;border-left:4px solid ${PRIMARY};
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:#111827;">${esc(naslov)}</p>
      ${tip ? badge(tip, PRIMARY) : ""}
      <table style="margin-top:12px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${datumFmt ? metaRow("Datum", datumFmt) : ""}
        ${vreme ? metaRow("Vreme", vreme) : ""}
        ${mesto ? metaRow("Mesto", mesto) : ""}
        ${organizator ? metaRow("Organizator", organizator) : ""}
      </table>
    </div>
    <p style="margin:0;">
      <a href="${link}"
         style="display:inline-block;background:${PRIMARY};color:#ffffff;
                text-decoration:none;padding:10px 20px;border-radius:6px;
                font-size:14px;font-weight:600;">
        Otvori sastanak
      </a>
    </p>`;

  const text = `Podsetnik: ${naslov}\nDatum: ${datumFmt}${vreme ? "\nVreme: " + vreme : ""}${mesto ? "\nMesto: " + mesto : ""}\n${link}`;

  return {
    subject,
    html,
    text,
    replyTo: organizator.includes("@") ? organizator : undefined,
  };
}

function tMeetingCancel(p: Record<string, unknown>): EmailContent {
  const naslov = str(p.naslov);
  const datum = str(p.datum);
  const vreme = str(p.vreme);
  const mesto = str(p.mesto);
  const DANGER = "#d6453d";

  // Paritet edge-a: otkazivanje dodaje TAČKU posle datuma (ostali šabloni ne).
  const datumFmt = datum ? datum.split("-").reverse().join(".") + "." : "";
  const subject = `Otkazano: ${naslov}`;

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Sastanak je otkazan</h2>
    <p style="margin:0 0 20px;font-size:14px;color:${GRAY};">Termin ispod se <strong>ne održava</strong>. Novi termin stiže posebnom pozivnicom.</p>
    <div style="background:#fbe9e8;border-left:4px solid ${DANGER};
                border-radius:4px;padding:16px 20px;margin-bottom:20px;">
      <p style="margin:0 0 8px;font-size:17px;font-weight:bold;color:#111827;text-decoration:line-through;">${esc(naslov)}</p>
      <table style="margin-top:8px;border-collapse:collapse;" cellpadding="0" cellspacing="0">
        ${datumFmt ? metaRow("Datum", datumFmt) : ""}
        ${vreme ? metaRow("Vreme", vreme) : ""}
        ${mesto ? metaRow("Mesto", mesto) : ""}
      </table>
    </div>`;

  const text = `Sastanak otkazan: ${naslov}\nDatum: ${datumFmt}${vreme ? "\nVreme: " + vreme : ""}\nNovi termin stiže posebnom pozivnicom.`;

  return { subject, html, text };
}

function tPrepReminder(
  p: Record<string, unknown>,
  appUrl: string,
): EmailContent {
  const naslov = str(p.naslov);
  const datum = str(p.datum);
  const vreme = str(p.vreme);
  const sastanakId = str(p.sastanak_id);
  const datumFmt = datum ? datum.split("-").reverse().join(".") : "";
  const subject = `Podsetnik: pripremi se za „${naslov}"`;
  const link = sastanakLink(appUrl, sastanakId);

  const html = `
    <h2 style="margin:0 0 4px;font-size:20px;color:#111827;">Pripremi se za sastanak</h2>
    <p style="margin:0 0 16px;font-size:14px;color:${GRAY};">
      Još nisi označen kao <strong>pripremljen</strong> za sastanak <strong>${esc(naslov)}</strong>${datumFmt ? " (" + esc(datumFmt) + (vreme ? " u " + esc(vreme) : "") + ")" : ""}.
    </p>
    ${zaduzenjaHtml(p)}
    <p style="margin:0 0 16px;font-size:13px;color:${GRAY};">
      Upiši kratku pripremu po projektima u tabu <strong>Priprema</strong>, otvori teme/probleme i čekiraj „Pripremljen".
    </p>
    <p style="margin:0;">
      <a href="${link}" style="display:inline-block;background:#d97706;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;">
        Otvori i pripremi se
      </a>
    </p>`;
  const text = `Podsetnik: pripremi se za ${naslov}${datumFmt ? " (" + datumFmt + ")" : ""}.\n\n${zaduzenjaText(p)}Upiši pripremu u tabu Priprema i čekiraj „Pripremljen".\n${link}`;
  return { subject, html, text };
}

// ── Glavni export ────────────────────────────────────────────────────────────

export function buildEmailFor(
  kind: string,
  payload: Record<string, unknown> | null,
  appUrl: string,
): EmailContent {
  const p = payload ?? {};
  // FIX mrtvog linka: edge je slao `sastanci/podesavanja-notifikacija` (404 na
  // 3.0 statičkom exportu) — 3.0 čita `?tab=` deep-link.
  const settingsUrl = `${appUrl}sastanci?tab=${SETTINGS_TAB}`;

  let content: EmailContent;

  switch (kind) {
    case "akcija_new":
      content = tAkcijaNew(p);
      break;
    case "akcija_changed":
      content = tAkcijaChanged(p);
      break;
    case "meeting_invite":
      content = tMeetingInvite(p, appUrl);
      break;
    case "meeting_locked":
      content = tMeetingLocked(p, appUrl);
      break;
    case "action_reminder":
      content = tActionReminder(p);
      break;
    case "meeting_reminder":
      content = tMeetingReminder(p, appUrl);
      break;
    case "meeting_prep_reminder":
      content = tPrepReminder(p, appUrl);
      break;
    case "meeting_cancel":
      content = tMeetingCancel(p);
      break;
    default:
      content = {
        subject: `Obaveštenje: ${kind}`,
        html: `<p>Obaveštenje iz Servoteh sistema (${kind}).</p>`,
        text: `Obaveštenje iz Servoteh sistema (${kind}).`,
      };
  }

  // Omotaj HTML u layout (preheader = subject, kao u edge-u).
  content.html = layout(content.html, content.subject, appUrl, settingsUrl);

  // Dodaj plain-text footer
  content.text += `\n\n---\nOvo je automatska poruka. Promeni podešavanja: ${settingsUrl}`;

  return content;
}
