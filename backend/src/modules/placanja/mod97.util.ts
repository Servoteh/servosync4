/**
 * Poziv na broj — kontrolni brojevi (MOD97 / MOD11).
 * =========================================================================
 * 1:1 iz legacy `Module__KontrolniBrojevi.txt` (BigBit). Čiste funkcije,
 * bez zavisnosti — jedini izvor istine za poziv na broj u pripremi plaćanja.
 *
 * Modeli poziva na broj (`PNBOdobModel` / `PNBZadModel`, doc 21 §B):
 *   "97" = MOD97 (KBroj97)   → dvocifreni kontrolni broj
 *   "11" = MOD11 (Kbroj22)   → jednocifreni kontrolni broj (težine 7..2)
 *   "99" = bez kontrole      → poziv na broj se ne obračunava (vrati kako jeste)
 *
 * ⚠️ Legacy koristi CDec (28-cifreni decimal) da izbegne overflow — mi koristimo
 *    BigInt iz istog razloga (broj računa + serijal ume da prebaci Number.MAX_SAFE).
 */

/** Zadrži samo cifre iz stringa (legacy `IzbaciIzStCh` + poziv na broj bez crtica). */
export function digitsOnly(input: string): string {
  return (input ?? "").replace(/\D+/g, "");
}

/**
 * MOD97 kontrolni broj (legacy `KBroj97`, `:35-56`):
 *   KBroj97 = 98 − ((broj × 100) mod 97), pad na 2 cifre.
 *
 * @param broj  numerički niz (npr. banka+račun bez crtica, ili broj fakture)
 * @returns dvocifreni kontrolni broj "00".."97", ili "" ako ulaz nije numerički
 *          (legacy vraća "" na Err 6 „preveliki broj").
 */
export function kBroj97(broj: string): string {
  const digits = digitsOnly(broj);
  if (digits.length === 0) return "";
  const n = BigInt(digits);
  // 98 − ((n × 100) mod 97); rezultat je uvek u opsegu 1..97 → dvocifren pad.
  const kbroj = 98n - ((n * 100n) % 97n);
  return kbroj.toString().padStart(2, "0");
}

/**
 * MOD11 kontrolni broj (legacy `Kbroj22`, `:12-34`) — koristi se za PNB model "11".
 * Sedmocifreni ulaz; ako počinje "0", rotira prvu cifru na kraj (legacy pravilo).
 * Težine 8−i za i=1..6, pa ×7 za 7. cifru; kbroj = 11 − (Σ mod 11); 10→0, 11→1.
 *
 * @param sf  numerički niz dužine 7 (legacy pretpostavlja tačno 7 cifara)
 * @returns jednocifreni kontrolni broj "0".."9", ili "" ako ulaz nije 7 cifara.
 */
export function kBroj22(sf: string): string {
  let digits = digitsOnly(sf);
  if (digits.length !== 7) return "";
  // legacy: If Left$(sf,1)="0" Then sf = Mid$(sf,2,6) & Left$(sf,1)
  if (digits[0] === "0") {
    digits = digits.slice(1, 7) + digits[0];
  }
  let zb = 0;
  for (let i = 1; i <= 6; i++) {
    zb += Number(digits[i - 1]) * (8 - i);
  }
  zb += Number(digits[6]) * 7;
  let kbroj = zb % 11;
  kbroj = 11 - kbroj;
  if (kbroj === 10) kbroj = 0;
  else if (kbroj === 11) kbroj = 1;
  return String(kbroj);
}

/**
 * Obračunaj poziv na broj za dati model.
 *   "97" → base + kBroj97(base)   (kontrolni sufiks)
 *   "11" → base + kBroj22(base)
 *   "99"/ostalo → base (bez kontrole)
 *
 * @param model  PNB model ("97" | "11" | "99")
 * @param base   osnova poziva na broj (npr. broj fakture bez kontrolne cifre)
 */
export function computeReferenceNumber(model: string, base: string): string {
  const clean = digitsOnly(base);
  switch ((model ?? "").trim()) {
    case "97": {
      const kb = kBroj97(clean);
      return kb ? clean + kb : clean;
    }
    case "11": {
      const kb = kBroj22(clean);
      return kb ? clean + kb : clean;
    }
    default:
      // "99" (bez kontrole) i sve nepoznato → vrati osnovu netaknutu.
      return clean;
  }
}

/**
 * Validacija tekućeg računa (legacy `DobarTR`, `:57-73`): format banka(3)-racun-KK(2),
 * gde je kontrolni KK == KBroj97(banka(3) + racun(13, left-pad "0")).
 *
 * @param tr  račun sa crticama "NNN-...-KK"
 */
export function isValidAccountNumber(tr: string): boolean {
  if (!tr || tr.indexOf("-") < 0) return false;
  const tr1 = tr.slice(0, 3);
  const dash = tr.indexOf("-");
  const tr2 = tr.slice(dash + 1, tr.length - 3); // sredina bez zadnjih "-KK"
  const tr3 = tr.slice(-2);
  const rebuilt = `${tr1}-${tr2}-${tr3}`;
  const structureOk = tr === rebuilt;
  const tr2Padded = tr2.padStart(13, "0");
  const kb = kBroj97(tr1 + tr2Padded);
  return structureOk && kb === tr3;
}

/*
 * RAZMIŠLJANJE O TESTOVIMA (bez test-runnera ovde — obrazac):
 *   kBroj97("840000000000000000") → uvek dvocifren; identitet:
 *     (n*100) % 97 ∈ [0,96] → 98 − to ∈ [2,98]; kada je == 98 → "98"? Ne:
 *     legacy dozvoljava i "98"/"99"? Zapravo 98−0=98, 98−96=2 → opseg [2,98].
 *   kBroj97("") → "" (guard prazan ulaz).
 *   computeReferenceNumber("99", "1234") → "1234" (bez kontrole).
 *   computeReferenceNumber("97", "1234") → "1234" + kBroj97("1234").
 *   kBroj22 pon 7-cifreni ulaz koji počinje "0" → rotacija pa težine.
 *   isValidAccountNumber("160-0000000000000-16") → struktura+KK provera.
 */
