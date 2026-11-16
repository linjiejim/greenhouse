/**
 * Copy a value to the clipboard (DESIGN.md States and feedback). The button that copied answers:
 * it says 已复制 (common.copied) for 1.5 s, or 复制失败 (common.copyFailed) when the clipboard
 * refuses, then goes back; never a notice, the result is where the member clicked. A second copy
 * restarts the 1.5 s.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import type { CopyState } from './copy-state';

const ANSWER_MS = 1500;

export function useCopy(): { state: CopyState; copy: (value: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (value: string) => {
    const ok = await Clipboard.setStringAsync(value).catch(() => false);
    clearTimeout(timer.current);
    setState(ok ? 'copied' : 'failed');
    timer.current = setTimeout(() => setState('idle'), ANSWER_MS);
  }, []);
  return { state, copy };
}
