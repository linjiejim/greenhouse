import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
export const PlaceSecondaryContext = createContext<HTMLElement | null>(null);
export function PlaceSecondary({ children }: { children: React.ReactNode }) {
  const host = useContext(PlaceSecondaryContext);
  return host ? createPortal(children, host) : null;
}
