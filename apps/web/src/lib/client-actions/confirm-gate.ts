/**
 * Confirmation gate for agent-initiated actions.
 *
 * Two callers share it: `safety: 'confirm'` client actions, and browser
 * automation writes that the desktop's policy decided to ask about. Both are
 * "the agent wants to do something to the user's stuff" and both must look the
 * same, so there is one queue and one dialog.
 *
 * A module-level store rather than React state because `executeClientAction`
 * and the bridge listener both run outside the component tree — same shape as
 * `desktop/capabilities.ts`.
 */

export interface ConfirmationPrompt {
  id: string;
  title: string;
  description?: string;
  /** Why this needs confirming, e.g. 'will submit a form'. Rendered as a list. */
  reasons?: string[];
  /**
   * Host to offer a "don't ask again for this site" grant for. That grant is
   * conversation-scoped and never persisted — see the bridge listener.
   */
  siteLabel?: string;
  /**
   * Whether to also offer permanent trust for `siteLabel`. Only the browser
   * bridge sets this: a generic client action has no host to trust.
   */
  offerPermanentTrust?: boolean;
  confirmLabel?: string;
}

export interface ConfirmationOutcome {
  allowed: boolean;
  /** True when the user chose the "allow for this site" affordance. */
  rememberSite: boolean;
  /**
   * True when the user chose to trust the site permanently (the YOLO list).
   *
   * Distinct from `rememberSite`, which lapses with the connection. Permanently
   * disarming the gate for a host is a decision worth its own answer rather than
   * a stronger version of "yes".
   */
  trustSiteAlways?: boolean;
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
  pending.forEach((entry) => entry.resolve({ allowed: false, rememberSite: false, trustSiteAlways: false }));
  notify();
}

export function peekConfirmation(): ConfirmationPrompt | null {
  return queue[0]?.prompt ?? null;
}

export function onConfirmationChange(listener: (prompt: ConfirmationPrompt | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
