/**
 * Small formatting helpers shared across screens: file sizes.
 * Times live in ../data/time.ts (Hermes-safe parsing, relative times).
 */


/** File size: 512 → "512 B", 12_345 → "12.1 KB", 3_400_000 → "3.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

