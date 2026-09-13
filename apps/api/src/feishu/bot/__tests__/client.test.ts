/**
 * 长连接客户端的两处纯逻辑：启用开关与消息文本解析。
 *
 * 这两处错了都不会有任何东西报错——开关判反了会让一个没打算开机器人的部署
 * 悄悄连上去，`@_user_1` 没剥干净则会把飞书的内部标记当成用户的话喂给模型。
 */

import { describe, expect, it } from 'vitest';
import { isFeishuBotEnabled, parseFeishuText } from '../client.js';

const CONFIGURED = { FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 's' } as NodeJS.ProcessEnv;

describe('isFeishuBotEnabled', () => {
  it('默认关闭 —— 配了飞书凭证不等于同意开机器人', () => {
    // 开长连接 = 任何能给机器人发消息的人都能触发 agent 运行，必须是显式决定。
    expect(isFeishuBotEnabled({ ...CONFIGURED })).toBe(false);
  });

  it('两个条件都满足才启用', () => {
    expect(isFeishuBotEnabled({ ...CONFIGURED, FEISHU_BOT_ENABLED: '1' })).toBe(true);
    // 开关开了但没凭证 —— 连不上，等于没开。
    expect(isFeishuBotEnabled({ FEISHU_BOT_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('只认 "1"，不把任意真值当同意', () => {
    expect(isFeishuBotEnabled({ ...CONFIGURED, FEISHU_BOT_ENABLED: 'true' })).toBe(false);
    expect(isFeishuBotEnabled({ ...CONFIGURED, FEISHU_BOT_ENABLED: '0' })).toBe(false);
  });
});

describe('parseFeishuText', () => {
  it('从飞书的 JSON content 里取正文', () => {
    expect(parseFeishuText('{"text":"昨天的工单有多少条？"}')).toBe('昨天的工单有多少条？');
  });

  it('剥掉群里 @机器人 留下的内部标记', () => {
    // 飞书在正文里插 `@_user_1`；不剥掉就会被模型读成用户说的话。
    expect(parseFeishuText('{"text":"@_user_1 帮我查一下 CRM"}')).toBe('帮我查一下 CRM');
    expect(parseFeishuText('{"text":"@_user_12 查 CRM @_user_3"}')).toBe('查 CRM');
  });

  it('content 不是 JSON 时按原样处理，不抛异常', () => {
    expect(parseFeishuText('裸文本')).toBe('裸文本');
  });

  it('归一空白 —— 剥标记会留下多余空格', () => {
    expect(parseFeishuText('{"text":"  多  空格  "}')).toBe('多 空格');
  });
});
