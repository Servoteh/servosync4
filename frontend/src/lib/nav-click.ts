// Klik na link koji BROWSER obrađuje sam — a mi ga svejedno „propratimo" u tekućem tabu.
//
// Kućni kanal `servosync:nav` (v. `use-query-tab.ts`) postoji zato što Next NE remount-uje
// stranu kad se menja samo query, pa podstavka sidebara `/odrzavanje?tab=masine` → `?tab=kvarovi`
// menja adresu a ne i ekran. Rešenje je `emitNavEvent(href)` u `onClick` <Link>-a. Ali `onClick`
// se izvrši i kad korisnik drži Ctrl/⌘ (otvori u NOVOM tabu), Shift (nov prozor) ili klikne
// srednjim tasterom — tada Next namerno prepušta navigaciju browseru, TEKUĆA strana ostaje gde
// jeste, a naš event bi joj svejedno rekao „prikaži cilj". Ishod: korisnik ctrl-klikne
// „Održavanje → Kvarovi" da ga uporedi sa tekućim pogledom, dobije ga u novom tabu — i zatekne
// da mu je STARI tab takođe skočio na Kvarove, dok adresa i dalje pokazuje pogled koji je gledao.
//
// Zato svaki <Link> koji emituje nav event MORA prvo da propusti ovaj gard. U app-shell-u je
// to obezbeđeno tipom (`NavigateHandler` prima događaj kao prvi argument, pa nov link koji ga
// zaboravi ne prolazi `tsc`); van njega gard stoji u samom `onClick`-u.

/**
 * Minimum koji nam treba od događaja klika — strukturno, bez veze sa React-om i DOM-om
 * (pa je funkcija testabilna golim `node --test`). Odgovara i `React.MouseEvent` i
 * nativnom `MouseEvent`.
 */
export interface NavClickLike {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  /** 0 = levi taster. Srednji (1) otvara nov tab, desni (2) otvara kontekstni meni. */
  button?: number;
}

/**
 * `true` = klik koji NE menja tekuću stranu (nov tab/prozor, preuzimanje, srednji taster).
 * Pozivalac tada mora da preskoči i `emitNavEvent` i svaku drugu izmenu stanja tekuće
 * strane — korisnik je tražio „otvori drugde", ne „vodi mene tamo".
 *
 * Alt-klik je namerno unutra: u browserima gde on znači „preuzmi" navigacije uopšte ni nema.
 */
export function isModifiedNavClick(e: NavClickLike): boolean {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return true;
  return (e.button ?? 0) !== 0;
}
