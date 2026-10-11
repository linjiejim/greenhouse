/** Text card: the builder's Markdown, through the shared (sanitizing) renderer. */

import { Markdown } from '../markdown';

export function TextCard({ markdown }: { markdown: string }) {
  if (!markdown.trim()) return <p className="text-sm text-fg-faint">—</p>;
  return <Markdown content={markdown} compact className="text-sm text-fg-secondary" />;
}
