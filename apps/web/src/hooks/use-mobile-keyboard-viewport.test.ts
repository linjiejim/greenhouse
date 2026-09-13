import { describe, expect, it } from 'vitest';
import { resolveMobileKeyboardViewport } from './use-mobile-keyboard-viewport';

describe('mobile keyboard viewport', () => {
  it('keeps the app height and exposes only the obscured composer inset', () => {
    expect(
      resolveMobileKeyboardViewport({
        stableHeight: 844,
        layoutHeight: 544,
        visualHeight: 544,
        visualOffsetTop: 0,
        editableFocused: true,
        keyboardWasOpen: false,
        widthChanged: false,
      }),
    ).toEqual({ stableHeight: 844, keyboardInset: 300, viewportOffsetTop: 0, keyboardOpen: true });
  });

  it('cancels visual-viewport panning while keeping the composer at its visible bottom', () => {
    expect(
      resolveMobileKeyboardViewport({
        stableHeight: 844,
        layoutHeight: 844,
        visualHeight: 510,
        visualOffsetTop: 42,
        editableFocused: true,
        keyboardWasOpen: false,
        widthChanged: false,
      }),
    ).toEqual({ stableHeight: 844, keyboardInset: 334, viewportOffsetTop: 42, keyboardOpen: true });
  });

  it('holds the keyboard baseline across blur until the visual viewport returns', () => {
    expect(
      resolveMobileKeyboardViewport({
        stableHeight: 844,
        layoutHeight: 544,
        visualHeight: 544,
        visualOffsetTop: 0,
        editableFocused: false,
        keyboardWasOpen: true,
        widthChanged: false,
      }),
    ).toEqual({ stableHeight: 844, keyboardInset: 300, viewportOffsetTop: 0, keyboardOpen: true });
  });

  it('adopts an ordinary resized viewport when no keyboard session is active', () => {
    expect(
      resolveMobileKeyboardViewport({
        stableHeight: 844,
        layoutHeight: 720,
        visualHeight: 720,
        visualOffsetTop: 0,
        editableFocused: false,
        keyboardWasOpen: false,
        widthChanged: false,
      }),
    ).toEqual({ stableHeight: 720, keyboardInset: 0, viewportOffsetTop: 0, keyboardOpen: false });
  });
});
