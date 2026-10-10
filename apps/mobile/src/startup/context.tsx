/** Launch-only readiness. Loading starts in the real screen and is never repeated by a preloader. */
import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import type { StartupContent } from './content';

export const StartupContext = createContext<{ content: StartupContent; covered: boolean } | null>(null);

/** A focused screen can reveal successful, empty or failed content; an underlying home cannot. */
export function useStartupContent(ready: boolean): void {
  const startup = useContext(StartupContext);
  const content = startup?.content;
  const covered = startup?.covered ?? false;
  const focused = useIsFocused();
  const owner = useRef({}).current;
  useLayoutEffect(() => {
    if (!content || !covered || !focused) return;
    return content.report(owner, ready);
  }, [content, covered, focused, owner, ready]);
}

/** Being focused underneath the splash is not the same as having read the conversation. */
export function useStartupCovered(): boolean {
  return useContext(StartupContext)?.covered ?? false;
}
