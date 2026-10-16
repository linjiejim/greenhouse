/**
 * The words of system mail (invites, password resets, the admin's test), in the recipient's
 * language: plain text with a simple HTML alternative. Names people wrote are escaped in HTML.
 * Pure.
 */

import { escapeHtml } from '@greenhouse/utils/html';
import { han } from '@greenhouse/utils/i18n';

export type Locale = 'zh' | 'en';

export interface SystemMail {
  subject: string;
  text: string;
  html: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function compose(locale: Locale, subject: string, lines: string[], link?: { url: string; label: string }): SystemMail {
  const text = [...lines, ...(link ? [`${link.label}: ${link.url}`] : [])].join('\n\n');
  const html = [
    '<!doctype html>',
    `<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body>`,
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...(link ? [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`] : []),
    '</body></html>',
  ].join('\n');
  return { subject, text, html };
}

/** An invitation: who invites, to which workspace, and the activation link. */
export function inviteMail(input: {
  locale: Locale;
  workspace: string;
  inviter: string;
  name: string;
  url: string;
  days: number;
}): SystemMail {
  const workspace = oneLine(input.workspace);
  const inviter = oneLine(input.inviter);
  if (input.locale === 'en') {
    return compose(
      'en',
      `${inviter} invited you to ${workspace}`,
      [
        `Hi ${oneLine(input.name)},`,
        `${inviter} invited you to ${workspace} on Greenhouse. Set a password to start.`,
        `The link works once and for ${input.days} days.`,
      ],
      { url: input.url, label: 'Set your password' },
    );
  }
  return compose(
    'zh',
    han`${inviter} 邀请你加入 ${workspace}`,
    [
      han`${oneLine(input.name)}，你好：`,
      han`${inviter} 邀请你加入 Greenhouse 上的 ${workspace}。设置密码就可以开始使用。`,
      han`链接只能用一次，${input.days} 天内有效。`,
    ],
    { url: input.url, label: '设置密码' },
  );
}

/** A password reset an admin started. */
export function resetMail(input: {
  locale: Locale;
  workspace: string;
  name: string;
  url: string;
  days: number;
}): SystemMail {
  const workspace = oneLine(input.workspace);
  if (input.locale === 'en') {
    return compose(
      'en',
      `Reset your password for ${workspace}`,
      [
        `Hi ${oneLine(input.name)},`,
        `An admin of ${workspace} sent you a link to set a new password. Your current sessions end once you do.`,
        `The link works once and for ${input.days} days. If you did not expect it, ask your admin.`,
      ],
      { url: input.url, label: 'Set a new password' },
    );
  }
  return compose(
    'zh',
    han`重置你在 ${workspace} 的密码`,
    [
      han`${oneLine(input.name)}，你好：`,
      han`${workspace} 的管理员给你发了一个设置新密码的链接。设置后，已登录的设备都需要重新登录。`,
      han`链接只能用一次，${input.days} 天内有效。如果你没有预料到这封邮件，请联系管理员。`,
    ],
    { url: input.url, label: '设置新密码' },
  );
}

/** The admin's test from 管理 → 服务 → 邮箱. */
export function testMail(input: { locale: Locale; workspace: string; instance: string }): SystemMail {
  const workspace = oneLine(input.workspace);
  return input.locale === 'en'
    ? compose('en', `${workspace}: test mail`, [
        `This is a test mail: ${workspace} can send mail through ${oneLine(input.instance)}.`,
      ])
    : compose('zh', han`${workspace}：测试邮件`, [
        han`这是一封测试邮件：${workspace} 能通过 ${oneLine(input.instance)} 发出邮件。`,
      ]);
}
