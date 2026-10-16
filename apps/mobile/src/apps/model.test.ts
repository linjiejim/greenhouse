import { describe, expect, it } from 'vitest';
import type { AppRuntime, Field } from '../shared/contract';
import { canAct, cardFields, validValues, appCardPath, choiceCard, type RecordCard } from './model';

const title = { id: 'title', type: 'text', required: true } as Field;
const secret = { id: 'secret', type: 'text' } as Field;
const runtime = {
  app: { id: 'app_a' },
  version: 1,
  preview: false,
  base: { archived_at: null, access: 'editor', tables: [{ id: 'table', access: 'edit', fields: [title, secret] }] },
} as AppRuntime;
const card = { table_id: 'table', fields: ['title', 'missing'], detail_fields: [] } as unknown as RecordCard;

describe('published app boundaries on phones', () => {
  it('reads picker titles only through a published record card that exposes the primary field', () => {
    const form = { ...card, id: 'form', kind: 'form', fields: ['title'] };
    const hiddenTitle = { ...card, id: 'hidden', kind: 'records', fields: ['secret'] };
    const source = { ...card, id: 'source', kind: 'records', fields: ['title'] };
    const runtimeWithPages = {
      ...runtime,
      base: {
        ...runtime.base,
        tables: [{ ...runtime.base.tables[0]!, fields: [{ ...title, is_primary: true }, secret] }],
      },
      pages: [{ id: 'page', name: 'Page', cards: [form, hiddenTitle, source] }],
    } as AppRuntime;
    const relation = { id: 'link', type: 'relation', table_id: 'table', config: {} } as Field;
    expect(choiceCard(runtimeWithPages, relation)?.id).toBe('source');
    expect(appCardPath(runtimeWithPages, 'source')).toBe('/#/apps/app_a/page');
    expect(
      choiceCard(
        {
          ...runtimeWithPages,
          pages: [
            { ...runtimeWithPages.pages[0]!, cards: [form, hiddenTitle] as AppRuntime['pages'][number]['cards'] },
          ],
        },
        relation,
      ),
    ).toBeUndefined();
  });
  it('keeps detail_fields empty and never fills missing or hidden fields from the base', () => {
    expect(cardFields(runtime, card)).toEqual([title]);
    expect(cardFields(runtime, card, true)).toEqual([]);
    expect(cardFields(runtime, { ...card, detail_fields: undefined }, true)).toEqual([title]);
  });
  it('disables writes for previews, unpublished versions, archives and explicit read-only tables', () => {
    expect(canAct(runtime, 'table')).toBe(true);
    expect(canAct({ ...runtime, preview: true }, 'table')).toBe(false);
    expect(canAct({ ...runtime, version: 0 }, 'table')).toBe(false);
    expect(canAct({ ...runtime, base: { ...runtime.base, archived_at: 'now' } }, 'table')).toBe(false);
    expect(
      canAct(
        { ...runtime, base: { ...runtime.base, tables: [{ ...runtime.base.tables[0]!, access: 'read' }] } },
        'table',
      ),
    ).toBe(false);
  });
  it('accepts false checkboxes, rejects missing required values and non-finite numbers, and leaves computed fields to the server', () => {
    const fields = [
      title,
      { id: 'check', required: true, type: 'checkbox' },
      { id: 'calculated', required: true, type: 'formula' },
    ] as Field[];
    expect(validValues(fields, { title: 'Draft', check: false })).toBe(true);
    expect(validValues(fields, { title: '', check: true })).toBe(false);
    expect(validValues([{ id: 'amount', type: 'number' } as Field], { amount: NaN })).toBe(false);
  });
});
