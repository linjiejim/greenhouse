import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { useIsFocused } from 'expo-router';
export const PlaceSecondaryContext = createContext<HTMLElement | null>(null);
/**
 * A place's sidebar, portalled into the wide shell's second column. Places a member has visited
 * stay mounted behind the drawer (and under a page pushed over it), so only the focused one
 * fills the column; the others would stack their sidebars above it.
 */
export function PlaceSecondary({ children }: { children: React.ReactNode }) {
  const host = useContext(PlaceSecondaryContext);
  const focused = useIsFocused();
  return host && focused ? createPortal(children, host) : null;
}
