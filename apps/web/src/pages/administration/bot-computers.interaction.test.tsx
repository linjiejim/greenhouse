/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminBotComputersView } from '../../lib/api/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotComputersPanel, formatBytes, parseKnob, IDLE_MINUTES_RANGE } from './bot-computers';

const api = vi.hoisted(() => ({
  fetchAdminBotComputers: vi.fn(),
  adminStopComputer: vi.fn(),
  adminResetComputer: vi.fn(),
  saveBotComputerSettings: vi.fn(),
  startComputer: vi.fn(),
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW: AdminBotComputersView = {
  runtime: { state: 'ready', reason: null, hardened: false },
  settings: { idle_minutes: 15, max_running: 2 },
  checks: [
    { id: 'docker', ok: true, detail: 'Docker 28.3 reachable' },
    {
      id: 'image',
      ok: false,
      detail: 'greenhouse/bot-computer:latest not found',
      fix: 'scripts/build-bot-computer.sh',
    },
  ],
  computers: [
    {
      user_id: 'u-mia',
      nickname: 'Mia',
      state: 'running',
      state_reason: null,
      controller: 'user',
      last_active_at: new Date().toISOString(),
      last_started_at: new Date().toISOString(),
      disk_bytes: 734_003_200,
      memory_bytes: 512 * 1024 * 1024,
    },
    {
      user_id: 'u-leo',
      nickname: 'Leo',
      state: 'absent',
      state_reason: null,
      controller: 'bot',
      last_active_at: null,
      last_started_at: null,
      disk_bytes: null,
      memory_bytes: null,
    },
  ],
};

let root: ReturnType<typeof createRoot> | null = null;

async function settle(ms = 260) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(BotComputersPanel) }));
  });
  await settle();
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error(`Missing element in: ${document.body.textContent}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle(30);
}

async function fill(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function rowOf(name: string): HTMLTableRowElement {
  const row = [...document.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(name));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchAdminBotComputers.mockResolvedValue(VIEW);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('helpers', () => {
  it('formats sizes and validates knob input', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(734_003_200)).toBe('700 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(parseKnob('30', IDLE_MINUTES_RANGE)).toBe(30);
    expect(parseKnob('4', IDLE_MINUTES_RANGE)).toBeNull();
    expect(parseKnob('15.5', IDLE_MINUTES_RANGE)).toBeNull();
  });
});

describe('BotComputersPanel', () => {
  it('shows the runtime, the failing check with its fix command, and every computer', async () => {
    await renderPanel();

    const runtime = document.querySelector('[data-testid="bot-computers-runtime"]')!;
    expect(runtime.textContent).toContain('Ready');
    expect(runtime.textContent).toContain('Development mode');
    expect(document.body.textContent).toContain('without gVisor isolation');

    const failing = document.querySelector('[data-check="image"]')!;
    expect(failing.getAttribute('data-ok')).toBe('false');
    expect(failing.textContent).toContain('scripts/build-bot-computer.sh');
    expect(document.querySelector('[data-check="docker"] code')).toBeNull();
    expect(document.body.textContent).toContain('1 check(s) need attention');

    expect(rowOf('Mia').textContent).toContain('Running');
    expect(rowOf('Mia').textContent).toContain('Member');
    expect(rowOf('Mia').textContent).toContain('700 MB');
    expect(rowOf('Leo').textContent).toContain('Asleep');
    expect(document.body.textContent).toContain('1 of 2 computers running');
  });

  it('names the egress and host-disk checks and shows a multi-line fix whole, copied whole', async () => {
    const script =
      'sudo iptables -I DOCKER-USER -s 172.30.0.0/16 -j DROP\nsudo iptables -I DOCKER-USER -s 172.30.0.0/16 -d 10.0.0.5 -j ACCEPT';
    api.fetchAdminBotComputers.mockResolvedValue({
      ...VIEW,
      checks: [
        { id: 'egress', ok: false, detail: 'Computers can reach private addresses', fix: script },
        { id: 'host_disk', ok: true, detail: '42% free on the Docker disk' },
      ],
    });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await renderPanel();

    const egress = document.querySelector('[data-check="egress"]')!;
    expect(egress.textContent).toContain('Egress lockdown');
    expect(document.querySelector('[data-check="host_disk"]')?.textContent).toContain('Host disk space');
    expect(document.querySelector('[data-check="host_disk"]')?.textContent).toContain('42% free on the Docker disk');

    const fix = egress.querySelector('[data-testid="bot-computers-fix"]')!;
    expect(fix.textContent).toBe(script);
    expect(fix.className).toContain('whitespace-pre-wrap');
    await click(egress.querySelector('button[aria-label="Copy command"]'));
    expect(writeText).toHaveBeenCalledWith(script);
  });

  it('validates and saves the capacity knobs through workspace settings', async () => {
    api.saveBotComputerSettings.mockResolvedValue(undefined);
    await renderPanel();

    const save = document.querySelector<HTMLButtonElement>('[data-testid="bot-computers-save"]')!;
    expect(save.disabled).toBe(true);

    await fill('[data-testid="bot-computers-idle"]', '1');
    expect(document.body.textContent).toContain('Enter a whole number from 5 to 240.');
    expect(save.disabled).toBe(true);

    await fill('[data-testid="bot-computers-idle"]', '30');
    await fill('[data-testid="bot-computers-max"]', '4');
    expect(save.disabled).toBe(false);
    await click(save);

    expect(api.saveBotComputerSettings).toHaveBeenCalledWith({ idle_minutes: 30, max_running: 4 });
    expect(api.fetchAdminBotComputers.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops a running computer only after confirmation', async () => {
    api.adminStopComputer.mockResolvedValue(undefined);
    await renderPanel();

    // Asleep computers have nothing to stop.
    expect(rowOf('Leo').querySelector('button[title="Stop"]')).toBeNull();
    await click(rowOf('Mia').querySelector('button[title="Stop"]'));
    expect(document.body.textContent).toContain("Stop Mia's computer?");
    await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));

    expect(api.adminStopComputer).toHaveBeenCalledWith('u-mia');
  });

  it('resets, deleting files and sign-ins only when explicitly ticked', async () => {
    api.adminResetComputer.mockResolvedValue(undefined);
    await renderPanel();

    await click(rowOf('Leo').querySelector('button[title="Reset"]'));
    expect(document.body.textContent).toContain("Reset Leo's computer?");
    const confirm = document.querySelector<HTMLButtonElement>('[data-testid="computer-reset-confirm"]')!;
    expect(confirm.textContent).toBe('Reset');

    await click(document.querySelector('[data-testid="computer-reset-wipe"]'));
    expect(confirm.textContent).toBe('Reset and delete');
    await click(confirm);

    expect(api.adminResetComputer).toHaveBeenCalledWith('u-leo', true);
  });

  it('runs an end-to-end start as the admin and reports the outcome', async () => {
    api.startComputer.mockResolvedValue({
      runtime: VIEW.runtime,
      state: 'running',
      state_reason: null,
      controller: 'bot',
      controller_since: null,
      last_active_at: null,
      queue_position: null,
      disk_bytes: null,
    });
    await renderPanel();

    await click(document.querySelector('[data-testid="bot-computers-try-start"]'));
    expect(api.startComputer).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the view cannot be loaded', async () => {
    api.fetchAdminBotComputers.mockRejectedValueOnce(new Error('boom'));
    await renderPanel();
    expect(document.body.textContent).toContain("Couldn't load Bot computers.");

    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
    await click(retry);
    await settle();
    expect(document.querySelector('[data-testid="bot-computers-runtime"]')).not.toBeNull();
  });
});
