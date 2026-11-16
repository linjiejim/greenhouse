/**
 * Copy a value to the clipboard (DESIGN.md States and feedback). On phones the platform confirms it:
 * the iOS HUD, Android's own overlay (./toast). The browser answers on the button instead
 * (./use-copy.web.ts), so `state` stays idle here.
 */
import { useCallback } from 'react';
import * as Clipboard from 'expo-clipboard';
import { useT } from '../lib/i18n';
import { toast } from './toast';
import type { CopyState } from './copy-state';

export function useCopy(): { state: CopyState; copy: (value: string) => Promise<void> } {
  const t = useT();
  const copy = useCallback(
    async (value: string) => {
      await Clipboard.setStringAsync(value).catch(() => {});
      toast(t('common.copied'), 'copy');
    },
    [t],
  );
  return { state: 'idle', copy };
}
