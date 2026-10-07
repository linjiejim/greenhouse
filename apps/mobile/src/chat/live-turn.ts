/**
 * Live turns for a reply's sheets (/peek/tools, /peek/reasoning): the sheet
 * follows the reply as it streams — new tool calls appear, running ones
 * finish, reasoning keeps growing — instead of freezing at the moment it was
 * opened.
 *
 *  - the opener seeds the turn (`openTurn(msg)` → the id to route with);
 *  - the conversation publishes its messages (`publishTurns`, every change —
 *    a no-op unless a sheet is watching);
 *  - the sheet subscribes (`useLiveTurn(id)`), which also keeps the entry
 *    alive while it's mounted (ref-counted) and drops it after.
 *
 * A turn that leaves the conversation (history reloaded under new ids) keeps
 * its last published state — final by then.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import type { ChatMessage } from './model';

const useTurns = create<{ turns: Record<string, ChatMessage> }>(() => ({ turns: {} }));
const watchers = new Map<string, number>();

/** Seed a turn for a sheet about to open; returns the id to put in the route. */
export function openTurn(msg: ChatMessage): string {
  useTurns.setState((s) => ({ turns: { ...s.turns, [msg.id]: msg } }));
  return msg.id;
}

/** The conversation's messages changed — refresh any turn a sheet is showing. */
export function publishTurns(messages: ChatMessage[]): void {
  const { turns } = useTurns.getState();
  let next: Record<string, ChatMessage> | null = null;
  for (const m of messages) {
    const shown = turns[m.id];
    if (shown && shown !== m) (next ??= { ...turns })[m.id] = m;
  }
  if (next) useTurns.setState({ turns: next });
}

/** The live turn behind a sheet (undefined: unknown id — e.g. after the app restarted). */
export function useLiveTurn(id: string | undefined): ChatMessage | undefined {
  const msg = useTurns((s) => (id ? s.turns[id] : undefined));
  useEffect(() => {
    if (!id) return;
    watchers.set(id, (watchers.get(id) ?? 0) + 1);
    return () => {
      const left = (watchers.get(id) ?? 1) - 1;
      if (left > 0) {
        watchers.set(id, left);
        return;
      }
      watchers.delete(id);
      useTurns.setState((s) => {
        const turns = { ...s.turns };
        delete turns[id];
        return { turns };
      });
    };
  }, [id]);
  return msg;
}
