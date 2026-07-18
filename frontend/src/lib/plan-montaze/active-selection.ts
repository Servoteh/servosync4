// Deljeni AKTIVAN projekat/nalog kroz sve poglede modula (paritet 1.0 activeProject/activeWp:
// Plan → Gantt → Plan zadržava izbor umesto reseta na prvi ⭐ projekat) + localStorage persist
// preko reload-a. SSR-safe (typeof window guard — static export prerender).

const LS_PROJECT = 'montaza.active.project';
const LS_WP = 'montaza.active.wp';

export interface ActiveSelection {
  projectId: string | null;
  wpId: string | null;
}

export function readActiveSelection(): ActiveSelection {
  if (typeof window === 'undefined') return { projectId: null, wpId: null };
  try {
    return {
      projectId: window.localStorage.getItem(LS_PROJECT),
      wpId: window.localStorage.getItem(LS_WP),
    };
  } catch {
    return { projectId: null, wpId: null };
  }
}

export function writeActiveSelection(projectId: string | null, wpId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (projectId) window.localStorage.setItem(LS_PROJECT, projectId);
    else window.localStorage.removeItem(LS_PROJECT);
    if (wpId) window.localStorage.setItem(LS_WP, wpId);
    else window.localStorage.removeItem(LS_WP);
  } catch {
    /* privatni mod / puna kvota — izbor važi samo unutar mount-a */
  }
}
