import { useEffect, useRef } from 'react';
import { matchesShortcut } from './shortcut-model';
export function useShortcut(shortcut: string | undefined, action: () => void, enabled = true): void {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!shortcut || !enabled) return;
    const run = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !matchesShortcut(shortcut, event)) return;
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        event.key !== 'Escape' &&
        event.target instanceof HTMLElement &&
        event.target.closest('input,textarea,[contenteditable=true]')
      )
        return;
      event.preventDefault();
      latest.current();
    };
    const native = (event: Event) => {
      if ((event as CustomEvent<string>).detail === shortcut) latest.current();
    };
    window.addEventListener('greenhouse:shortcut', native);
    window.addEventListener('keydown', run);
    return () => {
      window.removeEventListener('keydown', run);
      window.removeEventListener('greenhouse:shortcut', native);
    };
  }, [shortcut, enabled]);
}
