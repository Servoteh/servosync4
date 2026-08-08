import { Logger } from "@nestjs/common";
import type { IzvorPrekidac } from "./izvor-prekidac";

/**
 * Izričit izuzetak od sprege Reversi <-> Lokacije. Postoji SAMO da razdvajanje bude
 * imenovana, namerna odluka nekoga ko zna posledicu — nikad previd u `.env`-u.
 */
export const RAZDVOJI_REVERSE_I_LOKACIJE = "REVERSI_LOKACIJE_RAZDVOJENO";

/**
 * 🔴 Brana koja sprovodi da `REVERSI_IZVOR` i `LOKACIJE_IZVOR` imaju ISTU vrednost.
 *
 * ZAŠTO POSTOJI (izmereno 07.08.2026, docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md §2):
 * izdavanje alata je JEDNA transakcija koja piše u oba domena — `rev_issue_reversal`
 * upisuje `rev_document_lines` i odmah, u istom commit-u, `loc_location_movements`
 * (kroz `loc_create_movement`). Ako prekidači stanu na različite vrednosti, ta
 * transakcija se preseca na dve baze: dokument u jednoj, kretanje u drugoj, bez
 * ijedne poruke o grešci.
 *
 * To je razlog zbog kog ovde NE važi doslovno pravilo iz `IzvorPrekidac`-a („jedan
 * prekidač = jedan domen", pouka incidenta 06.08.2026 sa `SASTANCI_PB_IZVOR`).
 * Tamo su dva NEPOVEZANA domena delila prekidač, pa je spreman domen obarao
 * nespreman. Ovde su domeni transakciono spojeni: pravilo iz 06.08. ostaje ispunjeno
 * time što SVAKI domen ima svoje ime env-a i svoje poruke o 503 — a sprega je
 * dodatna brana iznad toga, ne zamena za nju.
 *
 * PONAŠANJE: `throw` na startu aplikacije (bootstrap), pre nego što ijedan zahtev
 * stigne. Bolje da backend ne krene nego da 15 minuta piše u dve baze — pouka
 * „docker restart ne čita env" (07.08.2026) kaže da tihi pogrešan prekidač ume da
 * radi neprimećeno.
 *
 * POVRATAK: postavi obe promenljive na istu vrednost i restartuj.
 */
export function assertSpojeniIzvori(
  reversi: IzvorPrekidac,
  lokacije: IzvorPrekidac,
  logger: Logger = new Logger("SpojeniIzvori"),
): void {
  if (reversi.izvor === lokacije.izvor) return;

  const razdvojeno =
    (process.env[RAZDVOJI_REVERSE_I_LOKACIJE] ?? "").trim().toLowerCase() ===
    "true";

  if (razdvojeno) {
    logger.warn(
      `${RAZDVOJI_REVERSE_I_LOKACIJE}=true — REVERSI_IZVOR=${reversi.izvor} i ` +
        `LOKACIJE_IZVOR=${lokacije.izvor} su NAMERNO razdvojeni. Izdavanje i povraćaj ` +
        `alata pišu u OBA domena u jednoj transakciji; dok ovo stoji, ta transakcija ` +
        `se preseca na dve baze. Koristiti samo za merenje, nikad na produkciji.`,
    );
    return;
  }

  throw new Error(
    `REVERSI_IZVOR="${reversi.izvor}" i LOKACIJE_IZVOR="${lokacije.izvor}" se razlikuju. ` +
      `Ta dva domena su transakciono spojena (izdavanje alata u istom commit-u piše ` +
      `rev_document_lines i loc_location_movements), pa bi razdvojen preklop tiho ` +
      `razišao dve baze. Postavi obe na istu vrednost ("sy15" ili "3.0") i restartuj. ` +
      `Ako razdvajanje IPAK treba (merenje), postavi ${RAZDVOJI_REVERSE_I_LOKACIJE}=true.`,
  );
}
