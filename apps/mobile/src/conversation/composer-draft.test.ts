import { describe, expect, it } from 'vitest';
import type { ComposerFile } from '../chat/composer-files';
import type { Skill } from '../shared/contract';
import {
  emptyComposerContent,
  restoreComposerContent,
  restoreComposerFiles,
  type ComposerContent,
} from './composer-draft';
import { namedMentions } from './picker';

const skill = (id: string, variables: Skill['variables'] = []): Skill => ({
  id,
  name: id,
  display_name: id,
  description: '',
  kind: 'template',
  space: 'personal',
  owner_id: 'member',
  tags: [],
  latest_version: '1',
  requirements: { computer: false, connectors: [] },
  variables,
  scan_status: 'clean',
  scan_findings: [],
  scanned_at: null,
  scan_reviewed_by: null,
  scan_note: null,
  download_count: 0,
  archived_at: null,
  created_at: '2026-10-17T00:00:00Z',
  updated_at: '2026-10-17T00:00:00Z',
  can_manage: true,
  can_review: false,
  available: true,
  unavailable: null,
});

const failed = (): ComposerContent => ({
  value: 'Draft A: @Lin, analyze these orders.',
  quote: { message_id: 'message-a', text: 'Original constraint' },
  skill: skill('orders', [{ key: 'month', label: 'Month', type: 'text', required: true }]),
  fields: { month: 'September' },
  picked: [{ handle: 'member-lin', name: 'Lin' }],
});

describe('restoring a failed composer send', () => {
  it('restores all submitted fields when the member has not started another draft', () => {
    expect(restoreComposerContent(emptyComposerContent(), failed())).toEqual(failed());
  });

  it('keeps newer text beside the failed message, with both named recipients', () => {
    const current: ComposerContent = {
      ...emptyComposerContent(),
      value: 'Draft B: @Mei, prepare the next meeting.',
      picked: [{ handle: 'member-mei', name: 'Mei' }],
    };
    const restored = restoreComposerContent(current, failed());
    expect(restored.value).toBe(`${failed().value}\n${current.value}`);
    expect(namedMentions(restored.value, restored.picked)).toEqual(['member-lin', 'member-mei']);
    expect(restored.quote).toEqual(failed().quote);
    expect(restored.skill?.id).toBe('orders');
    expect(restored.fields).toEqual({ month: 'September' });
    expect(current.value).toBe('Draft B: @Mei, prepare the next meeting.');
  });

  it('preserves the newer quote and skill with its own variables as one choice', () => {
    const current: ComposerContent = {
      ...emptyComposerContent(),
      value: 'New meeting request',
      quote: { message_id: 'message-b', text: 'New constraint' },
      skill: skill('meeting'),
      fields: { topic: 'Launch' },
    };
    const restored = restoreComposerContent(current, failed());
    expect(restored.quote).toEqual(current.quote);
    expect(restored.skill).toEqual(current.skill);
    expect(restored.fields).toEqual({ topic: 'Launch' });
    expect(restored.fields).not.toHaveProperty('month');
  });

  it('does not attach the old skill variables to a newer skill with no variables', () => {
    const current = { ...emptyComposerContent(), skill: skill('plain-summary') };
    const restored = restoreComposerContent(current, failed());
    expect(restored.skill?.id).toBe('plain-summary');
    expect(restored.fields).toEqual({});
  });

  it('does not duplicate a mentioned member and keeps their current display name', () => {
    const current = {
      ...emptyComposerContent(),
      value: '@Lin Chen, one more request.',
      picked: [{ handle: 'member-lin', name: 'Lin Chen' }],
    };
    const restored = restoreComposerContent(current, failed());
    expect(restored.picked).toEqual(current.picked);
    expect(namedMentions(restored.value, restored.picked)).toEqual(['member-lin']);
  });

  it('keeps failed-send attachments and newer uploads without reverting or duplicating files', () => {
    const old: ComposerFile = { id: 'file-a', uri: 'file:///a', name: 'a.csv', kind: 'file', status: 'error' };
    const changed = { ...old, status: 'uploading' as const };
    const newer: ComposerFile = { id: 'file-b', uri: 'file:///b', name: 'b.png', kind: 'image', status: 'uploading' };
    expect(restoreComposerFiles([], [old])).toEqual([old]);
    expect(restoreComposerFiles([newer], [old])).toEqual([old, newer]);
    expect(restoreComposerFiles([changed, newer], [old])).toEqual([changed, newer]);
    expect(old.status).toBe('error');
    expect(newer.status).toBe('uploading');
  });
});
