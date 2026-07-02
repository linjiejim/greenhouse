/**
 * Shared "Thinking" reasoning panel — neutral styling, used by both the
 * completed message bubble and the streaming bubble so the two stay in sync.
 */

export function ReasoningPanel({ reasoning }: { reasoning: string }) {
  return (
    <div className="mb-3 p-3 bg-surface-sunken border border-edge rounded-lg text-xs text-fg-muted italic max-h-48 overflow-y-auto">
      <pre className="whitespace-pre-wrap font-sans leading-relaxed">{reasoning}</pre>
    </div>
  );
}
