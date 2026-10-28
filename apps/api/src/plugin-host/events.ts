import { logger } from '@greenhouse/utils/logger';

export interface ExtensionEvents {
  'user.created': { userId: string };
  'user.disabled': { userId: string };
  'run.completed': { runId: string; userId?: string; status: string; kind: string };
  'conversation.turn.completed': { conversationId: string; userId: string; messageId?: string };
  'automation.ran': { automationId: string; runId?: string; userId: string; status: string };
}
export interface ExtensionHooks {
  on<E extends keyof ExtensionEvents>(
    event: E,
    handler: (payload: Readonly<ExtensionEvents[E]>) => void | Promise<void>,
  ): void;
}
const subscribers = new Map<
  keyof ExtensionEvents,
  Array<{ id: string; handle: (payload: never) => void | Promise<void> }>
>();
export function registerExtensionHooks(id: string, register: (hooks: ExtensionHooks) => void): void {
  register({
    on(event, handler) {
      if (
        !['user.created', 'user.disabled', 'run.completed', 'conversation.turn.completed', 'automation.ran'].includes(
          event,
        )
      )
        throw new Error(`Unsupported extension event: ${event}`);
      const entries = subscribers.get(event) ?? [];
      entries.push({ id, handle: handler as (payload: never) => void | Promise<void> });
      subscribers.set(event, entries);
    },
  });
}
/** Call only after the authoritative write/transaction has resolved. No request awaits subscribers. */
export function emitExtensionEvent<E extends keyof ExtensionEvents>(event: E, payload: ExtensionEvents[E]): void {
  const snapshot = Object.freeze({ ...payload });
  for (const subscriber of subscribers.get(event) ?? []) {
    setImmediate(() => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extension event timed out after 5000 ms')), 5000);
        timer.unref();
      });
      void Promise.race([Promise.resolve().then(() => subscriber.handle(snapshot as never)), timeout])
        .catch((error) => logger.warn(`[Extensions] ${subscriber.id}: ${event} failed`, { error: String(error) }))
        .finally(() => clearTimeout(timer));
    });
  }
}
