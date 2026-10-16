import { describe, expect, it } from 'vitest';
import type { SkillVariable } from '@greenhouse/contract';
import { checkValues, fillTemplate, placeholdersIn, variablesProblem } from '../template.js';

const BODY = 'Write the weekly report for {{team}} covering {{ period }}. Focus: {{focus}}. Tone: {{tone}}.';
const FIELDS: SkillVariable[] = [
  { key: 'team', label: 'Team', type: 'text', required: true },
  { key: 'period', label: 'Period', type: 'text', required: true },
  { key: 'focus', label: 'Focus', type: 'text', required: false },
  { key: 'tone', label: 'Tone', type: 'choice', options: ['plain', 'upbeat'], required: false },
];

describe('template skills', () => {
  it('finds the placeholders in order, once each', () => {
    expect(placeholdersIn(`${BODY} Again {{team}}.`)).toEqual(['team', 'period', 'focus', 'tone']);
    expect(placeholdersIn('{{1bad}} {{ ok_2 }}')).toEqual(['ok_2']);
  });

  it('checks that every field has its placeholder and no key is there twice', () => {
    expect(variablesProblem(BODY, FIELDS)).toBeNull();
    expect(
      variablesProblem(BODY, [...FIELDS, { key: 'extra', label: 'Extra', type: 'text', required: false }]),
    ).toContain('{{extra}}');
    expect(variablesProblem(BODY, [FIELDS[0]!, FIELDS[0]!])).toContain('twice');
  });

  it('checks the values: required ones, choices, length; drops unknown keys', () => {
    expect(checkValues(FIELDS, { team: ' Platform ', period: 'this week', tone: 'plain', other: 'x' })).toEqual({
      ok: true,
      values: { team: 'Platform', period: 'this week', tone: 'plain' },
    });
    expect(checkValues(FIELDS, { team: 'Platform' })).toMatchObject({ ok: false, fields: ['period'] });
    expect(checkValues(FIELDS, { team: 'a', period: 'b', tone: 'loud' })).toMatchObject({
      ok: false,
      fields: ['tone'],
    });
    expect(checkValues(FIELDS, { team: 'a'.repeat(4001), period: 'b' })).toMatchObject({
      ok: false,
      fields: ['team'],
    });
  });

  it('fills the body; an empty optional field keeps its placeholder', () => {
    expect(fillTemplate(BODY, { team: 'Platform', period: 'W41', tone: '$& plain' })).toBe(
      'Write the weekly report for Platform covering W41. Focus: {{focus}}. Tone: $& plain.',
    );
  });
});
