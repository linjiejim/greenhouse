import { describe, expect, it } from 'vitest';
import {
  agentChoices,
  automationBody,
  draftChanged,
  draftFromAutomation,
  duplicateDraft,
  grantableTools,
  newDraft,
  notifyOptions,
  orderedTools,
  pinnedProfileVersion,
  reviewDraft,
  unpinnedProfileId,
  validateDraft,
  type AutomationDraft,
} from './draft';
import { checkSchedule } from './cron';
import type { Automation } from './model';
import { CORE_OPT_IN_TOOLS } from '../shared/greenhouse-types';

const NOW = Date.UTC(2026, 9, 27, 10, 0);
const channels = [
  { key: 'email', label: 'Email' },
  { key: 'wecom', label: 'WeCom' },
];
const task: Automation = {
  id: 'auto-1',
  user_id: 'member',
  name: '每日站会摘要',
  profile_id: 'custom:ops@3',
  task_prompt: '每个工作日早上汇总昨天各项目的任务变化。',
  schedule: '0 9 * * 1-5',
  timezone: 'Asia/Taipei',
  enabled: true,
  notify: { webhook: null, email: true, wecom: false, feishu: true },
  quiet_when_empty: false,
  max_steps: 15,
  unattended_tools: ['export_data'],
  last_run_at: null,
  last_status: null,
  next_run_at: null,
  run_count: 0,
  created_at: '2026-10-22T09:00:00Z',
  updated_at: '2026-10-22T09:00:00Z',
};
const filled = (patch: Partial<AutomationDraft> = {}): AutomationDraft => ({
  ...newDraft({ timezone: 'Asia/Taipei', profileId: 'sprouty' }),
  name: '周报',
  prompt: '每周五汇总本周所有项目的进展。',
  ...patch,
});
const errorsOf = (draft: AutomationDraft) => validateDraft(draft, checkSchedule(draft.schedule, draft.timezone, NOW));

describe('drafts', () => {
  it('a new automation runs daily at 09:00, switched on, as the default agent', () => {
    expect(newDraft({ timezone: 'Europe/Berlin', profileId: 'sprouty' })).toEqual({
      name: '',
      prompt: '',
      schedule: '0 9 * * *',
      timezone: 'Europe/Berlin',
      profileId: 'sprouty',
      enabled: true,
      maxSteps: '15',
      notify: {},
      webhook: '',
      quietWhenEmpty: false,
      tools: [],
    });
  });

  it('opens an automation with its delivery, pin and tools', () => {
    expect(draftFromAutomation(task)).toMatchObject({
      profileId: 'custom:ops@3',
      notify: { email: true, wecom: false, feishu: true },
      webhook: '',
      maxSteps: '15',
      tools: ['export_data'],
    });
  });

  it('a duplicate starts paused under its new name', () => {
    expect(duplicateDraft(task, '每日站会摘要（副本）')).toMatchObject({
      name: '每日站会摘要（副本）',
      enabled: false,
    });
  });

  it('notices an edit', () => {
    const start = draftFromAutomation(task);
    expect(draftChanged({ ...start }, start)).toBe(false);
    expect(draftChanged({ ...start, name: 'x' }, start)).toBe(true);
  });
});

describe('validateDraft', () => {
  it('accepts a complete draft', () => {
    expect(errorsOf(filled())).toEqual({});
  });

  it('holds the station’s lengths and limits', () => {
    expect(errorsOf(filled({ name: ' a ' }))).toEqual({ name: 'nameLength' });
    expect(errorsOf(filled({ name: 'x'.repeat(51) }))).toEqual({ name: 'nameLength' });
    expect(errorsOf(filled({ prompt: '太短了' }))).toEqual({ prompt: 'promptShort' });
    expect(errorsOf(filled({ prompt: 'x'.repeat(4001) }))).toEqual({ prompt: 'promptLong' });
    expect(errorsOf(filled({ maxSteps: '0' }))).toEqual({ maxSteps: 'maxSteps' });
    expect(errorsOf(filled({ maxSteps: '21' }))).toEqual({ maxSteps: 'maxSteps' });
    expect(errorsOf(filled({ maxSteps: '2.5' }))).toEqual({ maxSteps: 'maxSteps' });
  });

  it('puts schedule and zone problems on their fields', () => {
    expect(errorsOf(filled({ schedule: '*/5 * * * *' }))).toEqual({ schedule: 'cronTooOften' });
    expect(errorsOf(filled({ schedule: 'soon' }))).toEqual({ schedule: 'cronInvalid' });
    expect(errorsOf(filled({ timezone: 'Atlantis' }))).toEqual({ timezone: 'timezoneInvalid' });
  });

  it('wants an https webhook, or none', () => {
    expect(errorsOf(filled({ webhook: 'http://qyapi.weixin.qq.com/x' }))).toEqual({ webhook: 'webhookInvalid' });
    expect(errorsOf(filled({ webhook: 'not a url' }))).toEqual({ webhook: 'webhookInvalid' });
    expect(errorsOf(filled({ webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }))).toEqual({});
  });

  it('reviews schedule and fields in one go', () => {
    const review = reviewDraft(filled(), NOW);
    expect(review.errors).toEqual({});
    expect(review.schedule.ok && review.schedule.runs?.length).toBe(3);
  });
});

