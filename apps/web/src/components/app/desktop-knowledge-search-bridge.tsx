/** Main-window receiver for knowledge searches started in Desktop Quick Capture. */

import { useEffect } from 'react';
import { invokeDesktop } from '../../lib/desktop/bridge';
import { onKnowledgeSearch } from '../../lib/desktop/surface-actions';
import { useGlobalSearchStore } from '../../stores/global-search-store';

export function DesktopKnowledgeSearchBridge() {
  useEffect(() => {
    const unlisten = onKnowledgeSearch(({ query }) => {
      useGlobalSearchStore.getState().open({ query, kind: 'kb_doc' });
      void invokeDesktop('desktop_focus_main_window');
    });
    return () => void unlisten.then((off) => off());
  }, []);

  return null;
}
