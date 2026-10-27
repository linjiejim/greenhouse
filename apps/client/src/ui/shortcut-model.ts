/** Shortcut matching shared by the web listener and its React-free tests. */
export interface KeyStroke {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
export function matchesShortcut(shortcut: string, event: KeyStroke): boolean {
  const parts = shortcut
    .toLowerCase()
    .replace(/⌘/g, 'mod+')
    .replace(/⌥/g, 'alt+')
    .replace(/⇧/g, 'shift+')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const key = parts.pop();
  return (
    event.key.toLowerCase() === key &&
    (event.metaKey || event.ctrlKey) === parts.includes('mod') &&
    event.altKey === parts.includes('alt') &&
    event.shiftKey === parts.includes('shift')
  );
}
