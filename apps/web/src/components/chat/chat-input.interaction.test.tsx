/**
 * @vitest-environment happy-dom
 */

import { act, createElement, createRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserPrompt } from '@greenhouse/types/api';
import { I18nProvider } from '../../lib/i18n';
import { ChatInput } from './chat-input';
import { CommandMenuPopover, type SlashSkill } from './command-menu-popover';
import { MentionPopover } from './mention-popover';
import type { Profile } from '../../lib/api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task: UserPrompt = {
  id: 7,
  user_id: 'user-1',
  title: 'Prompt improver',
  content: 'Act as {{role}} and improve {{prompt}}.',
  shortcut: 'improve',
  sort_order: 0,
  is_global: false,
  description: 'Improve an initial prompt.',
  variables: JSON.stringify([
    { key: 'role', label: 'Role', required: true },
    { key: 'prompt', label: 'Prompt', required: true },
  ]),
  expected_tools: '[]',
  source_session_id: null,
  created_via: 'manual',
  created_at: '2026-08-10T00:00:00.000Z',
  updated_at: '2026-08-10T00:00:00.000Z',
};

const secondTask: UserPrompt = {
  ...task,
  id: 8,
  title: 'Research brief',
  shortcut: 'research',
  description: 'This description must stay out of the compact picker row.',
};

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  for (const item of mounted.splice(0)) {
    await act(async () => item.root.unmount());
    item.container.remove();
  }
});

function Harness() {
  const [input, setInput] = useState('');
  const [selectedPrompt, setSelectedPrompt] = useState<UserPrompt | null>(null);
  const [taskValues, setTaskValues] = useState<Record<string, string>>({});

  return createElement(ChatInput, {
    input,
    setInput,
    isStreaming: false,
    pendingImages: [],
    onSend: vi.fn(),
    onStop: vi.fn(),
    onImageSelect: vi.fn(),
    onRemoveImage: vi.fn(),
    slashPrompts: [task],
    selectedPrompt,
    taskValues,
    onSelectPrompt: (prompt) => {
      setSelectedPrompt(prompt);
      setTaskValues({});
    },
    onTaskValueChange: (key, value) => setTaskValues((current) => ({ ...current, [key]: value })),
  });
}

describe('ChatInput Task keyboard flow', () => {
  it('focuses the first variable after / selection and keeps variables before the message field', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(Harness),
        }),
      );
    });

    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      textarea.focus();
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(textarea, '/');
      textarea.setSelectionRange(1, 1);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '/', inputType: 'insertText' }));
    });

    const taskRow = container.querySelector<HTMLButtonElement>('[data-idx="0"]');
    expect(taskRow?.textContent).toContain('Prompt improver');

    await act(async () => {
      taskRow?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    const variables = Array.from(container.querySelectorAll<HTMLInputElement>('[data-task-variable-input]'));
    expect(variables.map((input) => input.dataset.taskVariableInput)).toEqual(['role', 'prompt']);
    expect(document.activeElement).toBe(variables[0]);

    const nativeTabOrder = Array.from(
      container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-task-variable-input], textarea'),
    );
    expect(nativeTabOrder).toEqual([variables[0], variables[1], textarea]);

    await act(async () => {
      variables[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(variables[1]);

    await act(async () => {
      variables[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(textarea);
  });

  it('highlights the active compact Task row and selects it with ArrowDown + Enter', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSelectPrompt = vi.fn();

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(CommandMenuPopover, {
            query: '',
            prompts: [task, secondTask],
            onSelectPrompt,
            onDismiss: vi.fn(),
            anchorRef: createRef<HTMLDivElement>(),
          }),
        }),
      );
    });

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]?.className).toContain('bg-primary-600');
    expect(rows[0]?.textContent).toBe('Prompt improver/improve');
    expect(container.textContent).not.toContain(secondTask.description);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(rows[0]?.getAttribute('aria-selected')).toBe('false');
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');
    expect(rows[1]?.className).toContain('bg-primary-600');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSelectPrompt).toHaveBeenCalledOnce();
    expect(onSelectPrompt).toHaveBeenCalledWith(secondTask);
  });

  it('lists Skills as a second section and walks the keyboard straight across both', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSelectPrompt = vi.fn();
    const onSelectSkill = vi.fn();
    const skill: SlashSkill = {
      name: 'pdf-report',
      display_name: 'PDF Report',
      description: 'Render branded PDFs',
      group: 'branding',
    };

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(CommandMenuPopover, {
            query: '',
            prompts: [task],
            skills: [skill],
            onSelectPrompt,
            onSelectSkill,
            onDismiss: vi.fn(),
            anchorRef: createRef<HTMLDivElement>(),
          }),
        }),
      );
    });

    // One flat keyboard index across both sections; the skill row keeps the
    // compact shape (title + /name + Mission tag, no description).
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain('Skills');
    expect(rows[1]?.textContent).toBe('PDF Report/pdf-reportMission');
    expect(container.textContent).not.toContain(skill.description);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSelectSkill).toHaveBeenCalledWith(skill);
    expect(onSelectPrompt).not.toHaveBeenCalled();
  });

  it('filters both sections by the query — a skills-only match keeps Enter on the skill', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSelectSkill = vi.fn();
    const skills: SlashSkill[] = [
      { name: 'pdf-report', display_name: 'PDF Report', description: '', group: 'branding' },
      { name: 'excel-audit', display_name: 'Excel Audit', description: '', group: 'business' },
    ];

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(CommandMenuPopover, {
            query: 'pdf',
            prompts: [task, secondTask],
            skills,
            onSelectPrompt: vi.fn(),
            onSelectSkill,
            onDismiss: vi.fn(),
            anchorRef: createRef<HTMLDivElement>(),
          }),
        }),
      );
    });

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('PDF Report');
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSelectSkill).toHaveBeenCalledWith(skills[0]);
  });

  it('shows closed Mission admission as status instead of a selectable Skill row', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(CommandMenuPopover, {
            query: '',
            prompts: [],
            skills: [],
            missionAvailability: 'unavailable',
            onSelectPrompt: vi.fn(),
            onSelectSkill: vi.fn(),
            onDismiss: vi.fn(),
            anchorRef: createRef<HTMLDivElement>(),
          }),
        }),
      );
    });

    expect(container.textContent).toContain('Mission skills are unavailable in this environment');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('No matching Tasks');
  });
});

describe('ChatInput Agent Profile keyboard flow', () => {
  it('renders compact source-tagged rows and selects the highlighted profile with ArrowDown + Enter', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSelect = vi.fn();
    const profiles = [
      { id: 'sprouty', name: 'Sprouty', description: 'Default assistant' },
      {
        id: 'shared-agent',
        name: 'Shared analyst',
        description: 'Shared description',
        is_custom: true,
        is_shared: true,
      },
      { id: 'my-agent', name: 'My writer', description: 'Personal description', is_custom: true, is_shared: false },
    ] as Profile[];

    await act(async () => {
      root.render(
        createElement(I18nProvider, {
          initialLocale: 'en',
          children: createElement(MentionPopover, {
            query: '',
            profiles,
            selectedProfileId: 'sprouty',
            onSelect,
            onDismiss: vi.fn(),
            anchorRef: createRef<HTMLDivElement>(),
          }),
        }),
      );
    });

    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]?.className).toContain('bg-primary-600');
    expect(rows.map((row) => row.textContent)).toEqual(['SproutySystem', 'Shared analystShared', 'My writerPersonal']);
    expect(container.textContent).not.toContain('description');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(rows[1]?.getAttribute('aria-selected')).toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('shared-agent');
  });
});
