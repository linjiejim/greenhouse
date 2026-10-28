import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keyboard = vi.hoisted(() => ({
  visible: false,
  dismiss: vi.fn<() => Promise<void>>(),
}));
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardController: { isVisible: () => keyboard.visible, dismiss: keyboard.dismiss },
}));
vi.mock('../store/auth', () => ({ AFTER_DISMISS_MS: 380 }));
const { KEYBOARD_WAIT_MS, closeThen, keyboardDown } = await import('./close-then');

beforeEach(() => {
  vi.useFakeTimers();
  keyboard.visible = false;
  keyboard.dismiss.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('closing a sheet, then opening the next screen', () => {
  it('opens only after the closing sheet has had its dismissal', async () => {
    const steps: string[] = [];
    const done = closeThen(
      () => steps.push('close'),
      () => steps.push('open'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual(['close']);
    await vi.advanceTimersByTimeAsync(379);
    expect(steps).toEqual(['close']);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(steps).toEqual(['close', 'open']);
  });

  it('puts the keyboard down before the sheet starts closing', async () => {
    keyboard.visible = true;
    let down!: () => void;
    keyboard.dismiss.mockReturnValue(new Promise<void>((resolve) => (down = resolve)));
    const steps: string[] = [];
    void closeThen(
      () => steps.push('close'),
      () => steps.push('open'),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
    expect(steps).toEqual([]);
    down();
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual(['close']);
    await vi.advanceTimersByTimeAsync(380);
    expect(steps).toEqual(['close', 'open']);
  });

  it('does not wait on a keyboard that never reports back, nor ask one that is not up', async () => {
    keyboard.visible = true;
    keyboard.dismiss.mockReturnValue(new Promise<void>(() => undefined));
    let finished = false;
    void keyboardDown().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(KEYBOARD_WAIT_MS);
    expect(finished).toBe(true);

    keyboard.visible = false;
    keyboard.dismiss.mockClear();
    await keyboardDown();
    expect(keyboard.dismiss).not.toHaveBeenCalled();
  });
});
