/**
 * Lets a pane body put its own controls in the pane's one header row.
 *
 * Before this, a body that needed a toolbar grew a second header of its own,
 * so an HTML preview showed its title twice — once in the pane chrome, once
 * directly underneath — and spent a row of a narrow column saying it.
 *
 * A portal rather than a `chrome.actions` field on the registry: the controls
 * are driven by the body's own state (source-vs-preview, reload key), and
 * hoisting that state into `ChatSidePane` would make the generic pane know
 * what an HTML preview is. This way ownership stays in the body and only the
 * pixels move.
 *
 * Rendering nothing when there is no slot is deliberate — `HtmlPreview` is
 * also rendered by tests and could one day be rendered outside the pane; a
 * missing host should cost the toolbar, not throw.
 */

import React, { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';

const HeaderSlotContext = createContext<HTMLElement | null>(null);

export const SidePaneHeaderSlotProvider = HeaderSlotContext.Provider;

/** Renders its children into the pane header, left of the close button. */
export function SidePaneHeaderActions({ children }: { children: React.ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  if (!slot) return null;
  return createPortal(children, slot);
}
