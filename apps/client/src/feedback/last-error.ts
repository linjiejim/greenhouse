/**
 * The last failure the app showed (every alertError, src/ui/dialogs.tsx), kept in memory only so
 * feedback can say what went wrong just before. React-free (./feedback.test.ts). Never persisted:
 * an error text can quote a document title.
 */

let last: { at: number; text: string } | null = null;

export function recordError(title: string, message?: string): void {
  last = { at: Date.now(), text: [title, message].filter(Boolean).join(' — ').slice(0, 300) };
}

/** "HH:MM title — message" for the feedback context, or null when nothing failed this session. */
export function lastErrorLine(now = Date.now()): string | null {
  if (!last) return null;
  const minutes = Math.max(0, Math.round((now - last.at) / 60000));
  return `${last.text} (${minutes} min ago)`;
}

/** What the feedback carries about this app, besides the member's words. */
export function feedbackContext(input: {
  version: string;
  platform: string;
  stationUrl: string | null;
  lastError: string | null;
}): Record<string, string> {
  const context: Record<string, string> = { app: input.version || 'unknown', platform: input.platform };
  if (input.stationUrl) {
    try {
      context.station = new URL(input.stationUrl).host;
    } catch {
      // a malformed address says nothing useful
    }
  }
  if (input.lastError) context.last_error = input.lastError;
  return context;
}
