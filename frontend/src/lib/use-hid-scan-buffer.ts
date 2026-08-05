'use client';

import { useEffect, useRef } from 'react';

/**
 * `useHidScanBuffer` — LOKALNI HID („keyboard wedge") bafer unutar punoekranskog skenera
 * i (od 04.08.2026) FORM-WEDGE hvatač unutar otvorene forme/dijaloga.
 *
 * ZAŠTO (regresija 02.08.2026, Android/kiosk): dok je skener otvoren, sken sa
 * Bluetooth/USB čitača nije imao gde da padne.
 *  1. Polje ručnog unosa u ljuskama ima `autoFocus` pod gardom
 *     `!matchMedia('(pointer: coarse)')` — na SVAKOM telefonu i tabletu je to `false`,
 *     pa polje nije fokusirano. (Gard je namerno i OSTAJE: programatski fokus na
 *     telefonu diže soft tastaturu PREKO kadra pre svakog skena.)
 *  2. Globalni HID hvatač radnog stola (`lib/reversi-global-scanner.ts:55`) namerno
 *     ćuti dok postoji `[role="dialog"][aria-modal="true"]` — a skener overlay je baš
 *     takav element, jer se pretpostavljalo da „UI sam preuzima sken".
 * Zbir to dvoje: karakteri sa čitača odu u `document.body` i nestanu. Radnik pritisne
 * okidač, čuje bip čitača i ne dobije ništa.
 *
 * Algoritam je isti kao u `reversi-global-scanner.ts` (koji je port 1.0 `globalScanner.js`):
 * akumuliraj `keydown` u capture fazi, resetuj bafer na pauzu dužu od 80 ms (čovek koji
 * kuca nikad ne napravi 4+ znaka sa razmakom < 80 ms), na `Enter` predaj kod od bar 4
 * znaka i utišaj isti kod 1,5 s (dupli okidač čitača).
 *
 * PODRAZUMEVANO ćuti dok je fokus U POLJU (input/select/textarea/contentEditable) —
 * tada kucanje i `Enter` pripadaju formi ljuske (ručni unos), pa bi bafer poslao kod
 * DVA puta. To je režim svih skener-overlay ljuski i on se OVIM NE MENJA.
 *
 * ─── FORM-WEDGE režim (`captureMarkedFields`, prijava 04.08.2026) ───────────────
 * U OTVORENOJ FORMI (npr. „Premesti stavku") stoni čitač kuca pravo u fokusirano
 * polje: ceo `RNZ:…` string sleti sirov u „Broj TP", parser se nikad ne pozove.
 * `captureMarkedFields: true` zato bafer puni I DOK JE FOKUS U POLJU — ali SAMO u
 * polju koje vlasnik OZNAČI sa `data-hid-wedge-field="…"` (svoja polja forme).
 * NEoznačeno tekstualno polje (npr. pretraga police u `LocationSelect`) ostaje pun
 * vlasnik svog unosa — bafer se tu resetuje kao i do sada, pa se dva hvatača
 * (form-wedge i eventualni hvatač samog polja) NIKAD ne sudaraju. Ne-tekstualni
 * elementi (checkbox/radio/dugme) ne primaju karaktere pa se tretiraju kao „van
 * polja". Karakteri bursta se NE presreću (do `Enter`-a ne znamo da li je sken) —
 * zato hook uz kod predaje i SNAPSHOT polja sa početka bursta
 * (`HidScanFieldContext`), kojim vlasnik vraća upisani višak iz svog state-a.
 * `accept` (npr. provera oblika barkoda) + `minLength` čuvaju NORMALNO kucanje:
 * `Enter` se guta samo kad je burst brz (RESET_MS gejt), dovoljno dug i prihvaćen —
 * inače prolazi netaknut.
 *
 * @param enabled  Isključi kad hvatač ne sme da prima kod (npr. dok je preko forme
 *                 otvoren kamera overlay sa SVOJIM hvatačem).
 * @param onCode   Prima očišćen kod (+ kontekst polja u form-wedge režimu); ljuska
 *                 ga vodi kroz svoj `resolve`/parse put (isti kao kamera).
 */
export interface HidScanFieldContext {
  /** Označeno polje (`data-hid-wedge-field`) u kome je burst završio; `null` = fokus van polja. */
  field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  /** Vrednost polja PRE prvog znaka bursta — vlasnik njome vraća upisani višak. */
  valueBefore: string;
}

export interface HidScanBufferOptions {
  /**
   * Form-wedge režim: hvataj i dok je fokus u polju označenom
   * `data-hid-wedge-field`; NEoznačena tekstualna polja i dalje resetuju bafer.
   */
  captureMarkedFields?: boolean;
  /**
   * Presudi da li je kod „naš" (npr. oblik ITEM nalepnice). Kad vrati `false`,
   * `Enter` se NE guta — pripada formi (obavezno u form-wedge režimu, da ručni
   * unos + Enter ne bude ometan).
   */
  accept?: (code: string) => boolean;
  /** Minimalna dužina koda (default 4; form-wedge tipično traži više). */
  minLength?: number;
}

