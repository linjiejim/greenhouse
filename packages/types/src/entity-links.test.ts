import { describe, expect, it } from 'vitest';
import { ENTITY_KINDS, type EntityRef, entityUrl, isEntityUrl, parseEntityUrl } from './entity-links.js';

/** One representative ref per kind — the round-trip test asserts full coverage. */
const SAMPLES: EntityRef[] = [
  { kind: 'project', id: 9 },
  { kind: 'kb_doc', id: 88, slug: 'brand-foundations-logo' },
  { kind: 'tables_record', baseId: 3, tableId: 12, id: 501 },
];

describe('entity links', () => {
  it('round-trips every kind', () => {
    expect(SAMPLES.map((r) => r.kind).sort()).toEqual([...ENTITY_KINDS].sort());
    for (const ref of SAMPLES) {
      expect(parseEntityUrl(entityUrl(ref))).toEqual(ref);
    }
  });

  it('builds the app routes the pages actually serve', () => {
    expect(entityUrl({ kind: 'project', id: 9 })).toBe('#/projects/9');
    expect(entityUrl({ kind: 'kb_doc', id: 88, slug: 'a-b' })).toBe('#/knowledge/doc/88-a-b');
    expect(entityUrl({ kind: 'tables_record', baseId: 3, tableId: 12, id: 501 })).toBe(
      '#/tables/3/table/12?record=501',
    );
  });

  it('keeps dashes inside a kb slug', () => {
    expect(parseEntityUrl('#/knowledge/doc/12-multi-dash-slug')).toEqual({
      kind: 'kb_doc',
      id: 12,
      slug: 'multi-dash-slug',
    });
  });

  // The renderer turns a match into a peek that suppresses navigation, so a loose
  // parse would break ordinary links rather than merely miss an enhancement.
  it.each([
    ['a list route', '#/projects'],
    ['a module root', '#/knowledge'],
    ['an unknown module', '#/widgets/42'],
    ['an extra path segment', '#/projects/42/edit'],
    ['an unknown segment', '#/projects/leads/42'],
    ['a non-numeric id', '#/projects/abc'],
    ['a zero id', '#/projects/0'],
    ['a padded id', '#/projects/007'],
    ['a negative id', '#/projects/-1'],
    ['a fractional id', '#/projects/1.5'],
    ['a kb doc with no slug', '#/knowledge/doc/12'],
    ['a kb doc with an empty slug', '#/knowledge/doc/12-'],
    ['a kb doc with no id', '#/knowledge/doc/-slug'],
    ['a kb scope route', '#/knowledge/internal/space/slug'],
    ['a table without a record param', '#/tables/3/table/12'],
    ['a table with a junk record param', '#/tables/3/table/12?record=abc'],
    ['a non-hash in-app path', '/projects/42'],
    ['an external url', 'https://example.com/projects/42'],
    ['a mention', 'user:abc'],
    ['an empty href', ''],
  ])('rejects %s', (_label, href) => {
    expect(parseEntityUrl(href)).toBeNull();
    expect(isEntityUrl(href)).toBe(false);
  });

  it('tolerates surrounding whitespace and extra query params', () => {
    expect(parseEntityUrl('  #/projects/9  ')).toEqual({ kind: 'project', id: 9 });
    expect(parseEntityUrl('#/tables/3/table/12?view=grid&record=501')).toEqual({
      kind: 'tables_record',
      baseId: 3,
      tableId: 12,
      id: 501,
    });
  });
});
