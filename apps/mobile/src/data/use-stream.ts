/** The live piece of one reply being written (./streams.ts), re-rendering only its own row. */

import { useCallback, useSyncExternalStore } from 'react';
import { readStream, subscribeStream, type Stream } from './streams';

export function useStream(messageId: string): Stream | undefined {
  const subscribe = useCallback((listener: () => void) => subscribeStream(messageId, listener), [messageId]);
  const read = useCallback(() => readStream(messageId), [messageId]);
  return useSyncExternalStore(subscribe, read, read);
}
