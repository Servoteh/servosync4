/**
 * Deljeni util za brojeve crteža (Plan proizvodnje + Praćenje; port 1.0 `drawings.js`).
 * Sanitizacija = trim + skini vodeće/prateće tačke i razmake; čisto-tačka placeholder
 * → null (BigTehn data-quality, MODULE_SPEC_planovi_pracenje_30.md §2-14; slash je
 * kanon nad dash-om — memorija). NE menja semantiku (doktrina §C).
 */
export function sanitizeDrawingNo(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\.+$/.test(s)) return null;
  const cleaned = s
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  return cleaned || null;
}
