import { it, expect } from 'vitest';
import { parsePeople, peopleIds } from './people';

const fields = [
  { key: 'title', kind: 'text' },
  { key: 'owner', kind: 'user' },
  { key: 'reviewer', kind: 'user' },
];

it('collects the member ids of user fields, each once', () => {
  expect(
    peopleIds(fields, [
      { title: 'usr_x', owner: 'usr_1', reviewer: 'usr_2' },
      { title: 'b', owner: 'usr_1', reviewer: null },
    ]),
  ).toEqual(['usr_1', 'usr_2']);
});

it('skips masked and empty values', () => {
  expect(peopleIds(fields, [{ owner: '***', reviewer: '' }])).toEqual([]);
});

it('reads the answer and skips anything malformed', () => {
  expect(
    parsePeople({
      people: [{ id: 'usr_1', name: 'Ada' }, { id: 'usr_2', name: ' ' }, { id: 3, name: 'x' }, null],
    }),
  ).toEqual({ usr_1: 'Ada' });
  expect(parsePeople(null)).toEqual({});
});
