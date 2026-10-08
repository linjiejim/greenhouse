/**
 * A `key` that changes with the system text size — put it on a stateless text
 * container so mounted text re-measures when the member changes Dynamic Type
 * while the app runs.
 *
 * Why: on iOS, RN 0.86 (Fabric) marks text for re-measuring on a font-scale
 * change by cloning nodes on the main thread, but React's own references are
 * not moved to those clones (`updateRuntimeShadowNodeReferencesOnCommit` is
 * off), so the next render puts the old nodes back and Yoga reuses the old
 * measurements: mounted text keeps its old heights and line breaks while a
 * fresh screen measures right (facebook/react-native#57512). Remounting the
 * text is the over-the-air workaround.
 *
 * Only on containers that hold no state worth keeping (rows, bubbles,
 * captions) — never on a screen, a list, a navigator or a form: a remount
 * would drop drafts, scroll position and navigation state.
 */

import { useWindowDimensions } from 'react-native';

export function useFontScaleKey(): string {
  return useWindowDimensions().fontScale.toFixed(2);
}
