/**
 * Tests for extractJson — robust JSON extraction from LLM output.
 * Tests the shared implementation from utils/json.ts.
 */

import { describe, it, expect } from 'vitest';
import { extractJson } from '@greenhouse/utils/json';

describe('extractJson', () => {
  it('extracts JSON from code fence with language tag', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: 'value' });
  });

  it('extracts JSON from plain code fence', () => {
    const input = '```\n{"key": "value"}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: 'value' });
  });

  it('returns JSON directly when no code fence', () => {
    const input = '{"key": "value"}';
    const result = extractJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('handles array JSON', () => {
    const input = '```json\n[1, 2, 3]\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual([1, 2, 3]);
  });

  it('finds JSON object embedded in text', () => {
    const input = 'Here is the result:\n{"key": "value"}\nEnd of response.';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toHaveProperty('key');
  });

  it('finds JSON array embedded in text', () => {
    const input = 'Results:\n[{"a": 1}, {"a": 2}]\nDone.';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toHaveLength(2);
  });

  it('handles multiline JSON in code fence', () => {
    const input = [
      '```json',
      '{',
      '  "summary": "test",',
      '  "tags": ["a", "b"]',
      '}',
      '```',
    ].join('\n');

    const result = extractJson(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.summary).toBe('test');
    expect(parsed.tags).toEqual(['a', 'b']);
  });

  it('handles whitespace around input', () => {
    const input = '  \n{"key": "value"}\n  ';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: 'value' });
  });

  it('handles code fence without closing backticks', () => {
    const input = '```json\n{"key": "value"}';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: 'value' });
  });

  it('returns null when no JSON found', () => {
    const input = 'No JSON here at all';
    const result = extractJson(input);
    expect(result).toBeNull();
  });

  it('handles nested JSON objects', () => {
    const input =
      '```json\n{"outer": {"inner": "value"}, "list": [1, 2]}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.outer.inner).toBe('value');
    expect(parsed.list).toEqual([1, 2]);
  });

  it('handles empty JSON object', () => {
    const input = '```json\n{}\n```';
    const result = extractJson(input);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({});
  });
});
