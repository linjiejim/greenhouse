/** @vitest-environment happy-dom */

/**
 * The kanban body under real pointer gestures: dragging a card to another lane
 * is exactly one single-field write with the record's revision (through the
 * container's `onCommitValue`), the card moves at once and snaps back when the
 * write fails, lane counts come from the aggregate, hidden lanes stay hidden,
 * and nothing drags or creates without the permission.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanViewBody } from './kanban';
import {
  bodyProps,
  dragTo,
  fixtureField,
  fixtureRecord,
  flush,
  mountBody,
  type MountedBody,
} from './view-test-fixtures';

const api = vi.hoisted(() => ({ aggregateTableRecords: vi.fn() }));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...api,
}));

const primary = fixtureField(1, 'Name', 'text');
const stage = fixtureField(2, 'Stage', 'single_select', {
  options: [
    { id: 'lead', label: 'Lead' },
    { id: 'won', label: 'Won' },
  ],
});
const schemaFields = [primary, stage];
const acme = fixtureRecord(5, { '1': 'Acme', '2': 'lead' }, { revision: 3 });
const globex = fixtureRecord(6, { '1': 'Globex' });

let mounted: MountedBody | null = null;

beforeEach(() => {
  api.aggregateTableRecords.mockResolvedValue([
    { group: 'lead', value: 41 },
    { group: null, value: 2 },
  ]);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const lane = (key: string) => mounted!.container.querySelector(`[data-testid="kanban-lane-${key}"]`)!;
const card = (id: number) => mounted!.container.querySelector(`[data-testid="kanban-card-${id}"]`)!;

describe('KanbanViewBody', () => {
  it('moves a card to another lane with one revision-checked single-field write', async () => {
    const props = bodyProps({ config: { kanban: { groupFieldId: stage.id } }, schemaFields, records: [acme, globex] });
    mounted = await mountBody(KanbanViewBody, props);

    expect(lane('lead').contains(card(5))).toBe(true);
    expect(lane('none').contains(card(6))).toBe(true);
    // Counts are the aggregate's (the whole query), not the cards on screen.
    expect(lane('lead').querySelector('[data-testid="kanban-lane-count"]')?.textContent).toBe('41');
    expect(api.aggregateTableRecords).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ operation: 'count', groupBy: { fieldId: stage.id } }),
    );

    await dragTo(card(5), lane('won').querySelector('header'));

    expect(props.onCommitValue).toHaveBeenCalledTimes(1);
    expect(props.onCommitValue).toHaveBeenCalledWith(acme, stage, 'won');
    // Dropping a card on the "no value" lane clears the field.
    await dragTo(card(5), lane('none'));
    expect(props.onCommitValue).toHaveBeenLastCalledWith(acme, stage, null);
    // The click the browser sends after the drag does not open the record.
    expect(props.onOpenRecord).not.toHaveBeenCalled();
  });

  it('does nothing when the card is dropped on its own lane or outside every lane', async () => {
    const props = bodyProps({ config: { kanban: { groupFieldId: stage.id } }, schemaFields, records: [acme] });
    mounted = await mountBody(KanbanViewBody, props);
    await dragTo(card(5), lane('lead'));
    await dragTo(card(5), null);
    expect(props.onCommitValue).not.toHaveBeenCalled();
  });

  it('snaps the card back and says so when the write fails', async () => {
    let reject: (error: Error) => void = () => undefined;
    const props = bodyProps({
      config: { kanban: { groupFieldId: stage.id } },
      schemaFields,
      records: [acme],
      onCommitValue: vi.fn(() => new Promise<void>((_resolve, fail) => (reject = fail))),
    });
    mounted = await mountBody(KanbanViewBody, props);

    await dragTo(card(5), lane('won'));
    // Optimistic: the card sits in the target lane while the write is in flight.
    expect(lane('won').contains(card(5))).toBe(true);

    await act(async () => reject(new Error('This record was changed by someone else.')));
    await flush();
    expect(lane('lead').contains(card(5))).toBe(true);
    expect(document.body.textContent).toContain('This record was changed by someone else.');
  });

  it('respects the permissions the container passes', async () => {
    const props = bodyProps({
      config: { kanban: { groupFieldId: stage.id } },
      schemaFields,
      records: [acme],
      permissions: { canEdit: false, canCreate: false, canBuild: false, canChangeView: false },
    });
    mounted = await mountBody(KanbanViewBody, props);
    await dragTo(card(5), lane('won'));
    expect(props.onCommitValue).not.toHaveBeenCalled();
    expect(mounted.container.textContent).not.toContain('New record');
    expect(mounted.container.querySelector('button[aria-label="Hide lane"]')).toBeNull();
    // A plain click still opens the record.
    await act(async () => (card(5) as HTMLElement).click());
    expect(props.onOpenRecord).toHaveBeenCalledWith(acme);
  });

  it('creates a record prefilled with the lane, hides lanes, and caps the board with a notice', async () => {
    const props = bodyProps({
      config: { kanban: { groupFieldId: stage.id, hiddenGroups: ['won'] } },
      schemaFields,
      records: [acme],
      total: 640,
    });
    mounted = await mountBody(KanbanViewBody, props);

    expect(mounted.container.querySelector('[data-testid="kanban-lane-won"]')).toBeNull();
    expect(mounted.container.textContent).toContain('Hidden lanes');
    expect(mounted.container.textContent).toContain('Showing the first 500 of 640 records');

    const newInLead = [...lane('lead').querySelectorAll('button')].find((button) =>
      button.textContent?.includes('New record'),
    )!;
    await act(async () => newInLead.click());
    expect(props.onCreateRecord).toHaveBeenCalledWith({ '2': 'lead' });

    await act(async () => (lane('lead').querySelector('button[aria-label="Hide lane"]') as HTMLButtonElement).click());
    expect(props.onUpdateViewConfig).toHaveBeenCalledWith({
      kanban: { groupFieldId: stage.id, hiddenGroups: ['won', 'lead'] },
    });
  });

  it('asks for a lane field when the view has none', async () => {
    const props = bodyProps({ config: {}, schemaFields, records: [acme] });
    mounted = await mountBody(KanbanViewBody, props);
    expect(mounted.container.textContent).toContain('Choose how to split the board');
    const choose = [...mounted.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Choose a field'),
    )!;
    await act(async () => choose.click());
    expect(props.onConfigureView).toHaveBeenCalled();
  });
});
