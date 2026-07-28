/**
 * Pokretač testova za matične ekrane (artikli / komitenti).
 *
 * Frontend nema jest ni vitest (v. `frontend/package.json`), a Node 22.18+/24 ume da
 * pokrene `.ts` direktno (skida tipove). Jedina prepreka je što ESM traži punu
 * ekstenziju u putanji, a `tsc --noEmit` zabranjuje `./nesto.ts` u import-u
 * (TS5097, `allowImportingTsExtensions` nije uključen) — pa spec ne može da napiše ni
 * jedno ni drugo. Ovaj shim dodaje `.ts` pri razrešavanju, tako da spec ostaje
 * običan `*.spec.ts` pored koda, kako traže pravila repoa.
 *
 * Pokretanje (iz `frontend/`):
 *   node --import ./src/app/artikli/_forma/test-runner.mjs --test "src/app/**‌/*.spec.ts"
 * ili konkretno:
 *   node --import ./src/app/artikli/_forma/test-runner.mjs --test src/app/artikli/_forma/pravila.spec.ts
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `frontend/src` — koren `@/` alijasa iz `tsconfig.json` (`paths`). */
const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@/x` → `frontend/src/x` (tsconfig paths; Node ne čita tsconfig).
    const cilj = specifier.startsWith('@/')
      ? pathToFileURL(resolvePath(SRC, specifier.slice(2))).href
      : specifier;
    try {
      return nextResolve(cilj, context);
    } catch (err) {
      const relativan = cilj.startsWith('./') || cilj.startsWith('../') || cilj.startsWith('file:');
      const bezEkstenzije = !/\.[a-z]+$/i.test(cilj);
      if (relativan && bezEkstenzije) return nextResolve(`${cilj}.ts`, context);
      throw err;
    }
  },
});
