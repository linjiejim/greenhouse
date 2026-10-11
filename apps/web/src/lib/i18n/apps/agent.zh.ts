/**
 * Apps · the Agent side: the Assistant's `app-page` context, app plan operations,
 * Bots plan requests and built-in templates.
 * Owned by slice AG; spread into `apps` by ./zh.ts (keys resolve as `apps.agent.*`).
 */

import type { DeepRecord } from '../types';
import type { appsAgentEn } from './agent.en';

export const appsAgentZh: DeepRecord<typeof appsAgentEn> = {
  agent: {
    context: {
      label: '{app} · {page}',
      appOnly: '{app}',
      unnamedApp: '应用 #{id}',
      builderLabel: '{app} · 构建器',
      empty: '问我关于「{app}」的问题——某个页面是做什么的、怎么用。',
      builderEmpty: '问我关于「{app}」的问题——它的页面、角色，以及分发给了谁。',
      explainPage: '解释这个页面',
      explainPagePrompt: '解释应用「{app}」的「{page}」页面是做什么的、怎么用。',
      planPage: '规划一个页面',
      planPagePrompt: '帮我为应用「{app}」规划一个新页面。',
    },
  },
};
