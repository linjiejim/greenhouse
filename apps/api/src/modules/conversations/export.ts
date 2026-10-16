/**
 * A conversation as one Markdown file (CONV-27): the title, then every message with its author
 * and time; event rows as italic lines, tool steps as a short list under a reply, attachments by
 * file name. Names and times only: no internal ids.
 */

export interface ExportedMessage {
  role: 'user' | 'assistant' | 'event';
  /** A member's or an Agent's name. */
  author: string;
  createdAt: string;
  content: string;
  quote: string | null;
  steps: { summary: string; failed: boolean }[];
  attachments: string[];
  status: 'complete' | 'streaming' | 'stopped' | 'failed';
}

export interface ExportInput {
  title: string;
  locale: 'zh' | 'en';
  timeZone: string;
  exportedAt: string;
  messages: ExportedMessage[];
}

const COPY = {
  zh: {
    exported: '导出于',
    attachments: '附件：',
    separator: '、',
    stopped: '（已停止）',
    failed: '（未完成）',
    stepFailed: '（失败）',
  },
  en: {
    exported: 'Exported',
    attachments: 'Attachments: ',
    separator: ', ',
    stopped: '(stopped)',
    failed: '(not finished)',
    stepFailed: ' (failed)',
  },
} as const;

/** `YYYY-MM-DD HH:mm` in the reader's time zone (UTC when the zone is unknown). */
export function formatTime(iso: string, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(iso));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone);
  } catch {
    parts = format('UTC');
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Text that cannot break the line it sits on: one line, emphasis marks escaped. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\*_`[\]])/g, '\\$1');
}

export function renderConversationMarkdown(input: ExportInput): string {
  const copy = COPY[input.locale];
  const out: string[] = [
    `# ${inline(input.title)}`,
    '',
    `${copy.exported} ${formatTime(input.exportedAt, input.timeZone)} (${input.timeZone})`,
  ];
  for (const message of input.messages) {
    out.push('');
    if (message.role === 'event') {
      out.push(`*${inline(message.content) || '…'}*`);
      continue;
    }
    out.push(`**${inline(message.author)}** · ${formatTime(message.createdAt, input.timeZone)}`, '');
    if (message.quote) out.push(...message.quote.split('\n').map((line) => `> ${line}`), '');
    const status = message.status === 'stopped' ? copy.stopped : message.status === 'failed' ? copy.failed : '';
    const content = message.content.trim();
    if (content || status) out.push([content, status].filter(Boolean).join(' '));
    if (message.steps.length) {
      out.push('', ...message.steps.map((step) => `- ${inline(step.summary)}${step.failed ? copy.stepFailed : ''}`));
    }
    if (message.attachments.length) {
      out.push('', `${copy.attachments}${message.attachments.map(inline).join(copy.separator)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** A file name from the title that every system accepts, ending in `.md`. */
export function exportFilename(title: string, fallback: string): string {
  const name = [...title]
    .map((char) =>
      char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f || '\\/:*?"<>|'.includes(char) ? ' ' : char,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${name || fallback}.md`;
}
