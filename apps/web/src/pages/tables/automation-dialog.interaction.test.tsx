/** @vitest-environment happy-dom */

/**
 * The automations dialog under real interaction: build a rule in the editor
 * (trigger, watched field, a webhook with a write-only secret) and save it as
 * one create call; edit a stored rule without touching its secret; read a run
 * log worded from step codes; delete a rule an app's button runs only after
 * seeing where (D6, resent with `confirm`).
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import {
  TablesRequestError,
  type TableAutomation,
  type TableDefinition,
  type TableField,
  type TableSchema,
} from '../../lib/api/tables';
import { TablesAutomationDialog } from './automation-dialog';

const api = vi.hoisted(() => ({
  getTableSchema: vi.fn(),
  listTableAutomations: vi.fn(),
  createTableAutomation: vi.fn(),
  updateTableAutomation: vi.fn(),
  deleteTableAutomation: vi.fn(),
  listTableAutomationRuns: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  fetchShareableUsers: vi
    .fn()
    .mockResolvedValue([{ id: 'u1', nickname: 'Jim', email: 'jim@example.com', role: 'team' }]),
}));
vi.mock('../../lib/api/groups', () => ({ listGroups: vi.fn().mockResolvedValue([]) }));
vi.mock('../../lib/api/bots', () => ({
  listBots: vi.fn().mockResolvedValue({ bots: [{ id: 'bot1', name: 'Summary Bot' }] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stamp = '2026-10-11T00:00:00.000Z';
const table: TableDefinition = {
  id: 7,
  base_id: 3,
  name: 'Deals',
  description: null,
  position: 0,
  schema_revision: 1,
  created_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
  archived_at: null,
};

function field(id: number, name: string, type: TableField['type']): TableField {
  return {
    id,
    table_id: 7,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const schema: TableSchema = { table, fields: [field(1, 'Name', 'text'), field(2, 'Stage', 'text')], views: [] };

const stored: TableAutomation = {
  id: 11,
  base_id: 3,
  table_id: 7,
  name: 'Ping CRM',
  status: 'enabled',
  trigger: 'record_created',
  config: {
    version: 1,
    actions: [{ id: 'a1', type: 'webhook', url: 'https://hooks.example.com/crm', hasSecret: true }],
  },
  execution_user_id: 'u1',
  revision: 3,
  next_fire_at: null,
  swept_until: null,
  created_by: 'u1',
  updated_by: 'u1',
  created_at: stamp,
  updated_at: stamp,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <TablesAutomationDialog
          open
          baseId={3}
          tables={[table]}
          users={[{ id: 'u1', nickname: 'Jim', email: 'jim@example.com' }]}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );
  });
  await flush();
}

function byTestId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element as T;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  );
  if (!button) throw new Error(`missing button ${name}`);
  return button as HTMLButtonElement;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await flush();
}

beforeEach(() => {
  api.getTableSchema.mockResolvedValue(schema);
  api.listTableAutomations.mockResolvedValue([]);
  api.createTableAutomation.mockImplementation(async (_baseId, input) => ({ ...stored, ...input, id: 12 }));
  api.updateTableAutomation.mockResolvedValue(stored);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('TablesAutomationDialog', () => {
  it('saves an Agent step with a selected Bot, same-Base reads and a text output', async () => {
    await mount();
    await click(byTestId('automation-new'));
    const editor = byTestId('automation-rule-editor');
    await type(editor.querySelector('input[placeholder^="Notify the owner"]') as HTMLInputElement, 'Summarize');
    await click(buttonNamed('Remove step'));
    await choose(byTestId<HTMLSelectElement>('automation-add-action'), 'agent');
    await type(editor.querySelector('textarea')!, 'Summarize the request');
    const selectWith = (value: string) =>
      [...editor.querySelectorAll('select')].find((select) =>
        [...select.options].some((option) => option.value === value),
      )!;
    await choose(selectWith('bot1'), 'bot1');
    await choose(selectWith('same_base_read'), 'same_base_read');
    const outputLabel = [...editor.querySelectorAll('label')].find((label) => label.textContent === 'Save output to')!;
    await choose(document.getElementById(outputLabel.htmlFor) as HTMLSelectElement, '2');
    const limits = editor.querySelector('details')!;
    expect(limits.open).toBe(false);
    await click(limits.querySelector('summary')!);
    await type(editor.querySelector('input[type="number"]')!, '20');
    await click(byTestId('automation-save'));
    expect(api.createTableAutomation).toHaveBeenCalledWith(
      3,
      expect.objectContaining({
        name: 'Summarize',
        config: {
          version: 1,
          actions: [
            {
              type: 'agent',
              prompt: 'Summarize the request',
              botId: 'bot1',
              outputFieldId: 2,
              tools: 'same_base_read',
              maxSteps: 20,
            },
          ],
        },
      }),
    );
  });
  it('builds a rule with a watched field and a signed webhook, and saves it once', async () => {
    await mount();
    await click(byTestId('automation-new'));
    expect(api.getTableSchema).toHaveBeenCalledWith(7);
    const editor = byTestId('automation-rule-editor');

    await type(editor.querySelector('input[placeholder^="Notify the owner"]') as HTMLInputElement, 'Ping on stage');
    await choose(byTestId<HTMLSelectElement>('automation-trigger'), 'record_updated');
    const stage = [...editor.querySelectorAll('label')].find((label) => label.textContent === 'Stage');
    await click(stage!.querySelector('input') as HTMLInputElement);

    // Replace the default notify step with a webhook.
    await click(buttonNamed('Remove step'));
    await choose(byTestId<HTMLSelectElement>('automation-add-action'), 'webhook');
    await type(editor.querySelector('input[type="url"]') as HTMLInputElement, 'https://hooks.example.com/in');
    await click(buttonNamed('Set a secret'));
    await type(editor.querySelector('input[type="password"]') as HTMLInputElement, 'k'.repeat(24));

    await click(byTestId('automation-save'));
    expect(api.createTableAutomation).toHaveBeenCalledTimes(1);
    expect(api.createTableAutomation).toHaveBeenCalledWith(3, {
      name: 'Ping on stage',
      tableId: 7,
      trigger: 'record_updated',
      status: 'enabled',
      config: {
        version: 1,
        watchFieldIds: [2],
        actions: [{ type: 'webhook', url: 'https://hooks.example.com/in', secret: 'k'.repeat(24) }],
      },
    });
    // Back on the list.
    expect(document.querySelector('[data-testid="automation-rule-editor"]')).toBeNull();
  });

  it('shows the first problem instead of saving an incomplete rule', async () => {
    await mount();
    await click(byTestId('automation-new'));
    await click(byTestId('automation-save'));
    expect(api.createTableAutomation).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Give the rule a name.');
  });

  it('edits a stored rule without ever sending its secret', async () => {
    api.listTableAutomations.mockResolvedValue([stored]);
    await mount();
    expect(document.body.textContent).toContain('Runs as Jim');
    await click(buttonNamed('Edit'));
    expect(document.body.textContent).toContain('A secret is set');
    await type(byTestId('automation-rule-editor').querySelector('input') as HTMLInputElement, 'Ping CRM v2');
    await click(byTestId('automation-save'));
    expect(api.updateTableAutomation).toHaveBeenCalledWith(11, {
      revision: 3,
      name: 'Ping CRM v2',
      status: 'enabled',
      trigger: 'record_created',
      config: { version: 1, actions: [{ id: 'a1', type: 'webhook', url: 'https://hooks.example.com/crm' }] },
    });
  });

  it('words the run log from step codes and run errors', async () => {
    api.listTableAutomations.mockResolvedValue([stored]);
    api.listTableAutomationRuns.mockResolvedValue([
      {
        id: 1,
        rule_id: 11,
        outbox_id: 4,
        status: 'canceled',
        actions_completed: 1,
        error: 'rule_changed',
        steps: [
          {
            actionId: 'a1',
            type: 'webhook',
            status: 'succeeded',
            code: 'webhook_sent',
            params: { status: 204 },
            at: stamp,
          },
        ],
        trigger_kind: 'record_created',
        record_id: 9,
        started_at: stamp,
        finished_at: stamp,
      },
    ]);
    await mount();
    await click(buttonNamed('Run log'));
    const log = byTestId('automation-run-log');
    expect(log.textContent).toContain('Webhook answered 204');
    expect(log.textContent).toContain('Canceled: the rule was changed while this run waited.');
    expect(log.textContent).toContain('Record #9');
  });

  it('deletes a rule an app runs only after showing where, resending with confirm', async () => {
    api.listTableAutomations.mockResolvedValue([stored]);
    api.deleteTableAutomation
      .mockRejectedValueOnce(
        new TablesRequestError('Apps run this automation', 409, {
          reason: 'used_by_apps',
          references: [{ appId: 12, name: 'Deal desk', where: 'Pipeline · Records card · action Notify' }],
        }),
      )
      .mockResolvedValueOnce(undefined);
    await mount();
    await click(buttonNamed('Delete'));
    await click(byTestId('confirm-dialog-confirm'));

    expect(api.deleteTableAutomation).toHaveBeenCalledWith(11);
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    const dialog = byTestId('app-references-dialog');
    expect(document.body.textContent).toContain('Apps run the automation “Ping CRM”');
    expect(dialog.querySelector('a')?.getAttribute('href')).toBe('#/apps/12/edit');
    expect(dialog.textContent).toContain('action Notify');
    // The 409 is not reported as a failure.
    expect(document.body.textContent).not.toContain('Apps run this automation');

    api.listTableAutomations.mockResolvedValue([]);
    await click(byTestId('app-references-proceed'));
    expect(api.deleteTableAutomation).toHaveBeenLastCalledWith(11, { confirm: true });
    expect(document.querySelector('[data-testid="app-references-dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('No automations yet');
  });

  it('shows a refused confirmed delete in the references dialog, and other failures as before', async () => {
    api.listTableAutomations.mockResolvedValue([stored]);
    api.deleteTableAutomation
      .mockRejectedValueOnce(
        new TablesRequestError('Apps run this automation', 409, {
          reason: 'used_by_apps',
          references: [{ appId: 12, name: 'Deal desk', where: 'Pipeline' }],
        }),
      )
      .mockRejectedValueOnce(new TablesRequestError('Only builders delete automations', 403, undefined))
      .mockRejectedValueOnce(new TablesRequestError('Automation not found', 404, undefined));
    await mount();
    await click(buttonNamed('Delete'));
    await click(byTestId('confirm-dialog-confirm'));
    await click(byTestId('app-references-proceed'));
    expect(byTestId('app-references-dialog').textContent).toContain('Only builders delete automations');

    await click(buttonNamed('Cancel'));
    await click(buttonNamed('Delete'));
    await click(byTestId('confirm-dialog-confirm'));
    expect(document.querySelector('[data-testid="app-references-dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('Automation not found');
  });
});
