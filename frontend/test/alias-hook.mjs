import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Razrešavanje uvoza za `npm test` (`node --test`) — bez ijedne nove zavisnosti.
 *
 * Specifikacije (`*.spec.ts`) su pisane u stilu izvornog koda: alias `@/…` i relativni
 * uvozi BEZ ekstenzije. To razume bundler (Next), ali ne i goli Node, pa je do sada
 * postojeća `artikli/_forma/pravila.spec.ts` mogla samo da se čita — nijedan alat je
 * nije pokretao. Ova kuka mapira `@/x` → `src/x` i dopisuje `.ts`/`.tsx`, pa se testovi
 * čiste logike (bez React-a) pokreću ugrađenim `node:test`-om i Node-ovim skidanjem
 * tipova. Ništa od ovoga ne ulazi u `next build` — fajl je van `src/` i niko ga ne uvozi.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith('@/')) {
      base = path.join(SRC, specifier.slice(2));
    } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
      if (context.parentURL?.startsWith('file:')) {
        base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      }
    }
    if (base) {
      for (const cand of [`${base}.ts`, `${base}.tsx`, base, path.join(base, 'index.ts')]) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
          return { url: pathToFileURL(cand).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
