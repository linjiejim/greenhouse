/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportBootOk } from '../index';
import { applyUpdate, checkForUpdates, currentDesktopUpdate as current, resetDesktopUpdate } from '../updates';

type Answers = Record<string, unknown>;

function shell(answers: Answers) {
  const invoke = vi.fn(async (command: string) => answers[command]);
  window.__TAURI_INTERNALS__ = { invoke };
  return invoke;
}

beforeEach(resetDesktopUpdate);
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe('desktop updates', () => {
  it('does nothing in a browser', async () => {
    await checkForUpdates();
    expect(current()).toEqual({ kind: 'none' });
  });

  it('offers a restart into a downloaded web bundle', async () => {
    const invoke = shell({ desktop_check_web_update: { status: 'staged', version: '412', downloaded: true } });
    await checkForUpdates();
    expect(current()).toEqual({ kind: 'web', version: '412' });
    await applyUpdate();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['desktop_check_web_update', 'desktop_restart']);
  });

  it('downloads the shell when the next bundle needs it, and installs it before restarting', async () => {
    const invoke = shell({
      desktop_check_web_update: { status: 'needs_newer_shell', required: '1.0.0' },
      desktop_prepare_shell_update: { status: 'ready', version: '2.0.0' },
      desktop_install_shell_update: { status: 'installed', version: '2.0.0' },
    });
    await checkForUpdates();
    expect(current()).toEqual({ kind: 'shell', version: '2.0.0' });
    await applyUpdate();
    expect(invoke.mock.calls.map(([command]) => command).slice(-2)).toEqual([
      'desktop_install_shell_update',
      'desktop_restart',
    ]);
  });

  it('asks for a new app when no shell update could be downloaded', async () => {
    shell({
      desktop_check_web_update: { status: 'needs_newer_shell', required: '1.0.0' },
      desktop_prepare_shell_update: { status: 'up_to_date' },
    });
    await checkForUpdates();
    expect(current()).toEqual({ kind: 'shell_required' });
  });

  it('keeps quiet when the check fails, and logs it in the shell', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'desktop_check_web_update') throw new Error('offline');
    });
    window.__TAURI_INTERNALS__ = { invoke };
    await checkForUpdates();
    expect(current()).toEqual({ kind: 'none' });
    expect(invoke).toHaveBeenCalledWith('desktop_log', expect.objectContaining({ level: 'warn' }));
  });

  it('reports a successful boot once', async () => {
    const invoke = shell({});
    reportBootOk();
    reportBootOk();
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_mark_boot_ok')).toHaveLength(1);
  });
});
