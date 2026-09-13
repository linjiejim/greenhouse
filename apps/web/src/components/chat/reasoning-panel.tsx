import { CheckCircle, ChevronDown } from '../../lib/icons';
import { useT } from '../../lib/i18n';

/**
 * First line of the most recently completed reasoning paragraph.
 *
 * The final paragraph is still being streamed, so exposing it here makes the
 * compact row flicker on every token. We only promote a paragraph once the next
 * one has started; completed reasoning deliberately has no side preview.
 */
export function reasoningHeadline(reasoning: string): string {
  const paragraphs = reasoning
    .split(/\n\s*\n/)
    .map(
      (paragraph) =>
        paragraph
          .split('\n')
          .find((line) => line.trim())
          ?.trim() ?? '',
    )
    .filter(Boolean);
  return (paragraphs.at(-2) ?? '').slice(0, 180);
}

export function ReasoningToggle({
  reasoning,
  expanded,
  onToggle,
  active = false,
}: {
  reasoning: string;
  expanded: boolean;
  onToggle: () => void;
  active?: boolean;
}) {
  const t = useT();
  const headline = active ? reasoningHeadline(reasoning) : '';
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex min-w-0 max-w-full items-center gap-1 py-0.5 text-left text-[11px] text-fg-faint transition-colors hover:text-fg-secondary"
    >
      {active ? (
        <span className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-primary-500" />
      ) : (
        <CheckCircle size={12} className="flex-shrink-0 text-primary-500" />
      )}
      <span className="flex-shrink-0">{active ? t('chat.thinking') : t('chat.thought')}</span>
      <ChevronDown size={11} className={`flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      {!expanded && headline && (
        <span key={headline} className="ml-1 min-w-0 truncate text-[10px] text-fg-faint animate-fade-in">
          {headline}
        </span>
      )}
    </button>
  );
}

export function ReasoningPanel({ reasoning }: { reasoning: string }) {
  return (
    <div className="mb-3 p-3 bg-surface-sunken border border-edge rounded-lg text-xs text-fg-muted italic max-h-48 overflow-y-auto">
      <pre className="whitespace-pre-wrap font-sans leading-relaxed">{reasoning}</pre>
    </div>
  );
}
