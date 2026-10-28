import { describe, expect, it } from 'vitest';
import {
  addSection,
  draftOf,
  draftProblems,
  moveSection,
  removeSection,
  templateBody,
  toggleFormat,
  updateSection,
  withKind,
} from './template-draft';

describe('report template draft', () => {
  it('a new draft needs a name and a section title before the station would take it', () => {
    const draft = draftOf();
    expect(draftProblems(draft)).toEqual(['name is required.', 'Section 1: title is required.']);
    const named = updateSection({ ...draft, name: 'Weekly' }, 0, { title: 'Summary' });
    expect(draftProblems(named)).toEqual([]);
    expect(templateBody(named)).toMatchObject({
      name: 'Weekly',
      kind: 'report',
      formats: ['pdf', 'docx'],
      visibility: 'team',
    });
  });

  it('keeps formats valid for the kind, in canonical order', () => {
    const deck = withKind(draftOf(), 'presentation');
    expect(deck.formats).toEqual(['pdf']);
    expect(toggleFormat(deck, 'pptx').formats).toEqual(['pptx', 'pdf']);
    expect(toggleFormat(toggleFormat(deck, 'pptx'), 'pdf').formats).toEqual(['pptx']);
    expect(draftProblems({ ...toggleFormat(deck, 'pdf'), name: 'x', sections: [] })).toContain(
      'Pick at least one output format.',
    );
  });

  it('adds sections with unused keys, moves and removes them', () => {
    let draft = addSection(addSection(draftOf()));
    expect(draft.sections.map((s) => s.key)).toEqual(['summary', 'section_2', 'section_3']);
    draft = moveSection(draft, 2, -1);
    expect(draft.sections.map((s) => s.key)).toEqual(['summary', 'section_3', 'section_2']);
    expect(moveSection(draft, 0, -1)).toBe(draft);
    draft = removeSection(draft, 0);
    expect(addSection(draft).sections.at(-1)!.key).toBe('section_4');
    const dup = updateSection(draft, 1, { key: 'section_3' });
    expect(draftProblems({ ...dup, name: 'x' }).some((p) => p.includes('used twice'))).toBe(true);
  });
});
