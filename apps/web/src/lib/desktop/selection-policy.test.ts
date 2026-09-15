import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeDesktop } from './bridge';
import { presentCapturedSelection } from './selection-policy';

const isFocused = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFocused }),
}));
vi.mock('./bridge', () => ({
  invokeDesktop: vi.fn(),
  onDesktopEvent: vi.fn(),
}));

const invoke = vi.mocked(invokeDesktop);

describe('desktop selection display policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the native satellite for a selection captured in another app', async () => {
    isFocused.mockResolvedValue(false);
    await presentCapturedSelection({
      text: 'outside',
      source: 'accessibility',
      x: 120,
      y: 240,
    });

    expect(invoke).toHaveBeenCalledWith('desktop_show_selection_bar', { x: 120, y: 240 });
  });

  it('suppresses the global bar while Greenhouse is focused', async () => {
    isFocused.mockResolvedValue(true);
    await presentCapturedSelection({
      text: 'already handled by the in-app quote popover',
      source: 'accessibility',
      x: 120,
      y: 240,
    });

    expect(invoke).not.toHaveBeenCalled();
  });

  it('ignores selections without pointer coordinates', async () => {
    await presentCapturedSelection({
      text: 'hotkey selection',
      source: 'accessibility',
      x: null,
      y: null,
    });

    expect(isFocused).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
