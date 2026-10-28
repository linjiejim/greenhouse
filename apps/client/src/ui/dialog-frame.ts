import { createContext } from 'react';
/**
 * True inside a centered dialog of a wide browser window (src/ui/sheet-edge.web.tsx): sheet forms
 * (FormChrome, NativeForm and the form controls) draw the desktop dialog look there, not a phone sheet.
 */
export const DialogFrameContext = createContext(false);
