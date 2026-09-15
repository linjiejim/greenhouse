import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleShortcut } from './shortcuts';
import { invokeDesktop } from './bridge';
import { handOffToMain } from './handoff';

vi.mock('./bridge', () => ({
  invokeDesktop: vi.fn(),
  isDesktop: vi.fn(() => true),
  onDesktopEvent: vi.fn(),
}));
vi.mock('./handoff', () => ({ handOffToMain: vi.fn() }));
vi.mock('./capture', () => ({ captureToFile: vi.fn() }));
vi.mock('./attach', () => ({ publishAttachment: vi.fn() }));

const invoke = vi.mocked(invokeDesktop);
const handoff = vi.mocked(handOffToMain);

describe('desktop shortcut behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('focuses the main window for the default Cmd+G action', async () => {
    await handleShortcut('focus_main');
    expect(invoke).toHaveBeenCalledWith('desktop_focus_main_window');
  });

  it('hands an explicitly captured selection to the main composer', async () => {
    invoke.mockResolvedValueOnce({
      text: 'selected outside Greenhouse',
      source: 'accessibility',
      x: null,
      y: null,
    });

    await handleShortcut('selection');

    expect(invoke).toHaveBeenCalledWith('desktop_read_selection');
    expect(handoff).toHaveBeenCalledWith({ draft: 'selected outside Greenhouse' });
    expect(invoke).not.toHaveBeenCalledWith('desktop_toggle_quick_window');
  });
});
