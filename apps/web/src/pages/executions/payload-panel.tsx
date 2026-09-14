import type { RuntimePayload } from '@greenhouse/types/runtime';
import { ChevronRight } from '../../lib/icons';
import { payloadText } from './model';

/** Complete persisted JSON, collapsed by default so large tool payloads remain usable. */
export function RuntimePayloadPanel({
  title,
  value,
  open = false,
}: {
  title: string;
  value: RuntimePayload | null;
  open?: boolean;
}) {
  if (value === null) return null;
  return (
    <details open={open} className="group overflow-hidden rounded-lg border border-edge bg-surface-sunken">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-fg-secondary hover:bg-surface-muted">
        <ChevronRight
          size={13}
          className="flex-shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        <span>{title}</span>
      </summary>
      <pre className="selectable max-h-[32rem] overflow-auto border-t border-edge p-3 text-[11px] leading-relaxed text-fg-secondary">
        {payloadText(value)}
      </pre>
    </details>
  );
}