export function useHidScanBuffer(
  enabled: boolean,
  onCode: (code: string, ctx: HidScanFieldContext | null) => void,
  opts?: HidScanBufferOptions,
): void {
  // Callback/opcije su inline literali (nov identitet po renderu) — u ref-u, da se
  // slušalac ne skida i ne vezuje na svaki render ljuske (a time i ne gubi bafer
  // usred skena). Efekat zavisi samo od `enabled` + režima.
  const cbRef = useRef(onCode);
  const optsRef = useRef(opts);
  useEffect(() => {
    cbRef.current = onCode;
    optsRef.current = opts;
  });

  const captureMarked = !!opts?.captureMarkedFields;

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;

    const RESET_MS = 80; // gap između karaktera HID čitača < ~80 ms
    const MIN_LENGTH = 4; // ignoriši kratke „slučajne" sekvence
    const THROTTLE_MS = 1500; // dupli Enter / ponovljen okidač

    let buffer = '';
    let lastKeyAt = 0;
    let lastCode = '';
    let lastAt = 0;
    /** Snapshot označenog polja sa POČETKA bursta (form-wedge). */
    let burstField: HidScanFieldContext | null = null;

    type FocusKind = 'none' | 'marked' | 'foreign';
    const classifyFocus = (): { kind: FocusKind; el?: HidScanFieldContext['field'] } => {
      const ae = document.activeElement as HTMLElement | null;
      if (!ae) return { kind: 'none' };
      const tag = ae.tagName;
      const isField =
        tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || ae.isContentEditable === true;
      if (!isField) return { kind: 'none' };
      if (!captureMarked) return { kind: 'foreign' }; // postojeće ponašanje ljuski
      if (
        (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') &&
        ae.dataset.hidWedgeField != null
      ) {
        return { kind: 'marked', el: ae as HidScanFieldContext['field'] };
      }
      // Checkbox/radio/dugme ne primaju karaktere — burst preko njih je „van polja".
      if (tag === 'INPUT') {
        const t = (ae as HTMLInputElement).type;
        if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit' || t === 'file' || t === 'range') {
          return { kind: 'none' };
        }
      }
      return { kind: 'foreign' };
    };

    const onKeydown = (ev: KeyboardEvent) => {
      const focus = classifyFocus();
      if (focus.kind === 'foreign') {
        buffer = '';
        burstField = null;
        return;
      }
      const now = Date.now();
      if (now - lastKeyAt > RESET_MS) {
        buffer = '';
        burstField = null;
      }
      lastKeyAt = now;

      if (ev.key === 'Enter') {
        const code = buffer.trim();
        const ctx = burstField;
        buffer = '';
        burstField = null;
        if (code.length < (optsRef.current?.minLength ?? MIN_LENGTH)) return;
        const repeat = code === lastCode && now - lastAt < THROTTLE_MS;
        // Dupli okidač čitača (isti kod <1,5 s): ljuske (default režim) ga i
        // dalje tiho ignorišu. U form-wedge režimu burst je VEĆ upao u označeno
        // polje, pa bi tihi izlaz ostavio „121RNZ:…" u njemu i pustio Enter
        // formi (verify MAJOR-1) — zato i ponovljen kod ide vlasniku ISTIM
        // putem kao prihvaćen (restore + idempotentna ponovna primena), samo
        // bez pomeranja throttle prozora.
        if (repeat && !captureMarked) return;
        if (!repeat) {
          // Odbijen kod = NIJE sken → Enter pripada formi (ne diramo ga).
          // `repeat` je po konstrukciji već prošao `accept` (lastCode se puni
          // samo ovde), pa se provera ne ponavlja.
          if (optsRef.current?.accept && !optsRef.current.accept(code)) return;
          lastCode = code;
          lastAt = now;
        }
        // Enter sa čitača ne sme da „klikne" fokusirano dugme ljuske ni da procuri
        // na sloj ispod (escape-layer/dijalog) — sken je naš od ovog trenutka.
        ev.preventDefault();
        ev.stopPropagation();
        cbRef.current(code, ctx);
        return;
      }
      if (ev.key && ev.key.length === 1) {
        // Početak bursta u OZNAČENOM polju → zapamti stanje polja PRE prvog znaka
        // (keydown stiže pre nego što znak uđe u polje), za kasnije vraćanje.
        if (buffer === '' && focus.kind === 'marked' && focus.el) {
          burstField = { field: focus.el, valueBefore: focus.el.value ?? '' };
        }
        buffer += ev.key;
      }
    };

    document.addEventListener('keydown', onKeydown, true);
    return () => document.removeEventListener('keydown', onKeydown, true);
  }, [enabled, captureMarked]);
}
