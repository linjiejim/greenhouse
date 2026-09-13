/**
 * 会话键的回退链与飞书面的工具收窄。
 *
 * 这两件事都是「错了没有任何东西会报错」的类型：键选错只会让上下文悄悄断掉或
 * 串台，denylist 漏一个只会让 IM 里冒出一个按不了的确认卡。
 */

import { describe, expect, it } from 'vitest';
import {
  FEISHU_DENIED_TOOL_IDS,
  feishuConversationKey,
  filterFeishuToolIds,
  groupVisibilityFooter,
} from '../conversation-key.js';

describe('feishuConversationKey', () => {
  it('话题群按 thread_id 隔离 —— 每个话题一个会话', () => {
    expect(feishuConversationKey({ message_id: 'om_c', root_id: 'om_a', parent_id: 'om_b', thread_id: 'omt_1' })).toBe(
      'omt_1',
    );
  });

  it('普通回复链落到 root_id，而不是 parent_id', () => {
    // 实测：parent_id 指向「被直接回复的那一条」，链上每条各不相同；root_id 恒定。
    // 用 parent_id 当键会让每回复一次就换一个会话。
    const first = feishuConversationKey({ message_id: 'om_2', root_id: 'om_1', parent_id: 'om_bot_a' });
    const later = feishuConversationKey({ message_id: 'om_9', root_id: 'om_1', parent_id: 'om_bot_z' });
    expect(first).toBe('om_1');
    expect(later).toBe('om_1');
  });

  it('首次发言用自己的 message_id —— 它将成为这条链的根', () => {
    expect(feishuConversationKey({ message_id: 'om_1', root_id: null, parent_id: null, thread_id: null })).toBe('om_1');
  });

  it('空字符串按缺失处理（飞书对无值字段并不总是给 null）', () => {
    expect(feishuConversationKey({ message_id: 'om_1', root_id: '', thread_id: '' })).toBe('om_1');
  });
});

describe('filterFeishuToolIds', () => {
  it('挡掉编排类工具 —— IM 里没有 Launch 卡那道减速带', () => {
    const out = filterFeishuToolIds(['knowledge_query', 'mission_dispatch', 'crm_query', 'workflow_plan']);
    expect(out).toEqual(['knowledge_query', 'crm_query']);
  });

  it('只收窄，不放大 —— 传进来没有的工具不会凭空出现', () => {
    expect(filterFeishuToolIds([])).toEqual([]);
    expect(filterFeishuToolIds(['crm_query'])).toEqual(['crm_query']);
  });

  it('禁用集合钉死 —— 增删都应该是有意识的改动', () => {
    expect([...FEISHU_DENIED_TOOL_IDS].sort()).toEqual([
      'call_llm',
      'mission_dispatch',
      'spawn_session',
      'tables_schema_plan',
      'task_capture',
      'workflow_plan',
    ]);
  });
});

describe('groupVisibilityFooter', () => {
  it('群里点名是谁的权限、给谁看', () => {
    const footer = groupVisibilityFooter('Jim Lin');
    expect(footer).toContain('Jim Lin');
    expect(footer).toContain('本群可见');
  });
});
