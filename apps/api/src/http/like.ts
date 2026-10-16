/** A LIKE / ILIKE pattern that finds the text anywhere, with the text's own wildcards escaped. */
export function containing(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** About `size` characters of `text` around the first match of `query`, with ellipses where cut. */
export function snippetAround(text: string, query: string, size: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (flat.length <= size) return flat;
  if (at < 0) return `${flat.slice(0, size)}…`;
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size));
  return `${start ? '…' : ''}${flat.slice(start, start + size)}${start + size < flat.length ? '…' : ''}`;
}
