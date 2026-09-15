/**
 * A one-slot channel for handing captured context to the agent composer.
 *
 * The composer's attachment state lives inside the agent panel (`pendingImages` in
 * `components/agent-panel/index.tsx`), and a global shortcut fires from outside any
 * React tree. Rather than hoist that state up — or thread a ref through the app —
 * this is the seam: the shortcut publishes, the composer subscribes.
 *
 * Deliberately not a queue. If a second capture arrives before the composer has
 * taken the first, the newer one wins: the user pressed the key again because they
 * wanted a different screenshot.
 */

export interface AgentAttachment {
  /** Choose the full Chat page or the legacy global Assistant overlay. */
  target?: 'chat' | 'assistant';
  /** Images to attach to the next message. */
  files?: File[];
  /** Text to place in the composer, e.g. a captured selection. */
  draft?: string;
  /** Send immediately rather than waiting for the user to hit enter. */
  autoSend?: boolean;
  /** Select a profile before creating the next conversation. */
  profileId?: string;
  /** Force a fresh conversation for this launch. */
  newConversation?: boolean;
  /** Open an existing conversation without adding a draft. */
  sessionId?: string;
}

type Listener = (attachment: AgentAttachment) => void;
type AttachmentTarget = NonNullable<AgentAttachment['target']>;
interface ListenerRegistration {
  listener: Listener;
  target?: AttachmentTarget;
}

const listeners = new Set<ListenerRegistration>();
let pending: AgentAttachment | null = null;

function attachmentTarget(attachment: AgentAttachment): AttachmentTarget {
  return attachment.target ?? 'assistant';
}

function matches(registration: ListenerRegistration, attachment: AgentAttachment): boolean {
  return registration.target === undefined || registration.target === attachmentTarget(attachment);
}

/** Hand context to the composer. Held until something subscribes. */
export function publishAttachment(attachment: AgentAttachment): void {
  const recipients = [...listeners].filter((registration) => matches(registration, attachment));
  pending = null;
  if (recipients.length === 0) {
    pending = attachment;
    return;
  }
  recipients.forEach(({ listener }) => listener(attachment));
}

/**
 * Subscribe the composer. Immediately receives anything published while no
 * subscriber existed — a shortcut fired before the panel mounted still lands.
 */
export function onAttachment(listener: Listener, target?: AttachmentTarget): () => void {
  const registration = { listener, target };
  listeners.add(registration);
  if (pending && matches(registration, pending)) {
    const held = pending;
    pending = null;
    listener(held);
  }
  return () => listeners.delete(registration);
}
