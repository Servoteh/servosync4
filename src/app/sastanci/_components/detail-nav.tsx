'use client';

import { createContext, useContext } from 'react';

/**
 * Otvaranje detalja sastanka BEZ dinamičkog segmenta rute — app je `output: export`
 * (statički), pa `/sastanci/[id]` nije dozvoljen. Detalj se prikazuje kao stanje
 * unutar `/sastanci` (deep-link `?open=<id>`), paritet ostalih 2.0 modula (master
 * u istoj strani). Kontekst prosleđuje `open(id)` dubljim tabovima/paleti.
 */
export const DetailNavContext = createContext<{ open: (id: string) => void }>({
  open: () => {},
});

export function useDetailNav() {
  return useContext(DetailNavContext);
}
