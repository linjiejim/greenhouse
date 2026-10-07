/**
 * What interactive blocks need from the reply around them. A chat reply
 * provides it (src/chat/message.tsx); everywhere else the markdown renders
 * (knowledge documents, task notes) the default leaves blocks inert — a
 * ```confirm shows its buttons disabled.
 */
import { createContext, useContext } from 'react';

export interface RichEnv {
  /**
   * Send a follow-up user message (a ```confirm button's value). Absent in a
   * read-only conversation. Resolves false when nothing was sent (a reply is
   * still running, or the send failed).
   */
  reply?: (text: string) => Promise<boolean>;
  /** The user message that followed this reply — restores a ```confirm's pick after reload. */
  followUp?: string;
}

export const RichContext = createContext<RichEnv>({});

export const useRich = (): RichEnv => useContext(RichContext);
