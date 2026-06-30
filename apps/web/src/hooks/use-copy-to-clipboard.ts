import { useCallback, useState } from 'react';

/**
 * Copy-to-clipboard with a transient "copied" flag that auto-resets.
 *
 * Replaces the repeated `const [copied, setCopied] = useState(false)` +
 * `navigator.clipboard.writeText(...); setCopied(true); setTimeout(...)` idiom.
 */
export function useCopyToClipboard(resetMs = 2000): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs],
  );
  return { copied, copy };
}
