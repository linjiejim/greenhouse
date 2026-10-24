/**
 * Messages written while the station could not be reached, waiting to go. React-free
 * (./outbox.test.ts). A queued message belongs to a conversation (or starts a new one, `sessionId`
 * null) and keeps its words and its already-uploaded pictures; files cannot be queued (their
 * upload needs the station). They go oldest first, one at a time per conversation.
 */

export interface QueuedTurn {
  id: string;
  sessionId: string | null;
  text: string;
  images: { id: string; url: string }[];
  createdAt: number;
}

export const MAX_QUEUED = 30;

export function parseOutbox(saved: unknown): QueuedTurn[] {
  if (!Array.isArray(saved)) return [];
  return saved.flatMap((raw): QueuedTurn[] => {
    const item = raw as Partial<QueuedTurn> | null;
    if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.createdAt !== 'number') return [];
    const images = Array.isArray(item.images)
      ? item.images.filter((image): image is { id: string; url: string } => !!image && typeof image.id === 'string' && typeof image.url === 'string')
      : [];
    return [{ id: item.id, sessionId: typeof item.sessionId === 'string' ? item.sessionId : null, text: item.text, images, createdAt: item.createdAt }];
  });
}

export function enqueue(list: readonly QueuedTurn[], turn: QueuedTurn): QueuedTurn[] {
  return [...list.filter((item) => item.id !== turn.id), turn].slice(-MAX_QUEUED);
}

export function dequeue(list: readonly QueuedTurn[], id: string): QueuedTurn[] {
  return list.filter((item) => item.id !== id);
}

/** The next message to send for each conversation (and every new-conversation message), oldest first. */
export function nextToSend(list: readonly QueuedTurn[], skip: ReadonlySet<string>): QueuedTurn[] {
  const seen = new Set<string>();
  const out: QueuedTurn[] = [];
  for (const item of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    if (item.sessionId === null) {
      out.push(item);
      continue;
    }
    if (skip.has(item.sessionId) || seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    out.push(item);
  }
  return out;
}
