export type Theme = 'dark' | 'light';

const THEME_KEY = 'pi-desktop:theme';
const listeners = new Set<(t: Theme) => void>();

function readStored(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// Drive the whole UI from a single attribute on <html>. `:root` holds the dark
// defaults; `[data-theme="light"]` (in tokens.css) overrides the same token names,
// so every component — sidebar, title bar, modals — follows the theme for free.
function paint(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
}

export function getTheme(): Theme {
  return (document.documentElement.getAttribute('data-theme') as Theme) ?? 'dark';
}

export function setTheme(t: Theme) {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* storage may be unavailable (private mode); theme still applies for the session */
  }
  paint(t);
  listeners.forEach((l) => l(t));
}

export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Apply the persisted theme during module load, before React renders, so the
// first paint already uses the right theme (no flash of the wrong one).
paint(readStored());
