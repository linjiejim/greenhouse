/**
 * A document's body under its own title. Many docs open with `# <title>`; the reader already
 * draws the title, so that first heading is dropped (only when it says the same thing). React-free.
 */
const norm = (s: string) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function bodyUnderTitle(markdown: string | null | undefined, title: string): string {
  const source = markdown ?? '';
  const match = /^\s*#[ \t]+([^\n]+)\n?/.exec(source);
  if (!match || norm(match[1].replace(/\s+#+\s*$/, '')) !== norm(title)) return source;
  return source.slice(match[0].length).replace(/^\s*\n/, '');
}
