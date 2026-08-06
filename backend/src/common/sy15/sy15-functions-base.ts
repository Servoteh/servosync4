/**
 * JAVNA baza sy15 edge funkcija (`…/functions/v1`).
 *
 * Izdvojeno iz `SastanciDispatchService.functionsBase()` kad je RSVP dobio 3.0
 * parnjaka (`SastanciRsvpController`): oba mesta moraju da grade ISTI sy15 URL —
 * dispečer kad pod `SASTANCI_IZVOR=sy15` šalje link u mejlu, kontroler kad
 * pod istim prekidačem preusmeri klik na vlasnika podatka. Dve kopije bi se
 * razišle prvom izmenom lanca.
 *
 * ⚠️ MORA BITI JAVNI URL, i to je POPRAVKA a ne paritet: stari edge je link
 * gradio iz svog `SUPABASE_URL`, tj. `http://<gateway>/functions/v1/…` — interna
 * adresa, pa su RSVP dugmad („Dolazim / Ne dolazim") u pozivnici bila MRTVA za
 * SVE primaoce, ne samo van LAN-a. Iz istog razloga se ovde NE sme koristiti
 * `SY15_REST_URL`: na produ je to LAN adresa (192.168.64.28:8090), pa bi dugmad
 * radila samo sa LAN-a.
 *
 * Lanac: `SY15_FUNCTIONS_URL` (javni gateway) → izvedeno iz `SY15_STORAGE_URL`
 * (jedini env za koji je javnost garantovana — vidi memo „SY15 storage URL =
 * javni gateway") → izvođenje iz `SY15_REST_URL` kao poslednja slamka.
 *
 * Vraća BEZ završne kose crte (pozivalac dodaje `/<ime-funkcije>`).
 */
export function sy15FunctionsBase(): string {
  const explicit = (process.env.SY15_FUNCTIONS_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const storage = (process.env.SY15_STORAGE_URL || "").trim();
  if (storage) {
    return storage.replace(/\/$/, "").replace(/\/storage\/v1$/, "/functions/v1");
  }

  const base = (
    process.env.SY15_REST_URL || "https://api.servosync.servoteh.com/rest/v1"
  ).replace(/\/rest\/v1\/?$/, "");
  return `${base}/functions/v1`;
}
