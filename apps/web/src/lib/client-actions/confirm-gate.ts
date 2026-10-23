/**
 * Confirmation gate for agent-initiated actions.
 *
 * `safety: 'confirm'` client actions ask here before they run: one queue and one
 * dialog (`ActionConfirmDialog`), so a burst of actions can't bury one prompt
 * under another.
 *
 * A module-level store rather than React state because `executeClientAction`
 * runs outside the component tree.
 */

export interface ConfirmationPrompt {
  id: string;
  title: string;
  description?: string;
  /** Why this needs confirming, e.g. 'will submit a form'. Rendered as a list. */
  reasons?: string[];
  confirmLabel?: string;
}

export interface ConfirmationOutcome {
  allowed: boolean;
}

interface QueuedPrompt {
  prompt: ConfirmationPrompt;
  resolve: (outcome: ConfirmationOutcome) => void;
}

const queue: QueuedPrompt[] = [];
const listeners = new Set<(prompt: ConfirmationPrompt | null) => void>();
let nextId = 0;

function notify(): void {
  const current = queue[0]?.prompt ?? null;
  listeners.forEach((listener) => listener(current));
}

/**
 * Ask the user. Resolves when they answer; prompts queue rather than stacking,
 * so a burst of actions can't bury one dialog under another.
 */
export function requestConfirmation(prompt: Omit<ConfirmationPrompt, 'id'>): Promise<ConfirmationOutcome> {
  return new Promise<ConfirmationOutcome>((resolve) => {
    nextId += 1;
    queue.push({ prompt: { ...prompt, id: `confirm-${nextId}` }, resolve });
    notify();
  });
}

/** Answer the prompt at the head of the queue. */
export function resolveConfirmation(id: string, outcome: ConfirmationOutcome): void {
  const index = queue.findIndex((entry) => entry.prompt.id === id);
  if (index === -1) return;
  const [entry] = queue.splice(index, 1);
  entry.resolve(outcome);
  notify();
}

/**
 * Decline everything outstanding — used when the turn that asked is gone.
 *
 * Fails closed on purpose: an unanswered prompt must never become an approval.
 */
export function declineAllConfirmations(): void {
  const pending = queue.splice(0, queue.length);
  pending.forEach((entry) => entry.resolve({ allowed: false }));
  notify();
}

export function peekConfirmation(): ConfirmationPrompt | null {
  return queue[0]?.prompt ?? null;
}

export function onConfirmationChange(listener: (prompt: ConfirmationPrompt | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