describe('automationBody', () => {
  it('creates with the structured notify object, never the flat 1.x fields', () => {
    const body = automationBody(
      filled({ notify: { email: true }, webhook: ' https://open.feishu.cn/open-apis/bot/v2/hook/x ' }),
      {
        channels,
        webhook: true,
      },
    );
    expect(body).toEqual({
      name: '周报',
      task_prompt: '每周五汇总本周所有项目的进展。',
      schedule: '0 9 * * *',
      timezone: 'Asia/Taipei',
      profile_id: 'sprouty',
      enabled: true,
      max_steps: 15,
      quiet_when_empty: false,
      unattended_tools: [],
      notify: { email: true, wecom: false, webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' },
    });
    expect(Object.keys(body).some((key) => key.startsWith('notify_'))).toBe(false);
  });

  it('leaves notify out when the station offers no delivery', () => {
    expect(automationBody(filled(), { channels: [], webhook: false })).not.toHaveProperty('notify');
  });

  it('an edit sends only what changed', () => {
    const original = draftFromAutomation(task);
    const options = { original, channels, webhook: true };
    expect(automationBody(original, options)).toEqual({});
    expect(automationBody({ ...original, name: '站会摘要', schedule: '30 9 * * 1-5' }, options)).toEqual({
      name: '站会摘要',
      schedule: '30 9 * * 1-5',
    });
  });

  it('an untouched agent keeps its pinned version; picking it again re-pins', () => {
    const original = draftFromAutomation(task);
    const options = { original, channels, webhook: false };
    expect(automationBody({ ...original }, options)).not.toHaveProperty('profile_id');
    expect(automationBody({ ...original, profileId: 'custom:ops' }, options)).toEqual({ profile_id: 'custom:ops' });
  });

  it('merges delivery key by key: only changed channels, and dormant ones are never sent', () => {
    const original = draftFromAutomation(task);
    const options = { original, channels, webhook: true };
    expect(automationBody({ ...original, notify: { ...original.notify, wecom: true } }, options)).toEqual({
      notify: { wecom: true },
    });
    // feishu is stored but its transport is not active: left alone
    expect(automationBody({ ...original, notify: { ...original.notify, feishu: false } }, options)).toEqual({});
    expect(automationBody({ ...original, webhook: 'https://qyapi.weixin.qq.com/x' }, options)).toEqual({
      notify: { webhook: 'https://qyapi.weixin.qq.com/x' },
    });
  });
});

describe('what the station offers', () => {
  it('reads delivery channels from the manifest transports', () => {
    expect(
      notifyOptions([
        { id: 'email', title: 'Email', bindingSettings: { preference: 'email', label: 'Email' } },
        { id: 'wecom', title: 'WeCom', bindingSettings: { preference: 'wecom', label: 'WeCom' }, webhook: true },
        { id: 'sms', title: 'SMS' },
        null,
      ]),
    ).toEqual({
      channels: [
        { key: 'email', label: 'Email' },
        { key: 'wecom', label: 'WeCom' },
      ],
      webhook: true,
    });
    expect(notifyOptions(undefined)).toEqual({ channels: [], webhook: false });
  });

  it('offers only the grantable tools I hold, in catalog order', () => {
    const station = [{ id: 'tables_mutation', tier: 'write', order: 50 }, { id: 'bogus' }];
    expect(
      grantableTools(CORE_OPT_IN_TOOLS, station, ['mcp_call', 'tables_mutation', 'analyze_image', 'web_search']).map(
        (tool) => tool.id,
      ),
    ).toEqual(['analyze_image', 'tables_mutation', 'mcp_call']);
    expect(orderedTools(['mcp_call', 'gone', 'analyze_image'], CORE_OPT_IN_TOOLS)).toEqual([
      'analyze_image',
      'mcp_call',
      'gone',
    ]);
  });

  it('lists the agents an automation of mine may run as', () => {
    const profiles = [
      { id: 'sprouty', name: 'Sprouty' },
      { id: 'custom:mine', name: 'Mine', is_custom: true, user_id: 'member' },
      { id: 'custom:team', name: 'Team', is_custom: true, user_id: 'other', is_shared: true },
      { id: 'custom:private', name: 'Private', is_custom: true, user_id: 'other' },
    ];
    const choices = agentChoices(profiles, 'member');
    expect(choices.builtIn.map((p) => p.id)).toEqual(['sprouty']);
    expect(choices.custom.map((p) => p.id)).toEqual(['custom:mine', 'custom:team']);
    expect(unpinnedProfileId('custom:ops@3')).toBe('custom:ops');
    expect(unpinnedProfileId('sprouty')).toBe('sprouty');
    expect(pinnedProfileVersion('custom:ops@3')).toBe(3);
    expect(pinnedProfileVersion('custom:ops')).toBeNull();
  });
});
