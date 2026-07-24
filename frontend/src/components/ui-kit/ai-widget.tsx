'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bot } from 'lucide-react';
import { cn } from '@/lib/cn';
import { AiChat } from '@/app/ai/_components/ai-chat';

// Plutajući AI asistent (zahtev 003/26, Zoran): okruglo dugme dole desno → kompaktni
// chat panel koji NE tera korisnika da napusti trenutnu formu. Non-modal (bez scrim-a
// koji blokira stranu), minimizacija (X/Esc) vraća na dugme.
//
// Stanje (otvorenost + aktivna nit) živi u MODUL-scope store-u, NE u komponenti:
// AppShell se montira per-page, pa bi lokalno stanje nestalo na svakoj navigaciji.
// Modul se ne uvozi ponovo pri klijentskoj navigaciji → store preživi remount i panel
// ostaje otvoren na istoj niti dok je aplikacija otvorena. BEZ localStorage (Zoran:
// nema pamćenja sesija) — zatvaranje taba resetuje sve. Poruke istorije čuva TanStack
// Query keš (app-nivo, van AppShell-a), pa se nit vraća netaknuta.
interface WidgetState {
  open: boolean;
  conversationId: string | null;
}
let state: WidgetState = { open: false, conversationId: null };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
function getSnapshot(): WidgetState {
  return state;
}
function setOpen(v: boolean) {
  if (state.open === v) return;
  state = { ...state, open: v };
  emit();
}
// Stabilna referenca (module-scope) — bezbedno kao dep AiChat efekta.
function setConversationId(id: string | null) {
  if (state.conversationId === id) return;
  state = { ...state, conversationId: id };
  emit();
}

/**
 * Plutajuće AI dugme + panel. Mount-uje ga AppShell SAMO korisnicima sa AI permisijom
 * i van /ai strane (tamo je redundantno). z-40: iznad sadržaja i sticky traka, ISPOD
 * modala/dijaloga (z-50) — asistent nikad ne prekriva otvoreni dijalog.
 */
export function AiWidget({ screenContext }: { screenContext?: string }) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { open, conversationId } = snap;

  // Lenja montaža: AiChat (i njegovi upiti /me, /limit, /conversations) se montira tek
  // pri prvom otvaranju, pa ostaje montiran (sakriven CSS-om) da minimizacija sačuva
  // ceo razgovor. Ako je panel već otvoren pri (re)mount-u posle navigacije — odmah.
  const [everOpened, setEverOpened] = useState(open);
  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // Esc minimizuje (dok je panel otvoren) — osim ako je iznad njega modalni dijalog
  // (ima svoj Esc; ne otimamo mu ga).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Plutajuće dugme (dole desno) — sakriveno dok je panel otvoren. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="AI asistent"
          aria-label="Otvori AI asistenta"
          className={cn(
            'fixed bottom-4 right-4 z-40 grid h-14 w-14 place-items-center rounded-full',
            'bg-accent text-accent-fg shadow-lg transition-colors hover:bg-accent-hover',
            'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
          )}
        >
          <Bot className="h-6 w-6" aria-hidden />
        </button>
      )}

      {/* Panel — montiran čim je jednom otvoren; sakriven CSS-om kad je minimizovan
          (razgovor ostaje živ). Desktop: kartica dole desno; < lg: donji sheet. */}
      {(everOpened || open) && (
        <div
          role="dialog"
          aria-label="AI asistent"
          className={cn(
            'fixed z-40 flex-col overflow-hidden border border-line bg-surface shadow-2xl',
            'bottom-4 right-4 h-[65vh] max-h-[calc(100vh-2rem)] w-[380px] max-w-[calc(100vw-2rem)] rounded-panel',
            'max-lg:bottom-0 max-lg:left-0 max-lg:right-0 max-lg:h-[85vh] max-lg:w-auto max-lg:max-w-none max-lg:rounded-b-none',
            open ? 'flex' : 'hidden',
          )}
        >
          <AiChat
            variant="widget"
            screenContext={screenContext}
            onMinimize={() => setOpen(false)}
            initialConversationId={conversationId}
            onConversationChange={setConversationId}
          />
        </div>
      )}
    </>
  );
}
