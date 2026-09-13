/**
 * Rendering scope for detail components: are we a page, or a peek?
 *
 * The CRM and Projects detail screens are reused verbatim inside the peek
 * overlay, and two of their behaviours only make sense as a page — the "back to
 * list" link, and cross-record links that assign `window.location.hash`. Both
 * would walk the user out of the overlay they just opened.
 *
 * This is render context, not application state, so it is a React context
 * rather than a store: the same component renders differently depending on
 * where it is mounted, and both mountings can exist at once.
 */

import React, { createContext, useCallback, useContext } from 'react';
import { entityUrl, type EntityRef } from '@greenhouse/types/entity-links';
import { useEntityPeekStore } from '../../stores/entity-peek-store';

const InEntityPeekContext = createContext(false);

export function EntityPeekScope({ children }: { children: React.ReactNode }) {
  return <InEntityPeekContext.Provider value={true}>{children}</InEntityPeekContext.Provider>;
}

/** True when this subtree is rendered inside the peek overlay. */
export function useInEntityPeek(): boolean {
  return useContext(InEntityPeekContext);
}

/**
 * Open a record from inside a detail screen: drill down when we are already in a
 * peek, navigate the page when we are not.
 */
export function useEntityNavigate(): (ref: EntityRef) => void {
  const inPeek = useInEntityPeek();
  const openEntity = useEntityPeekStore((s) => s.openEntity);
  return useCallback(
    (ref: EntityRef) => {
      if (inPeek) openEntity({ ref });
      else window.location.hash = entityUrl(ref);
    },
    [inPeek, openEntity],
  );
}
